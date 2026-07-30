from __future__ import annotations

import asyncio
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.temporal.workflow_dispatch_control import (
    UnregisteredWorkflowDispatchError,
    WorkflowDispatchFencedError,
    reserve_workflow_dispatch,
    set_workflow_dispatches_blocked,
    workflow_dispatches_blocked,
)
from jobctrl.pipeline.workflow import JobPipelineWorkflow


@dataclass(frozen=True)
class _Handle:
    run_id: str


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "jobctrl.db"
    conn = init_db(path)
    conn.commit()
    close_connection(path)
    return path


@pytest.mark.asyncio
async def test_registered_start_is_reserved_before_dispatch(
    db_path: Path,
) -> None:
    async with reserve_workflow_dispatch(
        workflow=JobPipelineWorkflow,
        workflow_id="run-one",
        db_path=db_path,
    ) as reservation:
        with sqlite3.connect(db_path) as conn:
            row = conn.execute(
                """
                SELECT workflow_id, temporal_run_id,
                       workflow_type, state
                FROM workflow_dispatch_registry
                WHERE launch_id = ?
                """,
                (reservation.launch_id,),
            ).fetchone()
        assert row == (
            "run-one",
            None,
            "JobPipelineWorkflow",
            "reserved",
        )
        reservation.mark_dispatched(_Handle("temporal-one"))

    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT temporal_run_id, state
            FROM workflow_dispatch_registry
            WHERE launch_id = ?
            """,
            (reservation.launch_id,),
        ).fetchone()
    assert row == ("temporal-one", "dispatched")


@pytest.mark.asyncio
async def test_failed_start_remains_uncertain_for_exact_reconciliation(
    db_path: Path,
) -> None:
    with pytest.raises(TimeoutError, match="response lost"):
        async with reserve_workflow_dispatch(
            workflow=JobPipelineWorkflow,
            workflow_id="run-uncertain",
            db_path=db_path,
        ) as reservation:
            raise TimeoutError("response lost")

    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT temporal_run_id, state
            FROM workflow_dispatch_registry
            WHERE launch_id = ?
            """,
            (reservation.launch_id,),
        ).fetchone()
    assert row == (None, "uncertain")


@pytest.mark.asyncio
async def test_blocked_gate_refuses_dispatch_without_a_launch_row(
    db_path: Path,
) -> None:
    assert set_workflow_dispatches_blocked(
        blocked=True,
        reason="identity-cutover",
        db_path=db_path,
    )
    assert workflow_dispatches_blocked(db_path)

    with pytest.raises(
        WorkflowDispatchFencedError,
        match="stable JobId cutover",
    ):
        async with reserve_workflow_dispatch(
            workflow=JobPipelineWorkflow,
            workflow_id="run-blocked",
            db_path=db_path,
        ):
            pytest.fail("a fenced start must not reach dispatch")

    with sqlite3.connect(db_path) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM workflow_dispatch_registry"
        ).fetchone()[0]
    assert count == 0
    assert (
        set_workflow_dispatches_blocked(
            blocked=False,
            reason="test cleanup",
            db_path=db_path,
        )
        is False
    )
    assert workflow_dispatches_blocked(db_path) is False


@pytest.mark.asyncio
async def test_exclusive_gate_waits_for_inflight_reserved_start(
    db_path: Path,
) -> None:
    dispatch_entered = asyncio.Event()
    release_dispatch = asyncio.Event()

    async def _dispatch() -> None:
        async with reserve_workflow_dispatch(
            workflow=JobPipelineWorkflow,
            workflow_id="run-inflight",
            db_path=db_path,
        ) as reservation:
            dispatch_entered.set()
            await release_dispatch.wait()
            reservation.mark_dispatched(_Handle("temporal-inflight"))

    dispatch_task = asyncio.create_task(_dispatch())
    await dispatch_entered.wait()
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

    release_dispatch.set()
    await dispatch_task
    assert await fence_task is True
    assert workflow_dispatches_blocked(db_path) is True


@pytest.mark.asyncio
async def test_unregistered_workflow_fails_before_creating_lock_or_row(
    db_path: Path,
) -> None:
    class UndeclaredWorkflow:
        pass

    with pytest.raises(
        UnregisteredWorkflowDispatchError,
        match="not declared",
    ):
        async with reserve_workflow_dispatch(
            workflow=UndeclaredWorkflow,
            workflow_id="undeclared",
            db_path=db_path,
        ):
            pytest.fail("an undeclared workflow must not reach dispatch")

    with sqlite3.connect(db_path) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM workflow_dispatch_registry"
        ).fetchone()[0]
    assert count == 0
