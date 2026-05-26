"""Default JSON-RPC handler registry — wires methods to actions/state."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

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
from jobhunter.materials import activities as materials_activities_mod
from jobhunter.materials.activities import TailorActivityInput, tailor_activity
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobhunter.pipeline import workflow as workflow_mod
from jobhunter.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
from jobhunter.scoring import activities as scoring_activities_mod
from jobhunter.scoring.activities import ScoreActivityInput, score_activity


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
        "rescore_job",
        "rescore_jobs_not_on_current_scoring_policy",
        "retailor_job",
        "retailor_current_policy",
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
                "tailorModels": ["local:draft-a", "openai:draft-b"],
                "tailorJudgeModel": "gemini:judge-c",
                "tailorJudgeMinScore": 0.9,
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
        tailor_models=("local:draft-a", "openai:draft-b"),
        tailor_judge_model="gemini:judge-c",
        tailor_judge_min_score=0.9,
        llm_model=DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    )


def test_run_stage_preserves_omitted_tailor_judge_threshold(tmp_db: Path) -> None:
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
                "stage": "tailor",
                "stages": ["tailor"],
                "tailorModels": ["local:draft-a"],
                "tailorJudgeModel": "gemini:judge-c",
            },
            id=1,
        )
    )

    assert response is not None
    assert len(seen) == 1
    (payload,) = seen[0].args
    assert payload.tailor_judge_min_score is None


@pytest.mark.parametrize(
    ("method", "params", "expected_payload"),
    [
        (
            "rescore_job",
            {
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobhunter",
                "expectedDbPath": "/tmp/jobhunter/jobhunter.db",
                "jobUrl": "https://example.com/job/score",
                "dryRun": True,
            },
            {
                "stages": ["score"],
                "limit": 1,
                "rescore": True,
                "retailor": False,
                "job_url": "https://example.com/job/score",
                "dry_run": True,
            },
        ),
        (
            "rescore_jobs_not_on_current_scoring_policy",
            {
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobhunter",
                "expectedDbPath": "/tmp/jobhunter/jobhunter.db",
                "limit": 10,
                "jobUrls": [
                    "https://example.com/job/score-a",
                    "https://example.com/job/score-b",
                ],
                "dryRun": False,
            },
            {
                "stages": ["score"],
                "limit": 10,
                "rescore": True,
                "retailor": False,
                "job_url": None,
                "job_urls": (
                    "https://example.com/job/score-a",
                    "https://example.com/job/score-b",
                ),
                "score_current_policy_only": True,
                "dry_run": False,
            },
        ),
        (
            "retailor_job",
            {
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobhunter",
                "expectedDbPath": "/tmp/jobhunter/jobhunter.db",
                "jobUrl": "https://example.com/job/tailor",
                "dryRun": True,
                "suppressExistingArtifacts": False,
                "tailorModels": ["local:draft-a"],
                "tailorJudgeModel": "gemini:judge-c",
                "tailorJudgeMinScore": 0.9,
            },
            {
                "stages": ["tailor"],
                "limit": 1,
                "rescore": False,
                "retailor": True,
                "job_url": "https://example.com/job/tailor",
                "dry_run": True,
                "suppress_existing_artifacts": False,
                "tailor_models": ("local:draft-a",),
                "tailor_judge_model": "gemini:judge-c",
                "tailor_judge_min_score": 0.9,
            },
        ),
        (
            "retailor_current_policy",
            {
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobhunter",
                "expectedDbPath": "/tmp/jobhunter/jobhunter.db",
                "limit": 5,
                "jobUrls": [
                    "https://example.com/job/tailor-a",
                    "https://example.com/job/tailor-b",
                ],
                "dryRun": False,
                "suppressExistingArtifacts": True,
            },
            {
                "stages": ["tailor"],
                "limit": 5,
                "rescore": False,
                "retailor": True,
                "job_url": None,
                "job_urls": (
                    "https://example.com/job/tailor-a",
                    "https://example.com/job/tailor-b",
                ),
                "tailor_current_policy_only": True,
                "dry_run": False,
                "suppress_existing_artifacts": True,
            },
        ),
    ],
)
def test_current_policy_maintenance_methods_start_pipeline_workflows(
    tmp_db: Path,
    method: str,
    params: dict[str, object],
    expected_payload: dict[str, object],
) -> None:
    seen: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        seen.append(spec)
        return _StubHandle("maintenance-wf", "maintenance-run")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)

    response = server.dispatch(JsonRpcRequest(method=method, params=params, id=1))

    assert response is not None
    body = response.to_dict()
    assert body["result"] == {
        "runId": "maintenance-wf",
        "workflowId": "maintenance-wf",
        "firstExecutionRunId": "maintenance-run",
    }
    assert len(seen) == 1
    assert seen[0].workflow is JobPipelineWorkflow
    (payload,) = seen[0].args
    assert isinstance(payload, JobPipelineWorkflowInput)
    for name, value in expected_payload.items():
        assert getattr(payload, name) == value
    assert payload.tenant_id == "local"
    assert payload.expected_app_dir == "/tmp/jobhunter"
    assert payload.expected_db_path == "/tmp/jobhunter/jobhunter.db"


@pytest.mark.asyncio
async def test_pipeline_workflow_preserves_selected_job_urls_in_activity_inputs(monkeypatch) -> None:
    captured: list[tuple[object, object]] = []

    async def fake_execute_activity(activity_fn, payload, **_kwargs):
        captured.append((activity_fn, payload))
        return {
            "status": "ok",
            "elapsed": 0.0,
            "errors": {},
            "stages": [{"stage": "_", "status": "ok", "elapsed": 0.0}],
        }

    monkeypatch.setattr(workflow_mod.workflow, "execute_activity", fake_execute_activity)

    await workflow_mod._execute_stage(
        "score",
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["score"],
            job_url="https://example.com/job/score-one",
            rescore=True,
        ),
    )
    await workflow_mod._execute_stage(
        "score",
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["score"],
            job_urls=(
                "https://example.com/job/score-a",
                "https://example.com/job/score-b",
            ),
            rescore=True,
        ),
    )
    await workflow_mod._execute_stage(
        "tailor",
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["tailor"],
            job_url="https://example.com/job/tailor-one",
            retailor=True,
            suppress_existing_artifacts=False,
        ),
    )
    await workflow_mod._execute_stage(
        "tailor",
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["tailor"],
            job_urls=(
                "https://example.com/job/tailor-a",
                "https://example.com/job/tailor-b",
            ),
            retailor=True,
            suppress_existing_artifacts=True,
        ),
    )

    assert len(captured) == 4
    assert captured[0][0] is score_activity
    assert isinstance(captured[0][1], ScoreActivityInput)
    assert captured[0][1].job_urls == ("https://example.com/job/score-one",)
    assert captured[1][0] is score_activity
    assert isinstance(captured[1][1], ScoreActivityInput)
    assert captured[1][1].job_urls == (
        "https://example.com/job/score-a",
        "https://example.com/job/score-b",
    )
    assert captured[2][0] is tailor_activity
    assert isinstance(captured[2][1], TailorActivityInput)
    assert captured[2][1].job_urls == ("https://example.com/job/tailor-one",)
    assert captured[2][1].suppress_existing_artifacts is False
    assert captured[3][0] is tailor_activity
    assert isinstance(captured[3][1], TailorActivityInput)
    assert captured[3][1].job_urls == (
        "https://example.com/job/tailor-a",
        "https://example.com/job/tailor-b",
    )
    assert captured[3][1].suppress_existing_artifacts is True


def test_selected_score_activity_runs_only_requested_urls(monkeypatch) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    def fake_score_job_by_url(url: str, **kwargs: object) -> SimpleNamespace:
        calls.append((url, kwargs))
        return SimpleNamespace(ok=True, error=None)

    monkeypatch.setattr("jobhunter.scoring.scorer.score_job_by_url", fake_score_job_by_url)

    result = scoring_activities_mod._run_selected_scores(
        ScoreActivityInput(
            tenant_id="local",
            job_urls=(
                "https://example.com/job/score-a",
                "https://example.com/job/score-b",
                "https://example.com/job/score-a",
            ),
            limit=2,
            rescore=True,
            llm_model="local:score",
        )
    )

    assert [url for url, _kwargs in calls] == [
        "https://example.com/job/score-a",
        "https://example.com/job/score-b",
    ]
    assert all(call_kwargs["rescore"] is True for _url, call_kwargs in calls)
    assert all(call_kwargs["llm_model"] == "local:score" for _url, call_kwargs in calls)
    assert result["errors"] == {}
    assert result["stages"][0]["selected"] == 2
    assert result["stages"][0]["scored"] == 2


def test_current_policy_score_activity_skips_current_policy_scores(
    tmp_db: Path,
    monkeypatch,
) -> None:
    conn = get_connection(tmp_db)
    _seed_scoring_policy(conn, version=2)
    current_url = "https://example.com/job/current-score"
    outdated_url = "https://example.com/job/outdated-score"
    corrected_url = "https://example.com/job/corrected-score"
    missing_url = "https://example.com/job/missing-score"
    for url in (current_url, outdated_url, corrected_url, missing_url):
        _seed_enriched_job(conn, url)
    _seed_score(conn, current_url, policy_version=2)
    _seed_score(conn, outdated_url, policy_version=1)
    _seed_score(conn, corrected_url, policy_version=1, correction={"fit_score": 9})

    calls: list[str] = []

    def fake_score_job_by_url(url: str, **_kwargs: object) -> SimpleNamespace:
        calls.append(url)
        return SimpleNamespace(ok=True, error=None)

    monkeypatch.setattr("jobhunter.database.get_connection", lambda: get_connection(tmp_db))
    monkeypatch.setattr("jobhunter.scoring.scorer.score_job_by_url", fake_score_job_by_url)

    result = scoring_activities_mod._run_current_policy_scores(
        ScoreActivityInput(
            tenant_id="local",
            limit=10,
            rescore=True,
            current_policy_only=True,
        )
    )

    assert set(calls) == {missing_url, outdated_url}
    assert result["stages"][0]["selected"] == 2
    assert result["stages"][0]["scored"] == 2

    calls.clear()
    result = scoring_activities_mod._run_current_policy_scores(
        ScoreActivityInput(
            tenant_id="local",
            limit=10,
            rescore=True,
            job_urls=(current_url, outdated_url, corrected_url),
            current_policy_only=True,
        )
    )

    assert calls == [outdated_url]
    assert result["stages"][0]["selected"] == 1


def test_selected_tailor_activity_runs_only_requested_urls(monkeypatch) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    def fake_tailor_job_by_url(url: str, **kwargs: object) -> dict[str, object]:
        calls.append((url, kwargs))
        return {"status": "approved"}

    monkeypatch.setattr("jobhunter.scoring.tailor.tailor_job_by_url", fake_tailor_job_by_url)

    result = materials_activities_mod._run_selected_tailoring(
        TailorActivityInput(
            tenant_id="local",
            job_urls=(
                "https://example.com/job/tailor-a",
                "https://example.com/job/tailor-b",
                "https://example.com/job/tailor-a",
            ),
            limit=2,
            min_score=8,
            validation_mode="strict",
            retailor=True,
            suppress_existing_artifacts=True,
            tailor_models=("local:tailor",),
            tailor_judge_model="local:judge",
            tailor_judge_min_score=0.9,
            llm_model="local:default",
        )
    )

    assert [url for url, _kwargs in calls] == [
        "https://example.com/job/tailor-a",
        "https://example.com/job/tailor-b",
    ]
    assert all(call_kwargs["retailor"] is True for _url, call_kwargs in calls)
    assert all(call_kwargs["suppress_existing_artifacts"] is True for _url, call_kwargs in calls)
    assert all(call_kwargs["min_score"] == 8 for _url, call_kwargs in calls)
    assert all(call_kwargs["tailor_models"] == ("local:tailor",) for _url, call_kwargs in calls)
    assert result["errors"] == {}
    assert result["stages"][0]["selected"] == 2
    assert result["stages"][0]["approved"] == 2


def test_current_policy_tailor_activity_skips_current_policy_artifacts(
    tmp_db: Path,
    monkeypatch,
) -> None:
    conn = get_connection(tmp_db)
    _seed_tailoring_policy(conn, version=2)
    current_url = "https://example.com/job/current-tailor"
    outdated_url = "https://example.com/job/outdated-tailor"
    missing_url = "https://example.com/job/missing-tailor"
    for url in (current_url, outdated_url, missing_url):
        _seed_enriched_job(conn, url)
        _seed_score(conn, url, policy_version=2, fit_score=9)
    _seed_tailored_artifact(conn, current_url, policy_version=2)
    _seed_tailored_artifact(conn, outdated_url, policy_version=1)

    calls: list[tuple[str, dict[str, object]]] = []

    def fake_tailor_job_by_url(url: str, **kwargs: object) -> dict[str, object]:
        calls.append((url, kwargs))
        return {"status": "approved"}

    monkeypatch.setattr("jobhunter.database.get_connection", lambda: get_connection(tmp_db))
    monkeypatch.setattr("jobhunter.scoring.tailor.tailor_job_by_url", fake_tailor_job_by_url)

    result = materials_activities_mod._run_current_policy_tailoring(
        TailorActivityInput(
            tenant_id="local",
            min_score=7,
            limit=10,
            retailor=True,
            current_policy_only=True,
            suppress_existing_artifacts=True,
        )
    )

    assert {url for url, _kwargs in calls} == {missing_url, outdated_url}
    assert all(kwargs["suppress_existing_artifacts"] is True for _url, kwargs in calls)
    assert result["stages"][0]["selected"] == 2
    assert result["stages"][0]["approved"] == 2

    calls.clear()
    result = materials_activities_mod._run_current_policy_tailoring(
        TailorActivityInput(
            tenant_id="local",
            min_score=7,
            limit=10,
            retailor=True,
            job_urls=(current_url, outdated_url),
            current_policy_only=True,
            suppress_existing_artifacts=False,
        )
    )

    assert [url for url, _kwargs in calls] == [outdated_url]
    assert calls[0][1]["suppress_existing_artifacts"] is False
    assert result["stages"][0]["selected"] == 1


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


def _seed_enriched_job(conn, url: str) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, full_description, discovered_at) VALUES (?, ?, ?, ?)",
        (url, "Test job", "Full description", "2026-05-26T10:00:00+00:00"),
    )
    conn.commit()


def _seed_scoring_policy(conn, *, version: int) -> None:
    conn.execute(
        """
        INSERT INTO scoring_policies (tenant_id, version, rubric_json, anchors_json, created_at)
        VALUES ('local', ?, '{}', '[]', '2026-05-26T10:00:00+00:00')
        """,
        (version,),
    )
    conn.commit()


def _seed_tailoring_policy(conn, *, version: int) -> None:
    conn.execute(
        """
        INSERT INTO tailoring_policies (
            tenant_id, version, prompt_version, schema_version, judge_schema_version,
            prompt_fingerprint, config_fingerprint, profile_policy_fingerprint,
            custom_prompt_fingerprint, generator_settings_json, judge_settings_json,
            runtime_settings_json, rollback_of_version, rollback_reason, created_at,
            created_from_event_id
        ) VALUES ('local', ?, 'prompt-v1', 'schema-v1', 'judge-v1',
            'prompt-fp', 'config-fp', 'profile-fp', 'custom-fp',
            '{}', '{}', '{}', NULL, '', '2026-05-26T10:00:00+00:00', NULL)
        """,
        (version,),
    )
    conn.commit()


def _seed_score(
    conn,
    url: str,
    *,
    policy_version: int,
    fit_score: int = 8,
    correction: dict[str, object] | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (
            job_url, version, tenant_id, fit_score, breakdown_json, keywords_json,
            scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, 1, 'local', ?, ?, '[]', '2026-05-26T10:00:00+00:00',
            ?, '{}', ?)
        """,
        (
            url,
            fit_score,
            json.dumps({"reasoning": "ok", "eligibility": {"status": "eligible", "hard_blockers": []}}),
            json.dumps(correction) if correction is not None else None,
            json.dumps({"scoring_policy_version": policy_version}),
        ),
    )
    conn.commit()


def _seed_tailored_artifact(conn, url: str, *, policy_version: int) -> None:
    conn.execute(
        """
        INSERT INTO job_materials (
            job_url, generation, tenant_id, status, created_at, updated_at, metadata_json
        ) VALUES (?, 1, 'local', 'resume_approved',
            '2026-05-26T10:00:00+00:00', '2026-05-26T10:00:00+00:00', '{}')
        """,
        (url,),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            job_url, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at, superseded_at
        ) VALUES (?, 1, 'tailored_resume', ?, 'approved', ?, 'text', 12, ?,
            '2026-05-26T10:00:00+00:00', NULL)
        """,
        (
            url,
            f"artifact-{policy_version}-{url.rsplit('/', 1)[-1]}",
            f"/tmp/{url.rsplit('/', 1)[-1]}.txt",
            json.dumps({"tailoring_policy_version": policy_version}),
        ),
    )
    conn.commit()
