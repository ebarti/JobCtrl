"""Synthetic worker shutdown behavior; this does not prove native quiescence."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace

import pytest

from jobctrl.infrastructure.temporal import run_in_activity as ria
from .temporal_env import local_env


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_drain", [False, True])
async def test_drain_waits_for_all_threads_in_retired_generation(monkeypatch, cancel_drain):
    monkeypatch.setattr(ria.activity, "heartbeat", lambda *_: None)
    monkeypatch.setattr(ria.activity, "info", lambda: SimpleNamespace(activity_type="synthetic"))
    started = [threading.Event(), threading.Event()]
    release = [threading.Event(), threading.Event()]
    executor = ThreadPoolExecutor(max_workers=2)
    ria.set_activity_executor(executor)

    def work(index):
        started[index].set()
        if not release[index].wait(5):
            raise TimeoutError("synthetic work was not released")
        return index

    async def invoke(index):
        return await ria.run_blocking_with_heartbeat(
            lambda: work(index), starting_message="synthetic", poll_interval=0.01,
            cancel_wait_seconds=0,
        )

    first = asyncio.create_task(invoke(0))
    second = asyncio.create_task(invoke(1))
    try:
        assert await asyncio.to_thread(started[0].wait, 3)
        assert await asyncio.to_thread(started[1].wait, 3)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        release[0].set()
        # Force a subsequent rotation after the first abandoned thread exits.
        for _ in range(200):
            if len(ria._ACTIVITY_EXECUTOR_FUTURES.get(executor, ())) == 1:
                break
            await asyncio.sleep(0.01)
        replacement = ria._activity_executor()
        marker = asyncio.get_running_loop().create_future()
        assert ria._rotate_abandoned_activity_executor(replacement, marker)
        assert executor in [pool for pool, _ in ria._RETIRED_ACTIVITY_EXECUTORS]
        drain = asyncio.create_task(ria.drain_activity_executors())
        await asyncio.sleep(0.05)
        assert not drain.done()
        if cancel_drain:
            drain.cancel()
            await asyncio.sleep(0.05)
            assert not drain.done()
        with pytest.raises(RuntimeError, match="draining"):
            await invoke(0)
        release[1].set()
        assert await second == 1
        if cancel_drain:
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(drain, 3)
        else:
            await asyncio.wait_for(drain, 3)
    finally:
        for event in release:
            event.set()
        await asyncio.gather(first, second, return_exceptions=True)
        ria.shutdown_activity_executors()
        ria.set_activity_executor(None)


def test_sigterm_requests_worker_shutdown_in_owned_subprocess():
    source = """
import asyncio
import os
import signal
from jobctrl.infrastructure.temporal.worker import run_worker_until_sigterm

class Worker:
    def __init__(self):
        self.finished = asyncio.Event()
        self.calls = 0
    async def run(self):
        asyncio.get_running_loop().call_later(.05, os.kill, os.getpid(), signal.SIGTERM)
        await self.finished.wait()
    async def shutdown(self):
        self.calls += 1
        self.finished.set()

class InvalidWorker:
    async def run(self):
        asyncio.get_running_loop().call_soon(os.kill, os.getpid(), signal.SIGTERM)
        await asyncio.sleep(.05)
        raise ValueError("startup validation failed")
    async def shutdown(self):
        await asyncio.Event().wait()

async def main():
    worker = Worker()
    await run_worker_until_sigterm(worker)
    assert worker.calls == 1
    try:
        await asyncio.wait_for(run_worker_until_sigterm(InvalidWorker()), 1)
    except ValueError as error:
        assert str(error) == "startup validation failed"
    else:
        raise AssertionError("startup failure was lost")
asyncio.run(main())
"""
    completed = subprocess.run(
        [sys.executable, "-c", source],
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")},
        capture_output=True, text=True, timeout=10, check=False,
    )
    assert completed.returncode == 0, completed.stderr


@pytest.mark.asyncio
async def test_real_worker_cli_handles_sigterm_with_synthetic_temporal(tmp_path, monkeypatch):
    """Exercise CLI wiring without credentials, browsers, or auto-apply."""
    monkeypatch.delenv("PYTHONPATH", raising=False)
    source = """
import sys
from types import SimpleNamespace
import jobctrl.config as config
config.load_env = lambda: ()
import jobctrl.cli as cli
import jobctrl.apply.auto_apply as auto_apply

async def noop(*args, **kwargs):
    return None
async def no_auto_apply(*args, **kwargs):
    return SimpleNamespace(changed=False)
cli._reconcile_discovery_schedule = noop
cli._reconcile_legacy_discovery_executions = noop
cli._reconcile_saved_postings = noop
cli._reconcile_automatic_preparation = noop
auto_apply.reconcile_auto_apply_loop = no_auto_apply
sys.argv = ["jobctrl", "worker", "--task-queue", "shutdown-synthetic"]
cli.app()
"""
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home.mkdir()
    workspace.mkdir()
    async with local_env() as environment:
        address = environment.client.service_client.config.target_host
        assert address.startswith("127.0.0.1:") or address.startswith("localhost:")
        env = {
            "HOME": str(home),
            "JOBCTRL_DIR": str(workspace),
            "JOBCTRL_SKIP_BROWSER_PREFLIGHT": "1",
            "LANGFUSE_DISABLE": "1",
            "OTEL_SDK_DISABLED": "true",
            "PATH": "/usr/bin:/bin",
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
            "PYTHONUNBUFFERED": "1",
            "TEMPORAL_ADDRESS": address,
        }
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-u", "-c", source, cwd=str(workspace), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        assert process.stdout is not None
        output = []
        try:
            async def wait_for_start():
                while line := await process.stdout.readline():
                    output.append(line.decode(errors="replace"))
                    if "JobCtrl worker" in output[-1] and "running" in output[-1]:
                        return
                raise AssertionError("worker exited before readiness: " + "".join(output))

            await asyncio.wait_for(wait_for_start(), 30)
            # The readiness message precedes entry to the signal-aware loop.
            await asyncio.sleep(0.5)
            process.send_signal(__import__("signal").SIGTERM)
            await asyncio.wait_for(process.wait(), 15)
            output.append((await process.stdout.read()).decode(errors="replace"))
            assert process.returncode == 0, "".join(output)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
