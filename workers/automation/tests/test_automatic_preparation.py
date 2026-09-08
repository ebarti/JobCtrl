"""Saved jobs resume without discovery; recovery never overrides a stop decision."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from types import SimpleNamespace

import pytest
from temporalio.client import WorkflowExecutionStatus
from temporalio.converter import DataConverter
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.service import RPCError, RPCStatusCode

from jobctrl.database import init_db
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.pipeline import automatic_preparation as recovery
from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state

_OLD = "2026-01-01T00:00:00+00:00"
_NOW = datetime(2026, 9, 6, tzinfo=timezone.utc)


@pytest.fixture
def conn(tmp_path, monkeypatch):
    connection = init_db(tmp_path / "recovery.db")
    monkeypatch.setattr("jobctrl.database.get_connection", lambda: connection)
    monkeypatch.setattr("jobctrl.llm.read_spend_budget_status", lambda: SimpleNamespace(exceeded=False))
    monkeypatch.setattr("jobctrl.infrastructure.scoring.criteria_provider.read_min_fit_score", lambda **_: 7)
    yield connection
    connection.close()


def _job(conn, number=1, *, state="failed", attempts=1, retryable=True, enriched=False, tenant="local"):
    job_id = canonical_job_id(f"10000000-0000-4000-8000-{number:012d}")
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) VALUES (?, ?, ?, 'Role', 'synthetic', ?)",
        (tenant, str(job_id), f"https://example.test/jobs/{number}", _OLD),
    )
    ensure_job_stage_rows(conn, job_id, tenant_id=tenant, discovered_at=_OLD)
    conn.execute(
        "INSERT INTO job_enrichments (tenant_id, job_id, current_status, full_description, attempts_json, updated_at) "
        "VALUES (?, ?, ?, ?, '[]', ?)",
        (
            tenant,
            str(job_id),
            "enriched" if enriched else "failed",
            "Build Python services." if enriched else None,
            _OLD,
        ),
    )
    set_stage_state(
        conn,
        job_id,
        "enrich",
        "succeeded" if enriched else state,
        tenant_id=tenant,
        attempt_count=attempts,
        retryable=retryable,
        error_code=None if enriched else "DETAIL_ERROR",
        validate_transition=False,
    )
    conn.execute(
        "UPDATE job_stage_states SET updated_at = ? WHERE tenant_id = ? AND job_id = ?", (_OLD, tenant, str(job_id))
    )
    conn.commit()
    return job_id


def _stage(conn, job_id, stage="enrich"):
    return dict(
        conn.execute(
            "SELECT * FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = ?",
            (str(job_id), stage),
        ).fetchone()
    )


class _Client:
    def __init__(self):
        self.statuses = {}
        self.starts = []
        self.active = False
        self.unavailable = False
        self.lose_ack = False
        self.describes = []
        self.histories = {}
        self.data_converter = DataConverter.default

    async def list_workflows(self, **kwargs):
        assert "ExecutionStatus = 'Running'" in kwargs["query"]
        if self.unavailable:
            raise RPCError("unavailable", RPCStatusCode.UNAVAILABLE, b"")
        if self.active:
            yield SimpleNamespace()

    def get_workflow_handle(self, workflow_id, *, run_id=None):
        async def describe():
            self.describes.append((workflow_id, run_id))
            key = (workflow_id, run_id) if run_id else workflow_id
            if key not in self.statuses:
                raise RPCError("not found", RPCStatusCode.NOT_FOUND, b"")
            status = self.statuses[key]
            if isinstance(status, BaseException):
                raise status
            return SimpleNamespace(status=status, run_id=run_id or f"run:{workflow_id}")

        async def fetch_history():
            return self.histories.get(workflow_id, SimpleNamespace(events=[]))

        return SimpleNamespace(describe=describe, fetch_history=fetch_history)

    async def start_workflow(self, workflow, payload, **kwargs):
        self.starts.append((workflow, payload, kwargs))
        self.statuses[kwargs["id"]] = WorkflowExecutionStatus.RUNNING
        if self.lose_ack:
            raise RPCError("lost acknowledgement", RPCStatusCode.UNAVAILABLE, b"")
        return SimpleNamespace()


async def _tick(client):
    return await recovery.reconcile_automatic_preparation(
        client,
        task_queue="recovery-test",
        expected_app_dir="/test/app",
        expected_db_path="/test/app/recovery.db",
    )


def test_failed_enrichment_is_reserved_once_with_attempt_history(conn):
    job_id = _job(conn)
    # Use the domain serialization so this is an audit-preservation test, not
    # a hand-written approximation of the repository's attempt format.
    from jobctrl.domain.enrichment.aggregate import JobEnrichment
    from jobctrl.domain.enrichment.value_objects import EnrichmentError, ExtractionTier
    from jobctrl.infrastructure.enrichment.sqlite_repository import SqliteEnrichmentRepository

    aggregate = JobEnrichment.empty(tenant_id=LOCAL_TENANT, job_id=job_id, updated_at=_OLD)
    aggregate = aggregate.start_attempt(extraction_tier=ExtractionTier.CSS_SELECTORS, started_at=_OLD)
    aggregate = aggregate.fail_attempt(
        error=EnrichmentError(code="detail_error", message="no data", retryable=True), finished_at=_OLD
    )
    repository = SqliteEnrichmentRepository(conn)
    repository.save(aggregate)
    before = repository.load(LOCAL_TENANT, job_id)
    first = recovery.reserve_recovery_batch(conn, now=_NOW)
    second = recovery.reserve_recovery_batch(conn, now=_NOW)
    assert first == second
    assert first.job_ids == (job_id,)
    assert first.stage == "enrich"
    assert _stage(conn, job_id)["attempt_count"] == 1
    assert repository.load(LOCAL_TENANT, job_id).attempts == before.attempts
    assert repository.load(LOCAL_TENANT, job_id).current_status == "pending"
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type = 'StageQueued'").fetchone()[0] == 1


@pytest.mark.parametrize(
    "state,attempts,retryable",
    [
        ("canceled", 0, True),
        ("blocked", 1, True),
        ("exhausted", 5, True),
        ("failed", 5, True),
        ("failed", 1, False),
        ("succeeded", 1, True),
    ],
)
def test_terminal_safety_and_attempt_decisions_are_not_reset(conn, state, attempts, retryable):
    job_id = _job(conn, state=state, attempts=attempts, retryable=retryable)
    before = _stage(conn, job_id)
    assert recovery.reserve_recovery_batch(conn, now=_NOW) is None
    assert _stage(conn, job_id) == before


def test_cooldown_and_configured_attempt_ceiling(conn):
    job_id = _job(conn, attempts=2)
    conn.execute(
        "UPDATE job_stage_states SET updated_at = ? WHERE job_id = ? AND stage = 'enrich'",
        ((_NOW - timedelta(seconds=239)).isoformat(), str(job_id)),
    )
    conn.commit()
    assert recovery.reserve_recovery_batch(conn, now=_NOW) is None
    conn.execute(
        "UPDATE job_stage_states SET updated_at = ?, max_attempts = 2 WHERE job_id = ? AND stage = 'enrich'",
        (_OLD, str(job_id)),
    )
    conn.commit()
    assert recovery.reserve_recovery_batch(conn, now=_NOW) is None


def test_deleted_closed_and_other_tenant_jobs_are_excluded(conn):
    deleted = _job(conn, 1)
    closed = _job(conn, 2)
    _job(conn, 3, tenant="other")
    conn.execute(
        "INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at) VALUES ('local', ?, ?)", (str(deleted), _OLD)
    )
    conn.execute(
        "INSERT INTO posting_snapshot_sets (tenant_id, job_id, latest_active_state, snapshot_set_json, updated_at) VALUES ('local', ?, 'closed', '{}', ?)",
        (str(closed), _OLD),
    )
    conn.commit()
    assert recovery.reserve_recovery_batch(conn, now=_NOW) is None


def test_pending_score_is_preferred_and_never_starts_apply(conn):
    _job(conn, 1)
    ready = _job(conn, 2, enriched=True)
    client = _Client()
    assert asyncio.run(_tick(client)) == 1
    _, payload, options = client.starts[0]
    assert payload.stages == ["score"]
    assert payload.job_ids == (ready,)
    assert payload.automatic_recovery is True
    assert not payload.rescore and not payload.retailor and not payload.suppress_existing_artifacts
    assert options["id_conflict_policy"] is WorkflowIDConflictPolicy.USE_EXISTING
    assert options["id_reuse_policy"] is WorkflowIDReusePolicy.REJECT_DUPLICATE


def test_lost_ack_and_second_worker_reattach_to_the_reserved_execution(conn):
    job_id = _job(conn)
    client = _Client()
    client.lose_ack = True
    with pytest.raises(RPCError):
        asyncio.run(_tick(client))
    reserved = _stage(conn, job_id)
    assert reserved["state"] == "queued"
    assert asyncio.run(_tick(client)) == 0
    assert len(client.starts) == 1
    assert _stage(conn, job_id) == reserved


def test_crash_before_dispatch_reuses_the_frozen_batch_after_restart(conn):
    job_id = _job(conn)
    batch = recovery.reserve_recovery_batch(conn, now=_NOW)
    # Independent connection models a second worker process after the first
    # committed its reservation but died before calling Temporal.
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    with sqlite3.connect(path) as second:
        second.row_factory = sqlite3.Row
        assert recovery.reserve_recovery_batch(second, now=_NOW) == batch
    client = _Client()
    assert asyncio.run(_tick(client)) == 1
    assert client.starts[0][1].job_ids == (job_id,)
    assert client.starts[0][2]["id"] == batch.workflow_id


@pytest.mark.parametrize(
    "status,expected",
    [
        (WorkflowExecutionStatus.CANCELED, "canceled"),
        (WorkflowExecutionStatus.FAILED, "blocked"),
        (WorkflowExecutionStatus.COMPLETED, "blocked"),
    ],
)
def test_unconsumed_closed_batch_stops_instead_of_restarting_forever(conn, status, expected):
    job_id = _job(conn)
    batch = recovery.reserve_recovery_batch(conn, now=_NOW)
    client = _Client()
    client.statuses[batch.workflow_id] = status
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, job_id)["state"] == expected
    assert asyncio.run(_tick(client)) == 0
    assert client.starts == []


async def _interrupted_history(batch, *, canceled=False, timed_out=True, automatic=True):
    from temporalio.api.common.v1 import Payloads
    from temporalio.api.enums.v1 import TimeoutType
    from temporalio.api.history.v1 import HistoryEvent

    events = [HistoryEvent(event_id=1), HistoryEvent(event_id=2), HistoryEvent(event_id=3)]
    start = events[0].workflow_execution_started_event_attributes
    start.workflow_type.name = "JobPipelineWorkflow"
    start.original_execution_run_id = f"run:{batch.workflow_id}"
    start.input.CopyFrom(Payloads(payloads=await DataConverter.default.encode([{
        "tenant_id": "local", "stages": [batch.stage], "job_ids": list(batch.job_ids),
        "min_score": batch.min_score, "automatic_recovery": automatic,
    }])))
    scheduled = events[1].activity_task_scheduled_event_attributes
    scheduled.activity_type.name = batch.stage
    scheduled.input.CopyFrom(Payloads(payloads=await DataConverter.default.encode([{
        "recovery_workflow_id": batch.workflow_id, "job_ids": list(batch.job_ids),
        "workflow_id": batch.workflow_id if batch.stage == "enrich" else f"run:{batch.workflow_id}",
        **({"workflow_run_id": f"run:{batch.workflow_id}"} if batch.stage == "enrich" else {}),
    }])))
    events[2].activity_task_started_event_attributes.scheduled_event_id = 2
    if timed_out:
        timeout = HistoryEvent(event_id=4)
        attrs = timeout.activity_task_timed_out_event_attributes
        attrs.scheduled_event_id = 2
        attrs.started_event_id = 3
        attrs.failure.timeout_failure_info.timeout_type = TimeoutType.TIMEOUT_TYPE_HEARTBEAT
        events.append(timeout)
    if canceled:
        cancel = HistoryEvent(event_id=5)
        cancel.workflow_execution_cancel_requested_event_attributes.SetInParent()
        events.append(cancel)
    return SimpleNamespace(events=events)


def _consumed_reservation(conn, batch, job_id):
    before = _stage(conn, job_id, batch.stage)
    set_stage_state(
        conn, job_id, batch.stage, "failed", attempt_count=before["attempt_count"] + 1,
        error_code=f"{batch.stage.upper()}_ACTIVITY_OWNER_STOPPED", retryable=True,
        metadata={"recoveredFromWorkflowId": f"run:{batch.workflow_id}"}, validate_transition=False,
    )
    record_job_event(
        conn, job_id, batch.stage, "StageFailed",
        payload={"workflowId": f"run:{batch.workflow_id}", "reason": "orphaned_activity_failed",
                 "attemptCount": before["attempt_count"] + 1},
    )
    conn.commit()


@pytest.mark.parametrize("already_blocked", [False, True])
def test_interrupted_batch_releases_only_unconsumed_reservations_without_spending_attempts(conn, already_blocked):
    consumed, unstarted = _job(conn, 1), _job(conn, 2)
    batch = recovery.reserve_recovery_batch(conn, now=_NOW)
    _consumed_reservation(conn, batch, consumed)
    if already_blocked:
        recovery._settle_closed_reservation(conn, batch, WorkflowExecutionStatus.COMPLETED)
    before = _stage(conn, unstarted)
    client = _Client()
    client.statuses[batch.workflow_id] = WorkflowExecutionStatus.COMPLETED
    client.histories[batch.workflow_id] = asyncio.run(_interrupted_history(batch))
    assert asyncio.run(_tick(client)) == 0
    after = _stage(conn, unstarted)
    assert after["state"] == "pending"
    assert after["retryable"] == 1
    assert (after["attempt_count"], after["max_attempts"]) == (before["attempt_count"], before["max_attempts"])
    assert _stage(conn, consumed)["attempt_count"] == 2
    assert asyncio.run(_tick(client)) == 0  # The normal cooldown still applies.
    assert client.starts == []


@pytest.mark.parametrize("guard", [
    "canceled", "terminated", "cancel_requested", "not_timeout", "not_automatic", "no_progress",
    "copied_reset_history", "wrong_activity_owner",
])
def test_closed_reservation_requires_interruption_and_durable_progress_before_release(conn, guard):
    consumed, unstarted = _job(conn, 1), _job(conn, 2)
    batch = recovery.reserve_recovery_batch(conn, now=_NOW)
    if guard != "no_progress":
        _consumed_reservation(conn, batch, consumed)
    client = _Client()
    client.statuses[batch.workflow_id] = {
        "canceled": WorkflowExecutionStatus.CANCELED,
        "terminated": WorkflowExecutionStatus.TERMINATED,
    }.get(guard, WorkflowExecutionStatus.COMPLETED)
    client.histories[batch.workflow_id] = asyncio.run(_interrupted_history(
        batch, canceled=guard == "cancel_requested", timed_out=guard != "not_timeout",
        automatic=guard != "not_automatic",
    ))
    if guard == "copied_reset_history":
        client.histories[batch.workflow_id].events[0].workflow_execution_started_event_attributes.original_execution_run_id = "original-run"
    if guard == "wrong_activity_owner":
        from temporalio.api.common.v1 import Payloads

        scheduled = client.histories[batch.workflow_id].events[1].activity_task_scheduled_event_attributes
        data = asyncio.run(DataConverter.default.decode(scheduled.input.payloads))[0]
        data["workflow_run_id"] = "another-run"
        scheduled.input.CopyFrom(Payloads(payloads=asyncio.run(DataConverter.default.encode([data]))))
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, unstarted)["state"] in {"blocked", "canceled"}
    assert client.starts == []


def test_unavailable_temporal_and_live_work_prevent_mutation(conn):
    job_id = _job(conn)
    before = _stage(conn, job_id)
    client = _Client()
    client.unavailable = True
    with pytest.raises(RPCError):
        asyncio.run(_tick(client))
    client.unavailable = False
    client.active = True
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, job_id) == before


def test_budget_halt_does_not_reserve_or_dispatch(conn, monkeypatch):
    job_id = _job(conn)
    before = _stage(conn, job_id)
    monkeypatch.setattr("jobctrl.llm.read_spend_budget_status", lambda: SimpleNamespace(exceeded=True))
    client = _Client()
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, job_id) == before
    assert client.starts == []


def test_execution_rechecks_cancellation_and_never_expands_an_empty_cohort(conn, monkeypatch):
    from jobctrl.enrichment.activities import EnrichActivityInput, _run_selected_enrichment

    job_id = _job(conn)
    batch = recovery.reserve_recovery_batch(conn, now=_NOW)
    set_stage_state(conn, job_id, "enrich", "canceled", attempt_count=1, validate_transition=False)
    conn.commit()

    def unexpected(*_args, **_kwargs):
        pytest.fail("Canceled selected recovery must not become an unscoped enrichment sweep")

    monkeypatch.setattr("jobctrl.enrichment.detail._run_detail_scraper", unexpected)
    result = _run_selected_enrichment(
        EnrichActivityInput(
            tenant_id="local",
            job_ids=(job_id,),
            recovery_workflow_id=batch.workflow_id,
        )
    )
    assert result["stages"][0]["enrichedJobIds"] == []
    assert _stage(conn, job_id)["state"] == "canceled"


def test_batch_size_is_bounded(conn):
    for number in range(1, 31):
        _job(conn, number)
    batch = recovery.reserve_recovery_batch(conn, now=_NOW)
    assert len(batch.job_ids) == 25
    assert conn.execute("SELECT COUNT(*) FROM job_stage_states WHERE state = 'queued'").fetchone()[0] == 25


@pytest.mark.parametrize("veto", [None, "request", "terminal_lease", "different_run", "failed_workflow"])
def test_historical_handoff_repair_requires_positive_exact_run_evidence(conn, veto):
    from jobctrl.state import record_job_event

    job_id = _job(conn, state="canceled", attempts=0)
    metadata = {
        "workflowId": "discover-local",
        "temporalRunId": "discovery-1",
        "cancellationReason": "workflow_canceled",
        "recoveryReason": "transient_interruption",
    }
    conn.execute(
        "UPDATE job_stage_states SET metadata_json = ? WHERE job_id = ? AND stage = 'enrich'",
        (json.dumps(metadata), str(job_id)),
    )
    conn.execute(
        "INSERT INTO workflow_run_projections (workflow_id, tenant_id, workflow_type, status, temporal_run_id, finished_at) "
        "VALUES ('discover-local', 'local', 'DiscoverWorkflow', ?, 'discovery-1', '2026-01-01T00:05:00Z')",
        ("failed" if veto == "failed_workflow" else "succeeded",),
    )
    execution = {"workflowId": "discover-local", "runId": "different" if veto == "different_run" else "discovery-1"}
    record_job_event(
        conn,
        None,
        "enrich",
        "EnrichmentLeaseClaimed",
        occurred_at="2026-01-01T00:01:00Z",
        payload={"execution": execution, "activityPhase": 2},
    )
    if veto == "request":
        record_job_event(
            conn,
            None,
            "workflow",
            "WorkflowCancellationRequested",
            payload={"workflowId": "discover-local", "temporalRunId": "discovery-1"},
        )
    if veto == "terminal_lease":
        record_job_event(
            conn, None, "enrich", "EnrichmentLeaseClaimed", payload={"execution": execution, "activityPhase": 3}
        )
    conn.commit()
    assert recovery.reserve_recovery_batch(conn, now=_NOW) is None
    assert _stage(conn, job_id)["state"] == ("pending" if veto is None else "canceled")
    assert _stage(conn, job_id)["attempt_count"] == 0


def test_saved_enrichment_reaches_real_scoring_without_discovery(conn, monkeypatch):
    from jobctrl.domain.scoring import ScoringCriteria
    from jobctrl.infrastructure.scoring import SqliteScoreRepository
    from jobctrl.scoring import scorer
    from jobctrl.scoring.activities import ScoreActivityInput, _run_selected_scores
    from .test_v7_score_runtime import _StrongLlm, _profile_snapshot

    job_id = _job(conn, enriched=True)
    client = _Client()
    assert asyncio.run(_tick(client)) == 1
    batch = client.starts[0][1]
    real_score = scorer.score_job_by_id
    llm = _StrongLlm()
    monkeypatch.setattr(scorer, "get_connection", lambda: conn)

    def score_with_synthetic_inputs(job_id, **kwargs):
        return real_score(
            job_id,
            **kwargs,
            profile_snapshot=_profile_snapshot(LOCAL_TENANT),
            resume_text="Python platform engineer.",
            criteria=ScoringCriteria(),
            repository=SqliteScoreRepository(conn),
            llm_port=llm,
            require_employer_analysis=False,
        )

    monkeypatch.setattr(scorer, "score_job_by_id", score_with_synthetic_inputs)
    result = _run_selected_scores(
        ScoreActivityInput(
            tenant_id="local",
            job_ids=batch.job_ids,
            workflow_id="recovery-run-1",
            recovery_workflow_id=client.starts[0][2]["id"],
        )
    )
    assert result["status"] == "ok"
    assert llm.calls == 1
    saved = conn.execute("SELECT version, fit_score FROM job_scores WHERE job_id = ?", (str(job_id),)).fetchall()
    assert [tuple(row) for row in saved] == [(1, 8)]
    assert _stage(conn, job_id, "score")["state"] == "succeeded"
    # A heartbeat can advance to materials, but must never rescore a saved
    # score or re-enrich its source merely because preparation resumed.
    next_batch = recovery.reserve_recovery_batch(conn, now=datetime.now(timezone.utc) + timedelta(hours=1))
    assert next_batch is None or next_batch.stage == "tailor"
    assert conn.execute("SELECT COUNT(*) FROM job_scores WHERE job_id = ?", (str(job_id),)).fetchone()[0] == 1
    assert all(start[1].stages != ["discover"] for start in client.starts)


@pytest.mark.parametrize("committed", [False, True])
def test_cancel_running_automatic_score_preserves_committed_result(conn, committed):
    from jobctrl.infrastructure.preparation_recovery import CancelPreparationStateInput, cancel_preparation_state_rows

    job_id = _job(conn, enriched=True)
    set_stage_state(
        conn,
        job_id,
        "score",
        "running",
        attempt_count=2,
        metadata={"activityOwner": "recovery-run"},
        validate_transition=False,
    )
    if committed:
        conn.execute(
            "INSERT INTO job_scores (tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at, criteria_json, trace_json) VALUES ('local', ?, 1, 8, '{}', '[]', ?, '{}', '{}')",
            (str(job_id), _OLD),
        )
    conn.commit()
    result = cancel_preparation_state_rows(
        conn,
        CancelPreparationStateInput(
            tenant_id="local",
            workflow_id="recovery-run",
            stage="score",
            job_ids=(str(job_id),),
        ),
    )
    assert _stage(conn, job_id, "score")["state"] == ("succeeded" if committed else "canceled")
    assert result.restored == int(committed)
    assert result.canceled == int(not committed)


@pytest.mark.parametrize("stage", ["score", "tailor", "cover"])
@pytest.mark.parametrize(
    "status, expected",
    [
        (WorkflowExecutionStatus.TERMINATED, "failed"),
        (WorkflowExecutionStatus.CANCELED, "canceled"),
        (WorkflowExecutionStatus.RUNNING, "running"),
        (None, "running"),
    ],
)
def test_stopped_owner_requires_exact_history_and_preserves_cancel(conn, stage, status, expected):
    job_id = _job(conn, enriched=True)
    workflow_id, run_id = "prepare-auto-local-" + stage + "-test", "exact-run"
    set_stage_state(
        conn,
        job_id,
        stage,
        "running",
        attempt_count=2,
        max_attempts=5,
        validate_transition=False,
        metadata={
            "activityOwner": run_id,
            "automaticRecovery": True,
            "workflowId": workflow_id,
            "temporalRunId": run_id,
            "attemptCountBasis": "completed",
        },
    )
    conn.commit()
    client = _Client()
    # A newer run sharing the workflow ID is not authority over this row.
    client.statuses[workflow_id] = WorkflowExecutionStatus.TERMINATED
    if status is not None:
        client.statuses[(workflow_id, run_id)] = status
    asyncio.run(recovery._reconcile_stopped_activity_owners(client, conn))
    assert client.describes == [(workflow_id, run_id)]
    assert _stage(conn, job_id, stage)["state"] == expected
    assert _stage(conn, job_id, stage)["attempt_count"] == (3 if expected == "failed" else 2)


def test_history_unavailable_does_not_release_owner(conn):
    job_id = _job(conn, enriched=True)
    set_stage_state(
        conn,
        job_id,
        "score",
        "running",
        attempt_count=2,
        validate_transition=False,
        metadata={
            "activityOwner": "exact-run",
            "automaticRecovery": True,
            "workflowId": "prepare-auto-local-score-test",
            "temporalRunId": "exact-run",
        },
    )
    conn.commit()
    before = _stage(conn, job_id, "score")
    client = _Client()
    client.statuses[("prepare-auto-local-score-test", "exact-run")] = RPCError(
        "unavailable", RPCStatusCode.UNAVAILABLE, b""
    )
    with pytest.raises(RPCError):
        asyncio.run(_tick(client))
    assert _stage(conn, job_id, "score") == before
    assert client.starts == []


def test_stopped_score_owner_restores_committed_result(conn):
    job_id = _job(conn, enriched=True)
    set_stage_state(
        conn,
        job_id,
        "score",
        "running",
        attempt_count=2,
        validate_transition=False,
        metadata={
            "activityOwner": "exact-run",
            "automaticRecovery": True,
            "workflowId": "prepare-auto-local-score-test",
            "temporalRunId": "exact-run",
        },
    )
    conn.execute(
        "INSERT INTO job_scores (tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at, criteria_json, trace_json) VALUES ('local', ?, 1, 8, '{}', '[]', ?, '{}', '{}')",
        (str(job_id), _OLD),
    )
    conn.commit()
    client = _Client()
    client.statuses[("prepare-auto-local-score-test", "exact-run")] = WorkflowExecutionStatus.TERMINATED
    asyncio.run(recovery._reconcile_stopped_activity_owners(client, conn))
    assert _stage(conn, job_id, "score")["state"] == "succeeded"
    assert _stage(conn, job_id, "score")["attempt_count"] == 3
    assert conn.execute("SELECT COUNT(*) FROM job_scores WHERE job_id = ?", (str(job_id),)).fetchone()[0] == 1


@pytest.mark.parametrize("status,cancellation_fenced", [
    (WorkflowExecutionStatus.TERMINATED, False), (WorkflowExecutionStatus.CANCELED, False),
    (None, False), (WorkflowExecutionStatus.TERMINATED, True),
])
def test_enrichment_owner_recovery_fences_late_worker_and_counts_attempt(conn, status, cancellation_fenced):
    from jobctrl.domain.enrichment import StaleEnrichmentExecutionLease
    from jobctrl.enrichment.detail import _claim_enrich_job_for_activity
    from jobctrl.infrastructure.enrichment.execution_lease import (
        claim_enrichment_execution_lease_for_run,
        fence_enrichment_execution_lease,
    )
    from jobctrl.infrastructure.enrichment.sqlite_repository import SqliteEnrichmentRepository

    job_id = _job(conn)
    batch = recovery.reserve_recovery_batch(conn, now=_NOW)
    run_id = "exact-enrich-run"
    conn.execute(
        "UPDATE job_stage_states SET metadata_json = json_set(metadata_json, '$.temporalRunId', ?) WHERE job_id = ? AND stage = 'enrich'",
        (run_id, str(job_id)),
    )
    conn.commit()
    lease = claim_enrichment_execution_lease_for_run(
        conn,
        tenant_id=LOCAL_TENANT,
        workflow_id=batch.workflow_id,
        run_id=run_id,
        owner_token="old-enrichment-activity",
        activity_phase=1,
        activity_attempt=1,
    )
    _claim_enrich_job_for_activity(conn, job_id, started_at=_OLD, tenant_id=LOCAL_TENANT, activity_lease=lease)
    conn.commit()
    client = _Client()
    if cancellation_fenced:
        claim_enrichment_execution_lease_for_run(conn, tenant_id=LOCAL_TENANT, workflow_id=batch.workflow_id,
            run_id=run_id, owner_token=f"cancellation:{batch.workflow_id}:{run_id}", activity_phase=3, activity_attempt=1)
    if status is not None:
        client.statuses[(batch.workflow_id, run_id)] = status
    asyncio.run(recovery._reconcile_stopped_enrichment_owners(client, conn))
    state = _stage(conn, job_id)
    if status is None:
        assert state["state"] == "running"
        assert state["attempt_count"] == 1
        return
    canceled = status == WorkflowExecutionStatus.CANCELED or cancellation_fenced
    assert state["state"] == ("canceled" if canceled else "failed")
    assert state["attempt_count"] == (1 if canceled else 2)
    with pytest.raises(StaleEnrichmentExecutionLease):
        fence_enrichment_execution_lease(conn, lease)
    conn.rollback()
    if not canceled:
        aggregate = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, job_id)
        assert aggregate.is_failed
        assert aggregate.last_attempt.error.code == "ENRICH_ACTIVITY_OWNER_STOPPED"
    assert client.describes == [(batch.workflow_id, run_id)]


@pytest.mark.parametrize("scraper_release", [False, True])
def test_unclaimed_enrichment_failure_keeps_one_stopped_reservation(conn, scraper_release):
    from jobctrl.enrichment.detail import _release_unstarted_enrichment_cohort

    job_id = _job(conn)
    batch = recovery.reserve_recovery_batch(conn, now=_NOW)
    conn.execute(
        "UPDATE job_stage_states SET metadata_json = json_set(metadata_json, '$.temporalRunId', 'run-1') "
        "WHERE job_id = ? AND stage = 'enrich'", (str(job_id),),
    )
    conn.commit()
    if scraper_release:
        _release_unstarted_enrichment_cohort(
            conn, (job_id,), tenant_id=LOCAL_TENANT,
            workflow_id=batch.workflow_id, workflow_run_id="run-1",
        )
    client = _Client()
    client.statuses[batch.workflow_id] = WorkflowExecutionStatus.FAILED
    client.statuses[(batch.workflow_id, "run-1")] = WorkflowExecutionStatus.FAILED
    for _ in range(4):
        asyncio.run(_tick(client))
        conn.execute("UPDATE job_stage_states SET updated_at = ?", (_OLD,))
        conn.commit()
    row = _stage(conn, job_id)
    assert row["state"] == "blocked"
    assert row["error_code"] == "PREPARATION_RECOVERY_STOPPED"
    assert row["attempt_count"] == 1
    assert client.starts == []
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type = 'StageQueued'").fetchone()[0] == 1


@pytest.mark.parametrize("workers", [1, 2])
def test_material_reservation_loss_at_claim_is_isolated_to_one_job(workers):
    from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost
    from jobctrl.materials.executor import run_material_jobs

    revoked, next_job = [canonical_job_id(f"10000000-0000-4000-8000-{i:012d}") for i in (1, 2)]
    attempted = []

    def run_one(job_id):
        if job_id == revoked:
            raise PreparationReservationLost("reservation revoked during admission")
        attempted.append(job_id)
        return {"status": "approved"}

    result = run_material_jobs((revoked, next_job), workers=workers, cancel_event=None, stage="tailor", run_one=run_one)
    assert attempted == [next_job]
    assert result[0][1]["reason"] == "reservation_lost"
    assert result[1][1]["status"] == "approved"
