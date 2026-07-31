"""Default JSON-RPC handler registry — wires methods to actions/state."""

from __future__ import annotations

import json
import uuid
from dataclasses import fields
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from temporalio.common import WorkflowIDConflictPolicy

from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
from jobctrl.domain.compensation import ReportedCompensationObservation
from jobctrl.domain.interview import INTERVIEW_PREP_ITEM_KINDS, INTERVIEW_PREP_STATUSES
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.compensation import refresh as compensation_refresh_mod
from jobctrl.infrastructure.compensation import sqlite_market_repository as market_repository_mod
from jobctrl.infrastructure.compensation.refresh import refresh_compensation_facts
from jobctrl.infrastructure.compensation.workflow import (
    CompensationRefreshWorkflow,
    CompensationRefreshWorkflowInput,
)
from jobctrl.domain.rpc.messages import (
    INVALID_PARAMS,
    METHOD_NOT_FOUND,
    JsonRpcRequest,
    WorkflowStartSpec,
)
from jobctrl.infrastructure.rpc import handlers as handlers_mod
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer
from jobctrl.interview.workflow import InterviewPrepWorkflow, InterviewPrepWorkflowInput
from jobctrl.materials import activities as materials_activities_mod
from jobctrl.materials.activities import CoverActivityInput, TailorActivityInput, cover_activity, tailor_activity
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctrl.pipeline import workflow as workflow_mod
from jobctrl.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
from jobctrl.preparation.workflow import JobPreparationInput, JobPreparationWorkflow
from jobctrl.profile.workflow import ProfileImportWorkflow, ProfileImportWorkflowInput
from jobctrl.scoring import activities as scoring_activities_mod
from jobctrl.scoring.activities import ScoreActivityInput, score_activity


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


def _test_job_id(url: str) -> JobId:
    return JobId(str(uuid.uuid5(uuid.NAMESPACE_URL, url)))


def _seed_job(db_path: Path, url: str = "https://example.com/job/1") -> None:
    conn = get_connection(db_path)
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at) VALUES (?, ?, ?, ?, datetime('now'))",
        ("local", _test_job_id(url), url, "Test job"),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Registry / unknown method
# ---------------------------------------------------------------------------


def test_default_handlers_are_registered(monkeypatch) -> None:
    from jobctrl.infrastructure.llm import model_catalog

    monkeypatch.setattr(model_catalog, "provider_model_catalog", lambda: {"providers": []})
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
        "generate_interview_prep",
        "apply",
        "profile_import",
        "provider_status",
        "provider_models",
        "provider_verify",
    }
    # Force dispatch on each method name with deliberately invalid params
    # — we only care that the response is NOT METHOD_NOT_FOUND.
    for method in methods:
        response = server.dispatch(JsonRpcRequest(method=method, id=1))
        assert response is not None
        body = response.to_dict()
        assert "error" not in body or body["error"]["code"] != METHOD_NOT_FOUND


def test_provider_status_and_verify_are_secret_free(monkeypatch) -> None:
    from jobctrl.infrastructure import setup_probes

    monkeypatch.setattr(
        setup_probes,
        "provider_status_snapshot",
        lambda provider: {
            "provider": provider,
            "configured": provider == "codex",
            "ready": provider == "codex",
            "mode": "cli_auth" if provider == "codex" else None,
            "message": "ready" if provider == "codex" else "not configured",
        },
    )
    reuse_and_verify = Mock(
        return_value=(True, "connected", "Codex CLI authentication verified")
    )
    monkeypatch.setattr(setup_probes, "reuse_and_verify_codex_connection", reuse_and_verify)
    server = _server()

    status = server.dispatch(
        JsonRpcRequest(method="provider_status", params={"provider": "codex"}, id=1)
    )
    reuse_and_verify.assert_not_called()
    verify = server.dispatch(
        JsonRpcRequest(method="provider_verify", params={"provider": "codex"}, id=2)
    )

    assert status is not None
    assert status.to_dict()["result"] == {
        "providers": [
            {
                "provider": "codex",
                "configured": True,
                "ready": True,
                "mode": "cli_auth",
                "message": "ready",
            }
        ]
    }
    assert verify is not None
    assert verify.to_dict()["result"] == {
        "provider": "codex",
        "ok": True,
        "status": "connected",
        "message": "Codex CLI authentication verified",
    }
    reuse_and_verify.assert_called_once_with()
    assert "private-token" not in str(verify.to_dict())


def test_provider_verify_rejects_non_codex() -> None:
    server = _server()
    response = server.dispatch(
        JsonRpcRequest(method="provider_verify", params={"provider": "claude"}, id=1)
    )
    assert response is not None
    assert response.to_dict()["error"]["code"] == INVALID_PARAMS


def test_provider_models_dispatches_sanitized_catalog(monkeypatch) -> None:
    from jobctrl.infrastructure import setup_probes
    from jobctrl.infrastructure.llm import model_catalog

    catalog = {
        "providers": [
            {"provider": "codex", "configured": True, "ready": True, "source": "live", "models": []},
            {
                "provider": "claude",
                "configured": True,
                "ready": True,
                "source": "live",
                "models": [],
            },
            {
                "provider": "google",
                "configured": False,
                "ready": False,
                "source": "live",
                "models": [],
                "message": "Provider is not configured.",
            },
        ]
    }
    monkeypatch.setattr(model_catalog, "provider_model_catalog", lambda: catalog)
    import_auth = Mock()
    verify_auth = Mock()
    monkeypatch.setattr(setup_probes, "ensure_jobctrl_codex_auth", import_auth)
    monkeypatch.setattr(setup_probes, "reuse_and_verify_codex_connection", verify_auth)
    server = _server()

    response = server.dispatch(JsonRpcRequest(method="provider_models", params={}, id=3))

    assert response is not None
    assert response.to_dict()["result"] == catalog
    import_auth.assert_not_called()
    verify_auth.assert_not_called()


def test_generate_interview_prep_starts_user_triggered_workflow() -> None:
    seen: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        seen.append(spec)
        return _StubHandle("interview-prep-wf", "interview-prep-run")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)

    response = server.dispatch(
        JsonRpcRequest(
            method="generate_interview_prep",
            params={
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
                "jobUrl": "https://example.com/job/interview",
                "llmModel": "gpt-test",
            },
            id=1,
        )
    )

    assert response is not None
    assert response.to_dict()["result"] == {
        "runId": "interview-prep-wf",
        "workflowId": "interview-prep-wf",
        "firstExecutionRunId": "interview-prep-run",
    }
    assert len(seen) == 1
    assert seen[0].workflow is InterviewPrepWorkflow
    assert seen[0].workflow_id == "interview-prep-local-https://example.com/job/interview"
    (payload,) = seen[0].args
    assert payload == InterviewPrepWorkflowInput(
        tenant_id="local",
        expected_app_dir="/tmp/jobctrl",
        expected_db_path="/tmp/jobctrl/jobctrl.db",
        job_url="https://example.com/job/interview",
        llm_model="gpt-test",
    )


def test_interview_prep_has_no_live_assistance_surface() -> None:
    server = _server()
    handlers = getattr(server, "_handlers")

    assert handlers["generate_interview_prep"].mode == "workflow"
    prep_methods = sorted(method for method in handlers if "interview" in method)
    assert prep_methods == ["generate_interview_prep"]

    public_surface = [
        *handlers,
        *(field.name for field in fields(InterviewPrepWorkflowInput)),
        *INTERVIEW_PREP_STATUSES,
        *INTERVIEW_PREP_ITEM_KINDS,
    ]
    forbidden_tokens = (
        "live",
        "in_session",
        "session",
        "stream",
        "transcript",
        "microphone",
        "websocket",
        "real_time",
        "realtime",
    )
    offenders = [
        value
        for value in public_surface
        for token in forbidden_tokens
        if token in value.lower()
    ]
    assert offenders == []


def test_unknown_method_returns_method_not_found() -> None:
    server = _server()
    response = server.dispatch(JsonRpcRequest(method="does_not_exist", id=1))
    assert response is not None
    assert response.to_dict()["error"]["code"] == METHOD_NOT_FOUND


def test_refresh_compensation_ignores_company_metric_money(tmp_db: Path) -> None:
    conn = get_connection(tmp_db)
    selected_url = "https://example.com/jobs/company-metrics"
    selected_job_id = _test_job_id(selected_url)
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, location, salary, description, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            selected_job_id,
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
        job_id=selected_job_id,
        include_euro_top_tech=False,
    )

    assert result["status"] == "succeeded"

    selected_posted = conn.execute(
        """
        SELECT parse_state, source_field, minimum_amount, maximum_amount
        FROM job_posted_compensation_facts
        WHERE tenant_id = ? AND job_id = ?
        """,
        ("local", selected_job_id),
    ).fetchone()
    assert selected_posted["parse_state"] == "missing"
    assert selected_posted["source_field"] == "jobs.salary"
    assert selected_posted["minimum_amount"] is None
    assert selected_posted["maximum_amount"] is None


def test_refresh_compensation_does_not_match_ote_inside_words(tmp_db: Path) -> None:
    conn = get_connection(tmp_db)
    selected_url = "https://example.com/jobs/remote-prose"
    selected_job_id = _test_job_id(selected_url)
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, location, salary, description, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            selected_job_id,
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
        job_id=selected_job_id,
        include_euro_top_tech=False,
    )

    assert result["status"] == "succeeded"

    selected_posted = conn.execute(
        """
        SELECT parse_state, source_field, minimum_amount, maximum_amount
        FROM job_posted_compensation_facts
        WHERE tenant_id = ? AND job_id = ?
        """,
        ("local", selected_job_id),
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
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
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
        expected_app_dir="/tmp/jobctrl",
        expected_db_path="/tmp/jobctrl/jobctrl.db",
        job_id=None,
        limit=10,
        observations_json_path=str(observations_path),
        include_euro_top_tech=False,
        euro_top_tech_max_pages=3,
    )


def test_refresh_compensation_core_updates_one_job(tmp_db: Path, tmp_path: Path) -> None:
    conn = get_connection(tmp_db)
    selected_url = "https://example.com/jobs/platform"
    other_url = "https://example.com/jobs/other"
    selected_job_id = _test_job_id(selected_url)
    other_job_id = _test_job_id(other_url)
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, location, salary, description, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            selected_job_id,
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
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, location, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "local",
            other_job_id,
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
        job_id=selected_job_id,
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
        WHERE tenant_id = ? AND job_id = ?
        """,
        ("local", selected_job_id),
    ).fetchone()
    other_posted = conn.execute(
        "SELECT parse_state FROM job_posted_compensation_facts WHERE tenant_id = ? AND job_id = ?",
        ("local", other_job_id),
    ).fetchone()
    estimate = conn.execute(
        "SELECT estimate_state, minimum_amount, maximum_amount FROM job_market_compensation_estimates WHERE tenant_id = ? AND job_id = ?",
        ("local", selected_job_id),
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
    first_job_id = _test_job_id(first_url)
    second_job_id = _test_job_id(second_url)
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, location, salary, description, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            first_job_id,
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
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, location, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "local",
            second_job_id,
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
    assert result["postingUrl"] is None
    assert result["postedFactsRefreshed"] == 2
    assert result["reportedObservationsLoaded"] == 0
    assert result["estimatesRefreshed"] == 2

    posted_rows = conn.execute(
        "SELECT job_id, parse_state FROM job_posted_compensation_facts WHERE tenant_id = ? ORDER BY job_id",
        ("local",),
    ).fetchall()
    estimate_rows = conn.execute(
        "SELECT job_id, estimate_state FROM job_market_compensation_estimates WHERE tenant_id = ? ORDER BY job_id",
        ("local",),
    ).fetchall()
    assert {row["job_id"] for row in posted_rows} == {first_job_id, second_job_id}
    assert [row["parse_state"] for row in posted_rows] == ["parsed_range", "parsed_range"]
    assert {row["job_id"] for row in estimate_rows} == {first_job_id, second_job_id}
    assert [row["estimate_state"] for row in estimate_rows] == ["estimated_range", "estimated_range"]


def test_refresh_compensation_without_observations_uses_euro_top_tech_and_updates_market(
    tmp_db: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = get_connection(tmp_db)
    job_url = "https://example.com/jobs/staff-engineer"
    job_id = _test_job_id(job_url)
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site, location, salary, description, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            job_id,
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
                source_provenance="public",
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
        job_id=job_id,
    )

    assert result["reportedObservationsLoaded"] == 1
    assert result["localReportedObservationsLoaded"] == 0
    assert result["euroTopTechObservationsLoaded"] == 1
    assert result["marketRefreshSkipped"] is False
    estimate = conn.execute(
        """
        SELECT estimate_state, minimum_amount, maximum_amount, component, match_scope, source_snapshot_json
        FROM job_market_compensation_estimates WHERE tenant_id = ? AND job_id = ?
        """,
        ("local", job_id),
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
    job_id = _test_job_id(job_url)
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site, location, salary, description, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            job_id,
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
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        json.dumps(
            {
                "compensation_sources": {
                    "levels_fyi": {
                        "enabled": True,
                        "access_mode": "licensed_data_feed",
                        "europe_coverage_confirmed": True,
                    },
                    "glassdoor": {
                        "enabled": True,
                        "access_mode": "written_permission",
                    },
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings_path))
    monkeypatch.setenv("JOBCTRL_LEVELS_FYI_OBSERVATIONS_PATH", str(levels_path))
    monkeypatch.setenv("JOBCTRL_GLASSDOOR_OBSERVATIONS_PATH", str(glassdoor_path))

    def fake_euro_top_tech_observations(*, max_pages: int = 10, http=None):
        return (
            ReportedCompensationObservation(
                source_id="euro_top_tech",
                source_provenance="public",
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
        job_id=job_id,
    )

    assert result["reportedObservationsLoaded"] == 3
    assert result["licensedReportedObservationsLoaded"] == 2
    assert result["levelsFyiObservationsLoaded"] == 1
    assert result["glassdoorObservationsLoaded"] == 1
    assert result["euroTopTechObservationsLoaded"] == 1
    estimate = conn.execute(
        """
        SELECT minimum_amount, maximum_amount, source_snapshot_json
        FROM job_market_compensation_estimates WHERE tenant_id = ? AND job_id = ?
        """,
        ("local", job_id),
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
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
                "stage": "score",
                "stages": ["score", "tailor"],
                "jobIds": [
                    "20000000-0000-4000-8000-000000000001",
                    "20000000-0000-4000-8000-000000000002",
                ],
                "limit": 5,
                "workers": 2,
                "minScore": 8,
                "validationMode": "strict",
                "dryRun": True,
                "rescore": True,
                "retailor": True,
                "tailorModels": ["codex:draft-a", "claude:draft-b"],
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
        expected_app_dir="/tmp/jobctrl",
        expected_db_path="/tmp/jobctrl/jobctrl.db",
        stages=["score", "tailor"],
        job_ids=(
            JobId("20000000-0000-4000-8000-000000000001"),
            JobId("20000000-0000-4000-8000-000000000002"),
        ),
        min_score=8,
        workers=2,
        limit=5,
        validation_mode="strict",
        dry_run=True,
        rescore=True,
        retailor=True,
        tailor_models=("codex:draft-a", "claude:draft-b"),
        tailor_judge_model="gemini:judge-c",
        tailor_judge_min_score=0.9,
        llm_model=DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    )


def test_run_stage_rejects_noncanonical_job_ids() -> None:
    server = _server()

    response = server.dispatch(
        JsonRpcRequest(
            method="run_stage",
            params={
                "tenantId": "local",
                "stage": "score",
                "jobIds": ["https://example.com/jobs/not-an-id"],
            },
            id=1,
        )
    )

    assert response is not None
    assert response.to_dict()["error"]["code"] == INVALID_PARAMS


@pytest.mark.parametrize(
    ("method", "params"),
    [
        ("run_stage", {"stage": "score", "jobUrl": "https://example.com/jobs/legacy"}),
        (
            "rescore_jobs_not_on_current_scoring_policy",
            {"jobUrls": ["https://example.com/jobs/legacy"]},
        ),
        (
            "retailor_current_policy",
            {"jobUrls": ["https://example.com/jobs/legacy"]},
        ),
    ],
)
def test_pipeline_rpc_rejects_legacy_url_selection_fields(
    method: str,
    params: dict[str, object],
) -> None:
    response = _server().dispatch(JsonRpcRequest(method=method, params=params, id=1))

    assert response is not None
    body = response.to_dict()
    assert body["error"]["code"] == INVALID_PARAMS
    assert "jobId or jobIds" in body["error"]["message"]


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
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
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
        expected_app_dir="/tmp/jobctrl",
        expected_db_path="/tmp/jobctrl/jobctrl.db",
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
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
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
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
                "jobId": "20000000-0000-4000-8000-000000000001",
                "dryRun": True,
            },
            {
                "steps": ["score"],
                "rescore": True,
                "job_id": JobId("20000000-0000-4000-8000-000000000001"),
            },
        ),
        (
            "rescore_jobs_not_on_current_scoring_policy",
            {
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
                "limit": 10,
                "jobIds": [
                    "20000000-0000-4000-8000-000000000003",
                    "20000000-0000-4000-8000-000000000004",
                ],
                "dryRun": False,
            },
            {
                "stages": ["score"],
                "limit": 10,
                "rescore": True,
                "retailor": False,
                "job_id": None,
                "job_ids": (
                    JobId("20000000-0000-4000-8000-000000000003"),
                    JobId("20000000-0000-4000-8000-000000000004"),
                ),
                "score_current_policy_only": True,
                "dry_run": False,
            },
        ),
        (
            "tailor_job",
            {
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
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
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
                "jobId": "20000000-0000-4000-8000-000000000009",
                "dryRun": True,
                "suppressExistingArtifacts": False,
                "tailorModels": ["local:draft-a"],
                "tailorJudgeModel": "gemini:judge-c",
                "tailorJudgeMinScore": 0.9,
            },
            {
                "steps": ["tailor", "cover", "pdf"],
                "retailor": True,
                "job_id": JobId("20000000-0000-4000-8000-000000000009"),
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
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
                "jobId": "20000000-0000-4000-8000-000000000010",
            },
            {
                "steps": ["tailor", "cover", "pdf"],
                "retailor": True,
                "job_id": JobId("20000000-0000-4000-8000-000000000010"),
                "suppress_existing_artifacts": False,
            },
        ),
        (
            "retailor_current_policy",
            {
                "tenantId": "local",
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
                "limit": 5,
                "jobIds": [
                    "20000000-0000-4000-8000-000000000005",
                    "20000000-0000-4000-8000-000000000006",
                ],
                "dryRun": False,
                "suppressExistingArtifacts": True,
            },
            {
                "stages": ["tailor", "cover"],
                "limit": 5,
                "rescore": False,
                "retailor": True,
                "job_id": None,
                "job_ids": (
                    JobId("20000000-0000-4000-8000-000000000005"),
                    JobId("20000000-0000-4000-8000-000000000006"),
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
                "expectedAppDir": "/tmp/jobctrl",
                "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
                "limit": 5,
                "jobIds": ["20000000-0000-4000-8000-000000000007"],
            },
            {
                "stages": ["tailor", "cover"],
                "limit": 5,
                "rescore": False,
                "retailor": True,
                "job_id": None,
                "job_ids": (JobId("20000000-0000-4000-8000-000000000007"),),
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

    if method in {"rescore_job", "tailor_job", "retailor_job"}:
        if method in {"rescore_job", "retailor_job"}:
            job_id = JobId(str(params["jobId"]))
            job_url = f"https://example.com/job/{method}"
        else:
            job_url = str(params["jobUrl"])
            job_id = None
        job_id = _seed_v7_current_locator(
            get_connection(tmp_db),
            tenant_id=TenantId("local"),
            job_url=job_url,
            job_id=job_id,
        )
        expected_payload = {
            key: value
            for key, value in expected_payload.items()
            if key != "job_url"
        }
        expected_payload["job_id"] = job_id

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
        assert payload.expected_app_dir == "/tmp/jobctrl"
        assert payload.expected_db_path == "/tmp/jobctrl/jobctrl.db"
    for name, value in expected_payload.items():
        assert getattr(payload, name) == value
    assert payload.tenant_id == "local"


def test_v7_job_url_workflow_locators_are_tenant_scoped(tmp_db: Path, monkeypatch) -> None:
    tenant_a = TenantId("tenant-a")
    tenant_b = TenantId("tenant-b")
    job_url = "https://example.com/jobs/same-url"
    job_id_a = _seed_v7_current_locator(
        get_connection(tmp_db),
        tenant_id=tenant_a,
        job_url=job_url,
        job_id=JobId("10000000-0000-4000-8000-000000000001"),
    )
    job_id_b = _seed_v7_current_locator(
        get_connection(tmp_db),
        tenant_id=tenant_b,
        job_url=job_url,
        job_id=JobId("20000000-0000-4000-8000-000000000002"),
    )
    source_event_calls: list[tuple[TenantId, JobId]] = []

    def fake_latest_source_event_id(conn, *, tenant_id: TenantId, job_id: JobId) -> str:
        source_event_calls.append((tenant_id, job_id))
        return "source-event"

    monkeypatch.setattr(handlers_mod, "latest_source_event_id", fake_latest_source_event_id)
    seen: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        seen.append(spec)
        return _StubHandle("job-preparation", "preparation-run")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)

    for method, tenant_id, expected_job_id in (
        ("rescore_job", tenant_a, job_id_a),
        ("tailor_job", tenant_b, job_id_b),
        ("retailor_job", tenant_a, job_id_a),
    ):
        params: dict[str, str] = {"tenantId": str(tenant_id)}
        if method in {"rescore_job", "retailor_job"}:
            params["jobId"] = str(expected_job_id)
        else:
            params["jobUrl"] = job_url
        response = server.dispatch(
            JsonRpcRequest(
                method=method,
                params=params,
                id=1,
            )
        )

        assert response is not None
        assert "error" not in response.to_dict()
        (payload,) = seen[-1].args
        assert isinstance(payload, JobPreparationInput)
        assert payload.tenant_id == str(tenant_id)
        assert payload.job_id == expected_job_id

    assert source_event_calls == [
        (tenant_a, job_id_a),
        (tenant_b, job_id_b),
        (tenant_a, job_id_a),
    ]


@pytest.mark.parametrize("method", ("rescore_job", "retailor_job"))
def test_v7_job_id_workflow_targets_are_loaded_directly_and_tenant_scoped(
    tmp_db: Path,
    method: str,
) -> None:
    tenant_id = TenantId("tenant-a")
    job_id = _seed_v7_current_locator(
        get_connection(tmp_db),
        tenant_id=tenant_id,
        job_url="https://example.com/jobs/direct-job-id",
        job_id=JobId("50000000-0000-4000-8000-000000000005"),
    )
    conn = get_connection(tmp_db)
    conn.execute(
        "DELETE FROM job_locators WHERE tenant_id = ? AND job_id = ?",
        (str(tenant_id), str(job_id)),
    )
    conn.commit()
    seen: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        seen.append(spec)
        return _StubHandle("job-preparation", "preparation-run")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)
    response = server.dispatch(
        JsonRpcRequest(
            method=method,
            params={"tenantId": str(tenant_id), "jobId": str(job_id)},
            id=1,
        )
    )

    assert response is not None
    assert "error" not in response.to_dict()
    (payload,) = seen[0].args
    assert isinstance(payload, JobPreparationInput)
    assert payload.tenant_id == str(tenant_id)
    assert payload.job_id == job_id

    wrong_tenant = server.dispatch(
        JsonRpcRequest(
            method=method,
            params={"tenantId": "tenant-b", "jobId": str(job_id)},
            id=2,
        )
    )
    assert wrong_tenant is not None
    assert wrong_tenant.to_dict()["error"] == {
        "code": INVALID_PARAMS,
        "message": f"unknown or inactive jobId: {job_id}",
    }


@pytest.mark.parametrize("method", ("rescore_job", "retailor_job"))
@pytest.mark.parametrize(
    ("params", "expected_message"),
    [
        ({"tenantId": "local"}, "missing required param: jobId"),
        (
            {"tenantId": "local", "jobUrl": "https://example.com/jobs/legacy"},
            "jobUrl is not supported",
        ),
        (
            {
                "tenantId": "local",
                "jobId": "50000000-0000-4000-8000-000000000005",
                "jobUrl": "https://example.com/jobs/both",
            },
            "jobUrl is not supported",
        ),
        (
            {"tenantId": "local", "jobId": "https://example.com/jobs/not-an-id"},
            "JobId must be a canonical UUID",
        ),
    ],
)
def test_current_policy_job_handlers_require_a_canonical_job_id(
    tmp_db: Path,
    method: str,
    params: dict[str, object],
    expected_message: str,
) -> None:
    response = _server().dispatch(JsonRpcRequest(method=method, params=params, id=1))

    assert response is not None
    body = response.to_dict()
    assert body["error"]["code"] == INVALID_PARAMS
    assert expected_message in body["error"]["message"]


@pytest.mark.parametrize("method", ("rescore_job", "retailor_job"))
def test_current_policy_job_handlers_reject_legacy_url_fields(method: str) -> None:
    response = _server().dispatch(
        JsonRpcRequest(
            method=method,
            params={
                "tenantId": "local",
                "jobId": "20000000-0000-4000-8000-000000000001",
                "jobUrl": "https://example.com/jobs/legacy",
            },
            id=1,
        )
    )

    assert response is not None
    body = response.to_dict()
    assert body["error"]["code"] == INVALID_PARAMS
    assert "jobUrl is not supported" in body["error"]["message"]


@pytest.mark.parametrize(
    "method",
    ("tailor_job", "analyze_job"),
)
def test_v7_job_url_locators_reject_unknown_and_retired_jobs(
    tmp_db: Path,
    method: str,
) -> None:
    tenant_id = TenantId("tenant-a")
    active_url = "https://example.com/jobs/active"
    retired_url = "https://example.com/jobs/retired"
    deleted_url = "https://example.com/jobs/deleted"
    conn = get_connection(tmp_db)
    _seed_v7_current_locator(conn, tenant_id=tenant_id, job_url=active_url)
    retired_job_id = _seed_v7_current_locator(
        conn,
        tenant_id=tenant_id,
        job_url=retired_url,
    )
    deleted_job_id = _seed_v7_current_locator(
        conn,
        tenant_id=tenant_id,
        job_url=deleted_url,
    )
    conn.execute(
        """
        UPDATE job_locators
        SET is_current = 0, retired_at = '2026-07-30T11:00:00+00:00'
        WHERE tenant_id = ? AND job_id = ? AND locator_kind = 'posting_url'
        """,
        (str(tenant_id), str(retired_job_id)),
    )
    conn.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (
            tenant_id, job_id, deleted_at, reason
        ) VALUES (?, ?, '2026-07-30T11:00:00+00:00', 'user_deleted')
        """,
        (str(tenant_id), str(deleted_job_id)),
    )
    conn.commit()
    server = _server()

    for job_url in (
        "https://example.com/jobs/missing",
        retired_url,
        deleted_url,
    ):
        response = server.dispatch(
            JsonRpcRequest(
                method=method,
                params={"tenantId": str(tenant_id), "jobUrl": job_url},
                id=1,
            )
        )

        assert response is not None
        body = response.to_dict()
        assert body["error"]["code"] == INVALID_PARAMS
        assert "unknown or inactive jobUrl" in body["error"]["message"]


def test_analyze_job_loads_the_canonical_tenant_scoped_target(
    tmp_db: Path,
    monkeypatch,
) -> None:
    tenant_a = TenantId("tenant-a")
    tenant_b = TenantId("tenant-b")
    job_url = "https://example.com/jobs/analyze"
    job_id_a = _seed_v7_current_locator(
        get_connection(tmp_db),
        tenant_id=tenant_a,
        job_url=job_url,
        job_id=JobId("30000000-0000-4000-8000-000000000003"),
        full_description="Tenant A canonical description",
    )
    _seed_v7_current_locator(
        get_connection(tmp_db),
        tenant_id=tenant_b,
        job_url=job_url,
        job_id=JobId("40000000-0000-4000-8000-000000000004"),
        full_description="Tenant B canonical description",
    )
    captured: dict[str, object] = {}

    class _UseCase:
        def execute(self, *, job, tenant_id, force):
            captured.update(job=job, tenant_id=tenant_id, force=force)
            return SimpleNamespace(
                analysis=SimpleNamespace(
                    generation=2,
                    cache_key="canonical-cache-key",
                    legs_attempted=3,
                    legs_succeeded=3,
                    is_degraded=False,
                ),
                cached=False,
            )

    from jobctrl.scoring import tailor as tailor_mod

    monkeypatch.setattr(tailor_mod, "_build_analyze_use_case", lambda **_kwargs: _UseCase())
    response = _server().dispatch(
        JsonRpcRequest(
            method="analyze_job",
            params={"tenantId": str(tenant_a), "jobUrl": job_url, "force": True},
            id=1,
        )
    )

    assert response is not None
    assert response.to_dict()["result"]["cacheKey"] == "canonical-cache-key"
    assert captured["tenant_id"] == tenant_a
    assert captured["force"] is True
    assert captured["job"] == {
        "tenant_id": str(tenant_a),
        "job_id": str(job_id_a),
        "url": job_url,
        "title": "Test job",
        "company": "Acme",
        "salary": None,
        "description": "Summary",
        "location": "Remote",
        "site": "example",
        "strategy": "search",
        "discovered_at": "2026-07-30T10:00:00+00:00",
        "enrichment_status": "enriched",
        "full_description": "Tenant A canonical description",
        "application_url": None,
        "detail_scraped_at": "2026-07-30T10:01:00+00:00",
        "extraction_tier": "high",
    }


def test_retailor_job_duplicate_dispatch_uses_existing_workflow_without_duplicate_artifacts(
    tmp_db: Path,
) -> None:
    conn = get_connection(tmp_db)
    job_url = "https://example.com/job/retailor-idempotent"
    job_id = _seed_v7_current_locator(
        conn,
        tenant_id=TenantId("local"),
        job_url=job_url,
    )
    _seed_tailoring_policy(conn, version=3)
    _seed_tailored_artifact(conn, job_id, policy_version=3)
    before = conn.execute(
        "SELECT COUNT(*), COUNT(DISTINCT artifact_id) FROM job_materials_artifacts WHERE tenant_id = ? AND job_id = ?",
        ("local", job_id),
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
            "expectedAppDir": "/tmp/jobctrl",
            "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
            "jobId": str(job_id),
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
        "SELECT COUNT(*), COUNT(DISTINCT artifact_id) FROM job_materials_artifacts WHERE tenant_id = ? AND job_id = ?",
        ("local", job_id),
    ).fetchone()
    assert tuple(before) == (1, 1)
    assert tuple(after) == tuple(before)


@pytest.mark.asyncio
async def test_pipeline_workflow_preserves_selected_job_ids_in_activity_inputs(monkeypatch) -> None:
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
            job_id=JobId("30000000-0000-4000-8000-000000000001"),
            rescore=True,
        ),
    )
    await workflow_mod._execute_stage(
        "score",
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["score"],
            job_ids=(
                JobId("30000000-0000-4000-8000-000000000002"),
                JobId("30000000-0000-4000-8000-000000000003"),
            ),
            rescore=True,
        ),
    )
    await workflow_mod._execute_stage(
        "tailor",
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["tailor"],
            job_id=JobId("30000000-0000-4000-8000-000000000004"),
            retailor=True,
            suppress_existing_artifacts=False,
        ),
    )
    await workflow_mod._execute_stage(
        "tailor",
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["tailor"],
            job_ids=(
                JobId("30000000-0000-4000-8000-000000000005"),
                JobId("30000000-0000-4000-8000-000000000006"),
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
            job_id=JobId("30000000-0000-4000-8000-000000000007"),
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
    assert captured[0][1].job_ids == (JobId("30000000-0000-4000-8000-000000000001"),)
    assert captured[1][0] is score_activity
    assert isinstance(captured[1][1], ScoreActivityInput)
    assert captured[1][1].job_ids == (
        JobId("30000000-0000-4000-8000-000000000002"),
        JobId("30000000-0000-4000-8000-000000000003"),
    )
    assert captured[2][0] is tailor_activity
    assert isinstance(captured[2][1], TailorActivityInput)
    assert captured[2][1].job_ids == (JobId("30000000-0000-4000-8000-000000000004"),)
    assert captured[2][1].suppress_existing_artifacts is False
    assert captured[3][0] is tailor_activity
    assert isinstance(captured[3][1], TailorActivityInput)
    assert captured[3][1].job_ids == (
        JobId("30000000-0000-4000-8000-000000000005"),
        JobId("30000000-0000-4000-8000-000000000006"),
    )
    assert captured[3][1].suppress_existing_artifacts is True
    assert captured[4][0] is cover_activity
    assert isinstance(captured[4][1], CoverActivityInput)
    assert captured[4][1].job_ids == (JobId("30000000-0000-4000-8000-000000000007"),)


def test_selected_score_activity_runs_only_requested_job_ids(monkeypatch) -> None:
    calls: list[tuple[JobId, dict[str, object]]] = []

    def fake_score_job_by_id(job_id: JobId, **kwargs: object) -> SimpleNamespace:
        calls.append((job_id, kwargs))
        return SimpleNamespace(ok=True, error=None)

    monkeypatch.setattr("jobctrl.scoring.scorer.score_job_by_id", fake_score_job_by_id)

    result = scoring_activities_mod._run_selected_scores(
        ScoreActivityInput(
            tenant_id="local",
            job_ids=(
                JobId("40000000-0000-4000-8000-000000000001"),
                JobId("40000000-0000-4000-8000-000000000002"),
                JobId("40000000-0000-4000-8000-000000000001"),
            ),
            limit=2,
            rescore=True,
            llm_model="local:score",
        )
    )

    assert [job_id for job_id, _kwargs in calls] == [
        JobId("40000000-0000-4000-8000-000000000001"),
        JobId("40000000-0000-4000-8000-000000000002"),
    ]
    assert all(call_kwargs["rescore"] is True for _job_id, call_kwargs in calls)
    assert all(call_kwargs["llm_model"] == "local:score" for _job_id, call_kwargs in calls)
    assert result["errors"] == {}
    assert result["stages"][0]["selected"] == 2
    assert result["stages"][0]["scored"] == 2


def test_selected_score_activity_uses_requested_workers(monkeypatch) -> None:
    calls: list[JobId] = []
    submitted: list[JobId] = []
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

        def submit(self, fn, job_id: JobId):  # noqa: ANN001 - test double mirrors concurrent.futures
            submitted.append(job_id)
            return FakeFuture(fn(job_id))

    def fake_score_job_by_id(job_id: JobId, **_kwargs: object) -> SimpleNamespace:
        calls.append(job_id)
        return SimpleNamespace(ok=True, error=None)

    monkeypatch.setattr("jobctrl.scoring.scorer.score_job_by_id", fake_score_job_by_id)
    monkeypatch.setattr(scoring_activities_mod, "ThreadPoolExecutor", RecordingExecutor)
    monkeypatch.setattr(scoring_activities_mod, "as_completed", lambda futures: futures)

    result = scoring_activities_mod._run_selected_scores(
        ScoreActivityInput(
            tenant_id="local",
            job_ids=(
                JobId("40000000-0000-4000-8000-000000000003"),
                JobId("40000000-0000-4000-8000-000000000004"),
                JobId("40000000-0000-4000-8000-000000000005"),
            ),
            workers=3,
            llm_model="local:score",
        )
    )

    assert executor_workers == [3]
    assert submitted == [
        JobId("40000000-0000-4000-8000-000000000003"),
        JobId("40000000-0000-4000-8000-000000000004"),
        JobId("40000000-0000-4000-8000-000000000005"),
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
    job_ids = {
        url: _seed_v7_current_locator(
            conn,
            tenant_id=TenantId("local"),
            job_url=url,
        )
        for url in (current_url, outdated_url, corrected_url, missing_url)
    }
    _seed_v7_score(conn, job_ids[current_url], policy_version=2)
    _seed_v7_score(conn, job_ids[outdated_url], policy_version=1)
    _seed_v7_score(
        conn,
        job_ids[corrected_url],
        policy_version=1,
        correction={"fit_score": 9},
    )
    _seed_v7_current_locator(
        conn,
        tenant_id=TenantId("other"),
        job_url=missing_url,
        job_id=job_ids[missing_url],
    )
    _seed_v7_score(
        conn,
        job_ids[missing_url],
        tenant_id=TenantId("other"),
        policy_version=2,
    )

    calls: list[JobId] = []

    def fake_score_job_by_id(job_id: JobId, **_kwargs: object) -> SimpleNamespace:
        calls.append(job_id)
        return SimpleNamespace(ok=True, error=None)

    monkeypatch.setattr("jobctrl.database.get_connection", lambda: get_connection(tmp_db))
    monkeypatch.setattr("jobctrl.scoring.scorer.score_job_by_id", fake_score_job_by_id)

    result = scoring_activities_mod._run_current_policy_scores(
        ScoreActivityInput(
            tenant_id="local",
            limit=10,
            rescore=True,
            current_policy_only=True,
        )
    )

    assert set(calls) == {job_ids[missing_url], job_ids[outdated_url]}
    assert result["stages"][0]["selected"] == 2
    assert result["stages"][0]["scored"] == 2

    calls.clear()
    result = scoring_activities_mod._run_current_policy_scores(
        ScoreActivityInput(
            tenant_id="local",
            limit=10,
            rescore=True,
            job_ids=(job_ids[current_url], job_ids[outdated_url], job_ids[corrected_url]),
            current_policy_only=True,
        )
    )

    assert calls == [job_ids[outdated_url]]
    assert result["stages"][0]["selected"] == 1


def test_selected_tailor_activity_runs_only_requested_job_ids(monkeypatch) -> None:
    calls: list[tuple[JobId, dict[str, object]]] = []

    def fake_tailor_job_by_id(job_id: JobId, **kwargs: object) -> dict[str, object]:
        calls.append((job_id, kwargs))
        return {"status": "approved"}

    monkeypatch.setattr("jobctrl.scoring.tailor.tailor_job_by_id", fake_tailor_job_by_id)

    result = materials_activities_mod._run_selected_tailoring(
        TailorActivityInput(
            tenant_id="local",
            job_ids=(
                JobId("50000000-0000-4000-8000-000000000001"),
                JobId("50000000-0000-4000-8000-000000000002"),
                JobId("50000000-0000-4000-8000-000000000001"),
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

    assert [job_id for job_id, _kwargs in calls] == [
        JobId("50000000-0000-4000-8000-000000000001"),
        JobId("50000000-0000-4000-8000-000000000002"),
    ]
    assert all(call_kwargs["retailor"] is True for _job_id, call_kwargs in calls)
    assert all(call_kwargs["suppress_existing_artifacts"] is True for _job_id, call_kwargs in calls)
    assert all(call_kwargs["min_score"] == 8 for _job_id, call_kwargs in calls)
    assert all(call_kwargs["tailor_models"] == ("local:tailor",) for _job_id, call_kwargs in calls)
    assert result["errors"] == {}
    assert result["stages"][0]["selected"] == 2
    assert result["stages"][0]["approved"] == 2
    assert result["stages"][0]["selectedJobIds"] == [
        JobId("50000000-0000-4000-8000-000000000001"),
        JobId("50000000-0000-4000-8000-000000000002"),
    ]
    assert result["stages"][0]["approvedJobIds"] == [
        JobId("50000000-0000-4000-8000-000000000001"),
        JobId("50000000-0000-4000-8000-000000000002"),
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
    exhausted_url = "https://example.com/job/exhausted-tailor"
    job_ids = {
        url: _seed_v7_current_locator(
            conn,
            tenant_id=TenantId("local"),
            job_url=url,
        )
        for url in (
            current_url,
            outdated_url,
            missing_url,
            low_fit_url,
            exhausted_url,
        )
    }
    for url in (current_url, outdated_url, missing_url, exhausted_url):
        _seed_v7_score(conn, job_ids[url], policy_version=2, fit_score=9)
    _seed_v7_score(conn, job_ids[low_fit_url], policy_version=2, fit_score=5)
    _seed_v7_tailored_artifact(
        conn,
        job_ids[current_url],
        policy_version=2,
    )
    _seed_v7_tailored_artifact(
        conn,
        job_ids[outdated_url],
        policy_version=1,
    )
    _seed_v7_rejected_tailoring_generation(conn, job_ids[current_url], generation=2)
    _seed_v7_rejected_tailoring_generation(conn, job_ids[outdated_url], generation=2)
    _seed_v7_tailored_artifact(
        conn,
        job_ids[exhausted_url],
        policy_version=1,
    )
    _seed_v7_tailor_stage(
        conn,
        job_ids[exhausted_url],
        state="failed",
        attempt_count=5,
    )
    _seed_v7_current_locator(
        conn,
        tenant_id=TenantId("other"),
        job_url=missing_url,
        job_id=job_ids[missing_url],
    )
    _seed_v7_score(
        conn,
        job_ids[missing_url],
        tenant_id=TenantId("other"),
        policy_version=2,
        fit_score=9,
    )
    _seed_v7_tailored_artifact(
        conn,
        job_ids[missing_url],
        tenant_id=TenantId("other"),
        policy_version=2,
    )

    calls: list[tuple[JobId, dict[str, object]]] = []

    def fake_tailor_job_by_id(job_id: JobId, **kwargs: object) -> dict[str, object]:
        calls.append((job_id, kwargs))
        return {"status": "approved"}

    monkeypatch.setattr("jobctrl.database.get_connection", lambda: get_connection(tmp_db))
    monkeypatch.setattr("jobctrl.scoring.tailor.tailor_job_by_id", fake_tailor_job_by_id)

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

    assert {job_id for job_id, _kwargs in calls} == {job_ids[missing_url], job_ids[outdated_url]}
    assert all(kwargs["suppress_existing_artifacts"] is True for _job_id, kwargs in calls)
    assert result["stages"][0]["selected"] == 2
    assert result["stages"][0]["approved"] == 2
    assert set(result["stages"][0]["approvedJobIds"]) == {job_ids[missing_url], job_ids[outdated_url]}

    calls.clear()
    result = materials_activities_mod._run_current_policy_tailoring(
        TailorActivityInput(
            tenant_id="local",
            min_score=7,
            limit=10,
            retailor=True,
            job_ids=(job_ids[current_url], job_ids[outdated_url]),
            current_policy_only=True,
            suppress_existing_artifacts=False,
        )
    )

    assert [job_id for job_id, _kwargs in calls] == [job_ids[outdated_url]]
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
                    "templateText": "{{ personal_data }}\n\n{{ resume_body }}\n",
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
                "templateText": "{{ personal_data }}\n\n{{ resume_body }}\n",
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


def _seed_v7_current_locator(
    conn,
    *,
    tenant_id: TenantId,
    job_url: str,
    job_id: JobId | None = None,
    full_description: str = "Full description",
) -> JobId:
    stable_job_id = job_id or JobId(str(uuid.uuid5(uuid.NAMESPACE_URL, f"{tenant_id}:{job_url}")))
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, salary, description,
            location, site, strategy, discovered_at
        ) VALUES (?, ?, ?, 'Test job', 'Acme', NULL, 'Summary', 'Remote',
                  'example', 'search', '2026-07-30T10:00:00+00:00')
        """,
        (str(tenant_id), str(stable_job_id), job_url),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value, is_current,
            first_seen_at, last_seen_at, retired_at
        ) VALUES (?, ?, 'posting_url', ?, 1, '2026-07-30T10:00:00+00:00',
                  '2026-07-30T10:00:00+00:00', NULL)
        """,
        (str(tenant_id), str(stable_job_id), job_url),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description,
            application_url, enriched_at, extraction_tier, updated_at
        ) VALUES (?, ?, 'enriched', ?, NULL, '2026-07-30T10:01:00+00:00',
                  'high', '2026-07-30T10:01:00+00:00')
        """,
        (str(tenant_id), str(stable_job_id), full_description),
    )
    conn.commit()
    return stable_job_id


def _seed_scoring_policy(conn, *, version: int) -> None:
    conn.execute(
        """
        INSERT INTO scoring_policies (tenant_id, version, rubric_json, anchors_json, created_at)
        VALUES ('local', ?, '{}', '[]', '2026-05-26T10:00:00+00:00')
        """,
        (version,),
    )
    conn.commit()


def _seed_v7_score(
    conn,
    job_id: JobId,
    *,
    tenant_id: TenantId = TenantId("local"),
    policy_version: int,
    fit_score: int = 8,
    correction: dict[str, object] | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
            scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, ?, 1, ?, ?, '[]', '2026-07-30T10:02:00+00:00',
                  ?, '{}', ?)
        """,
        (
            str(tenant_id),
            str(job_id),
            fit_score,
            json.dumps(
                {
                    "reasoning": "ok",
                    "eligibility": {
                        "status": "eligible",
                        "hard_blockers": [],
                    },
                }
            ),
            json.dumps(correction) if correction is not None else None,
            json.dumps({"scoring_policy_version": policy_version}),
        ),
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


def _seed_v7_tailored_artifact(
    conn,
    job_id: JobId,
    *,
    tenant_id: TenantId = TenantId("local"),
    policy_version: int,
) -> None:
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at,
            metadata_json
        ) VALUES (?, ?, 1, 'resume_approved',
                  '2026-07-30T10:03:00+00:00',
                  '2026-07-30T10:03:00+00:00', '{}')
        """,
        (str(tenant_id), str(job_id)),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status,
            path, render_format, size_bytes, metadata_json, created_at,
            superseded_at
        ) VALUES (?, ?, 1, 'tailored_resume', ?, 'approved', ?, 'text', 12, ?,
                  '2026-07-30T10:03:00+00:00', NULL)
        """,
        (
            str(tenant_id),
            str(job_id),
            f"artifact-{policy_version}-{job_id}",
            f"/tmp/{job_id}.txt",
            json.dumps({"tailoring_policy_version": policy_version}),
        ),
    )
    conn.commit()


def _seed_v7_rejected_tailoring_generation(
    conn,
    job_id: JobId,
    *,
    tenant_id: TenantId = TenantId("local"),
    generation: int,
) -> None:
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at,
            metadata_json
        ) VALUES (?, ?, ?, 'resume_rejected',
                  '2026-07-30T10:04:00+00:00',
                  '2026-07-30T10:04:00+00:00', '{}')
        """,
        (str(tenant_id), str(job_id), generation),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status,
            path, render_format, size_bytes, metadata_json, created_at,
            superseded_at
        ) VALUES (?, ?, ?, 'tailored_resume', ?, 'rejected', ?, 'text', 12, '{}',
                  '2026-07-30T10:04:00+00:00', NULL)
        """,
        (
            str(tenant_id),
            str(job_id),
            generation,
            f"artifact-rejected-{generation}-{job_id}",
            f"/tmp/{job_id}-rejected-{generation}.txt",
        ),
    )
    conn.commit()


def _seed_v7_tailor_stage(
    conn,
    job_id: JobId,
    *,
    tenant_id: TenantId = TenantId("local"),
    state: str,
    attempt_count: int,
) -> None:
    conn.execute(
        """
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, attempt_count, max_attempts,
            updated_at, retryable
        ) VALUES (?, ?, 'tailor', ?, ?, 5, '2026-07-30T10:05:00+00:00', 1)
        """,
        (str(tenant_id), str(job_id), state, attempt_count),
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


def _seed_tailored_artifact(conn, job_id: JobId, *, policy_version: int) -> None:
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
        ) VALUES ('local', ?, 1, 'resume_approved',
            '2026-05-26T10:00:00+00:00', '2026-05-26T10:00:00+00:00', '{}')
        """,
        (job_id,),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status,
            path, render_format, size_bytes, metadata_json, created_at, superseded_at
        ) VALUES ('local', ?, 1, 'tailored_resume', ?, 'approved', ?, 'text', 12, ?,
            '2026-05-26T10:00:00+00:00', NULL)
        """,
        (
            job_id,
            f"artifact-{policy_version}-{job_id}",
            f"/tmp/{job_id}.txt",
            json.dumps({"tailoring_policy_version": policy_version}),
        ),
    )
    conn.commit()
