"""Default JSON-RPC handler registry — wires methods to actions/state."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from temporalio.common import WorkflowIDConflictPolicy

from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
from jobhunter.domain.compensation import ReportedCompensationObservation
from jobhunter.infrastructure.compensation import refresh as compensation_refresh_mod
from jobhunter.infrastructure.compensation import sqlite_market_repository as market_repository_mod
from jobhunter.infrastructure.compensation.refresh import refresh_compensation_facts
from jobhunter.infrastructure.compensation.workflow import (
    CompensationRefreshWorkflow,
    CompensationRefreshWorkflowInput,
)
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
from jobhunter.materials.activities import CoverActivityInput, TailorActivityInput, cover_activity, tailor_activity
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobhunter.pipeline import workflow as workflow_mod
from jobhunter.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
from jobhunter.preparation.workflow import JobPreparationInput, JobPreparationWorkflow
from jobhunter.profile.workflow import ProfileImportWorkflow, ProfileImportWorkflowInput
from jobhunter.scoring import activities as scoring_activities_mod
from jobhunter.scoring.activities import ScoreActivityInput, score_activity


class _StubHandle:
    def __init__(
        self,
        workflow_id: str,
        run_id: str = "first-run",
        result_payload=None,
    ) -> None:
        self.id = workflow_id
        self.first_execution_run_id = run_id
        self._result_payload = result_payload if result_payload is not None else {"status": "succeeded"}

    async def result(self):
        return self._result_payload


async def _stub_starter(spec):
    return _StubHandle("wf-stub")


async def _stub_canceler(_run_id: str) -> None:  # pragma: no cover — never invoked here
    return None


@pytest.fixture
def tmp_db(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "jobs.db"
    init_db(db_path)
    monkeypatch.setattr(handlers_mod, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(compensation_refresh_mod, "get_connection", lambda: get_connection(db_path))
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
        "cancel_run",
        "run_stage",
        "rescore_job",
        "rescore_jobs_not_on_current_scoring_policy",
        "tailor_job",
        "retailor_job",
        "retailor_current_policy",
        "refresh_compensation",
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


def test_refresh_compensation_ignores_company_metric_money(tmp_db: Path) -> None:
    conn = get_connection(tmp_db)
    selected_url = "https://example.com/jobs/company-metrics"
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, location, salary, description, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            selected_url,
            "Senior Platform Engineer",
            "Moniepoint",
            "Remote Europe",
            "",
            "Synthetic job",
            (
                "Through our subsidiaries, Moniepoint Inc. processes over $250 billion "
                "in digital payment transaction value annually. More than 6 million "
                "businesses run their financial lives through Moniepoint."
            ),
            "2026-06-19T10:00:00Z",
        ),
    )
    conn.commit()

    result = refresh_compensation_facts(
        tenant_id="local",
        job_url=selected_url,
        include_euro_top_tech=False,
    )

    assert result["status"] == "succeeded"

    selected_posted = conn.execute(
        """
        SELECT parse_state, source_field, minimum_amount, maximum_amount
        FROM job_posted_compensation_facts
        WHERE job_url = ?
        """,
        (selected_url,),
    ).fetchone()
    assert selected_posted["parse_state"] == "missing"
    assert selected_posted["source_field"] == "jobs.salary"
    assert selected_posted["minimum_amount"] is None
    assert selected_posted["maximum_amount"] is None


def test_refresh_compensation_does_not_match_ote_inside_words(tmp_db: Path) -> None:
    conn = get_connection(tmp_db)
    selected_url = "https://example.com/jobs/remote-prose"
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, location, salary, description, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            selected_url,
            "Senior Platform Engineer",
            "Acme",
            "Remote Europe",
            "",
            "Synthetic job",
            (
                "Remote-first role for candidates with potential. "
                "Spend up to 30 days per year working from another location."
            ),
            "2026-06-19T10:00:00Z",
        ),
    )
    conn.commit()

    result = refresh_compensation_facts(
        tenant_id="local",
        job_url=selected_url,
        include_euro_top_tech=False,
    )

    assert result["status"] == "succeeded"

    selected_posted = conn.execute(
        """
        SELECT parse_state, source_field, minimum_amount, maximum_amount
        FROM job_posted_compensation_facts
        WHERE job_url = ?
        """,
        (selected_url,),
    ).fetchone()
    assert selected_posted["parse_state"] == "missing"
    assert selected_posted["source_field"] == "jobs.salary"
    assert selected_posted["minimum_amount"] is None
    assert selected_posted["maximum_amount"] is None


def test_refresh_compensation_starts_workflow(tmp_db: Path, tmp_path: Path) -> None:
    observations_path = tmp_path / "reported-comp.json"
    observations_path.write_text("[]", encoding="utf-8")
    started_workflows: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        started_workflows.append(spec)
        return _StubHandle("compensation-wf", "compensation-run")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)
    response = server.dispatch(
        JsonRpcRequest(
            method="refresh_compensation",
            params={
                "tenantId": "local",
                "allJobs": True,
                "expectedAppDir": "/tmp/jobhunter",
                "expectedDbPath": "/tmp/jobhunter/jobhunter.db",
                "observationsJsonPath": str(observations_path),
                "includeEuroTopTech": False,
                "euroTopTechMaxPages": 3,
                "limit": 10,
            },
            id=1,
        )
    )

    assert response is not None
    body = response.to_dict()
    assert body["result"] == {
        "runId": "compensation-wf",
        "workflowId": "compensation-wf",
        "firstExecutionRunId": "compensation-run",
    }
    assert len(started_workflows) == 1
    assert started_workflows[0].workflow is CompensationRefreshWorkflow
    (payload,) = started_workflows[0].args
    assert payload == CompensationRefreshWorkflowInput(
        tenant_id="local",
        expected_app_dir="/tmp/jobhunter",
        expected_db_path="/tmp/jobhunter/jobhunter.db",
        job_url=None,
        limit=10,
        observations_json_path=str(observations_path),
        include_euro_top_tech=False,
        euro_top_tech_max_pages=3,
    )


def test_refresh_compensation_core_updates_one_job(tmp_db: Path, tmp_path: Path) -> None:
    conn = get_connection(tmp_db)
    selected_url = "https://example.com/jobs/platform"
    other_url = "https://example.com/jobs/other"
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, location, salary, description, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            selected_url,
            "Senior Platform Engineer",
            "Acme AI",
            "Remote Europe",
            "",
            "Synthetic job",
            "We build platform tooling. The salary range is €100,000-€130,000/year.",
            "2026-06-19T10:00:00Z",
        ),
    )
    conn.execute(
        "INSERT INTO jobs (url, title, site, location, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            other_url,
            "Staff Platform Engineer",
            "Acme AI",
            "Remote Europe",
            "€90,000-€110,000/year",
            "Synthetic job",
            "2026-06-19T10:00:00Z",
        ),
    )
    conn.commit()

    observations_path = tmp_path / "reported-comp.json"
    observations_path.write_text(
        json.dumps(
            [
                {
                    "sourceId": "levels.fyi",
                    "company": "Acme AI",
                    "role": "Senior Platform Engineer",
                    "totalCompensationMin": 118000,
                    "totalCompensationMax": 142000,
                    "companyTier": "tier_2",
                    "sampleCount": 4,
                },
                {
                    "sourceId": "glassdoor",
                    "company": "Acme AI",
                    "role": "Senior Platform Engineer",
                    "amount": 125000,
                    "companyTier": "tier_2",
                    "sampleCount": 3,
                },
            ]
        ),
        encoding="utf-8",
    )

    result = refresh_compensation_facts(
        tenant_id="local",
        job_url=selected_url,
        observations_json_path=str(observations_path),
        include_euro_top_tech=False,
    )

    assert result["status"] == "succeeded"
    assert result["postedFactsRefreshed"] == 1
    assert result["reportedObservationsLoaded"] == 2
    assert result["estimatesRefreshed"] == 1

    selected_posted = conn.execute(
        """
        SELECT parse_state, source_field, minimum_amount, maximum_amount
        FROM job_posted_compensation_facts
        WHERE job_url = ?
        """,
        (selected_url,),
    ).fetchone()
    other_posted = conn.execute(
        "SELECT parse_state FROM job_posted_compensation_facts WHERE job_url = ?",
        (other_url,),
    ).fetchone()
    estimate = conn.execute(
        "SELECT estimate_state, minimum_amount, maximum_amount FROM job_market_compensation_estimates WHERE job_url = ?",
        (selected_url,),
    ).fetchone()
    assert selected_posted["parse_state"] == "parsed_range"
    assert selected_posted["source_field"] == "jobs.full_description"
    assert selected_posted["minimum_amount"] == 100_000
    assert selected_posted["maximum_amount"] == 130_000
    assert other_posted is None
    assert estimate["estimate_state"] == "estimated_range"
    assert estimate["minimum_amount"] == 118_000
    assert estimate["maximum_amount"] == 142_000


def test_refresh_compensation_core_updates_all_jobs(tmp_db: Path, tmp_path: Path) -> None:
    conn = get_connection(tmp_db)
    first_url = "https://example.com/jobs/platform"
    second_url = "https://example.com/jobs/other"
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, location, salary, description, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            first_url,
            "Senior Platform Engineer",
            "Acme AI",
            "Remote Europe",
            "",
            "Synthetic job",
            "We build platform tooling. The salary range is €100,000-€130,000/year.",
            "2026-06-19T10:00:00Z",
        ),
    )
    conn.execute(
        "INSERT INTO jobs (url, title, site, location, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            second_url,
            "Staff Platform Engineer",
            "Acme AI",
            "Remote Europe",
            "€90,000-€110,000/year",
            "Synthetic job",
            "2026-06-19T10:00:00Z",
        ),
    )
    conn.commit()
    observations_path = tmp_path / "empty-reported-comp.json"
    observations_path.write_text("[]", encoding="utf-8")

    result = refresh_compensation_facts(
        tenant_id="local",
        observations_json_path=str(observations_path),
        include_euro_top_tech=False,
    )

    assert result["status"] == "succeeded"
    assert result["jobUrl"] is None
    assert result["postedFactsRefreshed"] == 2
    assert result["reportedObservationsLoaded"] == 0
    assert result["estimatesRefreshed"] == 2

    posted_rows = conn.execute(
        "SELECT job_url, parse_state FROM job_posted_compensation_facts ORDER BY job_url",
    ).fetchall()
    estimate_rows = conn.execute(
        "SELECT job_url, estimate_state FROM job_market_compensation_estimates ORDER BY job_url",
    ).fetchall()
    assert [row["job_url"] for row in posted_rows] == sorted([first_url, second_url])
    assert [row["parse_state"] for row in posted_rows] == ["parsed_range", "parsed_range"]
    assert [row["job_url"] for row in estimate_rows] == sorted([first_url, second_url])
    assert [row["estimate_state"] for row in estimate_rows] == ["estimated_range", "estimated_range"]


def test_refresh_compensation_without_observations_uses_euro_top_tech_and_updates_market(
    tmp_db: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = get_connection(tmp_db)
    job_url = "https://example.com/jobs/staff-engineer"
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, location, salary, description, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_url,
            "Staff Software Engineer",
            "Acme AI",
            "Barcelona, Spain",
            "",
            "Synthetic job",
            "2026-06-19T10:00:00Z",
        ),
    )
    conn.commit()

    def fake_euro_top_tech_observations(*, max_pages: int = 10, http=None):
        assert max_pages == 10
        return (
            ReportedCompensationObservation(
                source_id="euro_top_tech",
                company_name="Airbnb",
                role_title="Staff Software Engineer",
                minimum_amount=242_000,
                maximum_amount=242_000,
                component="total_compensation",
                location="Barcelona, Spain",
                level_label="Staff / Engineering Manager",
                sample_count=1,
                attribution="Euro Top Tech public crowdsourced compensation data",
            ),
        )

    monkeypatch.setattr(market_repository_mod, "load_euro_top_tech_observations", fake_euro_top_tech_observations)

    result = refresh_compensation_facts(
        tenant_id="local",
        job_url=job_url,
    )

    assert result["reportedObservationsLoaded"] == 1
    assert result["localReportedObservationsLoaded"] == 0
    assert result["euroTopTechObservationsLoaded"] == 1
    assert result["marketRefreshSkipped"] is False
    estimate = conn.execute(
        """
        SELECT estimate_state, minimum_amount, maximum_amount, component, match_scope, source_snapshot_json
        FROM job_market_compensation_estimates WHERE job_url = ?
        """,
        (job_url,),
    ).fetchone()
    assert estimate["estimate_state"] == "estimated_range"
    assert estimate["minimum_amount"] == 242_000
    assert estimate["maximum_amount"] == 242_000
    assert estimate["component"] == "total_compensation"
    assert estimate["match_scope"] == "same_location_role_fallback"
    assert "euro_top_tech" in estimate["source_snapshot_json"]


def test_refresh_compensation_loads_all_configured_sources_by_default(
    tmp_db: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = get_connection(tmp_db)
    job_url = "https://example.com/jobs/platform"
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, location, salary, description, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_url,
            "Senior Platform Engineer",
            "Acme AI",
            "Remote Europe",
            "",
            "Synthetic job",
            "2026-06-19T10:00:00Z",
        ),
    )
    conn.commit()
    levels_path = tmp_path / "levels.json"
    levels_path.write_text(
        json.dumps(
            [
                {
                    "company": "Acme AI",
                    "role": "Senior Platform Engineer",
                    "totalCompensationMin": 118000,
                    "totalCompensationMax": 142000,
                    "companyTier": "tier_2",
                    "sampleCount": 4,
                }
            ]
        ),
        encoding="utf-8",
    )
    glassdoor_path = tmp_path / "glassdoor.json"
    glassdoor_path.write_text(
        json.dumps(
            [
                {
                    "company": "Acme AI",
                    "role": "Senior Platform Engineer",
                    "amount": 125000,
                    "companyTier": "tier_2",
                    "sampleCount": 3,
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("JOBHUNTER_LEVELS_FYI_ACCESS_MODE", "licensed_data_feed")
    monkeypatch.setenv("JOBHUNTER_LEVELS_FYI_EUROPE_COVERAGE", "true")
    monkeypatch.setenv("JOBHUNTER_LEVELS_FYI_OBSERVATIONS_PATH", str(levels_path))
    monkeypatch.setenv("JOBHUNTER_GLASSDOOR_ACCESS_MODE", "written_permission")
    monkeypatch.setenv("JOBHUNTER_GLASSDOOR_OBSERVATIONS_PATH", str(glassdoor_path))

    def fake_euro_top_tech_observations(*, max_pages: int = 10, http=None):
        return (
            ReportedCompensationObservation(
                source_id="euro_top_tech",
                company_name="Acme AI",
                role_title="Senior Platform Engineer",
                minimum_amount=160_000,
                maximum_amount=160_000,
                component="total_compensation",
                location="Berlin, Germany",
                level_label="Senior",
                company_tier="tier_2_ambitious",
                sample_count=1,
                attribution="Euro Top Tech public crowdsourced compensation data",
            ),
        )

    monkeypatch.setattr(market_repository_mod, "load_euro_top_tech_observations", fake_euro_top_tech_observations)

    result = refresh_compensation_facts(
        tenant_id="local",
        job_url=job_url,
    )

    assert result["reportedObservationsLoaded"] == 3
    assert result["licensedReportedObservationsLoaded"] == 2
    assert result["levelsFyiObservationsLoaded"] == 1
    assert result["glassdoorObservationsLoaded"] == 1
    assert result["euroTopTechObservationsLoaded"] == 1
    estimate = conn.execute(
        """
        SELECT minimum_amount, maximum_amount, source_snapshot_json
        FROM job_market_compensation_estimates WHERE job_url = ?
        """,
        (job_url,),
    ).fetchone()
    assert estimate["minimum_amount"] == 118_000
    assert estimate["maximum_amount"] == 160_000
    source_ids = {item["source_id"] for item in json.loads(estimate["source_snapshot_json"])}
    assert source_ids == {"levels_fyi", "glassdoor", "euro_top_tech"}


def test_missing_required_param_returns_invalid_params(tmp_db: Path) -> None:
    server = _server()
    response = server.dispatch(
        JsonRpcRequest(
            method="profile_import",
            params={"tenantId": "local"},  # missing pdfPath
            id=1,
        )
    )
    assert response is not None
    body = response.to_dict()
    assert body["error"]["code"] == INVALID_PARAMS


def test_missing_tenant_id_falls_back_to_local(tmp_db: Path, caplog) -> None:
    _seed_job(tmp_db)
    started_workflows: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        started_workflows.append(spec)
        return _StubHandle("compensation-wf", "compensation-run")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)
    with caplog.at_level("WARNING"):
        response = server.dispatch(
            JsonRpcRequest(method="refresh_compensation", params={"allJobs": True}, id=1)
        )
    assert response is not None
    assert "tenantid" in caplog.text.lower() or "local_tenant" in caplog.text.lower()
    assert started_workflows
    (payload,) = started_workflows[0].args
    assert payload.tenant_id == "local"


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
                "jobUrls": [
                    "https://example.com/job/score-a",
                    "https://example.com/job/score-b",
                ],
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
        job_urls=(
            "https://example.com/job/score-a",
            "https://example.com/job/score-b",
        ),
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


def test_run_stage_preserves_selected_discovery_source_ids(tmp_db: Path) -> None:
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
                "stage": "discover",
                "stages": ["discover"],
                "limit": 25,
                "sourceIds": ["jobspy:linkedin"],
            },
            id=1,
        )
    )

    assert response is not None
    assert len(seen) == 1
    assert seen[0].workflow is DiscoverWorkflow
    assert seen[0].workflow_id == "discover-local"
    (payload,) = seen[0].args
    assert payload == DiscoverWorkflowInput(
        tenant_id="local",
        expected_app_dir="/tmp/jobhunter",
        expected_db_path="/tmp/jobhunter/jobhunter.db",
        limit=25,
        source_ids=("jobspy:linkedin",),
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
                "steps": ["score"],
                "rescore": True,
                "job_url": "https://example.com/job/score",
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
            "tailor_job",
            {
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobhunter",
                "expectedDbPath": "/tmp/jobhunter/jobhunter.db",
                "jobUrl": "https://example.com/job/tailor",
                "dryRun": True,
                "allowLowFitOverride": True,
                "tailorModels": ["local:draft-a"],
                "tailorJudgeModel": "gemini:judge-c",
                "tailorJudgeMinScore": 0.9,
            },
            {
                "steps": ["tailor", "cover", "pdf"],
                "retailor": False,
                "job_url": "https://example.com/job/tailor",
                "allow_low_fit_override": True,
                "tailor_models": ("local:draft-a",),
                "tailor_judge_model": "gemini:judge-c",
                "tailor_judge_min_score": 0.9,
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
                "steps": ["tailor", "cover", "pdf"],
                "retailor": True,
                "job_url": "https://example.com/job/tailor",
                "suppress_existing_artifacts": False,
                "tailor_models": ("local:draft-a",),
                "tailor_judge_model": "gemini:judge-c",
                "tailor_judge_min_score": 0.9,
            },
        ),
        (
            "retailor_job",
            {
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobhunter",
                "expectedDbPath": "/tmp/jobhunter/jobhunter.db",
                "jobUrl": "https://example.com/job/tailor",
            },
            {
                "steps": ["tailor", "cover", "pdf"],
                "retailor": True,
                "job_url": "https://example.com/job/tailor",
                "suppress_existing_artifacts": False,
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
                "stages": ["tailor", "cover"],
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
        (
            "retailor_current_policy",
            {
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobhunter",
                "expectedDbPath": "/tmp/jobhunter/jobhunter.db",
                "limit": 5,
                "jobUrls": ["https://example.com/job/tailor-a"],
            },
            {
                "stages": ["tailor", "cover"],
                "limit": 5,
                "rescore": False,
                "retailor": True,
                "job_url": None,
                "job_urls": ("https://example.com/job/tailor-a",),
                "tailor_current_policy_only": True,
                "dry_run": False,
                "suppress_existing_artifacts": False,
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
    (payload,) = seen[0].args
    if method in {"rescore_job", "tailor_job", "retailor_job"}:
        assert seen[0].workflow is JobPreparationWorkflow
        assert isinstance(payload, JobPreparationInput)
        assert seen[0].workflow_id == f"prep-{payload.idempotency_key}"
    else:
        assert seen[0].workflow is JobPipelineWorkflow
        assert isinstance(payload, JobPipelineWorkflowInput)
        assert payload.expected_app_dir == "/tmp/jobhunter"
        assert payload.expected_db_path == "/tmp/jobhunter/jobhunter.db"
    for name, value in expected_payload.items():
        assert getattr(payload, name) == value
    assert payload.tenant_id == "local"


def test_retailor_job_duplicate_dispatch_uses_existing_workflow_without_duplicate_artifacts(
    tmp_db: Path,
) -> None:
    conn = get_connection(tmp_db)
    job_url = "https://example.com/job/retailor-idempotent"
    _seed_job(tmp_db, job_url)
    _seed_tailoring_policy(conn, version=3)
    _seed_tailored_artifact(conn, job_url, policy_version=3)
    before = conn.execute(
        "SELECT COUNT(*), COUNT(DISTINCT artifact_id) FROM job_materials_artifacts WHERE job_url = ?",
        (job_url,),
    ).fetchone()
    seen: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        seen.append(spec)
        return _StubHandle(spec.workflow_id or "prep-missing", "prep-run")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)
    request = JsonRpcRequest(
        method="retailor_job",
        params={
            "tenantId": "local",
            "expectedAppDir": "/tmp/jobhunter",
            "expectedDbPath": "/tmp/jobhunter/jobhunter.db",
            "jobUrl": job_url,
            "dryRun": False,
        },
        id=1,
    )

    first = server.dispatch(request)
    second = server.dispatch(request)

    assert first is not None
    assert second is not None
    assert len(seen) == 2
    assert seen[0].workflow is JobPreparationWorkflow
    assert seen[1].workflow is JobPreparationWorkflow
    assert seen[0].workflow_id == seen[1].workflow_id
    assert seen[0].id_conflict_policy is WorkflowIDConflictPolicy.USE_EXISTING
    assert seen[1].id_conflict_policy is WorkflowIDConflictPolicy.USE_EXISTING
    after = conn.execute(
        "SELECT COUNT(*), COUNT(DISTINCT artifact_id) FROM job_materials_artifacts WHERE job_url = ?",
        (job_url,),
    ).fetchone()
    assert tuple(before) == (1, 1)
    assert tuple(after) == tuple(before)


@pytest.mark.asyncio
async def test_pipeline_workflow_preserves_selected_job_urls_in_activity_inputs(monkeypatch) -> None:
    captured: list[tuple[object, object]] = []
    child_workflows: list[tuple[object, object, dict[str, object]]] = []

    async def fake_execute_activity(activity_fn, payload, **_kwargs):
        captured.append((activity_fn, payload))
        return {
            "status": "ok",
            "elapsed": 0.0,
            "errors": {},
            "stages": [{"stage": "_", "status": "ok", "elapsed": 0.0}],
        }

    async def fake_execute_child_workflow(workflow_fn, payload, **kwargs):
        child_workflows.append((workflow_fn, payload, kwargs))
        return {"status": "ok"}

    monkeypatch.setattr(workflow_mod.workflow, "execute_activity", fake_execute_activity)
    monkeypatch.setattr(workflow_mod.workflow, "execute_child_workflow", fake_execute_child_workflow)
    monkeypatch.setattr(workflow_mod.workflow, "info", lambda: SimpleNamespace(workflow_id="unit-test-workflow"))

    await workflow_mod._execute_stage(
        "discover",
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["discover"],
            source_ids=("jobspy:linkedin",),
        ),
    )
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
    await workflow_mod._execute_stage(
        "cover",
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["cover"],
            job_url="https://example.com/job/cover-one",
        ),
    )

    assert len(child_workflows) == 1
    assert child_workflows[0][0] is DiscoverWorkflow.run
    assert isinstance(child_workflows[0][1], DiscoverWorkflowInput)
    assert child_workflows[0][1].source_ids == ("jobspy:linkedin",)
    assert child_workflows[0][2]["id"] == "unit-test-workflow-discover"
    assert len(captured) == 5
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
    assert captured[4][0] is cover_activity
    assert isinstance(captured[4][1], CoverActivityInput)
    assert captured[4][1].job_urls == ("https://example.com/job/cover-one",)


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


def test_selected_score_activity_uses_requested_workers(monkeypatch) -> None:
    calls: list[str] = []
    submitted: list[str] = []
    executor_workers: list[int] = []

    class FakeFuture:
        def __init__(self, result: object) -> None:
            self._result = result

        def result(self) -> object:
            return self._result

    class RecordingExecutor:
        def __init__(self, max_workers: int) -> None:
            executor_workers.append(max_workers)

        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def submit(self, fn, url: str):  # noqa: ANN001 - test double mirrors concurrent.futures
            submitted.append(url)
            return FakeFuture(fn(url))

    def fake_score_job_by_url(url: str, **_kwargs: object) -> SimpleNamespace:
        calls.append(url)
        return SimpleNamespace(ok=True, error=None)

    monkeypatch.setattr("jobhunter.scoring.scorer.score_job_by_url", fake_score_job_by_url)
    monkeypatch.setattr(scoring_activities_mod, "ThreadPoolExecutor", RecordingExecutor)
    monkeypatch.setattr(scoring_activities_mod, "as_completed", lambda futures: futures)

    result = scoring_activities_mod._run_selected_scores(
        ScoreActivityInput(
            tenant_id="local",
            job_urls=(
                "https://example.com/job/score-a",
                "https://example.com/job/score-b",
                "https://example.com/job/score-c",
            ),
            workers=3,
            llm_model="local:score",
        )
    )

    assert executor_workers == [3]
    assert submitted == [
        "https://example.com/job/score-a",
        "https://example.com/job/score-b",
        "https://example.com/job/score-c",
    ]
    assert calls == submitted
    assert result["errors"] == {}
    assert result["stages"][0]["selected"] == 3
    assert result["stages"][0]["scored"] == 3


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
    assert result["stages"][0]["selectedJobUrls"] == [
        "https://example.com/job/tailor-a",
        "https://example.com/job/tailor-b",
    ]
    assert result["stages"][0]["approvedJobUrls"] == [
        "https://example.com/job/tailor-a",
        "https://example.com/job/tailor-b",
    ]


def test_current_policy_tailor_activity_skips_current_policy_artifacts(
    tmp_db: Path,
    monkeypatch,
) -> None:
    conn = get_connection(tmp_db)
    _seed_tailoring_policy(conn, version=2)
    current_url = "https://example.com/job/current-tailor"
    outdated_url = "https://example.com/job/outdated-tailor"
    missing_url = "https://example.com/job/missing-tailor"
    low_fit_url = "https://example.com/job/low-fit-tailor"
    for url in (current_url, outdated_url, missing_url):
        _seed_enriched_job(conn, url)
        _seed_score(conn, url, policy_version=2, fit_score=9)
    _seed_enriched_job(conn, low_fit_url)
    _seed_score(conn, low_fit_url, policy_version=2, fit_score=5)
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
            min_score=5,
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
    assert set(result["stages"][0]["approvedJobUrls"]) == {missing_url, outdated_url}

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


def test_profile_import_starts_workflow_and_can_return_draft(tmp_db: Path) -> None:
    started_workflows: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        started_workflows.append(spec)
        return _StubHandle(
            "profile-wf",
            "profile-run",
            result_payload={
                "status": "succeeded",
                "draft": {
                    "profile": {"personal": {"full_name": "Imported Candidate"}},
                    "style": {"font_family": "imported"},
                    "templateText": "\\documentclass{article}",
                    "source": {"filename": "resume.pdf"},
                },
            },
        )

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)

    response = server.dispatch(
        JsonRpcRequest(
            method="profile_import",
            params={"tenantId": "local", "pdfPath": "/tmp/resume.pdf", "awaitResult": True},
            id=1,
        )
    )
    assert response is not None
    body = response.to_dict()
    assert body["result"] == {
        "runId": "profile-wf",
        "workflowId": "profile-wf",
        "firstExecutionRunId": "profile-run",
        "result": {
            "status": "succeeded",
            "draft": {
                "profile": {"personal": {"full_name": "Imported Candidate"}},
                "style": {"font_family": "imported"},
                "templateText": "\\documentclass{article}",
                "source": {"filename": "resume.pdf"},
            },
        },
    }
    assert len(started_workflows) == 1
    assert started_workflows[0].workflow is ProfileImportWorkflow
    (payload,) = started_workflows[0].args
    assert payload == ProfileImportWorkflowInput(
        tenant_id="local",
        pdf_path="/tmp/resume.pdf",
        expected_app_dir=None,
        expected_db_path=None,
        import_profile=True,
        import_style=True,
    )


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
