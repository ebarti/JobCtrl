"""Regression fixtures for immutable Discover execution/job lineage."""

from __future__ import annotations

import sqlite3
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.database import init_db
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.identity import JobSourceObservation
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.discovery.activities import (
    DiscoveryEnrichmentActivityInput,
    DiscoveryPreparationFanoutInput,
    DiscoverySourceActivityInput,
)
from jobctrl.infrastructure.discovery.sqlite_execution_repository import (
    SqliteDiscoveryExecutionRepository,
)
from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobctrl.pipeline import preparation as preparation_pipeline
from jobctrl.preparation.workflow import JobPreparationInput, _input_summary


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def _execution(run_id: str, *, workflow_id: str = "discover-local") -> DiscoveryExecutionRef:
    return DiscoveryExecutionRef(
        tenant_id=str(LOCAL_TENANT),
        workflow_id=workflow_id,
        temporal_run_id=run_id,
    )


def _insert_job(conn: sqlite3.Connection, suffix: str) -> str:
    job_url = f"https://example.com/jobs/{suffix}"
    conn.execute(
        "INSERT INTO jobs (url, title, discovered_at) VALUES (?, ?, ?)",
        (job_url, f"Job {suffix}", "2026-07-14T08:00:00+00:00"),
    )
    conn.commit()
    return job_url


def test_execution_ref_is_serializable_across_every_discovery_handoff() -> None:
    execution = _execution("temporal-run-serialized")
    source = DiscoverySourceActivityInput(
        tenant_id=str(LOCAL_TENANT),
        family="jobspy",
        discovery_execution=execution,
    )
    enrichment = DiscoveryEnrichmentActivityInput(
        tenant_id=str(LOCAL_TENANT),
        discovery_execution=execution,
    )
    fanout = DiscoveryPreparationFanoutInput(
        tenant_id=str(LOCAL_TENANT),
        discovery_execution=execution,
        cohort_kind="existing_backlog",
    )
    preparation = JobPreparationInput(
        tenant_id=str(LOCAL_TENANT),
        job_url="https://example.com/jobs/serialized",
        steps=["score"],
        target_version="1",
        idempotency_key="preparation:serialized",
        discovery_execution=execution,
        discovery_cohort_kind="existing_backlog",
    )

    expected = {
        "tenant_id": "local",
        "workflow_id": "discover-local",
        "temporal_run_id": "temporal-run-serialized",
    }
    assert asdict(source)["discovery_execution"] == expected
    assert asdict(enrichment)["discovery_execution"] == expected
    assert asdict(fanout)["discovery_execution"] == expected
    assert asdict(preparation)["discovery_execution"] == expected
    assert _input_summary(preparation)["discoveryExecution"] == {
        "tenantId": "local",
        "workflowId": "discover-local",
        "temporalRunId": "temporal-run-serialized",
    }
    assert _input_summary(preparation)["discoveryCohortKind"] == "existing_backlog"


def test_source_observation_retry_links_once_without_rewriting_first_link(
    conn: sqlite3.Connection,
) -> None:
    job_url = _insert_job(conn, "retry")
    execution = _execution("temporal-run-1")
    repository = SqliteJobRepository(
        conn,
        discovery_execution=execution,
        source_family="jobspy",
    )

    repository.attach_source_observation(
        LOCAL_TENANT,
        JobId(job_url),
        JobSourceObservation(
            source_observation_id="observation-1",
            source_id="jobspy:indeed",
            source_native_id="native-1",
            observed_url=job_url,
            run_id="source-run-original",
            observed_at="2026-07-14T09:00:00+00:00",
        ),
    )
    repository.attach_source_observation(
        LOCAL_TENANT,
        JobId(job_url),
        JobSourceObservation(
            source_observation_id="observation-2",
            source_id="jobspy:indeed",
            source_native_id="native-1",
            observed_url=job_url,
            run_id="source-run-retry",
            observed_at="2026-07-14T09:05:00+00:00",
        ),
    )

    lineage = SqliteDiscoveryExecutionRepository(conn).get(execution, job_url)
    assert lineage is not None
    assert lineage.source_run_id == "source-run-original"
    assert lineage.linked_at == "2026-07-14T09:00:00+00:00"
    assert conn.execute("SELECT COUNT(*) FROM discovery_execution_jobs").fetchone()[0] == 1

    # The source observation remains mutable metadata and is intentionally not
    # the authority for the immutable execution link above.
    source_row = conn.execute(
        "SELECT run_id, observed_at FROM job_source_observations WHERE job_url = ?",
        (job_url,),
    ).fetchone()
    assert tuple(source_row) == ("source-run-retry", "2026-07-14T09:05:00+00:00")


def test_later_temporal_run_inserts_history_instead_of_reusing_membership(
    conn: sqlite3.Connection,
) -> None:
    job_url = _insert_job(conn, "history")
    repository = SqliteDiscoveryExecutionRepository(conn)
    first = _execution("temporal-run-old")
    second = _execution("temporal-run-new")

    repository.link_job(
        first,
        job_url,
        cohort_kind="observed_this_run",
        source_family="workday",
        source_run_id="source-old",
        linked_at="2026-07-13T09:00:00+00:00",
    )
    repository.link_job(
        second,
        job_url,
        cohort_kind="observed_this_run",
        source_family="ats_api",
        source_run_id="source-new",
        linked_at="2026-07-14T09:00:00+00:00",
    )

    first_membership = repository.get(first, job_url)
    second_membership = repository.get(second, job_url)
    assert first_membership is not None
    assert second_membership is not None
    assert first_membership.source_run_id == "source-old"
    assert second_membership.source_run_id == "source-new"
    assert conn.execute("SELECT COUNT(*) FROM discovery_execution_jobs").fetchone()[0] == 2


def test_observed_promotion_wins_transactionally_without_double_count(
    conn: sqlite3.Connection,
) -> None:
    job_url = _insert_job(conn, "promotion")
    execution = _execution("temporal-run-promotion")
    repository = SqliteDiscoveryExecutionRepository(conn)

    repository.link_job(
        execution,
        job_url,
        cohort_kind="existing_backlog",
        linked_at="2026-07-14T08:55:00+00:00",
    )
    repository.set_work_plan(
        execution,
        job_url,
        state="planned",
        required_steps=["tailor", "cover", "pdf"],
        preparation_workflow_id="prep-backlog-job",
    )
    promoted = repository.link_job(
        execution,
        job_url,
        cohort_kind="observed_this_run",
        source_family="jobspy",
        source_run_id="source-current",
        linked_at="2026-07-14T09:00:00+00:00",
    )
    attempted_reverse = repository.link_job(
        execution,
        job_url,
        cohort_kind="existing_backlog",
        linked_at="2026-07-14T09:10:00+00:00",
    )

    assert promoted.cohort_kind == "observed_this_run"
    assert attempted_reverse.cohort_kind == "observed_this_run"
    assert attempted_reverse.source_family == "jobspy"
    assert attempted_reverse.source_run_id == "source-current"
    assert attempted_reverse.linked_at == "2026-07-14T08:55:00+00:00"
    assert attempted_reverse.preparation_workflow_id == "prep-backlog-job"
    assert attempted_reverse.required_steps == ("tailor", "cover", "pdf")
    assert conn.execute("SELECT COUNT(*) FROM discovery_execution_jobs").fetchone()[0] == 1


def test_promoted_job_keeps_existing_plan_instead_of_starting_parallel_work(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_url = _insert_job(conn, "promoted-plan")
    execution = _execution("temporal-run-promoted-plan")
    repository = SqliteDiscoveryExecutionRepository(conn)
    repository.link_job(execution, job_url, cohort_kind="existing_backlog")
    repository.set_work_plan(
        execution,
        job_url,
        state="planned",
        required_steps=["tailor", "cover", "pdf"],
        preparation_workflow_id="prep-existing-plan",
    )
    repository.link_job(
        execution,
        job_url,
        cohort_kind="observed_this_run",
        source_family="jobspy",
        source_run_id="source-current",
    )
    replacement = preparation_pipeline.PreparationTarget(
        job_url=job_url,
        idempotency_key="replacement-plan",
        target_version="4",
        steps=["score", "tailor", "cover", "pdf"],
    )
    started: list[str] = []

    monkeypatch.setattr(preparation_pipeline, "get_connection", lambda: conn)
    monkeypatch.setattr(
        preparation_pipeline,
        "derive_preparation_targets",
        lambda _payload: [replacement],
    )

    async def starter(spec):
        started.append(spec.workflow_id)
        return SimpleNamespace(id=spec.workflow_id)

    result = preparation_pipeline.start_discovery_preparation_workflows(
        tenant_id=LOCAL_TENANT,
        workflow_starter=starter,
        discovery_execution=execution,
    )

    membership = repository.get(execution, job_url)
    assert membership is not None
    assert membership.cohort_kind == "observed_this_run"
    assert membership.preparation_workflow_id == "prep-existing-plan"
    assert membership.required_steps == ("tailor", "cover", "pdf")
    assert started == []
    assert result["started"] == {"job_preparation": 0}


def test_pre_run_selection_can_form_an_existing_backlog_only_cohort(
    conn: sqlite3.Connection,
) -> None:
    execution = _execution("temporal-run-backlog-only")
    repository = SqliteDiscoveryExecutionRepository(conn)
    first_url = _insert_job(conn, "backlog-a")
    second_url = _insert_job(conn, "backlog-b")

    for job_url in (first_url, second_url):
        repository.link_job(execution, job_url, cohort_kind="existing_backlog")

    memberships = repository.list_for_execution(execution)
    assert [membership.job_url for membership in memberships] == sorted(
        [first_url, second_url]
    )
    assert {membership.cohort_kind for membership in memberships} == {"existing_backlog"}


def test_pre_run_fanout_links_selected_target_and_propagates_lineage(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execution = _execution("temporal-run-pre-run-sweep")
    job_url = _insert_job(conn, "selected-backlog")
    target = preparation_pipeline.PreparationTarget(
        job_url=job_url,
        idempotency_key="preparation:selected-backlog",
        target_version="3",
        steps=["tailor", "cover", "pdf"],
    )
    started_inputs: list[JobPreparationInput] = []

    monkeypatch.setattr(preparation_pipeline, "get_connection", lambda: conn)
    monkeypatch.setattr(
        preparation_pipeline,
        "derive_preparation_targets",
        lambda _payload: [target],
    )

    async def starter(spec):
        started_inputs.append(spec.args[0])
        return SimpleNamespace(id=spec.workflow_id)

    preparation_pipeline.start_discovery_preparation_workflows(
        tenant_id=LOCAL_TENANT,
        workflow_starter=starter,
        discovery_execution=execution,
        discovery_cohort_kind="existing_backlog",
    )

    membership = SqliteDiscoveryExecutionRepository(conn).get(execution, job_url)
    assert membership is not None
    assert membership.cohort_kind == "existing_backlog"
    assert membership.work_plan_state == "planned"
    assert membership.required_steps == ("tailor", "cover", "pdf")
    assert membership.preparation_workflow_id == "prep-preparation:selected-backlog"
    assert started_inputs[0].discovery_execution == execution
    assert started_inputs[0].discovery_cohort_kind == "existing_backlog"


def test_terminal_fanout_decides_every_unselected_observed_membership(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execution = _execution("temporal-run-terminal-decisions")
    repository = SqliteDiscoveryExecutionRepository(conn)
    below_threshold_url = _insert_job(conn, "below-threshold")
    unresolved_url = _insert_job(conn, "unresolved")
    conn.execute("UPDATE jobs SET fit_score = 4 WHERE url = ?", (below_threshold_url,))
    conn.commit()
    for job_url in (below_threshold_url, unresolved_url):
        repository.link_job(
            execution,
            job_url,
            cohort_kind="observed_this_run",
            source_family="jobspy",
            source_run_id="source-terminal",
        )

    monkeypatch.setattr(preparation_pipeline, "get_connection", lambda: conn)
    monkeypatch.setattr(
        preparation_pipeline,
        "derive_preparation_targets",
        lambda _payload: [],
    )

    preparation_pipeline.start_discovery_preparation_workflows(
        tenant_id=LOCAL_TENANT,
        min_score=7,
        discovery_execution=execution,
        finalize_observed_work_plans=True,
    )

    below_threshold = repository.get(execution, below_threshold_url)
    unresolved = repository.get(execution, unresolved_url)
    assert below_threshold is not None
    assert below_threshold.work_plan_state == "not_eligible"
    assert below_threshold.work_plan_reason == "score_below_threshold"
    assert unresolved is not None
    assert unresolved.work_plan_state == "failed"
    assert unresolved.work_plan_reason == "preparation_target_not_selected"
    assert all(
        membership.work_plan_state != "pending"
        for membership in repository.list_for_execution(execution)
        if membership.cohort_kind == "observed_this_run"
    )


def test_derivation_failure_marks_pending_observed_membership_failed(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execution = _execution("temporal-run-derivation-failure")
    job_url = _insert_job(conn, "derivation-failure")
    repository = SqliteDiscoveryExecutionRepository(conn)
    repository.link_job(
        execution,
        job_url,
        cohort_kind="observed_this_run",
        source_family="ats_api",
        source_run_id="source-failure",
    )
    monkeypatch.setattr(preparation_pipeline, "get_connection", lambda: conn)

    def fail_derivation(_payload):
        raise RuntimeError("synthetic derivation failure")

    monkeypatch.setattr(
        preparation_pipeline,
        "derive_preparation_targets",
        fail_derivation,
    )

    with pytest.raises(RuntimeError, match="synthetic derivation failure"):
        preparation_pipeline.start_discovery_preparation_workflows(
            tenant_id=LOCAL_TENANT,
            discovery_execution=execution,
        )

    membership = repository.get(execution, job_url)
    assert membership is not None
    assert membership.work_plan_state == "failed"
    assert membership.work_plan_reason == "target_derivation_failed"
    assert membership.has_required_work is None


def test_planning_failure_marks_pending_observed_membership_failed(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execution = _execution("temporal-run-planning-failure")
    job_url = _insert_job(conn, "planning-failure")
    repository = SqliteDiscoveryExecutionRepository(conn)
    repository.link_job(
        execution,
        job_url,
        cohort_kind="observed_this_run",
        source_family="workday",
        source_run_id="source-planning-failure",
    )
    target = preparation_pipeline.PreparationTarget(
        job_url=job_url,
        idempotency_key="preparation:planning-failure",
        target_version="2",
        steps=["score", "tailor", "cover", "pdf"],
    )
    monkeypatch.setattr(preparation_pipeline, "get_connection", lambda: conn)
    monkeypatch.setattr(
        preparation_pipeline,
        "derive_preparation_targets",
        lambda _payload: [target],
    )

    def fail_planning(*_args, **_kwargs):
        raise RuntimeError("synthetic planning failure")

    monkeypatch.setattr(
        preparation_pipeline,
        "_workflow_spec_for_target",
        fail_planning,
    )

    with pytest.raises(RuntimeError, match="synthetic planning failure"):
        preparation_pipeline.start_discovery_preparation_workflows(
            tenant_id=LOCAL_TENANT,
            discovery_execution=execution,
        )

    membership = repository.get(execution, job_url)
    assert membership is not None
    assert membership.work_plan_state == "failed"
    assert membership.work_plan_reason == "work_plan_persistence_failed"
    assert membership.has_required_work is None


def test_pending_and_failed_work_plans_are_never_reported_as_no_work(
    conn: sqlite3.Connection,
) -> None:
    execution = _execution("temporal-run-plans")
    repository = SqliteDiscoveryExecutionRepository(conn)
    failed_url = _insert_job(conn, "failed-plan")
    excluded_url = _insert_job(conn, "explicitly-excluded")

    pending = repository.link_job(
        execution,
        failed_url,
        cohort_kind="observed_this_run",
        source_family="ats_api",
        source_run_id="source-plan",
    )
    assert pending.required_steps is None
    assert pending.required_work_decided is False
    assert pending.has_required_work is None

    failed = repository.set_work_plan(
        execution,
        failed_url,
        state="failed",
        reason="target_derivation_failed",
    )
    assert failed.required_steps is None
    assert failed.required_work_decided is False
    assert failed.has_required_work is None

    planned = repository.set_work_plan(
        execution,
        failed_url,
        state="planned",
        required_steps=["pdf", "score", "tailor", "cover", "score"],
        preparation_workflow_id="prep-recovered-plan",
    )
    retried = repository.set_work_plan(
        execution,
        failed_url,
        state="planned",
        required_steps=["score", "tailor", "cover", "pdf"],
        preparation_workflow_id="prep-recovered-plan",
    )
    assert planned.required_steps == ("score", "tailor", "cover", "pdf")
    assert retried == planned
    assert planned.has_required_work is True

    repository.link_job(
        execution,
        excluded_url,
        cohort_kind="observed_this_run",
        source_family="workday",
        source_run_id="source-plan",
    )
    excluded = repository.set_work_plan(
        execution,
        excluded_url,
        state="not_eligible",
        reason="no_preparation_required",
    )
    assert excluded.required_work_decided is True
    assert excluded.has_required_work is False
