"""Discovery preparation workflow fan-out tests."""

from __future__ import annotations

import asyncio
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.database import init_db
from jobctrl.domain.discovery.scheduler import ScheduledSource
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.preparation import PreparationWorkItemKind
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.discovery.workflow import DiscoverWorkflow
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.temporal.registry import WORKFLOWS
from jobctrl.pipeline import preparation, runner
from jobctrl.preparation.workflow import JobPreparationInput, JobPreparationWorkflow
from jobctrl.workflow_specs import build_run_stage_workflow_spec


def _job_id(index: int) -> JobId:
    return JobId(f"10000000-0000-4000-8000-{index:012d}")


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


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
    def fake_job_ids(_conn, *, stage: str, **_kwargs):
        if stage == "pending_score":
            return [_job_id(2), _job_id(1)]
        if stage == "pending_tailor":
            return [_job_id(1), _job_id(3)]
        return []

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "_preparation_job_ids", fake_job_ids)
    monkeypatch.setattr(preparation, "_suppress_ineligible_artifacts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(preparation, "current_scoring_policy_version", lambda *_args, **_kwargs: 11)
    monkeypatch.setattr(preparation, "current_tailoring_policy_version", lambda *_args, **_kwargs: 7)
    monkeypatch.setattr(
        preparation,
        "_latest_source_event_id",
        lambda _conn, *, tenant_id, job_id: f"event:{job_id}",
    )

    targets = preparation.derive_preparation_targets(
        preparation.DerivePreparationTargetsInput(tenant_id=str(LOCAL_TENANT), min_score=7)
    )

    assert [target.job_id for target in targets] == [_job_id(1), _job_id(2), _job_id(3)]
    assert {target.tenant_id for target in targets} == {LOCAL_TENANT}
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

    def fake_job_ids(_conn, *, stage: str, **_kwargs):
        if stage == "pending_score":
            return [_job_id(10)]
        if stage == "pending_tailor":
            # A job scored earlier this run, now mid-tailor.
            return [_job_id(11)]
        return []

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "_preparation_job_ids", fake_job_ids)
    monkeypatch.setattr(preparation, "_suppress_ineligible_artifacts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(preparation, "current_scoring_policy_version", lambda *_args, **_kwargs: 3)
    monkeypatch.setattr(preparation, "current_tailoring_policy_version", lambda *_args, **_kwargs: 5)
    monkeypatch.setattr(
        preparation,
        "_latest_source_event_id",
        lambda _conn, *, tenant_id, job_id: f"event:{job_id}",
    )

    full = preparation.derive_preparation_targets(
        preparation.DerivePreparationTargetsInput(tenant_id=str(LOCAL_TENANT), min_score=7)
    )
    score_only = preparation.derive_preparation_targets(
        preparation.DerivePreparationTargetsInput(
            tenant_id=str(LOCAL_TENANT), min_score=7, include_pending_tailor=False
        )
    )

    # The default (first-pass) derive sweeps both the fresh job and the straggler.
    assert {target.job_id for target in full} == {_job_id(10), _job_id(11)}
    # Score-only (every subsequent streaming pass) never touches pending_tailor,
    # so the mid-tailor job cannot get a second, racing prep workflow.
    assert [target.job_id for target in score_only] == [_job_id(10)]
    assert score_only[0].steps == ["score", "tailor", "cover", "pdf"]


def test_derive_preparation_targets_uses_exact_v7_job_identity_queries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The synchronous fan-out works on the sealed v7 schema without URL joins."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_exact_v7_schema(conn)
    now = "2026-07-31T09:00:00+00:00"
    pending_score_id = _job_id(60)
    pending_tailor_id = _job_id(61)
    suppressed_id = _job_id(62)
    deleted_score_id = _job_id(63)
    deleted_tailor_id = _job_id(64)
    restored_score_id = _job_id(65)
    other_tenant_id = _job_id(60)

    try:
        for tenant_id, job_id in (
            (LOCAL_TENANT, pending_score_id),
            (LOCAL_TENANT, pending_tailor_id),
            (LOCAL_TENANT, suppressed_id),
            (LOCAL_TENANT, deleted_score_id),
            (LOCAL_TENANT, deleted_tailor_id),
            (LOCAL_TENANT, restored_score_id),
            ("other", other_tenant_id),
        ):
            conn.execute(
                """
                INSERT INTO jobs (tenant_id, job_id, url, discovered_at)
                VALUES (?, ?, ?, ?)
                """,
                (str(tenant_id), str(job_id), f"https://jobs.example/{tenant_id}/{job_id}", now),
            )
        conn.executemany(
            """
            INSERT INTO job_enrichments (
                tenant_id, job_id, current_status, full_description, updated_at
            ) VALUES (?, ?, 'enriched', 'Canonical description', ?)
            """,
            [
                (str(LOCAL_TENANT), str(pending_score_id), now),
                (str(LOCAL_TENANT), str(pending_tailor_id), now),
                (str(LOCAL_TENANT), str(deleted_score_id), now),
                (str(LOCAL_TENANT), str(deleted_tailor_id), now),
                (str(LOCAL_TENANT), str(restored_score_id), now),
                ("other", str(other_tenant_id), now),
            ],
        )
        conn.executemany(
            """
            INSERT INTO job_scores (
                tenant_id, job_id, version, fit_score, breakdown_json,
                keywords_json, scored_at
            ) VALUES (?, ?, 1, ?, ?, '[]', ?)
            """,
            [
                (
                    str(LOCAL_TENANT),
                    str(pending_tailor_id),
                    8,
                    '{"eligibility":{"status":"eligible","hard_blockers":[]}}',
                    now,
                ),
                (
                    str(LOCAL_TENANT),
                    str(deleted_tailor_id),
                    8,
                    '{"eligibility":{"status":"eligible","hard_blockers":[]}}',
                    now,
                ),
                (str(LOCAL_TENANT), str(suppressed_id), 5, "{}", now),
            ],
        )
        conn.executemany(
            """
            INSERT INTO job_stage_states (
                tenant_id, job_id, stage, state, attempt_count, updated_at
            ) VALUES (?, ?, 'score', 'succeeded', 1, ?)
            """,
            (
                (str(LOCAL_TENANT), str(pending_tailor_id), now),
                (str(LOCAL_TENANT), str(deleted_tailor_id), now),
            ),
        )
        conn.executemany(
            """
            INSERT INTO jobctrl_deleted_jobs (
                tenant_id, job_id, deleted_at, reason, restored_at
            ) VALUES (?, ?, ?, 'fixture', ?)
            """,
            (
                (
                    str(LOCAL_TENANT),
                    str(deleted_score_id),
                    "2026-07-31T09:01:00+00:00",
                    None,
                ),
                (
                    str(LOCAL_TENANT),
                    str(deleted_tailor_id),
                    "2026-07-31T09:01:00+00:00",
                    None,
                ),
                (
                    str(LOCAL_TENANT),
                    str(restored_score_id),
                    "2026-07-31T09:01:00+00:00",
                    "2026-07-31T09:02:00+00:00",
                ),
            ),
        )
        conn.execute(
            """
            INSERT INTO job_materials (
                tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
            ) VALUES (?, ?, 1, 'resume_approved', ?, ?, '{"source":"fixture"}')
            """,
            (str(LOCAL_TENANT), str(suppressed_id), now, now),
        )
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id, status,
                path, render_format, metadata_json, created_at
            ) VALUES (?, ?, 1, 'tailored_resume', 'resume-62', 'approved',
                      '/tmp/resume-62.txt', 'text', '{"source":"fixture"}', ?)
            """,
            (str(LOCAL_TENANT), str(suppressed_id), now),
        )
        conn.commit()
        monkeypatch.setattr(preparation, "get_connection", lambda: conn)

        targets = preparation.derive_preparation_targets(
            preparation.DerivePreparationTargetsInput(tenant_id=str(LOCAL_TENANT), min_score=7)
        )

        assert [target.job_id for target in targets] == [
            pending_score_id,
            pending_tailor_id,
            restored_score_id,
        ]
        assert targets[0].steps == ["score", "tailor", "cover", "pdf"]
        assert targets[1].steps == ["tailor", "cover", "pdf"]
        assert targets[2].steps == ["score", "tailor", "cover", "pdf"]
        suppressed = conn.execute(
            """
            SELECT status, metadata_json
            FROM job_materials_artifacts
            WHERE tenant_id = ? AND job_id = ? AND generation = 1
            """,
            (str(LOCAL_TENANT), str(suppressed_id)),
        ).fetchone()
        assert suppressed is not None
        assert suppressed["status"] == "suppressed"
        assert '"reason":"threshold_or_hard_blocker_ineligible"' in suppressed["metadata_json"]
        assert preparation._unselected_work_plan_outcome(
            conn,
            tenant_id=LOCAL_TENANT,
            job_id=suppressed_id,
            min_score=7,
        ) == ("not_eligible", "score_below_threshold")
    finally:
        conn.close()


def test_derive_preparation_targets_admits_repairable_historical_salary_block() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_exact_v7_schema(conn)
    job_id = _job_id(66)
    now = "2026-07-31T09:00:00+00:00"
    try:
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, discovered_at) VALUES (?, ?, ?, ?)",
            (str(LOCAL_TENANT), str(job_id), "https://jobs.example/salary-advisory", now),
        )
        conn.execute(
            """
            INSERT INTO job_enrichments (
                tenant_id, job_id, current_status, full_description, updated_at
            ) VALUES (?, ?, 'enriched', 'Canonical description', ?)
            """,
            (str(LOCAL_TENANT), str(job_id), now),
        )
        conn.execute(
            """
            INSERT INTO job_scores (
                tenant_id, job_id, version, fit_score, breakdown_json,
                keywords_json, scored_at
            ) VALUES (?, ?, 1, 9, ?, '[]', ?)
            """,
            (
                str(LOCAL_TENANT),
                str(job_id),
                '{"eligibility":{"status":"blocked","hard_blockers":["Salary is below target."]}}',
                now,
            ),
        )
        conn.executemany(
            """
            INSERT INTO job_stage_states (
                tenant_id, job_id, stage, state, attempt_count, updated_at,
                error_code, error_message
            ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
            """,
            (
                (str(LOCAL_TENANT), str(job_id), "score", "succeeded", now, None, None),
                (
                    str(LOCAL_TENANT),
                    str(job_id),
                    "tailor",
                    "blocked",
                    now,
                    "SCORE_ELIGIBILITY_BLOCKED",
                    "Score eligibility blocks tailoring: salary below target",
                ),
            ),
        )
        conn.commit()

        selected = preparation._preparation_job_ids(
            conn,
            tenant_id=LOCAL_TENANT,
            stage="pending_tailor",
            min_score=7,
        )

        assert selected == [job_id]
    finally:
        conn.close()


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
            tenant_id=LOCAL_TENANT,
            job_id=_job_id(20),
            idempotency_key="preparation:key-a",
            target_version="3",
            steps=["score", "tailor", "cover", "pdf"],
        ),
        preparation.PreparationTarget(
            tenant_id=LOCAL_TENANT,
            job_id=_job_id(21),
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


def test_per_job_handoff_id_converges_with_fanout_and_forks_on_reenrichment(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """R9 Phase 2 idempotence (I1) at per-job granularity: the per-job handoff
    starts the SAME deterministic id a SCORE_JOB fan-out would derive for the
    job, so `USE_EXISTING` collapses the handoff + reconciling fan-out into one
    execution. A re-enrichment that changes ``source_event_id`` — a genuine
    material change — legitimately forks a new prep workflow."""
    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "current_scoring_policy_version", lambda *_a, **_k: 4)
    monkeypatch.setattr(
        preparation,
        "_latest_source_event_id",
        lambda _conn, *, tenant_id, job_id: "event-A",
    )

    requested: list[str] = []
    requested_payloads: list[JobPreparationInput] = []

    async def fake_starter(spec):
        requested.append(spec.workflow_id)
        requested_payloads.append(spec.args[0])
        return SimpleNamespace(id=spec.workflow_id)

    job_id = _job_id(30)
    preparation.start_job_preparation_workflow(job_id, workflow_starter=fake_starter)
    handoff_id = requested[-1]
    assert requested_payloads[-1].discovery_execution is None
    assert requested_payloads[-1].discovery_cohort_kind is None

    # Identical to what a SCORE_JOB fan-out derive produces for the same job.
    fanout_spec = preparation.build_preparation_workflow_spec(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        steps=["score", "tailor", "cover", "pdf"],
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=4,
        source_event_id="event-A",
    )
    assert handoff_id == fanout_spec.workflow_id
    assert handoff_id.startswith("prep-preparation:")

    # A benign repeated handoff for the same source event reuses the id (dedup).
    preparation.start_job_preparation_workflow(job_id, workflow_starter=fake_starter)
    assert requested[-1] == handoff_id

    # Re-enrichment producing a new source event forks a new id (material change).
    monkeypatch.setattr(
        preparation,
        "_latest_source_event_id",
        lambda _conn, *, tenant_id, job_id: "event-B",
    )
    preparation.start_job_preparation_workflow(job_id, workflow_starter=fake_starter)
    assert requested[-1] != handoff_id


def test_per_job_handoff_starts_from_inside_active_event_loop(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "current_scoring_policy_version", lambda *_a, **_k: 4)
    monkeypatch.setattr(
        preparation,
        "_latest_source_event_id",
        lambda _conn, *, tenant_id, job_id: "event-active-loop",
    )
    requested: list[str] = []

    async def fake_starter(spec):
        requested.append(spec.workflow_id)
        return SimpleNamespace(id=spec.workflow_id)

    async def invoke_sync_handoff() -> bool:
        return preparation.start_job_preparation_workflow(
            _job_id(31),
            workflow_starter=fake_starter,
        )

    assert asyncio.run(invoke_sync_handoff()) is True
    assert len(requested) == 1
    assert requested[0].startswith("prep-preparation:")


def test_preparation_fan_out_starts_batches_of_at_most_25(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    targets = [
        preparation.PreparationTarget(
            tenant_id=LOCAL_TENANT,
            job_id=_job_id(100 + index),
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
        job_id=_job_id(40),
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
    assert payload.job_id == _job_id(40)
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
        "jobctrl.discovery.workday",
        SimpleNamespace(run_workday_discovery=lambda employers=None, workers=1, limit=0, run_id=None: None),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobctrl.discovery.smartextract",
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
