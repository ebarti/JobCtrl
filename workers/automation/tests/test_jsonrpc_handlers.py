"""Default JSON-RPC handler registry — wires methods to actions/state."""

from __future__ import annotations

from pathlib import Path

import pytest

from jobhunter.actions import LocalActionRequest, LocalActionResult
from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.domain.rpc.messages import (
    INVALID_PARAMS,
    METHOD_NOT_FOUND,
    JsonRpcRequest,
    WorkflowStartSpec,
)
from jobhunter.infrastructure.rpc import handlers as handlers_mod
from jobhunter.infrastructure.rpc.handlers import register_default_handlers
from jobhunter.infrastructure.rpc.server import JsonRpcServer
from jobhunter.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput


class _StubHandle:
    def __init__(self, workflow_id: str, run_id: str = "first-run") -> None:
        self.id = workflow_id
        self.first_execution_run_id = run_id


async def _stub_starter(spec):
    return _StubHandle("wf-stub")


async def _stub_canceler(_run_id: str) -> None:  # pragma: no cover — never invoked here
    return None


@pytest.fixture
def tmp_db(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "jobs.db"
    init_db(db_path)
    monkeypatch.setattr(handlers_mod, "get_connection", lambda: get_connection(db_path))
    yield db_path
    close_connection(db_path)


def _server() -> JsonRpcServer:
    server = JsonRpcServer(workflow_starter=_stub_starter)
    register_default_handlers(server, canceler=_stub_canceler)
    return server


def _seed_job(db_path: Path, url: str = "https://example.com/job/1") -> None:
    conn = get_connection(db_path)
    conn.execute(
        "INSERT INTO jobs (url, title, discovered_at) VALUES (?, ?, datetime('now'))",
        (url, "Test job"),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Registry / unknown method
# ---------------------------------------------------------------------------


def test_default_handlers_are_registered() -> None:
    server = _server()
    methods = {
        "reset_stage",
        "mark_applied",
        "mark_skipped",
        "cancel_stage",
        "cancel_run",
        "run_stage",
        "apply",
        "profile_import",
    }
    # Force dispatch on each method name with deliberately invalid params
    # — we only care that the response is NOT METHOD_NOT_FOUND.
    for method in methods:
        response = server.dispatch(JsonRpcRequest(method=method, id=1))
        assert response is not None
        body = response.to_dict()
        assert "error" not in body or body["error"]["code"] != METHOD_NOT_FOUND


def test_unknown_method_returns_method_not_found() -> None:
    server = _server()
    response = server.dispatch(JsonRpcRequest(method="does_not_exist", id=1))
    assert response is not None
    assert response.to_dict()["error"]["code"] == METHOD_NOT_FOUND


# ---------------------------------------------------------------------------
# Simple state-transition handlers
# ---------------------------------------------------------------------------


def test_reset_stage_resets_to_pending(tmp_db: Path) -> None:
    _seed_job(tmp_db)
    server = _server()
    response = server.dispatch(
        JsonRpcRequest(
            method="reset_stage",
            params={
                "tenantId": "local",
                "jobUrl": "https://example.com/job/1",
                "stage": "tailor",
            },
            id=1,
        )
    )
    assert response is not None
    body = response.to_dict()
    assert "error" not in body
    assert body["result"]["state"] == "pending"
    assert body["result"]["stage"] == "tailor"

    conn = get_connection(tmp_db)
    row = conn.execute(
        "SELECT state FROM job_stage_states WHERE job_url=? AND stage=?",
        ("https://example.com/job/1", "tailor"),
    ).fetchone()
    assert row["state"] == "pending"


def test_mark_applied_writes_succeeded_state(tmp_db: Path) -> None:
    _seed_job(tmp_db)
    server = _server()
    response = server.dispatch(
        JsonRpcRequest(
            method="mark_applied",
            params={"tenantId": "local", "jobUrl": "https://example.com/job/1"},
            id=1,
        )
    )
    assert response is not None
    body = response.to_dict()
    assert body["result"]["state"] == "succeeded"

    conn = get_connection(tmp_db)
    row = conn.execute(
        "SELECT state FROM job_stage_states WHERE job_url=? AND stage='apply'",
        ("https://example.com/job/1",),
    ).fetchone()
    assert row["state"] == "succeeded"

    events = conn.execute(
        "SELECT event_type FROM job_events WHERE job_url=?",
        ("https://example.com/job/1",),
    ).fetchall()
    assert any(row["event_type"] == "ApplicationManuallyMarked" for row in events)


def test_mark_skipped_records_skip_event(tmp_db: Path) -> None:
    _seed_job(tmp_db)
    server = _server()
    response = server.dispatch(
        JsonRpcRequest(
            method="mark_skipped",
            params={
                "tenantId": "local",
                "jobUrl": "https://example.com/job/1",
                "stage": "score",
                "reason": "out_of_scope",
            },
            id=1,
        )
    )
    assert response is not None
    body = response.to_dict()
    assert body["result"]["state"] == "skipped"

    conn = get_connection(tmp_db)
    events = conn.execute(
        "SELECT event_type, message FROM job_events WHERE job_url=?",
        ("https://example.com/job/1",),
    ).fetchall()
    assert any(row["event_type"] == "StageSkipped" and row["message"] == "out_of_scope" for row in events)


def test_cancel_stage_writes_canceled_state(tmp_db: Path) -> None:
    _seed_job(tmp_db)
    server = _server()
    response = server.dispatch(
        JsonRpcRequest(
            method="cancel_stage",
            params={
                "tenantId": "local",
                "jobUrl": "https://example.com/job/1",
                "stage": "enrich",
            },
            id=1,
        )
    )
    assert response is not None
    body = response.to_dict()
    assert body["result"]["state"] == "canceled"


def test_missing_required_param_returns_invalid_params(tmp_db: Path) -> None:
    server = _server()
    response = server.dispatch(
        JsonRpcRequest(
            method="reset_stage",
            params={"tenantId": "local"},  # missing jobUrl + stage
            id=1,
        )
    )
    assert response is not None
    body = response.to_dict()
    assert body["error"]["code"] == INVALID_PARAMS


def test_missing_tenant_id_falls_back_to_local(tmp_db: Path, caplog) -> None:
    _seed_job(tmp_db)
    server = _server()
    with caplog.at_level("WARNING", logger="jobhunter.infrastructure.rpc.handlers"):
        response = server.dispatch(
            JsonRpcRequest(
                method="reset_stage",
                params={
                    "jobUrl": "https://example.com/job/1",
                    "stage": "score",
                },
                id=1,
            )
        )
    assert response is not None
    assert "tenantId" in caplog.text.lower() or "local_tenant" in caplog.text.lower()


# ---------------------------------------------------------------------------
# run_stage / apply / profile_import
# ---------------------------------------------------------------------------


def test_run_stage_starts_job_pipeline_workflow(tmp_db: Path) -> None:
    seen: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        seen.append(spec)
        return _StubHandle("pipeline-wf", "pipeline-run")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)

    response = server.dispatch(
        JsonRpcRequest(
            method="run_stage",
            params={
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobhunter",
                "expectedDbPath": "/tmp/jobhunter/jobhunter.db",
                "stage": "score",
                "stages": ["score", "tailor"],
                "limit": 5,
                "workers": 2,
                "minScore": 8,
                "validationMode": "strict",
                "dryRun": True,
                "rescore": True,
                "retailor": True,
            },
            id=1,
        )
    )

    assert response is not None
    body = response.to_dict()
    assert body["result"] == {
        "runId": "pipeline-wf",
        "workflowId": "pipeline-wf",
        "firstExecutionRunId": "pipeline-run",
    }
    assert len(seen) == 1
    assert seen[0].workflow is JobPipelineWorkflow
    (payload,) = seen[0].args
    assert payload == JobPipelineWorkflowInput(
        tenant_id="local",
        expected_app_dir="/tmp/jobhunter",
        expected_db_path="/tmp/jobhunter/jobhunter.db",
        stages=["score", "tailor"],
        min_score=8,
        workers=2,
        limit=5,
        validation_mode="strict",
        dry_run=True,
        rescore=True,
        retailor=True,
    )


def test_profile_import_remains_sync_local_action(tmp_db: Path, monkeypatch) -> None:
    captured: list[LocalActionRequest] = []
    started_workflows: list[WorkflowStartSpec] = []

    def fake_run(request: LocalActionRequest) -> LocalActionResult:
        captured.append(request)
        return LocalActionResult(
            ok=True,
            action_id="act-profile",
            stage=request.stage,
            status="succeeded",
            started_at="t0",
            finished_at="t1",
            duration_ms=1,
            result={"draft": {}},
        )

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        started_workflows.append(spec)
        return _StubHandle("unexpected-wf")

    monkeypatch.setattr(handlers_mod, "run_local_action", fake_run)
    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)

    response = server.dispatch(
        JsonRpcRequest(
            method="profile_import",
            params={"tenantId": "local", "pdfPath": "/tmp/resume.pdf"},
            id=1,
        )
    )
    assert response is not None
    body = response.to_dict()
    assert body["result"]["ok"] is True
    assert captured[0].stage == "profile_import"
    assert captured[0].pdf_path == "/tmp/resume.pdf"
    assert started_workflows == []


def test_profile_import_requires_pdf_path(tmp_db: Path) -> None:
    server = _server()
    response = server.dispatch(JsonRpcRequest(method="profile_import", params={"tenantId": "local"}, id=1))
    assert response is not None
    assert response.to_dict()["error"]["code"] == INVALID_PARAMS
