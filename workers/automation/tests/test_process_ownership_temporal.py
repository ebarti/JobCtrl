"""Real Temporal cancellation with many owned synthetic Apply processes."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import os
import signal
import subprocess
import sys
import threading
import time
import uuid

import pytest
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl import config
from jobctrl.apply import chrome, launcher, ownership
from jobctrl.apply.activities import apply_activity
from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobctrl.infrastructure import process_ownership
from jobctrl.infrastructure.apply import claude_code_cli
from jobctrl.infrastructure.temporal import run_in_activity
from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
from jobctrl.llm import check_spend_budget

from .temporal_env import local_env
from .test_apply_launcher_ownership import owned_runtime as owned_runtime


@pytest.mark.asyncio
async def test_temporal_cancel_bounds_uncertain_owned_handles_and_preserves_peer(owned_runtime, monkeypatch, tmp_path):
    """Census uncertainty must not multiply the 30-second activity drain."""
    app, first, second = owned_runtime
    monkeypatch.setattr(chrome, '_chrome_procs', {})
    monkeypatch.setattr(chrome, '_chrome_identities', {})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {})
    original_inventory = process_ownership._read_process_inventory
    monkeypatch.setattr(process_ownership, '_read_process_inventory', lambda: ({}, False))
    original_kill = os.kill
    processes, signals, runs = [], [], []
    started, done = threading.Event(), threading.Event()
    run_class = ownership.ApplyLauncherRun

    def create_run():
        run = run_class()
        runs.append(run)
        return run

    class GuardedOS:
        def __getattr__(self, name):
            return getattr(os, name)

        def kill(self, pid, sig):
            assert pid in {process.pid for process in processes} and sig == signal.SIGTERM
            signals.append(pid)
            return original_kill(pid, sig)

        def killpg(self, _pgid, _sig):
            pytest.fail('an incomplete census cannot authorize force')

    def controlled_main(*, launcher_run, target_job_id, **_kwargs):
        try:
            with launcher_run.lease():
                if target_job_id == str(second):
                    launcher_run.finish()
                    return 0, 0
                launcher_run.allocate_workers(2)
                for worker_id in launcher_run.worker_ids:
                    for kind in ('agent', 'browser'):
                        process = ownership.spawn_owned_apply_process(
                            worker_id, kind, [sys.executable, '-I', '-B', '-c', 'import time; time.sleep(120)'],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env={'HOME': str(tmp_path), 'PATH': '/usr/bin:/bin'}, start_new_session=True,
                        )
                        processes.append(process)
                        if kind == 'agent':
                            claude_code_cli._register_active_claude_process(worker_id, process)
                        else:
                            with chrome._chrome_lock:
                                chrome._chrome_procs[worker_id] = process
                                chrome._chrome_identities[worker_id] = (process, process.pid)
                started.set()
                try:
                    assert launcher_run.stop_event.wait(45)
                finally:
                    launcher_run.finish()
        finally:
            if target_job_id != str(second):
                done.set()

    monkeypatch.setattr(process_ownership, 'os', GuardedOS())
    monkeypatch.setattr(ownership, 'ApplyLauncherRun', create_run)
    monkeypatch.setattr(launcher, 'main', controlled_main)
    original_helper = run_in_activity.run_blocking_with_heartbeat

    async def responsive(fn, **kwargs):
        # Keep the production 30-second drain; shorten only heartbeat polling.
        return await original_helper(fn, **{**kwargs, 'poll_interval': 0.2})

    monkeypatch.setattr(run_in_activity, 'run_blocking_with_heartbeat', responsive)
    executor = ThreadPoolExecutor(max_workers=4)
    run_in_activity.set_activity_executor(executor)
    queue = f'owned-cleanup-{uuid.uuid4()}'
    try:
        async with local_env() as env:
            async with Worker(
                env.client, task_queue=queue, workflows=[ApplyWorkflow],
                activities=[apply_activity, check_spend_budget, record_workflow_started, record_workflow_outcome],
                workflow_runner=UnsandboxedWorkflowRunner(), max_concurrent_activities=2,
                max_heartbeat_throttle_interval=timedelta(milliseconds=20),
            ):
                def payload(job):
                    return ApplyWorkflowInput(tenant_id='local', job_id=job, dry_run=True,
                                              expected_app_dir=str(app), expected_db_path=str(config.DB_PATH))

                owner = await env.client.start_workflow(ApplyWorkflow.run, payload(first), id=f'owner-{uuid.uuid4()}', task_queue=queue)
                assert await asyncio.to_thread(started.wait, 20)
                assert len(processes) == 4
                before = time.monotonic()
                await owner.cancel()
                while not runs[0].stop_event.is_set():
                    assert time.monotonic() - before < 5
                    await asyncio.sleep(.02)
                peer = await env.client.start_workflow(ApplyWorkflow.run, payload(second), id=f'peer-{uuid.uuid4()}', task_queue=queue)
                assert (await asyncio.wait_for(peer.result(), 10)).ok
                assert await asyncio.to_thread(done.wait, 28), 'owned cleanup did not finish inside Temporal drain'
                elapsed = time.monotonic() - before
                # Persistent uncertainty must exercise both cancellation and
                # final cleanup passes under their production deadlines.
                assert 15 <= elapsed < 30
                assert runs[0]._cleanup_error is not None
                assert signals and set(signals) <= {process.pid for process in processes}
                assert len(chrome._chrome_procs) == 2
                assert len(claude_code_cli._ACTIVE_CLAUDE_PROCS) == 2
    finally:
        if runs and not done.is_set():
            runs[0].cancel()
            await asyncio.to_thread(done.wait, 25)
        # Each handle here is the exact Popen launched above; no discovered PID
        # or foreign process is used as signal authority.
        monkeypatch.setattr(process_ownership, '_read_process_inventory', original_inventory)
        cleanup_errors = []
        for process in processes:
            try:
                if process.poll() is None:
                    original_kill(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            except Exception as exc:
                cleanup_errors.append(str(exc))
        run_in_activity.shutdown_activity_executors()
        executor.shutdown(wait=True, cancel_futures=True)
        assert not cleanup_errors, f'owned synthetic cleanup remains unresolved: {cleanup_errors}'
