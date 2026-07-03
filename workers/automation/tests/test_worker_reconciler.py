"""Describe-based reconciler (P0): terminalize open workflow-run rows whose
Temporal execution has closed or vanished, and leave still-running rows alone.

This is the backstop that makes a killed / timed-out worker's runs terminalize
on their own — no reaper. Rows are seeded in the session sandbox DB with unique
ids so the test is isolated from other suites.
"""

from __future__ import annotations

import json
import uuid

import pytest
from temporalio.client import WorkflowExecutionStatus
from temporalio.service import RPCError, RPCStatusCode

from jobhunter.cli import _reconcile_workflow_runs
from jobhunter.database import get_connection
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.state import record_job_event


class _FakeDescribe:
    def __init__(self, status: WorkflowExecutionStatus, run_id: str = "temporal-run") -> None:
        self.status = status
        self.run_id = run_id


class _FakeHandle:
    def __init__(self, outcome) -> None:
        self._outcome = outcome

    async def describe(self):
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


class _FakeClient:
    """Maps workflow ids to a describe result; unknown ids look RUNNING so
    leftover rows from other suites are never terminalized by this test."""

    def __init__(self, mapping: dict) -> None:
        self._mapping = mapping

    def get_workflow_handle(self, workflow_id: str) -> _FakeHandle:
        return _FakeHandle(
            self._mapping.get(workflow_id, _FakeDescribe(WorkflowExecutionStatus.RUNNING))
        )


def _seed_open_run(conn, workflow_id: str, workflow_type: str = "JobPipelineWorkflow") -> None:
    record_job_event(
        conn,
        None,
        "workflow",
        "WorkflowStarted",
        payload={
            "tenantId": "local",
            "workflowId": workflow_id,
            "workflowType": workflow_type,
            "status": "in_progress",
        },
    )
    conn.commit()
    ProjectionBuilder(conn_factory=get_connection).refresh()


def _status(conn, workflow_id: str) -> str | None:
    row = conn.execute(
        "SELECT status FROM workflow_run_projections WHERE workflow_id = ?",
        (workflow_id,),
    ).fetchone()
    return None if row is None else row["status"]


def _events(conn, workflow_id: str) -> list[str]:
    row = conn.execute(
        "SELECT events_json FROM workflow_run_projections WHERE workflow_id = ?",
        (workflow_id,),
    ).fetchone()
    if row is None:
        return []
    return [event.get("eventType") for event in json.loads(row["events_json"] or "[]")]


@pytest.mark.asyncio
async def test_reconciler_terminalizes_closed_and_notfound_leaves_running() -> None:
    conn = get_connection()
    closed_id = f"run-{uuid.uuid4().hex}"
    notfound_id = f"run-{uuid.uuid4().hex}"
    running_id = f"run-{uuid.uuid4().hex}"
    for wid in (closed_id, notfound_id, running_id):
        _seed_open_run(conn, wid)
    assert _status(conn, closed_id) == "in_progress"

    client = _FakeClient(
        {
            closed_id: _FakeDescribe(WorkflowExecutionStatus.FAILED),
            notfound_id: RPCError("not found", RPCStatusCode.NOT_FOUND, b""),
            running_id: _FakeDescribe(WorkflowExecutionStatus.RUNNING),
        }
    )

    terminalized = await _reconcile_workflow_runs(client)

    assert terminalized >= 2
    # CLOSED (FAILED) execution → failed + WorkflowFailed emitted.
    assert _status(conn, closed_id) == "failed"
    assert "WorkflowFailed" in _events(conn, closed_id)
    # NOT_FOUND (dev-server data loss) → terminated + WorkflowTerminated.
    assert _status(conn, notfound_id) == "terminated"
    assert "WorkflowTerminated" in _events(conn, notfound_id)
    # Still RUNNING → untouched.
    assert _status(conn, running_id) == "in_progress"


@pytest.mark.asyncio
async def test_reconciler_maps_canceled_execution_to_workflow_canceled() -> None:
    conn = get_connection()
    canceled_id = f"run-{uuid.uuid4().hex}"
    _seed_open_run(conn, canceled_id, workflow_type="ApplyWorkflow")

    client = _FakeClient({canceled_id: _FakeDescribe(WorkflowExecutionStatus.CANCELED)})
    await _reconcile_workflow_runs(client)

    assert _status(conn, canceled_id) == "canceled"
    assert "WorkflowCanceled" in _events(conn, canceled_id)
