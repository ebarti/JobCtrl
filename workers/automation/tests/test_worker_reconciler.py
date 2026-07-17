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

from jobctrl.cli import _reconcile_workflow_runs, _record_reconciled_outcome
from jobctrl.database import get_connection
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.state import record_job_event


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
        self.lookups: list[tuple[str, str | None]] = []

    def get_workflow_handle(
        self, workflow_id: str, *, run_id: str | None = None
    ) -> _FakeHandle:
        self.lookups.append((workflow_id, run_id))
        return _FakeHandle(
            self._mapping.get(workflow_id, _FakeDescribe(WorkflowExecutionStatus.RUNNING))
        )


def _seed_open_run(
    conn,
    workflow_id: str,
    workflow_type: str = "JobPipelineWorkflow",
    temporal_run_id: str | None = None,
) -> None:
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
            "temporalRunId": temporal_run_id,
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


def _reason(conn, workflow_id: str) -> tuple[str | None, str | None]:
    row = conn.execute(
        "SELECT error_code, error_message FROM workflow_run_projections WHERE workflow_id = ?",
        (workflow_id,),
    ).fetchone()
    if row is None:
        return None, None
    return row["error_code"], row["error_message"]


def _raw_workflow_payloads(conn, workflow_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT payload_json FROM job_events WHERE event_type LIKE 'Workflow%' "
        "ORDER BY event_id ASC"
    ).fetchall()
    payloads = [json.loads(row["payload_json"] or "{}") for row in rows]
    return [payload for payload in payloads if payload.get("workflowId") == workflow_id]


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
    # A reconciler-closed row carries a reason so the UI never shows a terminal
    # run with no explanation (observability review).
    closed_code, closed_message = _reason(conn, closed_id)
    assert closed_code == "reconciled_closed_failed"
    assert closed_message and "FAILED" in closed_message
    # NOT_FOUND (dev-server data loss) → terminated + WorkflowTerminated.
    assert _status(conn, notfound_id) == "terminated"
    assert "WorkflowTerminated" in _events(conn, notfound_id)
    notfound_code, notfound_message = _reason(conn, notfound_id)
    assert notfound_code == "reconciled_not_found"
    assert notfound_message and "no longer exists" in notfound_message
    # Still RUNNING → untouched.
    assert _status(conn, running_id) == "in_progress"


@pytest.mark.asyncio
async def test_reconciler_recovers_exact_run_after_false_not_found_terminal() -> None:
    conn = get_connection()
    workflow_id = f"run-{uuid.uuid4().hex}"
    run_id = f"temporal-{uuid.uuid4().hex}"
    _seed_open_run(conn, workflow_id, temporal_run_id=run_id)

    missing_client = _FakeClient(
        {workflow_id: RPCError("not found", RPCStatusCode.NOT_FOUND, b"")}
    )
    assert await _reconcile_workflow_runs(missing_client) >= 1
    assert _status(conn, workflow_id) == "terminated"
    assert _reason(conn, workflow_id)[0] == "reconciled_not_found"

    live_client = _FakeClient(
        {workflow_id: _FakeDescribe(WorkflowExecutionStatus.RUNNING, run_id=run_id)}
    )
    assert await _reconcile_workflow_runs(live_client) >= 1

    assert (workflow_id, run_id) in live_client.lookups
    assert _status(conn, workflow_id) == "in_progress"
    assert _reason(conn, workflow_id) == (None, None)
    payloads = _raw_workflow_payloads(conn, workflow_id)
    assert [payload.get("status") for payload in payloads] == [
        "in_progress",
        "terminated",
        "in_progress",
    ]
    assert payloads[-1]["temporalRunId"] == run_id
    assert payloads[-1]["recoveredFromMissingHistory"] is True


@pytest.mark.asyncio
async def test_reconciler_replaces_false_terminal_with_recovered_real_outcome() -> None:
    conn = get_connection()
    workflow_id = f"run-{uuid.uuid4().hex}"
    run_id = f"temporal-{uuid.uuid4().hex}"
    _seed_open_run(conn, workflow_id, temporal_run_id=run_id)

    missing_client = _FakeClient(
        {workflow_id: RPCError("not found", RPCStatusCode.NOT_FOUND, b"")}
    )
    await _reconcile_workflow_runs(missing_client)
    assert _status(conn, workflow_id) == "terminated"

    completed_client = _FakeClient(
        {workflow_id: _FakeDescribe(WorkflowExecutionStatus.COMPLETED, run_id=run_id)}
    )
    assert await _reconcile_workflow_runs(completed_client) >= 1

    assert _status(conn, workflow_id) == "succeeded"
    assert _reason(conn, workflow_id) == (None, None)
    assert _events(conn, workflow_id)[-2:] == ["WorkflowStarted", "WorkflowCompleted"]


@pytest.mark.asyncio
async def test_reconciler_does_not_duplicate_provisional_terminal_while_still_missing() -> None:
    conn = get_connection()
    workflow_id = f"run-{uuid.uuid4().hex}"
    run_id = f"temporal-{uuid.uuid4().hex}"
    _seed_open_run(conn, workflow_id, temporal_run_id=run_id)
    client = _FakeClient(
        {workflow_id: RPCError("not found", RPCStatusCode.NOT_FOUND, b"")}
    )

    assert await _reconcile_workflow_runs(client) >= 1
    event_count = len(_events(conn, workflow_id))
    assert await _reconcile_workflow_runs(client) == 0

    assert _status(conn, workflow_id) == "terminated"
    assert len(_events(conn, workflow_id)) == event_count
    target_lookups = [lookup for lookup in client.lookups if lookup[0] == workflow_id]
    assert target_lookups == [(workflow_id, run_id), (workflow_id, run_id)]


def _record_terminal(conn, workflow_id: str, event_type: str, status: str) -> None:
    record_job_event(
        conn,
        None,
        "workflow",
        event_type,
        payload={
            "tenantId": "local",
            "workflowId": workflow_id,
            "workflowType": "ApplyWorkflow",
            "status": status,
            "errorCode": "apply_failed",
            "errorMessage": "boom",
            "finishedAt": "2026-05-04T13:02:00+00:00",
        },
    )
    conn.commit()
    ProjectionBuilder(conn_factory=get_connection).refresh()


def test_reconciler_does_not_overwrite_already_terminal_row() -> None:
    """The reconciler is a backstop for open rows, never an overwriter of
    terminal truth (M-1 review).

    A workflow whose finalize recorded ``WorkflowFailed`` closes COMPLETED on
    the Temporal side (stage/apply failure is encoded in the return value). If
    the reconciler acts on a stale open-runs snapshot and tries to record
    ``succeeded``, Layer 1 re-reads the row under the write lock and skips —
    no ``WorkflowCompleted`` is emitted and the row stays ``failed``.
    """
    conn = get_connection()
    failed_id = f"run-{uuid.uuid4().hex}"
    _seed_open_run(conn, failed_id, workflow_type="ApplyWorkflow")
    # finalize landed the real terminal outcome after the reconciler snapshotted
    # the run as still-open.
    _record_terminal(conn, failed_id, "WorkflowFailed", "failed")
    assert _status(conn, failed_id) == "failed"

    # Reconciler acts on its stale snapshot (run looked in_progress) and tries to
    # record succeeded, e.g. because describe returned COMPLETED.
    stale_run = {
        "workflow_id": failed_id,
        "tenant_id": "local",
        "workflow_type": "ApplyWorkflow",
    }
    _record_reconciled_outcome(conn, stale_run, status="succeeded")

    assert _status(conn, failed_id) == "failed"
    # Layer 1 skipped before writing, so no succeeded event even reaches the log.
    assert "WorkflowCompleted" not in _events(conn, failed_id)


@pytest.mark.asyncio
async def test_reconciler_maps_canceled_execution_to_workflow_canceled() -> None:
    conn = get_connection()
    canceled_id = f"run-{uuid.uuid4().hex}"
    _seed_open_run(conn, canceled_id, workflow_type="ApplyWorkflow")

    client = _FakeClient({canceled_id: _FakeDescribe(WorkflowExecutionStatus.CANCELED)})
    await _reconcile_workflow_runs(client)

    assert _status(conn, canceled_id) == "canceled"
    assert "WorkflowCanceled" in _events(conn, canceled_id)
    # WorkflowCanceled carries no app-level error, so the reconciler stamps its
    # own reason (observability review).
    canceled_code, canceled_message = _reason(conn, canceled_id)
    assert canceled_code == "reconciled_closed_canceled"
    assert canceled_message and "CANCELED" in canceled_message
