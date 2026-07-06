"""Discovery preparation workflow fan-out tests."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobhunter.database import init_db
from jobhunter.domain.discovery.scheduler import ScheduledSource
from jobhunter.domain.preparation import PreparationWorkItemKind
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.discovery.workflow import DiscoverWorkflow
from jobhunter.infrastructure.temporal.registry import WORKFLOWS
from jobhunter.pipeline import preparation, runner
from jobhunter.preparation.workflow import JobPreparationInput, JobPreparationWorkflow
from jobhunter.workflow_specs import build_run_stage_workflow_spec


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


def test_all_stage_expands_to_primary_discover_only_and_keeps_maintenance_explicit() -> None:
    assert runner.PRIMARY_STAGE_ORDER == ("discover",)
    assert runner.MAINTENANCE_STAGE_ORDER == ("score", "tailor", "cover")
    assert runner.SUPPORTED_STAGE_ORDER == ("discover", "score", "tailor", "cover")
    assert runner._resolve_stages(["all"]) == ["discover"]
    assert runner._resolve_stages(["score", "tailor", "cover"]) == ["score", "tailor", "cover"]


def test_discover_workflow_is_registered() -> None:
    assert DiscoverWorkflow in WORKFLOWS


def test_default_workflow_spec_uses_primary_stage_order() -> None:
    spec = build_run_stage_workflow_spec({"tenantId": "local", "minScore": 8})

    assert spec.workflow is DiscoverWorkflow
    payload = spec.args[0]
    assert payload.min_score == 8


def test_derive_preparation_targets_is_sorted_and_prefers_score_workflow(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_jobs(*, stage: str, **_kwargs):
        if stage == "pending_score":
            return [{"url": "https://example.com/job/b"}, {"url": "https://example.com/job/a"}]
        if stage == "pending_tailor":
            return [{"url": "https://example.com/job/a"}, {"url": "https://example.com/job/c"}]
        return []

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "get_jobs_by_stage", fake_jobs)
    monkeypatch.setattr(preparation, "_suppress_ineligible_artifacts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(preparation, "current_scoring_policy_version", lambda *_args, **_kwargs: 11)
    monkeypatch.setattr(preparation, "current_tailoring_policy_version", lambda *_args, **_kwargs: 7)
    monkeypatch.setattr(preparation, "_latest_source_event_id", lambda _conn, url: f"event:{url.rsplit('/', 1)[-1]}")

    targets = preparation.derive_preparation_targets(
        preparation.DerivePreparationTargetsInput(tenant_id=str(LOCAL_TENANT), min_score=7)
    )

    assert [target.job_url for target in targets] == [
        "https://example.com/job/a",
        "https://example.com/job/b",
        "https://example.com/job/c",
    ]
    assert targets[0].steps == ["score", "tailor", "cover", "pdf"]
    assert targets[0].target_version == "11"
    assert targets[2].steps == ["tailor", "cover", "pdf"]
    assert targets[2].target_version == "7"


def test_derive_targets_score_only_skips_pending_tailor(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """R9 Phase 1 race guard: with ``include_pending_tailor=False`` a job that
    has crossed ``pending_score`` -> ``pending_tailor`` (mid-tailor under its
    own SCORE_JOB workflow) is NOT re-derived as a duplicate TAILOR_RESUME
    target. Score-only passes only start fresh SCORE_JOB work."""

    def fake_jobs(*, stage: str, **_kwargs):
        if stage == "pending_score":
            return [{"url": "https://example.com/job/fresh"}]
        if stage == "pending_tailor":
            # A job scored earlier this run, now mid-tailor.
            return [{"url": "https://example.com/job/mid-tailor"}]
        return []

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "get_jobs_by_stage", fake_jobs)
    monkeypatch.setattr(preparation, "_suppress_ineligible_artifacts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(preparation, "current_scoring_policy_version", lambda *_args, **_kwargs: 3)
    monkeypatch.setattr(preparation, "current_tailoring_policy_version", lambda *_args, **_kwargs: 5)
    monkeypatch.setattr(preparation, "_latest_source_event_id", lambda _conn, url: f"event:{url.rsplit('/', 1)[-1]}")

    full = preparation.derive_preparation_targets(
        preparation.DerivePreparationTargetsInput(tenant_id=str(LOCAL_TENANT), min_score=7)
    )
    score_only = preparation.derive_preparation_targets(
        preparation.DerivePreparationTargetsInput(
            tenant_id=str(LOCAL_TENANT), min_score=7, include_pending_tailor=False
        )
    )

    # The default (first-pass) derive sweeps both the fresh job and the straggler.
    assert {target.job_url for target in full} == {
        "https://example.com/job/fresh",
        "https://example.com/job/mid-tailor",
    }
    # Score-only (every subsequent streaming pass) never touches pending_tailor,
    # so the mid-tailor job cannot get a second, racing prep workflow.
    assert [target.job_url for target in score_only] == ["https://example.com/job/fresh"]
    assert score_only[0].steps == ["score", "tailor", "cover", "pdf"]


class _FakeUseExistingStarter:
    """Simulate ``WorkflowIDConflictPolicy.USE_EXISTING`` for fan-out tests.

    A repeated start of an already-open deterministic id returns the existing
    handle instead of launching a second execution — exactly what keeps the
    streaming multi-pass fan-out idempotent (I1)."""

    def __init__(self) -> None:
        self.open_ids: set[str] = set()
        self.requested: list[str] = []
        self.new_starts: list[str] = []

    async def __call__(self, spec):
        self.requested.append(spec.workflow_id)
        if spec.workflow_id not in self.open_ids:
            self.open_ids.add(spec.workflow_id)
            self.new_starts.append(spec.workflow_id)
        return SimpleNamespace(id=spec.workflow_id)


def test_streaming_fanout_dedups_repeated_passes_via_deterministic_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """R9 Phase 1 fixture #3 — per-family fan-out across two families where the
    second adds no new eligible jobs requests the SAME deterministic
    ``prep-{idempotency_key}`` ids and (with USE_EXISTING) starts ZERO duplicate
    executions."""
    targets = [
        preparation.PreparationTarget(
            job_url="https://example.com/job/a",
            idempotency_key="preparation:key-a",
            target_version="3",
            steps=["score", "tailor", "cover", "pdf"],
        ),
        preparation.PreparationTarget(
            job_url="https://example.com/job/b",
            idempotency_key="preparation:key-b",
            target_version="3",
            steps=["score", "tailor", "cover", "pdf"],
        ),
    ]
    monkeypatch.setattr(preparation, "derive_preparation_targets", lambda _payload: list(targets))
    starter = _FakeUseExistingStarter()

    stats_pass1 = preparation.start_discovery_preparation_workflows(workflow_starter=starter)
    started_after_pass1 = list(starter.new_starts)
    stats_pass2 = preparation.start_discovery_preparation_workflows(workflow_starter=starter)

    # Both passes request the identical deterministic ids.
    expected_ids = ["prep-preparation:key-a", "prep-preparation:key-b"]
    assert sorted(set(starter.requested)) == expected_ids
    assert starter.requested == expected_ids * 2
    # Pass 1 launches both executions; pass 2 (no new eligible jobs) launches
    # zero new executions — USE_EXISTING returns the open handles.
    assert started_after_pass1 == expected_ids
    assert starter.new_starts == expected_ids
    assert stats_pass1["queued"] == {"job_preparation": 2}
    assert stats_pass2["queued"] == {"job_preparation": 2}


def test_preparation_fan_out_starts_batches_of_at_most_25(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    targets = [
        preparation.PreparationTarget(
            job_url=f"https://example.com/job/{index:02d}",
            idempotency_key=f"preparation:key-{index:02d}",
            target_version="1",
            steps=["score"],
        )
        for index in range(26)
    ]
    batch_sizes: list[int] = []

    monkeypatch.setattr(preparation, "derive_preparation_targets", lambda _payload: targets)
    monkeypatch.setattr(
        preparation,
        "_run_start_batch",
        lambda batch, _starter: batch_sizes.append(len(batch)),
    )

    stats = preparation.start_discovery_preparation_workflows()

    assert batch_sizes == [25, 1]
    assert stats["queued"] == {"job_preparation": 26}
    assert stats["started"] == {"job_preparation": 26}


def test_build_preparation_workflow_spec_uses_deterministic_id(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    spec = preparation.build_preparation_workflow_spec(
        tenant_id=LOCAL_TENANT,
        job_url="https://example.com/job/one",
        steps=["tailor", "cover", "pdf"],
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=7,
        source_event_id="event-1",
    )

    assert spec.workflow is JobPreparationWorkflow
    assert spec.workflow_id is not None
    assert spec.workflow_id.startswith("prep-preparation:")
    (payload,) = spec.args
    assert isinstance(payload, JobPreparationInput)
    assert payload.steps == ["tailor", "cover", "pdf"]
    assert payload.job_url == "https://example.com/job/one"
    assert spec.workflow_id == f"prep-{payload.idempotency_key}"


def test_discover_stage_kwargs_include_preparation_controls() -> None:
    kwargs = runner._build_stage_kwargs(
        "discover",
        min_score=8,
        workers=3,
        validation_mode="strict",
        limit=5,
        llm_model="local:score",
        tailor_models=("local:draft",),
        tailor_judge_model="local:judge",
        tailor_judge_min_score=0.9,
    )

    assert kwargs["min_score"] == 8
    assert kwargs["workers"] == 3
    assert kwargs["validation_mode"] == "strict"
    assert kwargs["limit"] == 5
    assert kwargs["llm_model"] == "local:score"
    assert kwargs["tailor_models"] == ("local:draft",)
    assert kwargs["tailor_judge_model"] == "local:judge"
    assert kwargs["tailor_judge_min_score"] == 0.9


def test_discovery_source_failure_records_failed_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str, str, str, dict]] = []
    monkeypatch.setattr(
        runner,
        "_record_pipeline_event",
        lambda stage, event_type, _level, message, payload=None: events.append(
            (stage, event_type, message, payload or {})
        ),
    )
    monkeypatch.setattr(runner, "_record_operational_attempt", lambda **_kwargs: None)

    scheduled = ScheduledSource(
        source_id="jobspy:linkedin",
        display_name="LinkedIn",
        source_kind=runner.SourceKind.BROAD_BOARD,
        priority=runner.SourcePriority.STANDARD,
        configured_state=runner.SourceState.ACTIVE,
        crawl_budget=25,
        decision="run",
        reason="test",
        recommended_state="active",
        adapter_config={
            "sites": ["linkedin"],
            "search_terms": ["python"],
            "locations": ["Remote"],
        },
    )

    def fail_source() -> None:
        raise RuntimeError("source outage")

    with pytest.raises(runner.SourceUnavailableError, match="JobSpy failed: source outage"):
        runner._run_discovery_source(
            "jobspy",
            "JobSpy",
            (scheduled,),
            fail_source,
            progress_completed=1,
            progress_total=5,
        )

    failed_event = [event for event in events if event[1] == "StageFailed"][0]
    assert failed_event[0] == "discover"
    assert failed_event[2] == "Discovery source jobspy failed: source outage"
    assert failed_event[3]["progress"] == {
        "completed": 2,
        "total": 5,
        "percent": 40,
        "currentStep": "JobSpy",
        "status": "failed",
        "message": "JobSpy failed",
    }


def test_discover_runs_internal_preparation_after_enrichment(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(runner, "init_db", lambda: conn)
    monkeypatch.setattr(runner, "get_connection", lambda: conn)
    monkeypatch.setattr(runner.config, "load_search_config", lambda: {"disable_jobspy": True})
    monkeypatch.setattr(
        runner,
        "_start_discovery_enrichment_worker",
        lambda *, workers, limit: (
            SimpleNamespace(set=lambda: None),
            {"status": "ok", "passes": 0, "pending": 0},
            SimpleNamespace(join=lambda: None),
        ),
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_record_operational_attempt", lambda **_kwargs: None)
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(run_workday_discovery=lambda employers=None, workers=1, limit=0, run_id=None: None),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(run_smart_extract=lambda sites=None, workers=1, limit=0: None),
    )

    def fake_fan_out(**kwargs):
        captured.update(kwargs)
        return {"status": "ok", "has_work": True, "queued": {}, "started": {}}

    monkeypatch.setattr(preparation, "start_discovery_preparation_workflows", fake_fan_out)

    result = runner.run_discovery_legacy_once(
        workers=3,
        limit=5,
        min_score=8,
        validation_mode="strict",
        llm_model="local:score",
        tailor_models=("local:draft",),
        tailor_judge_model="local:judge",
        tailor_judge_min_score=0.9,
    )

    assert result["preparation"] == "ok"
    assert captured == {
        "min_score": 8,
        "limit": 5,
        "workers": 3,
        "validation_mode": "strict",
        "llm_model": "local:score",
        "tailor_models": ("local:draft",),
        "tailor_judge_model": "local:judge",
        "tailor_judge_min_score": 0.9,
    }
