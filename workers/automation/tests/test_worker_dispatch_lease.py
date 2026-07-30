from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from jobctrl import cli, config
from jobctrl.cli import _run_worker_with_dispatch_lease
from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.temporal.workflow_dispatch_control import (
    WorkflowDispatchFencedError,
    set_workflow_dispatches_blocked,
)


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "jobctrl.db"
    conn = init_db(path)
    conn.commit()
    close_connection(path)
    return path


@pytest.mark.asyncio
async def test_worker_runtime_refuses_blocked_cutover_gate(
    db_path: Path,
) -> None:
    set_workflow_dispatches_blocked(
        blocked=True,
        reason="identity-cutover",
        db_path=db_path,
    )
    prepared = False
    entered = False

    def _prepare() -> None:
        nonlocal prepared
        prepared = True

    async def _run() -> None:
        nonlocal entered
        entered = True

    with pytest.raises(
        WorkflowDispatchFencedError,
        match="worker startup is blocked",
    ):
        await _run_worker_with_dispatch_lease(
            _run,
            db_path=str(db_path),
            prepare_worker=_prepare,
        )

    assert prepared is False
    assert entered is False


def test_worker_command_checks_fence_before_bootstrap(
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    set_workflow_dispatches_blocked(
        blocked=True,
        reason="identity-cutover",
        db_path=db_path,
    )
    bootstrapped = False
    browser_checked = False

    def _bootstrap() -> None:
        nonlocal bootstrapped
        bootstrapped = True

    def _browser_preflight() -> None:
        nonlocal browser_checked
        browser_checked = True

    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(config, "APP_DIR", db_path.parent)
    monkeypatch.setattr(cli, "_bootstrap", _bootstrap)
    monkeypatch.setattr(
        cli,
        "_preflight_browsers_or_exit",
        _browser_preflight,
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.observability.shutdown_otel",
        lambda: None,
    )

    with pytest.raises(
        WorkflowDispatchFencedError,
        match="worker startup is blocked",
    ):
        cli.worker(task_queue=None)

    assert bootstrapped is False
    assert browser_checked is False


@pytest.mark.asyncio
async def test_worker_runtime_holds_shared_fence_until_shutdown(
    db_path: Path,
) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    async def _run() -> None:
        entered.set()
        await release.wait()

    worker_task = asyncio.create_task(
        _run_worker_with_dispatch_lease(
            _run,
            db_path=str(db_path),
        )
    )
    await entered.wait()
    fence_task = asyncio.create_task(
        asyncio.to_thread(
            set_workflow_dispatches_blocked,
            blocked=True,
            reason="identity-cutover",
            db_path=db_path,
        )
    )
    await asyncio.sleep(0.1)
    assert fence_task.done() is False

    release.set()
    await worker_task
    assert await fence_task is True
