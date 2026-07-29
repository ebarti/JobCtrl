from __future__ import annotations

import json
import sqlite3
import uuid

import pytest

import jobctrl.discovery.execution_reconciliation as execution_reconciliation
from jobctrl.database import init_db
from jobctrl.discovery.execution_reconciliation import (
    LegacyActivityAttempt,
    LegacyDiscoveryRecoveryError,
    LegacyStep,
    _append_missing_step_events,
    _ensure_recovery_manifest_table,
    _exact_legacy_work_plans,
    _LEGACY_WORK_PLAN_REASON_CODE,
    _native_step_keys_v1,
    _recovery_key_digest,
    _write_recovery_manifest,
    decode_legacy_discovery_history_v1,
    legacy_steps_v1,
)
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.execution import validate_safe_reason_code
from jobctrl.domain.events.operations import (
    PipelineStepCompletedPayload,
    PipelineStepDetailCode,
    PipelineStepKind,
    PipelineStepQueuedPayload,
    PipelineStepSafeDetail,
    PipelineStepStartedPayload,
    create_pipeline_step_completed,
    create_pipeline_step_queued,
    create_pipeline_step_started,
)
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.sqlite_execution_repository import (
    SqliteDiscoveryExecutionRepository,
)
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.state import record_job_event


def _legacy_records() -> list[dict[str, object]]:
    return [
        {
            "kind": "scheduled",
            "event_id": 5,
            "event_time": "2026-07-16T08:00:00+00:00",
            "activity_type": "plan_discovery_sources",
            "payload": {"tenant_id": "local"},
        },
        {
            "kind": "started",
            "scheduled_event_id": 5,
            "event_time": "2026-07-16T08:00:01+00:00",
            "attempt": 1,
        },
        {
            "kind": "completed",
            "scheduled_event_id": 5,
            "event_time": "2026-07-16T08:00:02+00:00",
            "result": {"families": ["jobspy", "ats_api"]},
        },
        {
            "kind": "scheduled",
            "event_id": 8,
            "event_time": "2026-07-16T08:00:03+00:00",
            "activity_type": "discovery_enrichment",
            "payload": {"tenant_id": "local", "progress_total": 0},
        },
        {
            "kind": "started",
            "scheduled_event_id": 8,
            "event_time": "2026-07-16T08:00:04+00:00",
            "attempt": 1,
        },
        {
            "kind": "completed",
            "scheduled_event_id": 8,
            "event_time": "2026-07-16T08:00:05+00:00",
            "result": {"passes": 3},
        },
        {
            "kind": "scheduled",
            "event_id": 11,
            "event_time": "2026-07-16T08:00:06+00:00",
            "activity_type": "discovery_preparation_fanout",
            "payload": {
                "tenant_id": "local",
                "progress_total": 0,
                "include_pending_tailor": False,
            },
        },
        {
            "kind": "started",
            "scheduled_event_id": 11,
            "event_time": "2026-07-16T08:00:07+00:00",
            "attempt": 1,
        },
        {
            "kind": "completed",
            "scheduled_event_id": 11,
            "event_time": "2026-07-16T08:00:08+00:00",
            "result": {"targets": 72},
        },
    ]


def test_decodes_current_legacy_history_shape_into_exact_steps() -> None:
    attempts, skipped = decode_legacy_discovery_history_v1(_legacy_records())
    assert skipped == 0
    assert [attempt.scheduled_event_id for attempt in attempts] == [5, 8, 11]

    steps = legacy_steps_v1(attempts)
    assert [(step.step_kind, step.item_key, step.detail_code, step.item_count) for step in steps] == [
        ("source_planning", "plan", "source_plan", 2),
        ("enrichment_pass", "streaming:pass-1", "streaming_pass", 3),
        ("preparation_fanout", "streaming:pass-1", "streaming_pass", 72),
    ]


def test_legacy_recovery_uses_a_persistable_reason_code() -> None:
    assert validate_safe_reason_code(_LEGACY_WORK_PLAN_REASON_CODE) == "legacy_history_recovery"


def test_new_lineaged_activity_is_skipped() -> None:
    records = _legacy_records()
    scheduled = dict(records[0])
    scheduled["payload"] = {
        "tenant_id": "local",
        "discovery_execution": {
            "tenant_id": "local",
            "workflow_id": "discover-local",
            "temporal_run_id": "run-new",
        },
    }
    records[0] = scheduled

    attempts, skipped = decode_legacy_discovery_history_v1(records)
    assert skipped == 1
    assert [attempt.scheduled_event_id for attempt in attempts] == [8, 11]


def test_retry_without_exact_attempt_schedule_time_omits_queue_fact() -> None:
    records = _legacy_records()
    started = dict(records[1])
    started["attempt"] = 2
    records[1] = started
    attempts, skipped = decode_legacy_discovery_history_v1(records)
    assert skipped == 0
    assert attempts[0].attempt == 2
    assert attempts[0].queued_at is None
    assert attempts[0].started_at == "2026-07-16T08:00:01+00:00"
    assert attempts[0].finished_at == "2026-07-16T08:00:02+00:00"


def test_temporal_retry_state_distinguishes_pending_and_exhausted_failures() -> None:
    assert execution_reconciliation._failure_retryable(None, 1) is True
    assert execution_reconciliation._failure_retryable(None, 6) is True
    assert execution_reconciliation._failure_retryable(None, 4) is False
    assert execution_reconciliation._failure_retryable(None, 5) is False


def test_step_event_recovery_is_idempotent_after_partial_rerun(tmp_path) -> None:
    conn = init_db(tmp_path / "recovery.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-legacy",
    )
    step = LegacyStep(
        scheduled_event_id=5,
        step_kind="source_planning",
        item_key="plan",
        detail_code="source_plan",
        item_count=2,
        queued_at="2026-07-16T08:00:00+00:00",
        started_at="2026-07-16T08:00:01+00:00",
        finished_at="2026-07-16T08:00:02+00:00",
        attempt=1,
        state="succeeded",
        error_code="activity-failed",
        retryable=True,
    )

    # Simulate a crash after only the queued event was made durable.
    assert _append_missing_step_events(conn, execution, step) == 3
    conn.commit()
    conn.execute("DELETE FROM job_events WHERE event_type != 'PipelineStepQueued'")
    conn.commit()

    assert _append_missing_step_events(conn, execution, step) == 2
    conn.commit()
    assert _append_missing_step_events(conn, execution, step) == 0
    assert [row["event_type"] for row in conn.execute("SELECT event_type FROM job_events ORDER BY event_id")] == [
        "PipelineStepQueued",
        "PipelineStepStarted",
        "PipelineStepCompleted",
    ]


def _preparation_event_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE job_events (
            event_id INTEGER PRIMARY KEY,
            occurred_at TEXT,
            event_type TEXT,
            payload_json TEXT
        )
        """
    )
    # Match the live lossy read model: only jobUrl survived the fold. The
    # decoder must not read this projection as causal evidence.
    conn.execute(
        """
        CREATE TABLE workflow_run_projections (
            workflow_id TEXT PRIMARY KEY,
            input_summary_json TEXT
        )
        """
    )
    return conn


def _fanout_attempt(
    scheduled_event_id: int,
    *,
    started_at: str,
    finished_at: str,
    targets: int,
) -> LegacyActivityAttempt:
    return LegacyActivityAttempt(
        scheduled_event_id=scheduled_event_id,
        activity_type="discovery_preparation_fanout",
        payload={"tenant_id": "local"},
        result={"started": targets, "queued": targets, "targets": targets},
        queued_at=started_at,
        started_at=started_at,
        finished_at=finished_at,
        attempt=1,
        state="succeeded",
    )


def _insert_preparation_started(
    conn: sqlite3.Connection,
    event_id: int,
    *,
    occurred_at: str,
    workflow_id: str,
    job_url: str,
    full: bool,
    steps: list[str] | None = None,
    temporal_run_id: str | None = None,
) -> None:
    summary: dict[str, object] = {"jobUrl": job_url}
    if full:
        summary.update(
            {
                "steps": steps or ["score", "tailor", "cover", "pdf"],
                "targetVersion": "1",
                "idempotencyKey": workflow_id.removeprefix("prep-"),
            }
        )
    conn.execute(
        "INSERT INTO job_events VALUES (?, ?, 'WorkflowStarted', ?)",
        (
            event_id,
            occurred_at,
            json.dumps(
                {
                    "tenantId": "local",
                    "workflowId": workflow_id,
                    "temporalRunId": temporal_run_id or f"run-{workflow_id}",
                    "workflowType": "JobPreparationWorkflow",
                    "inputSummary": summary,
                }
            ),
        ),
    )


def _completed_activity_records(
    scheduled_event_id: int,
    *,
    activity_type: str,
    payload: dict[str, object],
    result: dict[str, object],
    queued_at: str,
    started_at: str,
    finished_at: str,
) -> list[dict[str, object]]:
    return [
        {
            "kind": "scheduled",
            "history_event_id": scheduled_event_id,
            "event_id": scheduled_event_id,
            "event_time": queued_at,
            "activity_type": activity_type,
            "payload": payload,
        },
        {
            "kind": "started",
            "history_event_id": scheduled_event_id + 1,
            "scheduled_event_id": scheduled_event_id,
            "event_time": started_at,
            "attempt": 1,
        },
        {
            "kind": "completed",
            "history_event_id": scheduled_event_id + 2,
            "scheduled_event_id": scheduled_event_id,
            "event_time": finished_at,
            "result": result,
        },
    ]


def _append_workflow_started(
    conn: sqlite3.Connection,
    *,
    occurred_at: str,
    workflow_id: str,
    temporal_run_id: str,
    input_summary: dict[str, object],
) -> None:
    job_url = input_summary.get("jobUrl")
    if isinstance(job_url, str):
        _ensure_job_identity(conn, job_url)
    record_job_event(
        conn,
        None,
        "workflow",
        "WorkflowStarted",
        payload={
            "tenantId": "local",
            "workflowId": workflow_id,
            "temporalRunId": temporal_run_id,
            "workflowType": "JobPreparationWorkflow",
            "inputSummary": input_summary,
        },
        occurred_at=occurred_at,
    )


def _ensure_job_identity(
    conn: sqlite3.Connection,
    job_url: str,
    *,
    tenant_id: str = "local",
) -> None:
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").fetchone() is None:
        return
    job_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{tenant_id}:{job_url}"))
    conn.execute(
        """
        INSERT OR IGNORE INTO jobs (url, tenant_id, job_id, title)
        VALUES (?, ?, ?, 'Recovery fixture')
        """,
        (job_url, tenant_id, job_id),
    )
    row = conn.execute(
        "SELECT job_id FROM jobs WHERE tenant_id = ? AND url = ?",
        (tenant_id, job_url),
    ).fetchone()
    assert row is not None
    conn.execute(
        """
        INSERT OR IGNORE INTO job_identity_aliases (
            tenant_id, alias_kind, alias_value, job_id, created_at
        ) VALUES (?, 'posting_url', ?, ?, '2026-07-16T00:00:00+00:00')
        """,
        (tenant_id, job_url, str(row["job_id"])),
    )


def _append_native_completed_step(
    conn: sqlite3.Connection,
    execution: DiscoveryExecutionRef,
    *,
    step_kind: PipelineStepKind,
    item_key: str,
    detail_code: PipelineStepDetailCode,
) -> None:
    tenant_id = TenantId(execution.tenant_id)
    detail = PipelineStepSafeDetail(code=detail_code, item_count=1)
    events = (
        create_pipeline_step_queued(
            tenant_id,
            PipelineStepQueuedPayload(
                execution=execution,
                step_kind=step_kind,
                item_key=item_key,
                attempt=1,
                queued_at="2026-07-16T11:00:00+00:00",
                detail=detail,
            ),
        ),
        create_pipeline_step_started(
            tenant_id,
            PipelineStepStartedPayload(
                execution=execution,
                step_kind=step_kind,
                item_key=item_key,
                attempt=1,
                started_at="2026-07-16T11:00:01+00:00",
                detail=detail,
            ),
        ),
        create_pipeline_step_completed(
            tenant_id,
            PipelineStepCompletedPayload(
                execution=execution,
                step_kind=step_kind,
                item_key=item_key,
                attempt=1,
                completed_at="2026-07-16T11:00:02+00:00",
                duration_ms=1_000,
                detail=detail,
            ),
        ),
    )
    for event in events:
        record_job_event(
            conn,
            None,
            "workflow",
            event.event_type,
            payload=dict(event.payload),
            occurred_at=event.occurred_at,
        )


def test_work_plan_recovery_uses_causal_fanout_ids_and_unions_overlap() -> None:
    conn = _preparation_event_db()
    fanouts = [
        _fanout_attempt(
            10,
            started_at="2026-07-16T08:00:00+00:00",
            finished_at="2026-07-16T08:01:00+00:00",
            targets=2,
        ),
        _fanout_attempt(
            20,
            started_at="2026-07-16T08:02:00+00:00",
            finished_at="2026-07-16T08:03:00+00:00",
            targets=2,
        ),
    ]
    causal = [
        (1, "2026-07-16T08:00:10+00:00", "prep-a", "job:a"),
        (2, "2026-07-16T08:00:20+00:00", "prep-b", "job:b"),
        (3, "2026-07-16T08:02:10+00:00", "prep-b", "job:b"),
        (4, "2026-07-16T08:02:20+00:00", "prep-c", "job:c"),
    ]
    for event_id, occurred_at, workflow_id, job_url in causal:
        _insert_preparation_started(
            conn,
            event_id,
            occurred_at=occurred_at,
            workflow_id=workflow_id,
            job_url=job_url,
            full=False,
        )
    for index, (workflow_id, job_url) in enumerate(
        (("prep-a", "job:a"), ("prep-b", "job:b"), ("prep-c", "job:c")),
        start=5,
    ):
        conn.execute(
            "INSERT INTO workflow_run_projections VALUES (?, ?)",
            (workflow_id, json.dumps({"jobUrl": job_url})),
        )
        _insert_preparation_started(
            conn,
            index,
            occurred_at=f"2026-07-16T08:04:0{index}+00:00",
            workflow_id=workflow_id,
            job_url=job_url,
            full=True,
            steps=["tailor", "score", "pdf"],
        )

    assert _exact_legacy_work_plans(conn, fanouts, tenant_id="local") == {
        "job:a": ("prep-a", ("score", "tailor", "pdf")),
        "job:b": ("prep-b", ("score", "tailor", "pdf")),
        "job:c": ("prep-c", ("score", "tailor", "pdf")),
    }


@pytest.mark.asyncio
async def test_decoder_v2_recovers_exact_legacy_fanouts_and_resumes_partial_replay(
    tmp_path,
    monkeypatch,
) -> None:
    conn = init_db(tmp_path / "decoder-v2-exact.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-decoder-v2",
    )
    records: list[dict[str, object]] = []
    scheduled_event_id = 100

    # Eight distinct legacy enrichment keys plus the four exact fanout passes
    # make the twelve legacy keys required by the recovery contract.
    for pass_index in range(8):
        progress_total = 0 if pass_index < 7 else 72
        records.extend(
            _completed_activity_records(
                scheduled_event_id,
                activity_type="discovery_enrichment",
                payload={"tenant_id": "local", "progress_total": progress_total},
                result={"passes": pass_index + 1},
                queued_at=f"2026-07-16T08:{pass_index:02d}:00+00:00",
                started_at=f"2026-07-16T08:{pass_index:02d}:01+00:00",
                finished_at=f"2026-07-16T08:{pass_index:02d}:02+00:00",
            )
        )
        scheduled_event_id += 3

    fanout_counts = (0, 71, 67, 34)
    for pass_index, target_count in enumerate(fanout_counts):
        records.extend(
            _completed_activity_records(
                scheduled_event_id,
                activity_type="discovery_preparation_fanout",
                payload={
                    "tenant_id": "local",
                    "progress_total": 0,
                    "include_pending_tailor": False,
                },
                result={
                    "started": target_count,
                    "queued": target_count,
                    "targets": target_count,
                },
                queued_at=f"2026-07-16T09:{pass_index:02d}:00+00:00",
                started_at=f"2026-07-16T09:{pass_index:02d}:01+00:00",
                finished_at=f"2026-07-16T09:{pass_index:02d}:59+00:00",
            )
        )
        scheduled_event_id += 3

    native_execution = {
        "tenant_id": execution.tenant_id,
        "workflow_id": execution.workflow_id,
        "temporal_run_id": execution.temporal_run_id,
    }
    native_specs = (
        (
            "plan_discovery_sources",
            {},
            ("source_planning", "plan"),
            "source_plan",
        ),
        (
            "discovery_source_family",
            {"family": "native-api"},
            ("source_family", "family:native-api"),
            "source_family",
        ),
        (
            "discovery_enrichment",
            {"pipeline_step_item_key": "native:enrichment"},
            ("enrichment_pass", "native:enrichment"),
            "streaming_pass",
        ),
        (
            "discovery_preparation_fanout",
            {
                "pipeline_step_kind": "existing_backlog_sweep",
                "pipeline_step_item_key": "existing_backlog",
            },
            ("existing_backlog_sweep", "existing_backlog"),
            "existing_backlog",
        ),
    )
    for native_index, (activity_type, payload, _step_key, _detail_code) in enumerate(native_specs):
        minute = 10 + native_index
        records.extend(
            _completed_activity_records(
                scheduled_event_id,
                activity_type=activity_type,
                payload={**payload, "discovery_execution": native_execution},
                result={},
                queued_at=f"2026-07-16T11:{minute:02d}:00+00:00",
                started_at=f"2026-07-16T11:{minute:02d}:01+00:00",
                finished_at=f"2026-07-16T11:{minute:02d}:02+00:00",
            )
        )
        scheduled_event_id += 3
    records.append(
        {
            "kind": "watermark",
            "history_event_id": 1_000,
            "event_time": "2026-07-16T12:00:00+00:00",
        }
    )

    attempts, skipped_native = decode_legacy_discovery_history_v1(records)
    legacy_steps = legacy_steps_v1(attempts)
    legacy_step_keys = {(step.step_kind, step.item_key) for step in legacy_steps}
    expected_legacy_step_keys = {
        *(("enrichment_pass", f"streaming:pass-{index}") for index in range(1, 8)),
        ("enrichment_pass", "terminal"),
        *(("preparation_fanout", f"streaming:pass-{index}") for index in range(1, 5)),
    }
    native_step_keys = {step_key for _, _, step_key, _ in native_specs}
    assert [step.item_count for step in legacy_steps if step.step_kind == "preparation_fanout"] == [
        0,
        71,
        67,
        34,
    ]
    assert skipped_native == 4
    assert legacy_step_keys == expected_legacy_step_keys
    assert len(legacy_step_keys) == 12
    assert (
        _native_step_keys_v1(
            records,
            tenant_id=execution.tenant_id,
            workflow_id=execution.workflow_id,
            temporal_run_id=execution.temporal_run_id,
        )
        == native_step_keys
    )
    assert len(native_step_keys) == 4
    assert legacy_step_keys.isdisjoint(native_step_keys)

    job_urls = [f"https://jobs.example/{index:03d}" for index in range(72)]
    fanout_job_indexes = (
        range(0),
        range(71),
        range(5, 72),
        range(38, 72),
    )
    assert [len(set(indexes)) for indexes in fanout_job_indexes] == list(fanout_counts)
    assert len({index for indexes in fanout_job_indexes for index in indexes}) == 72

    # The job-only dispatch marker is the causal evidence inside each fanout
    # interval. The full workflow input remains append-only evidence, while a
    # later job-only marker reproduces the lossy folded projection.
    for pass_index, job_indexes in enumerate(fanout_job_indexes):
        for position, job_index in enumerate(job_indexes):
            idempotency_key = f"job-{job_index:03d}"
            _append_workflow_started(
                conn,
                occurred_at=(f"2026-07-16T09:{pass_index:02d}:10.{position:03d}+00:00"),
                workflow_id=f"prep-{idempotency_key}",
                temporal_run_id=f"prep-run-{job_index:03d}",
                input_summary={"jobUrl": job_urls[job_index]},
            )
    for job_index, job_url in enumerate(job_urls):
        idempotency_key = f"job-{job_index:03d}"
        workflow_id = f"prep-{idempotency_key}"
        temporal_run_id = f"prep-run-{job_index:03d}"
        _append_workflow_started(
            conn,
            occurred_at=f"2026-07-16T10:00:00.{job_index:03d}+00:00",
            workflow_id=workflow_id,
            temporal_run_id=temporal_run_id,
            input_summary={
                "jobUrl": job_url,
                "steps": ["pdf", "cover", "score", "tailor"],
                "targetVersion": "1",
                "idempotencyKey": idempotency_key,
            },
        )
        _append_workflow_started(
            conn,
            occurred_at=f"2026-07-16T10:01:00.{job_index:03d}+00:00",
            workflow_id=workflow_id,
            temporal_run_id=temporal_run_id,
            input_summary={"jobUrl": job_url},
        )

    for _activity_type, _payload, (step_kind, item_key), detail_code in native_specs:
        _append_native_completed_step(
            conn,
            execution,
            step_kind=step_kind,
            item_key=item_key,
            detail_code=detail_code,
        )
    conn.commit()
    ProjectionBuilder(
        conn_factory=lambda: conn,
        tenant_id=TenantId(execution.tenant_id),
    ).refresh()

    folded_summaries = conn.execute(
        """
        SELECT input_summary_json FROM workflow_run_projections
        WHERE workflow_id LIKE 'prep-job-%'
        """
    ).fetchall()
    assert len(folded_summaries) == 72
    assert all(set(json.loads(row["input_summary_json"])) == {"jobUrl"} for row in folded_summaries)

    # Simulate an interrupted recovery after the first 15 memberships and work
    # plans became durable. The four native keys already owned by their normal
    # lifecycle are the only projected step rows at the interruption point.
    repository = SqliteDiscoveryExecutionRepository(conn)
    for job_index, job_url in enumerate(job_urls[:15]):
        repository.link_job(
            execution,
            job_url,
            cohort_kind="existing_backlog",
            linked_at="2026-07-16T10:02:00+00:00",
        )
        repository.set_work_plan(
            execution,
            job_url,
            state="planned",
            required_steps=("score", "tailor", "cover", "pdf"),
            preparation_workflow_id=f"prep-job-{job_index:03d}",
            reason=_LEGACY_WORK_PLAN_REASON_CODE,
        )

    all_step_keys = legacy_step_keys | native_step_keys
    expected_digest = _recovery_key_digest(set(job_urls), all_step_keys)
    _ensure_recovery_manifest_table(conn)
    _write_recovery_manifest(
        conn,
        execution,
        state="recovering",
        mode="reconstructed",
        history_event_id=1_000,
        expected_memberships=72,
        persisted_memberships=15,
        expected_steps=16,
        persisted_steps=4,
        key_digest=expected_digest,
    )
    partial_manifest = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert partial_manifest["state"] == "recovering"
    assert partial_manifest["expected_membership_count"] == 72
    assert partial_manifest["persisted_membership_count"] == 15
    assert partial_manifest["expected_step_count"] == 16
    assert partial_manifest["persisted_step_count"] == 4

    async def normalized_history(_handle, _converter):
        return records

    monkeypatch.setattr(
        execution_reconciliation,
        "_normalize_temporal_history",
        normalized_history,
    )

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(workflow_id, *, run_id):
            assert workflow_id == execution.workflow_id
            assert run_id == execution.temporal_run_id
            return object()

    result = await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
        conn=conn,
    )
    assert result.activities_recovered == 36
    assert result.jobs_linked == 57
    assert result.work_plans_recovered == 57
    assert result.skipped_native_activities == 4

    memberships = conn.execute(
        """
        SELECT jobs.url AS job_url, execution.work_plan_state,
               execution.required_steps_json,
               execution.preparation_workflow_id,
               execution.work_plan_reason
        FROM discovery_execution_jobs AS execution
        JOIN jobs
          ON jobs.tenant_id = execution.tenant_id
         AND jobs.job_id = execution.job_id
        WHERE execution.tenant_id = ?
          AND execution.discover_workflow_id = ?
          AND execution.discover_run_id = ?
        """,
        (execution.tenant_id, execution.workflow_id, execution.temporal_run_id),
    ).fetchall()
    assert {row["job_url"] for row in memberships} == set(job_urls)
    assert all(row["work_plan_state"] == "planned" for row in memberships)
    assert all(json.loads(row["required_steps_json"]) == ["score", "tailor", "cover", "pdf"] for row in memberships)
    assert all(
        row["preparation_workflow_id"] == f"prep-job-{int(str(row['job_url']).rsplit('/', 1)[1]):03d}"
        for row in memberships
    )
    assert all(row["work_plan_reason"] == _LEGACY_WORK_PLAN_REASON_CODE for row in memberships)

    persisted_step_keys = {
        (str(row["step_kind"]), str(row["item_key"]))
        for row in conn.execute(
            """
            SELECT step_kind, item_key FROM pipeline_step_projections
            WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
            """,
            (execution.tenant_id, execution.workflow_id, execution.temporal_run_id),
        ).fetchall()
    }
    assert persisted_step_keys == all_step_keys
    assert len(persisted_step_keys) == 16

    queued_payloads = [
        json.loads(row["payload_json"])
        for row in conn.execute(
            "SELECT payload_json FROM job_events WHERE event_type = 'PipelineStepQueued'"
        ).fetchall()
    ]
    assert {
        (payload["stepKind"], payload["itemKey"])
        for payload in queued_payloads
        if payload.get("recoveredFromLegacyHistory") is True
    } == legacy_step_keys
    assert {
        (payload["stepKind"], payload["itemKey"])
        for payload in queued_payloads
        if "recoveredFromLegacyHistory" not in payload
    } == native_step_keys

    ready_manifest = dict(conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone())
    assert ready_manifest["state"] == "ready"
    assert ready_manifest["mode"] == "reconstructed"
    assert ready_manifest["decoder_version"] == 2
    assert ready_manifest["history_event_id"] == 1_000
    assert ready_manifest["expected_membership_count"] == 72
    assert ready_manifest["persisted_membership_count"] == 72
    assert ready_manifest["expected_step_count"] == 16
    assert ready_manifest["persisted_step_count"] == 16
    assert ready_manifest["key_digest"] == expected_digest
    assert ready_manifest["last_error_code"] is None

    durable_counts = {
        table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in (
            "job_events",
            "discovery_execution_jobs",
            "pipeline_step_projections",
        )
    }
    replay = await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
        conn=conn,
    )
    assert replay.activities_recovered == 0
    assert replay.jobs_linked == 0
    assert replay.work_plans_recovered == 0
    assert replay.skipped_native_activities == 0
    assert {
        table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in durable_counts
    } == durable_counts
    assert dict(conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()) == ready_manifest


def test_fanout_target_count_mismatch_is_refused() -> None:
    conn = _preparation_event_db()
    fanout = _fanout_attempt(
        10,
        started_at="2026-07-16T08:00:00+00:00",
        finished_at="2026-07-16T08:01:00+00:00",
        targets=2,
    )
    _insert_preparation_started(
        conn,
        1,
        occurred_at="2026-07-16T08:00:10+00:00",
        workflow_id="prep-a",
        job_url="job:a",
        full=False,
    )
    _insert_preparation_started(
        conn,
        2,
        occurred_at="2026-07-16T08:02:00+00:00",
        workflow_id="prep-a",
        job_url="job:a",
        full=True,
    )

    with pytest.raises(
        LegacyDiscoveryRecoveryError,
        match="preparation_fanout_target_set_mismatch",
    ):
        _exact_legacy_work_plans(conn, [fanout], tenant_id="local")


def test_causal_dispatch_cannot_use_full_summary_from_another_run() -> None:
    conn = _preparation_event_db()
    fanout = _fanout_attempt(
        10,
        started_at="2026-07-16T08:00:00+00:00",
        finished_at="2026-07-16T08:01:00+00:00",
        targets=1,
    )
    _insert_preparation_started(
        conn,
        1,
        occurred_at="2026-07-16T08:00:10+00:00",
        workflow_id="prep-a",
        job_url="job:a",
        full=False,
        temporal_run_id="causal-run",
    )
    _insert_preparation_started(
        conn,
        2,
        occurred_at="2026-07-16T08:02:00+00:00",
        workflow_id="prep-a",
        job_url="job:a",
        full=True,
        temporal_run_id="other-run",
    )

    with pytest.raises(
        LegacyDiscoveryRecoveryError,
        match="preparation_summary_not_deterministic",
    ):
        _exact_legacy_work_plans(conn, [fanout], tenant_id="local")


def test_ambiguous_preparation_mapping_is_refused() -> None:
    conn = _preparation_event_db()
    fanout = _fanout_attempt(
        10,
        started_at="2026-07-16T08:00:00+00:00",
        finished_at="2026-07-16T08:01:00+00:00",
        targets=2,
    )
    for suffix in ("a", "b"):
        event_id = 1 if suffix == "a" else 2
        _insert_preparation_started(
            conn,
            event_id,
            occurred_at=f"2026-07-16T08:00:{event_id}0+00:00",
            workflow_id=f"prep-{suffix}",
            job_url="job:one",
            full=False,
        )
        _insert_preparation_started(
            conn,
            event_id + 2,
            occurred_at=f"2026-07-16T08:02:{event_id}0+00:00",
            workflow_id=f"prep-{suffix}",
            job_url="job:one",
            full=True,
            steps=["score"],
        )
    with pytest.raises(
        LegacyDiscoveryRecoveryError,
        match="preparation_work_plan_set_mismatch",
    ):
        _exact_legacy_work_plans(conn, [fanout], tenant_id="local")


def test_active_legacy_activity_is_recovered_before_completion() -> None:
    records = _legacy_records()[:2]
    attempts, skipped = decode_legacy_discovery_history_v1(records)
    assert skipped == 0
    assert len(attempts) == 1
    assert attempts[0].state == "running"
    assert attempts[0].finished_at is None

    step = legacy_steps_v1(attempts)[0]
    assert step.state == "running"
    assert step.step_kind == "source_planning"


def test_scheduled_legacy_activity_is_recovered_as_queued() -> None:
    attempts, _ = decode_legacy_discovery_history_v1(_legacy_records()[:1])
    assert len(attempts) == 1
    assert attempts[0].state == "queued"
    assert attempts[0].started_at is None


def test_running_step_writes_queued_and_started_without_terminal(tmp_path) -> None:
    conn = init_db(tmp_path / "running.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-running",
    )
    step = LegacyStep(
        scheduled_event_id=5,
        step_kind="source_planning",
        item_key="plan",
        detail_code="source_plan",
        item_count=None,
        queued_at="2026-07-16T08:00:00+00:00",
        started_at="2026-07-16T08:00:01+00:00",
        finished_at=None,
        attempt=1,
        state="running",
        error_code="activity-failed",
        retryable=True,
    )

    assert _append_missing_step_events(conn, execution, step) == 2
    assert [row["event_type"] for row in conn.execute("SELECT event_type FROM job_events ORDER BY event_id")] == [
        "PipelineStepQueued",
        "PipelineStepStarted",
    ]


def test_native_history_declares_exact_step_keys() -> None:
    records = _legacy_records()
    for index in (0, 3, 6):
        records[index] = {
            **records[index],
            "payload": {
                **dict(records[index]["payload"]),
                "discovery_execution": {
                    "tenant_id": "local",
                    "workflow_id": "discover-local",
                    "temporal_run_id": "run-native",
                },
            },
        }
    assert _native_step_keys_v1(
        records,
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-native",
    ) == {
        ("source_planning", "plan"),
        ("enrichment_pass", "streaming:pass-1"),
        ("preparation_fanout", "streaming:pass-1"),
    }


def test_recovery_manifest_upserts_monotonic_history_watermark(tmp_path) -> None:
    conn = init_db(tmp_path / "manifest.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-manifest",
    )
    _ensure_recovery_manifest_table(conn)
    digest = _recovery_key_digest({"job:a"}, {("source_planning", "plan")})
    _write_recovery_manifest(
        conn,
        execution,
        state="recovering",
        mode="reconstructed",
        history_event_id=12,
        expected_memberships=1,
        persisted_memberships=0,
        expected_steps=1,
        persisted_steps=0,
        key_digest=digest,
    )
    _write_recovery_manifest(
        conn,
        execution,
        state="ready",
        mode="reconstructed",
        history_event_id=18,
        expected_memberships=1,
        persisted_memberships=1,
        expected_steps=1,
        persisted_steps=1,
        key_digest=digest,
    )
    _write_recovery_manifest(
        conn,
        execution,
        state="retrying",
        mode="reconstructed",
        history_event_id=15,
        expected_memberships=1,
        persisted_memberships=0,
        expected_steps=1,
        persisted_steps=0,
        key_digest=digest,
        error_code="stale-pass",
    )
    row = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert row["state"] == "ready"
    assert row["mode"] == "reconstructed"
    assert row["decoder_version"] == 2
    assert row["history_event_id"] == 18
    assert row["key_digest"] == digest
    assert row["last_error_code"] is None


@pytest.mark.asyncio
async def test_ready_manifest_retries_history_read_without_losing_durable_proof(
    tmp_path,
    monkeypatch,
) -> None:
    conn = init_db(tmp_path / "history-read-retry.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-history-retry",
    )
    repository = SqliteDiscoveryExecutionRepository(conn)
    _ensure_job_identity(conn, "job:durable")
    repository.link_job(
        execution,
        "job:durable",
        cohort_kind="existing_backlog",
        linked_at="2026-07-16T08:00:00+00:00",
    )
    _append_native_completed_step(
        conn,
        execution,
        step_kind="source_planning",
        item_key="plan",
        detail_code="source_plan",
    )
    conn.commit()
    ProjectionBuilder(
        conn_factory=lambda: conn,
        tenant_id=TenantId(execution.tenant_id),
    ).refresh()

    membership_keys = {"job:durable"}
    step_keys = {("source_planning", "plan")}
    digest = _recovery_key_digest(membership_keys, step_keys)
    _ensure_recovery_manifest_table(conn)
    _write_recovery_manifest(
        conn,
        execution,
        state="ready",
        mode="native",
        history_event_id=12,
        expected_memberships=1,
        persisted_memberships=1,
        expected_steps=1,
        persisted_steps=1,
        key_digest=digest,
    )
    ready_manifest = dict(conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone())
    durable_rows = {
        table: [dict(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()]
        for table in ("discovery_execution_jobs", "pipeline_step_projections")
    }

    records = [
        {
            "kind": "scheduled",
            "history_event_id": 9,
            "event_id": 9,
            "event_time": "2026-07-16T11:00:00+00:00",
            "activity_type": "plan_discovery_sources",
            "payload": {
                "discovery_execution": {
                    "tenant_id": execution.tenant_id,
                    "workflow_id": execution.workflow_id,
                    "temporal_run_id": execution.temporal_run_id,
                }
            },
        },
        {
            "kind": "watermark",
            "history_event_id": 12,
            "event_time": "2026-07-16T11:00:03+00:00",
        },
    ]
    attempts = 0

    async def normalized_history(_handle, _converter):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("transient history decode failure: " + ("sensitive " * 100))
        return records

    monkeypatch.setattr(execution_reconciliation, "_normalize_temporal_history", normalized_history)

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(_workflow_id, *, run_id):
            assert run_id == execution.temporal_run_id
            return object()

    with pytest.raises(RuntimeError, match="transient history decode failure"):
        await execution_reconciliation.reconcile_legacy_discovery_execution(
            FakeClient(),
            workflow_id=execution.workflow_id,
            temporal_run_id=execution.temporal_run_id,
            conn=conn,
        )

    retrying_manifest = dict(conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone())
    assert retrying_manifest == {
        **ready_manifest,
        "state": "retrying",
        "last_error_code": "temporal-history-read-failed",
        "updated_at": retrying_manifest["updated_at"],
    }
    assert len(retrying_manifest["last_error_code"]) <= 80
    assert retrying_manifest["history_event_id"] == 12
    assert retrying_manifest["mode"] == "native"
    assert retrying_manifest["expected_membership_count"] == 1
    assert retrying_manifest["expected_step_count"] == 1
    assert retrying_manifest["key_digest"] == digest
    assert {
        table: [dict(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()]
        for table in durable_rows
    } == durable_rows

    result = await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
        conn=conn,
    )
    assert result.jobs_linked == 0
    assert result.activities_recovered == 0
    restored_manifest = dict(conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone())
    assert restored_manifest["state"] == "ready"
    assert restored_manifest["last_error_code"] is None
    assert restored_manifest["history_event_id"] == 12
    assert restored_manifest["mode"] == "native"
    assert restored_manifest["expected_membership_count"] == 1
    assert restored_manifest["persisted_membership_count"] == 1
    assert restored_manifest["expected_step_count"] == 1
    assert restored_manifest["persisted_step_count"] == 1
    assert restored_manifest["key_digest"] == digest
    assert execution_reconciliation._recovery_manifest_matches_persisted_keys(
        conn,
        tenant_id=execution.tenant_id,
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
    )
    assert {
        table: [dict(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()]
        for table in durable_rows
    } == durable_rows


@pytest.mark.asyncio
async def test_retried_fanout_recovers_exact_work_without_inventing_queue_time(
    tmp_path,
    monkeypatch,
) -> None:
    conn = init_db(tmp_path / "retried-fanout.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-retried-fanout",
    )
    records = [
        {
            "kind": "scheduled",
            "history_event_id": 10,
            "event_id": 10,
            "event_time": "2026-07-16T08:00:00+00:00",
            "activity_type": "discovery_preparation_fanout",
            "payload": {
                "tenant_id": "local",
                "progress_total": 0,
                "include_pending_tailor": False,
            },
        },
        {
            "kind": "started",
            "history_event_id": 11,
            "scheduled_event_id": 10,
            "event_time": "2026-07-16T08:00:01+00:00",
            "attempt": 1,
        },
        {
            "kind": "failed",
            "history_event_id": 12,
            "scheduled_event_id": 10,
            "event_time": "2026-07-16T08:00:02+00:00",
            "error_code": "transient-fanout-failure",
            "retryable": True,
        },
        {
            "kind": "started",
            "history_event_id": 13,
            "scheduled_event_id": 10,
            "event_time": "2026-07-16T08:01:00+00:00",
            "attempt": 2,
        },
        {
            "kind": "completed",
            "history_event_id": 14,
            "scheduled_event_id": 10,
            "event_time": "2026-07-16T08:01:02+00:00",
            "result": {"started": 1, "queued": 1, "targets": 1},
        },
        {
            "kind": "watermark",
            "history_event_id": 15,
            "event_time": "2026-07-16T08:01:03+00:00",
        },
    ]
    _append_workflow_started(
        conn,
        occurred_at="2026-07-16T08:01:01+00:00",
        workflow_id="prep-retried",
        temporal_run_id="prep-run-retried",
        input_summary={"jobUrl": "job:retried"},
    )
    _append_workflow_started(
        conn,
        occurred_at="2026-07-16T08:02:00+00:00",
        workflow_id="prep-retried",
        temporal_run_id="prep-run-retried",
        input_summary={
            "jobUrl": "job:retried",
            "steps": ["score", "tailor"],
            "targetVersion": "1",
            "idempotencyKey": "retried",
        },
    )

    async def normalized_history(_handle, _converter):
        return records

    monkeypatch.setattr(execution_reconciliation, "_normalize_temporal_history", normalized_history)

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(_workflow_id, *, run_id):
            assert run_id == execution.temporal_run_id
            return object()

    result = await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
        conn=conn,
    )

    assert result.jobs_linked == 1
    assert result.work_plans_recovered == 1
    membership = conn.execute(
        """
        SELECT execution.*
        FROM discovery_execution_jobs AS execution
        JOIN jobs
          ON jobs.tenant_id = execution.tenant_id
         AND jobs.job_id = execution.job_id
        WHERE jobs.url = 'job:retried'
        """
    ).fetchone()
    assert membership["work_plan_state"] == "planned"
    assert membership["preparation_workflow_id"] == "prep-retried"
    step = conn.execute(
        """
        SELECT * FROM pipeline_step_projections
        WHERE discover_run_id = ? AND step_kind = 'preparation_fanout'
        """,
        (execution.temporal_run_id,),
    ).fetchone()
    assert step["state"] == "succeeded"
    assert step["attempt"] == 2
    assert step["queued_at"] is None
    assert step["started_at"] == "2026-07-16T08:01:00+00:00"
    assert step["finished_at"] == "2026-07-16T08:01:02+00:00"
    recovered_events = [
        (row["event_type"], json.loads(row["payload_json"]))
        for row in conn.execute(
            """
            SELECT event_type, payload_json FROM job_events
            WHERE event_type LIKE 'PipelineStep%'
            ORDER BY event_id
            """
        ).fetchall()
    ]
    assert [event_type for event_type, _payload in recovered_events] == [
        "PipelineStepStarted",
        "PipelineStepCompleted",
    ]
    assert all(payload["attempt"] == 2 for _event_type, payload in recovered_events)
    manifest = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert manifest["state"] == "ready"
    assert manifest["history_event_id"] == 15


@pytest.mark.asyncio
async def test_latest_retry_start_ignores_prior_attempt_terminal_and_stays_recovering(
    tmp_path,
    monkeypatch,
) -> None:
    conn = init_db(tmp_path / "retry-running.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-retry-running",
    )
    records = [
        {
            "kind": "scheduled",
            "history_event_id": 30,
            "event_id": 30,
            "event_time": "2026-07-16T08:00:00+00:00",
            "activity_type": "plan_discovery_sources",
            "payload": {"tenant_id": "local"},
        },
        {
            "kind": "started",
            "history_event_id": 31,
            "scheduled_event_id": 30,
            "event_time": "2026-07-16T08:00:01+00:00",
            "attempt": 1,
        },
        {
            "kind": "failed",
            "history_event_id": 32,
            "scheduled_event_id": 30,
            "started_event_id": 31,
            "event_time": "2026-07-16T08:00:02+00:00",
            "error_code": "attempt-one-failed",
            "retryable": True,
        },
        {
            "kind": "started",
            "history_event_id": 33,
            "scheduled_event_id": 30,
            "event_time": "2026-07-16T08:01:00+00:00",
            "attempt": 2,
        },
        {
            "kind": "watermark",
            "history_event_id": 34,
            "event_time": "2026-07-16T08:01:01+00:00",
        },
    ]

    async def normalized_history(_handle, _converter):
        return records

    monkeypatch.setattr(execution_reconciliation, "_normalize_temporal_history", normalized_history)

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(_workflow_id, *, run_id):
            assert run_id == execution.temporal_run_id
            return object()

    result = await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
        conn=conn,
    )

    assert result.activities_recovered == 1
    events = [
        (row["event_type"], json.loads(row["payload_json"]))
        for row in conn.execute(
            """
            SELECT event_type, payload_json FROM job_events
            WHERE event_type LIKE 'PipelineStep%'
            ORDER BY event_id
            """
        ).fetchall()
    ]
    assert [event_type for event_type, _payload in events] == ["PipelineStepStarted"]
    assert events[0][1]["attempt"] == 2
    assert events[0][1]["startedAt"] == "2026-07-16T08:01:00+00:00"
    step = conn.execute(
        "SELECT * FROM pipeline_step_projections WHERE discover_run_id = ?",
        (execution.temporal_run_id,),
    ).fetchone()
    assert step["state"] == "running"
    assert step["attempt"] == 2
    assert step["queued_at"] is None
    assert step["started_at"] == "2026-07-16T08:01:00+00:00"
    assert step["finished_at"] is None
    manifest = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert manifest["state"] == "recovering"
    assert manifest["history_event_id"] == 34
    assert manifest["last_error_code"] is None


@pytest.mark.asyncio
async def test_retry_backoff_after_retryable_failure_cannot_publish_ready(
    tmp_path,
    monkeypatch,
) -> None:
    conn = init_db(tmp_path / "retry-backoff.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-retry-backoff",
    )
    records = [
        {
            "kind": "scheduled",
            "history_event_id": 40,
            "event_id": 40,
            "event_time": "2026-07-16T09:00:00+00:00",
            "activity_type": "plan_discovery_sources",
            "payload": {"tenant_id": "local"},
        },
        {
            "kind": "started",
            "history_event_id": 41,
            "scheduled_event_id": 40,
            "event_time": "2026-07-16T09:00:01+00:00",
            "attempt": 1,
        },
        {
            "kind": "failed",
            "history_event_id": 42,
            "scheduled_event_id": 40,
            "started_event_id": 41,
            "event_time": "2026-07-16T09:00:02+00:00",
            "error_code": "retry-in-progress",
            "retryable": True,
        },
    ]

    async def normalized_history(_handle, _converter):
        return records

    monkeypatch.setattr(execution_reconciliation, "_normalize_temporal_history", normalized_history)

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(_workflow_id, *, run_id):
            assert run_id == execution.temporal_run_id
            return object()

    await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
        conn=conn,
    )

    step = conn.execute(
        "SELECT * FROM pipeline_step_projections WHERE discover_run_id = ?",
        (execution.temporal_run_id,),
    ).fetchone()
    assert step["state"] == "failed"
    assert step["retryable"] == 1
    manifest = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert manifest["state"] == "recovering"
    assert manifest["history_event_id"] == 42


@pytest.mark.asyncio
async def test_canceled_closed_fanout_is_terminal_incomplete_not_ready(
    tmp_path,
    monkeypatch,
) -> None:
    conn = init_db(tmp_path / "canceled-fanout.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-canceled-fanout",
    )
    canceled_retryable = execution_reconciliation._failure_retryable(
        None,
        0,
        canceled=True,
    )
    assert canceled_retryable is False
    records = [
        {
            "kind": "scheduled",
            "history_event_id": 50,
            "event_id": 50,
            "event_time": "2026-07-16T10:00:00+00:00",
            "activity_type": "discovery_preparation_fanout",
            "payload": {
                "tenant_id": "local",
                "progress_total": 0,
                "include_pending_tailor": False,
            },
        },
        {
            "kind": "started",
            "history_event_id": 51,
            "scheduled_event_id": 50,
            "event_time": "2026-07-16T10:00:01+00:00",
            "attempt": 1,
        },
        {
            "kind": "failed",
            "history_event_id": 52,
            "scheduled_event_id": 50,
            "started_event_id": 51,
            "event_time": "2026-07-16T10:00:02+00:00",
            "error_code": "activity-canceled",
            "retryable": canceled_retryable,
        },
    ]

    async def normalized_history(_handle, _converter):
        return records

    monkeypatch.setattr(execution_reconciliation, "_normalize_temporal_history", normalized_history)

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(_workflow_id, *, run_id):
            assert run_id == execution.temporal_run_id
            return object()

    await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
        conn=conn,
    )

    step = conn.execute(
        "SELECT * FROM pipeline_step_projections WHERE discover_run_id = ?",
        (execution.temporal_run_id,),
    ).fetchone()
    assert step["state"] == "failed"
    assert step["retryable"] == 0
    manifest = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert manifest["state"] == "incomplete"
    assert manifest["last_error_code"] == "legacy-fanout-terminal-failed"
    assert manifest["history_event_id"] == 52


@pytest.mark.asyncio
async def test_terminal_failed_fanout_persists_exact_partial_incomplete_coverage(
    tmp_path,
    monkeypatch,
) -> None:
    conn = init_db(tmp_path / "failed-fanout.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-failed-fanout",
    )
    records = [
        {
            "kind": "scheduled",
            "history_event_id": 20,
            "event_id": 20,
            "event_time": "2026-07-16T09:00:00+00:00",
            "activity_type": "discovery_preparation_fanout",
            "payload": {
                "tenant_id": "local",
                "progress_total": 0,
                "include_pending_tailor": False,
            },
        },
        {
            "kind": "started",
            "history_event_id": 21,
            "scheduled_event_id": 20,
            "event_time": "2026-07-16T09:00:01+00:00",
            "attempt": 1,
        },
        {
            "kind": "failed",
            "history_event_id": 22,
            "scheduled_event_id": 20,
            "event_time": "2026-07-16T09:00:03+00:00",
            "error_code": "fanout-exhausted",
            "retryable": False,
        },
        {
            "kind": "watermark",
            "history_event_id": 23,
            "event_time": "2026-07-16T09:00:04+00:00",
        },
    ]
    _append_workflow_started(
        conn,
        occurred_at="2026-07-16T09:00:02+00:00",
        workflow_id="prep-partial",
        temporal_run_id="prep-run-partial",
        input_summary={"jobUrl": "job:partial"},
    )
    _append_workflow_started(
        conn,
        occurred_at="2026-07-16T09:01:00+00:00",
        workflow_id="prep-partial",
        temporal_run_id="prep-run-partial",
        input_summary={
            "jobUrl": "job:partial",
            "steps": ["score"],
            "targetVersion": "1",
            "idempotencyKey": "partial",
        },
    )

    async def normalized_history(_handle, _converter):
        return records

    monkeypatch.setattr(execution_reconciliation, "_normalize_temporal_history", normalized_history)

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(_workflow_id, *, run_id):
            assert run_id == execution.temporal_run_id
            return object()

    result = await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
        conn=conn,
    )

    assert result.jobs_linked == 1
    assert result.work_plans_recovered == 1
    membership = conn.execute(
        """
        SELECT execution.*
        FROM discovery_execution_jobs AS execution
        JOIN jobs
          ON jobs.tenant_id = execution.tenant_id
         AND jobs.job_id = execution.job_id
        WHERE jobs.url = 'job:partial'
        """
    ).fetchone()
    assert membership["work_plan_state"] == "planned"
    assert membership["preparation_workflow_id"] == "prep-partial"
    step = conn.execute(
        """
        SELECT * FROM pipeline_step_projections
        WHERE discover_run_id = ? AND step_kind = 'preparation_fanout'
        """,
        (execution.temporal_run_id,),
    ).fetchone()
    assert step["state"] == "failed"
    assert step["attempt"] == 1
    assert step["queued_at"] == "2026-07-16T09:00:00+00:00"
    assert step["started_at"] == "2026-07-16T09:00:01+00:00"
    assert step["finished_at"] == "2026-07-16T09:00:03+00:00"
    assert step["error_code"] == "fanout-exhausted"
    assert step["retryable"] == 0
    manifest = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert manifest["state"] == "incomplete"
    assert manifest["last_error_code"] == "legacy-fanout-terminal-failed"
    assert manifest["history_event_id"] == 23
    assert manifest["expected_membership_count"] == 1
    assert manifest["persisted_membership_count"] == 1
    assert manifest["expected_step_count"] == 1
    assert manifest["persisted_step_count"] == 1
    assert manifest["key_digest"] == _recovery_key_digest(
        {"job:partial"},
        {("preparation_fanout", "streaming:pass-1")},
    )


def test_recovery_key_digest_has_stable_non_ascii_golden_vector() -> None:
    assert (
        _recovery_key_digest(
            {"café", "求人/東京"},
            {
                ("source_family", "família:日本"),
                ("enrichment_pass", "étape:😀"),
            },
        )
        == "e10391b8b6c6def285172f687166d666e466e740a80487934aae552e6a1e6611"
    )


@pytest.mark.asyncio
async def test_reconciliation_repairs_stale_ready_manifest(tmp_path, monkeypatch) -> None:
    conn = init_db(tmp_path / "stale-ready.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-stale",
    )
    _ensure_job_identity(conn, "job:new")
    SqliteDiscoveryExecutionRepository(conn).link_job(
        execution,
        "job:new",
        cohort_kind="existing_backlog",
        linked_at="2026-07-16T08:00:00+00:00",
    )
    _ensure_recovery_manifest_table(conn)
    _write_recovery_manifest(
        conn,
        execution,
        state="ready",
        mode="native",
        history_event_id=12,
        expected_memberships=1,
        persisted_memberships=1,
        expected_steps=0,
        persisted_steps=0,
        key_digest=_recovery_key_digest({"job:old"}, set()),
    )

    async def normalized_history(_handle, _converter):
        return [
            {
                "kind": "watermark",
                "history_event_id": 12,
                "event_time": "2026-07-16T08:00:00+00:00",
            }
        ]

    monkeypatch.setattr(execution_reconciliation, "_normalize_temporal_history", normalized_history)

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(_workflow_id, *, run_id):
            assert run_id == "run-stale"
            return object()

    result = await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
        conn=conn,
    )

    assert result.jobs_linked == 0
    row = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert row["state"] == "ready"
    assert row["expected_membership_count"] == row["persisted_membership_count"] == 1
    assert row["key_digest"] == _recovery_key_digest({"job:new"}, set())


@pytest.mark.asyncio
async def test_reconciliation_revalidates_prior_decoder_manifest(tmp_path, monkeypatch) -> None:
    conn = init_db(tmp_path / "decoder-version.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-old-decoder",
    )
    _ensure_recovery_manifest_table(conn)
    _write_recovery_manifest(
        conn,
        execution,
        state="ready",
        mode="native",
        history_event_id=0,
        expected_memberships=0,
        persisted_memberships=0,
        expected_steps=0,
        persisted_steps=0,
        key_digest=_recovery_key_digest(set(), set()),
    )
    conn.execute("UPDATE discovery_execution_recoveries SET decoder_version = 1")
    conn.commit()

    async def normalized_history(_handle, _converter):
        return []

    monkeypatch.setattr(execution_reconciliation, "_normalize_temporal_history", normalized_history)

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(_workflow_id, *, run_id):
            assert run_id == "run-old-decoder"
            return object()

    await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id=execution.workflow_id,
        temporal_run_id=execution.temporal_run_id,
        conn=conn,
    )

    row = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert row["state"] == "ready"
    assert row["decoder_version"] == 2


@pytest.mark.asyncio
async def test_native_run_is_ready_only_after_declared_step_is_projected(tmp_path, monkeypatch) -> None:
    conn = init_db(tmp_path / "native.db")
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-native",
    )
    running_step = LegacyStep(
        scheduled_event_id=1,
        step_kind="source_planning",
        item_key="plan",
        detail_code="source_plan",
        item_count=None,
        queued_at="2026-07-16T08:00:00+00:00",
        started_at="2026-07-16T08:00:01+00:00",
        finished_at=None,
        attempt=1,
        state="running",
        error_code="activity-failed",
        retryable=True,
    )
    _append_missing_step_events(conn, execution, running_step)
    conn.commit()
    records = [
        {
            "kind": "scheduled",
            "history_event_id": 1,
            "event_id": 1,
            "event_time": "2026-07-16T08:00:00+00:00",
            "activity_type": "plan_discovery_sources",
            "payload": {
                "discovery_execution": {
                    "tenant_id": "local",
                    "workflow_id": "discover-local",
                    "temporal_run_id": "run-native",
                }
            },
        },
        {
            "kind": "started",
            "history_event_id": 2,
            "scheduled_event_id": 1,
            "event_time": "2026-07-16T08:00:01+00:00",
            "attempt": 1,
        },
    ]

    async def normalized_history(_handle, _converter):
        return records

    monkeypatch.setattr(execution_reconciliation, "_normalize_temporal_history", normalized_history)

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(workflow_id, *, run_id):
            assert workflow_id == "discover-local"
            assert run_id == "run-native"
            return object()

    result = await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id="discover-local",
        temporal_run_id="run-native",
        conn=conn,
    )
    assert result.skipped_native_activities == 1
    row = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert row["state"] == "ready"
    assert row["mode"] == "native"
    assert row["history_event_id"] == 2
    assert row["expected_step_count"] == row["persisted_step_count"] == 1


@pytest.mark.asyncio
async def test_empty_native_start_has_explicit_ready_manifest(tmp_path, monkeypatch) -> None:
    conn = init_db(tmp_path / "empty-native.db")

    async def normalized_history(_handle, _converter):
        return []

    monkeypatch.setattr(execution_reconciliation, "_normalize_temporal_history", normalized_history)

    class FakeClient:
        data_converter = object()

        @staticmethod
        def get_workflow_handle(_workflow_id, *, run_id):
            assert run_id == "run-empty"
            return object()

    await execution_reconciliation.reconcile_legacy_discovery_execution(
        FakeClient(),
        workflow_id="discover-local",
        temporal_run_id="run-empty",
        conn=conn,
    )
    row = conn.execute("SELECT * FROM discovery_execution_recoveries").fetchone()
    assert row["state"] == "ready"
    assert row["mode"] == "native"
    assert row["history_event_id"] == 0
    assert row["expected_step_count"] == row["persisted_step_count"] == 0
