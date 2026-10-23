"""Execution-bound metadata survives either real start-writer ordering."""

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl import database
from jobctrl.domain.events.workflow import (
    WorkflowCompletedPayload,
    WorkflowStartedPayload,
    WorkflowTerminatedPayload,
    create_workflow_completed,
    create_workflow_started,
    create_workflow_terminated,
)
from jobctrl.domain.rpc.messages import WorkflowStartSpec
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.infrastructure.rpc.workflow_starter import _record_dispatch_started
from jobctrl.pipeline.workflow import JobPipelineWorkflow
from jobctrl.preparation.workflow import JobPreparationWorkflow
from jobctrl.state import record_job_event


@pytest.fixture
def conn(tmp_path: Path):
    path = tmp_path / "jobctrl.db"
    connection = database.init_db(path)
    yield connection
    database.close_connection(path)


def record(conn: sqlite3.Connection, event):
    record_job_event(conn, None, "workflow", event.event_type, payload=dict(event.payload))
    conn.commit()


def start(conn, run_id, summary, **kwargs):
    record(conn, create_workflow_started(LOCAL_TENANT, WorkflowStartedPayload(
        workflow_id="owned-workflow", workflow_type="JobPreparationWorkflow",
        temporal_run_id=run_id, input_summary=summary,
        started_at="2026-01-01T00:00:00+00:00", **kwargs,
    )))


def refresh(conn):
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = conn.execute("SELECT * FROM workflow_run_projections WHERE workflow_id='owned-workflow'").fetchone()
    return dict(row), json.loads(row["input_summary_json"])


@pytest.mark.parametrize("dispatch_first", [False, True])
@pytest.mark.parametrize("batch", [False, True])
def test_real_dispatch_and_worker_start_preserve_recorded_input(conn, monkeypatch, dispatch_first, batch):
    job_id = "11111111-1111-4111-8111-111111111111"
    worker_summary = {"jobIds": [job_id], "workers": 10, "stages": ["score"]} if batch else {
        "jobId": job_id, "steps": ["score", "tailor", "cover", "pdf"], "targetVersion": "1",
    }
    payload = SimpleNamespace(tenant_id="local", stages=["score"], dry_run=False, limit=0) if batch else SimpleNamespace(
        tenant_id="local", job_id=job_id,
    )
    spec = WorkflowStartSpec(workflow=JobPipelineWorkflow if batch else JobPreparationWorkflow, args=(payload,))
    monkeypatch.setattr(database, "get_connection", lambda: conn)

    def dispatch():
        _record_dispatch_started(spec, "owned-workflow", SimpleNamespace(first_execution_run_id="owned-run"))

    if dispatch_first:
        dispatch()
    start(conn, "owned-run", worker_summary)
    if not dispatch_first:
        dispatch()
    row, summary = refresh(conn)
    assert row["status"] == "in_progress" and row["temporal_run_id"] == "owned-run"
    expected = {**worker_summary, **({"stages": ["score"], "dryRun": False, "limit": 0} if batch else {})}
    assert summary == expected
    assert [e["eventType"] for e in json.loads(row["events_json"])] == ["WorkflowStarted", "WorkflowStarted"]
    assert refresh(conn)[1] == expected


@pytest.mark.parametrize("closed", [False, True])
@pytest.mark.parametrize("summary_present", [False, True])
def test_new_execution_does_not_inherit_old_job_metadata(conn, closed, summary_present):
    start(conn, "old-run", {"jobId": "old-job", "steps": ["score"]})
    if closed:
        record(conn, create_workflow_completed(LOCAL_TENANT, WorkflowCompletedPayload(
            workflow_id="owned-workflow", workflow_type="JobPreparationWorkflow", temporal_run_id="old-run",
            finished_at="2026-01-01T00:01:00+00:00",
        )))
    event = create_workflow_started(LOCAL_TENANT, WorkflowStartedPayload(
        workflow_id="owned-workflow", workflow_type="JobPreparationWorkflow", temporal_run_id="new-run",
        started_at="2026-01-01T00:02:00+00:00",
    ))
    payload = dict(event.payload)
    if not summary_present:
        payload.pop("inputSummary")
    record_job_event(conn, None, "workflow", event.event_type, payload=payload)
    conn.commit()
    row, summary = refresh(conn)
    assert row["temporal_run_id"] == "new-run" and row["status"] == "in_progress"
    assert summary == {}


def test_late_sparse_dispatch_preserves_terminal_metadata(conn, monkeypatch):
    original = {"jobId": "owned-job", "steps": ["score"]}
    start(conn, "owned-run", original)
    record(conn, create_workflow_completed(LOCAL_TENANT, WorkflowCompletedPayload(
        workflow_id="owned-workflow", workflow_type="JobPreparationWorkflow", temporal_run_id="owned-run",
        finished_at="2026-01-01T00:01:00+00:00", duration_ms=60000,
    )))
    monkeypatch.setattr(database, "get_connection", lambda: conn)
    _record_dispatch_started(
        WorkflowStartSpec(workflow=JobPreparationWorkflow, args=(SimpleNamespace(tenant_id="local"),)),
        "owned-workflow", SimpleNamespace(first_execution_run_id="owned-run"),
    )
    row, summary = refresh(conn)
    assert row["status"] == "succeeded" and row["duration_ms"] == 60000
    assert summary == original and len(json.loads(row["events_json"])) == 3


def test_explicit_same_run_history_recovery_retains_known_input(conn):
    original = {"jobId": "owned-job", "steps": ["score"]}
    start(conn, "owned-run", original)
    record(conn, create_workflow_terminated(LOCAL_TENANT, WorkflowTerminatedPayload(
        workflow_id="owned-workflow", workflow_type="JobPreparationWorkflow", temporal_run_id="owned-run",
        error_code="reconciled_not_found", finished_at="2026-01-01T00:01:00+00:00",
    )))
    start(conn, "owned-run", {}, recovered_from_missing_history=True)
    row, summary = refresh(conn)
    assert row["status"] == "in_progress" and row["error_code"] is None
    assert summary == original


def test_unknown_execution_identity_does_not_merge_job_metadata(conn):
    start(conn, None, {"jobId": "unidentified-job"})
    start(conn, None, {})
    row, summary = refresh(conn)
    assert row["temporal_run_id"] is None and summary == {}
