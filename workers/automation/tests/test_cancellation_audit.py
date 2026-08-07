"""Temporal-history recovery of the cancellation requester (PR #750 review).

Covers the previously unwired half of the cancellation-audit capability:

* ``cancellation_source`` — boundary classification from Temporal's immutable
  requester identity.
* ``cancellation_request_from_history`` — protobuf history parsing (identity,
  cause, event timestamp) against mocked history events.
* ``reconcile_cancellation_audit`` — the heartbeat backfill sweep: a canceled
  run lacking the history-evidence fact gains it WITHOUT the stored projection
  row being rebuilt or corrupted (the reviewer-reproduced overwrite), and a
  vanished history is skipped quietly.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import pytest
from temporalio.service import RPCError, RPCStatusCode

from jobctrl.database import get_connection
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.infrastructure.temporal.cancellation_audit import (
    cancellation_request_from_history,
    cancellation_source,
    reconcile_cancellation_audit,
)
from jobctrl.state import record_job_event

_CANCEL_KIND = "workflow_execution_cancel_requested_event_attributes"


class _FakeTimestamp:
    def __init__(self, moment: datetime) -> None:
        self._moment = moment

    def ToDatetime(self, tzinfo=None):  # noqa: N802 — protobuf casing
        if tzinfo is not None:
            return self._moment.replace(tzinfo=tzinfo)
        return self._moment.replace(tzinfo=None)


class _FakeCancelAttributes:
    def __init__(self, identity: str, cause: str | None = None) -> None:
        self.identity = identity
        self.cause = cause


class _FakeHistoryEvent:
    def __init__(self, kind: str, attrs=None, event_time=None) -> None:
        self._kind = kind
        self.workflow_execution_cancel_requested_event_attributes = attrs
        self.event_time = event_time

    def WhichOneof(self, _field: str) -> str:  # noqa: N802 — protobuf casing
        return self._kind


class _FakeHandle:
    def __init__(self, history=(), error: Exception | None = None) -> None:
        self._history = tuple(history)
        self._error = error

    async def _iterate(self):
        if self._error is not None:
            raise self._error
        for event in self._history:
            yield event

    def fetch_history_events(self, *, wait_new_event: bool = False):
        return self._iterate()


class _FakeClient:
    """Maps workflow ids to a history; unknown ids yield an empty history so
    leftover canceled rows from other suites are never given invented facts."""

    def __init__(self, mapping: dict[str, _FakeHandle]) -> None:
        self._mapping = mapping
        self.lookups: list[tuple[str, str | None]] = []

    def get_workflow_handle(self, workflow_id: str, *, run_id: str | None = None) -> _FakeHandle:
        self.lookups.append((workflow_id, run_id))
        return self._mapping.get(workflow_id, _FakeHandle())


def _cancel_event(
    identity: str,
    *,
    cause: str | None = None,
    at: datetime | None = None,
) -> _FakeHistoryEvent:
    return _FakeHistoryEvent(
        _CANCEL_KIND,
        attrs=_FakeCancelAttributes(identity, cause),
        event_time=_FakeTimestamp(at or datetime(2026, 8, 4, 21, 4, 8, tzinfo=UTC)),
    )


def _audit_facts(conn, workflow_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT payload_json FROM job_events "
        "WHERE event_type = 'WorkflowCancellationRequested' AND entity_ref = ? "
        "ORDER BY event_id ASC",
        (workflow_id,),
    ).fetchall()
    return [json.loads(row["payload_json"] or "{}") for row in rows]


def _run_row(conn, workflow_id: str):
    return conn.execute(
        "SELECT * FROM workflow_run_projections WHERE workflow_id = ?",
        (workflow_id,),
    ).fetchone()


# ------------------------------------------------------------------ unit tests


def test_cancellation_source_classifies_boundaries() -> None:
    assert cancellation_source("temporal-cli:tester@local") == "temporal_cli"
    assert cancellation_source("  Temporal-CLI:tester@local  ") == "temporal_cli"
    assert cancellation_source("temporal-web:ops@local") == "temporal_web"
    assert cancellation_source("23456@some-host@") == "temporal_external"
    assert cancellation_source("   ") == "temporal_unknown"
    assert cancellation_source("") == "temporal_unknown"


@pytest.mark.asyncio
async def test_cancellation_request_from_history_parses_identity_cause_timestamp() -> None:
    handle = _FakeHandle(
        history=[
            _FakeHistoryEvent("workflow_execution_started_event_attributes"),
            _cancel_event(
                "  temporal-cli:tester@local  ",
                cause="operator requested stop",
                at=datetime(2026, 8, 4, 21, 4, 8, tzinfo=UTC),
            ),
            _cancel_event("temporal-web:later@local"),
        ]
    )

    observation = await cancellation_request_from_history(handle)

    assert observation is not None
    # First cancel-request wins; identity is stripped and classified.
    assert observation.requested_by == "temporal-cli:tester@local"
    assert observation.source == "temporal_cli"
    assert observation.reason == "operator requested stop"
    assert observation.requested_at == "2026-08-04T21:04:08+00:00"


@pytest.mark.asyncio
async def test_cancellation_request_from_history_handles_blank_identity_and_absence() -> None:
    blank = _FakeHandle(history=[_cancel_event("   ", cause=None)])
    observation = await cancellation_request_from_history(blank)
    assert observation is not None
    assert observation.requested_by == "unknown"
    assert observation.source == "temporal_unknown"
    assert observation.reason is None

    no_cancel = _FakeHandle(
        history=[_FakeHistoryEvent("workflow_execution_started_event_attributes")]
    )
    assert await cancellation_request_from_history(no_cancel) is None


# ------------------------------------------------------ backfill sweep (wired)


@pytest.mark.asyncio
async def test_reconcile_cancellation_audit_recovers_legacy_run_without_corrupting_it() -> None:
    """A canceled-without-audit run gains its immutable requester fact while
    the stored row keeps its canceled status, timestamps, and input summary.

    This is the exact population the reviewer showed the unfixed projection
    fold destroying (canceled -> in_progress, started_at/finished_at/
    input_summary nulled), so the assertions pin both halves: the fact lands
    AND nothing about the row changes.
    """
    conn = get_connection()
    workflow_id = f"run-{uuid.uuid4().hex}"
    run_id = f"temporal-{uuid.uuid4().hex}"
    conn.execute(
        "INSERT INTO workflow_run_projections ("
        " workflow_id, tenant_id, workflow_type, status, input_summary_json,"
        " error_code, error_message, retryable, started_at, finished_at,"
        " duration_ms, temporal_run_id, events_json"
        ") VALUES (?, 'local', 'JobPipelineWorkflow', 'canceled', ?, NULL, NULL,"
        " 0, '2026-08-01T09:00:00Z', '2026-08-01T09:30:00Z', NULL, ?, '[]')",
        (workflow_id, json.dumps({"jobId": "job-2"}), run_id),
    )
    conn.commit()

    client = _FakeClient(
        {workflow_id: _FakeHandle(history=[_cancel_event("temporal-cli:tester@local")])}
    )
    recovered = await reconcile_cancellation_audit(client)

    assert recovered >= 1
    assert (workflow_id, run_id) in client.lookups

    facts = _audit_facts(conn, workflow_id)
    assert len(facts) == 1
    assert facts[0]["evidenceKind"] == "recovered_temporal_history"
    assert facts[0]["requestedBy"] == "temporal-cli:tester@local"
    assert facts[0]["source"] == "temporal_cli"
    assert facts[0]["temporalRunId"] == run_id

    row = _run_row(conn, workflow_id)
    assert row is not None
    assert row["status"] == "canceled"
    assert row["started_at"] == "2026-08-01T09:00:00Z"
    assert row["finished_at"] == "2026-08-01T09:30:00Z"
    assert json.loads(row["input_summary_json"] or "{}") == {"jobId": "job-2"}
    assert row["temporal_run_id"] == run_id

    # The fact satisfied the missing-audit query: a second sweep is a no-op.
    await reconcile_cancellation_audit(client)
    assert len(_audit_facts(conn, workflow_id)) == 1


@pytest.mark.asyncio
async def test_reconcile_cancellation_audit_covers_event_backed_cancels_and_keeps_fold() -> None:
    """Cooperative cancels closed by finalize (real Workflow* events) also get
    the history fact, and the refreshed fold keeps the canceled verdict while
    the timeline gains the requester entry."""
    conn = get_connection()
    workflow_id = f"run-{uuid.uuid4().hex}"
    run_id = f"temporal-{uuid.uuid4().hex}"
    record_job_event(
        conn,
        None,
        "workflow",
        "WorkflowStarted",
        payload={
            "tenantId": "local",
            "workflowId": workflow_id,
            "workflowType": "ApplyWorkflow",
            "startedAt": "2026-08-04T21:00:00+00:00",
            "temporalRunId": run_id,
        },
        occurred_at="2026-08-04T21:00:00+00:00",
    )
    record_job_event(
        conn,
        None,
        "workflow",
        "WorkflowCanceled",
        payload={
            "tenantId": "local",
            "workflowId": workflow_id,
            "workflowType": "ApplyWorkflow",
            "errorCode": "",
            "errorMessage": "Workflow canceled.",
            "finishedAt": "2026-08-04T21:04:09+00:00",
            "temporalRunId": run_id,
        },
        occurred_at="2026-08-04T21:04:09+00:00",
    )
    conn.commit()
    ProjectionBuilder(conn_factory=get_connection).refresh()
    assert _run_row(conn, workflow_id)["status"] == "canceled"

    client = _FakeClient(
        {
            workflow_id: _FakeHandle(
                history=[_cancel_event("temporal-web:ops@local", cause="stop it")]
            )
        }
    )
    await reconcile_cancellation_audit(client)

    facts = _audit_facts(conn, workflow_id)
    assert len(facts) == 1
    assert facts[0]["evidenceKind"] == "recovered_temporal_history"
    assert facts[0]["source"] == "temporal_web"
    assert facts[0]["reason"] == "stop it"

    row = _run_row(conn, workflow_id)
    assert row["status"] == "canceled"
    assert row["started_at"] == "2026-08-04T21:00:00+00:00"
    assert row["finished_at"] == "2026-08-04T21:04:09+00:00"
    timeline = [event["eventType"] for event in json.loads(row["events_json"] or "[]")]
    assert "WorkflowCancellationRequested" in timeline
    assert timeline.count("WorkflowCanceled") == 1


@pytest.mark.asyncio
async def test_reconcile_cancellation_audit_skips_vanished_history_quietly() -> None:
    conn = get_connection()
    workflow_id = f"run-{uuid.uuid4().hex}"
    run_id = f"temporal-{uuid.uuid4().hex}"
    conn.execute(
        "INSERT INTO workflow_run_projections ("
        " workflow_id, tenant_id, workflow_type, status, input_summary_json,"
        " error_code, error_message, retryable, started_at, finished_at,"
        " duration_ms, temporal_run_id, events_json"
        ") VALUES (?, 'local', 'JobPipelineWorkflow', 'canceled', '{}', NULL,"
        " NULL, 0, '2026-08-01T09:00:00Z', '2026-08-01T09:30:00Z', NULL, ?, '[]')",
        (workflow_id, run_id),
    )
    conn.commit()

    client = _FakeClient(
        {
            workflow_id: _FakeHandle(
                error=RPCError("not found", RPCStatusCode.NOT_FOUND, b"")
            )
        }
    )
    await reconcile_cancellation_audit(client)

    assert _audit_facts(conn, workflow_id) == []
    row = _run_row(conn, workflow_id)
    assert row["status"] == "canceled"
    assert row["started_at"] == "2026-08-01T09:00:00Z"
