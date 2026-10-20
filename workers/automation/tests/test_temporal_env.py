"""Unit tests for the bounded Temporal test-environment lifecycle.

These prove the exact recovery behavior behind the six-hour CI hangs: a wedged
environment start is abandoned at the bound and retried with a fresh server,
and a wedged shutdown is abandoned without overturning the test's own result.
No real Temporal server is started here; the wedge is simulated.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from . import temporal_env
from .temporal_env import _bounded_env


class _FakeEnvironment:
    def __init__(self) -> None:
        self.shutdowns = 0

    async def shutdown(self) -> None:
        self.shutdowns += 1


@pytest.mark.asyncio
@pytest.mark.parametrize("use_existing", [False, True])
@pytest.mark.parametrize(
    "factory,sdk_method,variable,argument",
    [
        (
            temporal_env.time_skipping_env,
            "start_time_skipping",
            "JOBCTRL_TEMPORAL_TEST_SERVER_PATH",
            "test_server_existing_path",
        ),
        (temporal_env.local_env, "start_local", "JOBCTRL_TEMPORAL_CLI_PATH", "dev_server_existing_path"),
    ],
)
async def test_time_skipping_server_path_is_explicit_and_keeps_bounded_lifecycle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    use_existing: bool,
    factory,
    sdk_method,
    variable,
    argument,
) -> None:
    server = tmp_path / "owned-test-server"
    server.write_text("synthetic executable", encoding="utf-8")
    server.chmod(0o700)
    if use_existing:
        monkeypatch.setenv(variable, str(server))
    else:
        monkeypatch.delenv(variable, raising=False)
    calls = []
    healthy = _FakeEnvironment()

    async def start(**kwargs):
        calls.append(kwargs)
        return healthy

    monkeypatch.setattr(temporal_env.WorkflowEnvironment, sdk_method, start)
    async with factory() as env:
        assert env is healthy
    assert calls == ([{argument: str(server)}] if use_existing else [{}])
    assert healthy.shutdowns == 1


@pytest.mark.parametrize("kind", ["relative", "missing", "directory", "not_executable"])
def test_invalid_explicit_test_server_fails_before_start_or_download(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    kind: str,
) -> None:
    server = tmp_path / "owned-test-server"
    configured = str(server)
    if kind == "relative":
        configured = "relative-test-server"
    elif kind == "directory":
        server.mkdir()
    elif kind == "not_executable":
        server.write_text("synthetic non-executable", encoding="utf-8")
        server.chmod(0o600)
    monkeypatch.setenv("JOBCTRL_TEMPORAL_TEST_SERVER_PATH", configured)
    monkeypatch.setattr(
        temporal_env.WorkflowEnvironment,
        "start_time_skipping",
        lambda **_: pytest.fail("an invalid explicit server must not start or download"),
    )

    with pytest.raises(ValueError, match="must name an absolute executable file"):
        temporal_env.time_skipping_env()


@pytest.mark.asyncio
async def test_wedged_first_start_is_retried_with_a_fresh_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_env, "START_TIMEOUT_SECONDS", 0.05)
    starts = 0
    healthy = _FakeEnvironment()

    async def start() -> _FakeEnvironment:
        nonlocal starts
        starts += 1
        if starts == 1:
            await asyncio.Event().wait()
        return healthy

    async with _bounded_env(start, "wedge-once") as env:
        assert env is healthy
    assert starts == 2
    assert healthy.shutdowns == 1


@pytest.mark.asyncio
async def test_start_wedged_every_attempt_fails_bounded_not_forever(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_env, "START_TIMEOUT_SECONDS", 0.05)
    starts = 0

    async def start() -> _FakeEnvironment:
        nonlocal starts
        starts += 1
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    with pytest.raises(TimeoutError, match="failed to start 3 times"):
        async with _bounded_env(start, "always-wedged"):
            raise AssertionError("environment must never be yielded")
    assert starts == temporal_env.START_ATTEMPTS


@pytest.mark.asyncio
async def test_wedged_shutdown_is_abandoned_and_test_outcome_kept(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_env, "SHUTDOWN_TIMEOUT_SECONDS", 0.05)

    class _WedgedShutdown:
        async def shutdown(self) -> None:
            await asyncio.Event().wait()

    async def start() -> _WedgedShutdown:
        return _WedgedShutdown()

    entered = False
    async with _bounded_env(start, "wedged-shutdown"):
        entered = True
    assert entered

    with pytest.raises(RuntimeError, match="the real failure"):
        async with _bounded_env(start, "wedged-shutdown"):
            raise RuntimeError("the real failure")
