"""Resume durable preparation backlogs without starting another discovery run.

The queued stage row is the dispatch reservation. Its frozen batch survives a
lost Temporal acknowledgement; the deterministic workflow ID rejects a second
execution of that reservation. Each workflow runs only one stage, so every
successor is selected afresh through the canonical prerequisite predicates.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
import hashlib
import json
import sqlite3
from typing import Any

from temporalio.client import WorkflowExecutionStatus
from temporalio.api.enums.v1 import TimeoutType
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.converter import DataConverter
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from jobctrl import database
from jobctrl.config import get_cover_letter_generation_enabled
from jobctrl.infrastructure.materials.cover_letter_policy import reconcile_cover_letter_policy
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.enrichment.sqlite_repository import SqliteEnrichmentRepository
from jobctrl.infrastructure.preparation_recovery import MANUAL_APPLY_DECLINE_SQL
from jobctrl.infrastructure.temporal.concurrency import resolve_pipeline_internal_concurrency
from jobctrl.pipeline.public_fetch_recovery import reconcile_public_fetch_failures
from jobctrl.state import record_job_event, set_stage_state

_STAGES = ("score", "tailor", "cover", "enrich")
_BATCH_SIZE = 25
_ACTIVE_WORK = (
    "ExecutionStatus = 'Running' AND (WorkflowType = 'DiscoverWorkflow' "
    "OR WorkflowType = 'JobPipelineWorkflow' OR WorkflowType = 'JobPreparationWorkflow' "
    "OR WorkflowType = 'JobUrlImportWorkflow' OR WorkflowType = 'ManualCaptureImportWorkflow')"
)


@dataclass(frozen=True)
class RecoveryBatch:
    workflow_id: str
    stage: str
    job_ids: tuple[JobId, ...]
    min_score: int
    workers: int = 1
    run_id: str | None = None

    def metadata(self) -> dict[str, Any]:
        return {
            "workflowId": self.workflow_id,
            "stage": self.stage,
            "jobIds": list(self.job_ids),
            "minScore": self.min_score,
        }


@dataclass(frozen=True)
class _ActivePreparation:
    workflow_id: str
    run_id: str
    job_id: JobId
    steps: frozenset[str]
    batch_jobs: tuple[JobId, ...] = ()
    batch_workers: int = 0
    batch_min_score: int = 7


async def _active_preparation_scopes(
    client: Any, *, expected_app_dir: str, expected_db_path: str,
) -> dict[JobId, _ActivePreparation] | None:
    """Scope exact per-job and one-stage automatic cohorts; gate other producers."""
    executions = [execution async for execution in client.list_workflows(query=_ACTIVE_WORK)]
    if any(getattr(execution, "workflow_type", None) not in {"JobPreparationWorkflow", "JobPipelineWorkflow"} for execution in executions):
        return None
    scopes: dict[JobId, _ActivePreparation] = {}
    for execution in executions:
        workflow_id, run_id = getattr(execution, "id", None), getattr(execution, "run_id", None)
        if not isinstance(workflow_id, str) or not workflow_id or not isinstance(run_id, str) or not run_id:
            return None
        if execution.workflow_type == "JobPipelineWorkflow" and not workflow_id.startswith("prepare-auto-local-"):
            return None
        handle = client.get_workflow_handle(workflow_id, run_id=run_id)
        if getattr(handle, "run_id", None) != run_id:
            return None
        # A projection may be absent between activities. Read only the first
        # immutable event from the explicit run, without waiting for new events.
        events = handle.fetch_history_events(page_size=1, wait_new_event=False)
        event = await anext(events, None)
        if event is None or event.event_id != 1 or event.WhichOneof("attributes") != "workflow_execution_started_event_attributes":
            return None
        attrs = event.workflow_execution_started_event_attributes
        if attrs.workflow_type.name != execution.workflow_type or attrs.original_execution_run_id != run_id:
            return None
        raw = list(attrs.input.payloads)
        if len(raw) != 1 or len(raw[0].data) > 65536:
            return None
        try:
            decoded = await (getattr(client, "data_converter", None) or DataConverter.default).decode(raw)
            if len(decoded) != 1 or not isinstance(decoded[0], dict):
                return None
            payload = decoded[0]
            if payload.get("tenant_id") != str(LOCAL_TENANT):
                return None
            # Absent paths use the worker's configured workspace, as ordinary
            # per-job fanout does. Explicit foreign bindings must not be adopted.
            if payload.get("expected_app_dir") not in (None, expected_app_dir) or payload.get("expected_db_path") not in (None, expected_db_path):
                return None
            batch_jobs: tuple[JobId, ...] = ()
            batch_workers, batch_min_score = 0, 7
            if execution.workflow_type == "JobPreparationWorkflow":
                job_ids = (canonical_job_id(payload.get("job_id")),)
                steps = payload.get("steps")
                if not isinstance(steps, list) or not steps or any(not isinstance(step, str) or step not in {"score", "tailor", "cover", "pdf"} for step in steps):
                    return None
            else:
                steps, members = payload.get("stages"), payload.get("job_ids")
                batch_workers = payload.get("workers", 1)
                batch_min_score = payload.get("min_score", 7)
                if (
                    payload.get("automatic_recovery") is not True
                    or not isinstance(steps, list) or len(steps) != 1 or steps[0] not in _STAGES
                    or not workflow_id.startswith(f"prepare-auto-local-{steps[0]}-")
                    or not isinstance(members, list) or not 1 <= len(members) <= _BATCH_SIZE
                    or type(batch_workers) is not int or not 1 <= batch_workers <= 16
                    or type(batch_min_score) is not int
                    or payload.get("job_id") is not None
                    or payload.get("dry_run", False) is not False
                    or payload.get("continuous", False) is not False
                    or payload.get("expected_app_dir") != expected_app_dir
                    or payload.get("expected_db_path") != expected_db_path
                ):
                    return None
                job_ids = tuple(canonical_job_id(value) for value in members)
                if len(set(job_ids)) != len(job_ids):
                    return None
                batch_jobs = job_ids
            for job_id in job_ids:
                scope = _ActivePreparation(
                    workflow_id, run_id, job_id, frozenset(steps),
                    batch_jobs, batch_workers, batch_min_score,
                )
                if job_id in scopes and scopes[job_id] != scope:
                    return None
                scopes[job_id] = scope
        except (TypeError, ValueError):
            return None
    return scopes


def _owner_matches_run(metadata: dict[str, Any], stage: str, run_id: str) -> bool:
    owner = metadata.get("activityOwner")
    if owner == run_id:
        return True
    # Enrich leases use activity-id:run-id:attempt, rather than the run ID alone.
    attempt = metadata.get("activityAttempt")
    suffix = f":{run_id}:{attempt}"
    return (
        stage == "enrich" and type(attempt) is int and attempt > 0
        and isinstance(owner, str) and owner.endswith(suffix) and len(owner) > len(suffix)
    )


def _belongs_to_active_preparation(row: sqlite3.Row, scopes: dict[JobId, _ActivePreparation]) -> bool:
    scope = scopes.get(row["job_id"])
    if scope is None or row["stage"] not in scope.steps:
        return False
    try:
        metadata = json.loads(row["metadata_json"] or "{}")
    except (TypeError, ValueError):
        return False
    if not isinstance(metadata, dict):
        return False
    owner = metadata.get("activityOwner")
    if owner is not None:
        return (
            _owner_matches_run(metadata, row["stage"], scope.run_id)
            and metadata.get("workflowId") in (None, scope.workflow_id)
            and metadata.get("temporalRunId") in (None, scope.run_id)
        )
    if metadata.get("workflowId") == scope.workflow_id and metadata.get("temporalRunId") == scope.run_id:
        return True
    # The workflow can be visible before its first activity stamps a run ID.
    # Its exact immutable cohort must agree with the unchanged frozen queue row.
    saved = metadata.get("automaticPreparation")
    return (
        bool(scope.batch_jobs) and row["state"] == "queued"
        and metadata.get("workflowId") == scope.workflow_id
        and metadata.get("temporalRunId") in (None, scope.run_id)
        and isinstance(saved, dict)
        and saved.get("workflowId") == scope.workflow_id
        and saved.get("stage") == row["stage"]
        and saved.get("jobIds") == list(scope.batch_jobs)
        and saved.get("minScore") == scope.batch_min_score
    )


def _active_reservation(batch: RecoveryBatch, scopes: dict[JobId, _ActivePreparation]) -> bool:
    owners = [scopes.get(job_id) for job_id in batch.job_ids]
    return bool(owners) and all(
        owner is not None and owner.workflow_id == batch.workflow_id
        and owner.batch_jobs == batch.job_ids and owner.steps == frozenset({batch.stage})
        and owner.batch_min_score == batch.min_score and owner.run_id == owners[0].run_id
        for owner in owners
    )


def _pending_reservation_row(row: sqlite3.Row, batch: RecoveryBatch) -> bool:
    if row["state"] != "queued" or row["stage"] != batch.stage or row["job_id"] not in batch.job_ids:
        return False
    try:
        metadata = json.loads(row["metadata_json"] or "{}")
    except (TypeError, ValueError):
        return False
    if not isinstance(metadata, dict):
        return False
    run_id = metadata.get("temporalRunId")
    if run_id is not None and (not isinstance(run_id, str) or not run_id):
        return False
    return (
        (metadata.get("activityOwner") is None or (run_id is not None and _owner_matches_run(metadata, row["stage"], run_id)))
        and metadata.get("workflowId") == batch.workflow_id
        and metadata.get("automaticPreparation") == batch.metadata()
    )


def _available_recovery_workers(
    conn: sqlite3.Connection, scopes: dict[JobId, _ActivePreparation], limit: int,
) -> int:
    groups = {(scope.workflow_id, scope.run_id): scope for scope in scopes.values() if scope.batch_jobs}
    used = 0
    for scope in groups.values():
        stage = next(iter(scope.steps))  # Automatic cohorts contain exactly one stage.
        unfinished = 0
        for job_id in scope.batch_jobs:
            row = conn.execute(
                "SELECT state FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage=?",
                (str(LOCAL_TENANT), str(job_id), stage),
            ).fetchone()
            if row is None or row[0] not in {"succeeded", "failed", "exhausted", "blocked", "skipped", "canceled"}:
                unfinished += 1
        used += min(scope.batch_workers, unfinished)
    return max(0, limit - used)


async def reconcile_automatic_preparation(
    client: Any,
    *,
    task_queue: str,
    expected_app_dir: str,
    expected_db_path: str,
) -> int:
    """Dispatch one disjoint cohort within the shared recovery parallelism limit."""
    from jobctrl.infrastructure.scoring.criteria_provider import read_min_fit_score
    from jobctrl.llm import read_spend_budget_status
    from jobctrl.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput

    # Visibility errors propagate before any reservation is written. The worker
    # retries this read on its next heartbeat instead of guessing that it is idle.
    active_preparations = await _active_preparation_scopes(
        client, expected_app_dir=expected_app_dir, expected_db_path=expected_db_path,
    )
    if active_preparations is None:
        return 0
    if read_spend_budget_status(lane="scoring").global_exceeded:
        return 0
    conn = database.get_connection()
    if any(conn.execute(
        "SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=?", (str(LOCAL_TENANT), str(job_id)),
    ).fetchone() is None for job_id in active_preparations):
        return 0
    reconcile_cover_letter_policy(conn, tenant_id=LOCAL_TENANT, release_reserved=True)
    await _reconcile_stopped_enrichment_owners(client, conn)
    await _reconcile_stopped_activity_owners(client, conn)
    await _reconcile_interrupted_reservations(client, conn)
    await reconcile_public_fetch_failures(conn)
    batch = reserve_recovery_batch(
        conn, min_score=read_min_fit_score(default=7), active_preparations=active_preparations,
        internal_concurrency=resolve_pipeline_internal_concurrency(),
    )
    if batch is None:
        return 0
    try:
        description = await client.get_workflow_handle(batch.workflow_id, run_id=batch.run_id).describe()
    except RPCError as exc:
        if exc.status != RPCStatusCode.NOT_FOUND:
            raise
        if batch.run_id is not None:
            return 0  # Missing exact owner history cannot authorize a new execution.
    else:
        if batch.run_id is not None and description.run_id != batch.run_id:
            return 0
        if description.status != WorkflowExecutionStatus.RUNNING:
            _settle_closed_reservation(conn, batch, description.status, run_id=description.run_id)
        return 0

    payload = JobPipelineWorkflowInput(
        tenant_id=str(LOCAL_TENANT),
        stages=[batch.stage],
        job_ids=batch.job_ids,
        min_score=batch.min_score,
        workers=batch.workers,
        expected_app_dir=expected_app_dir,
        expected_db_path=expected_db_path,
        automatic_recovery=True,
    )
    try:
        await client.start_workflow(
            JobPipelineWorkflow.run,
            payload,
            id=batch.workflow_id,
            task_queue=task_queue,
            id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
        )
    except WorkflowAlreadyStartedError:
        # Another worker or a lost acknowledgement already dispatched this
        # exact reservation. Never mint a new ID to get around that decision.
        return 0
    return len(batch.job_ids)


async def _reconcile_stopped_enrichment_owners(client: Any, conn: sqlite3.Connection) -> None:
    """Fence a dead enrichment execution before releasing its durable cohort."""
    from jobctrl.domain.enrichment import StaleEnrichmentExecutionLease
    from jobctrl.domain.enrichment.aggregate import JobEnrichment
    from jobctrl.domain.enrichment.value_objects import EnrichmentError, ExtractionTier
    from jobctrl.enrichment.detail import cancel_enrichment_cohort
    from jobctrl.infrastructure.enrichment.execution_lease import claim_enrichment_execution_lease_for_run

    owners = conn.execute(
        "SELECT DISTINCT json_extract(metadata_json, '$.workflowId') AS workflow_id, "
        "json_extract(metadata_json, '$.temporalRunId') AS run_id FROM job_stage_states "
        "WHERE tenant_id = ? AND stage = 'enrich' AND state IN ('queued', 'running') "
        "AND json_extract(metadata_json, '$.workflowId') GLOB 'prepare-auto-local-*' "
        "AND json_extract(metadata_json, '$.temporalRunId') IS NOT NULL",
        (str(LOCAL_TENANT),),
    ).fetchall()
    for owner in owners:
        workflow_id, run_id = owner["workflow_id"], owner["run_id"]
        try:
            description = await client.get_workflow_handle(workflow_id, run_id=run_id).describe()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                continue
            raise
        if description.status == WorkflowExecutionStatus.RUNNING:
            continue
        job_ids = tuple(
            canonical_job_id(row[0])
            for row in conn.execute(
                "SELECT job_id FROM job_stage_states WHERE tenant_id = ? AND stage = 'enrich' "
                "AND state IN ('queued', 'running') AND json_extract(metadata_json, '$.workflowId') = ? "
                "AND json_extract(metadata_json, '$.temporalRunId') = ?",
                (str(LOCAL_TENANT), workflow_id, run_id),
            ).fetchall()
        )
        if description.status == WorkflowExecutionStatus.CANCELED:
            cancel_enrichment_cohort(conn, job_ids, workflow_id=workflow_id, workflow_run_id=run_id)
            continue
        try:
            claim_enrichment_execution_lease_for_run(
                conn,
                tenant_id=LOCAL_TENANT,
                workflow_id=workflow_id,
                run_id=run_id,
                owner_token=f"recovery:{workflow_id}:{run_id}",
                activity_phase=3,
                activity_attempt=1,
            )
        except StaleEnrichmentExecutionLease:
            # Cancellation may have committed its fence but lost the process
            # before settling rows. Finish that decision even if the workflow
            # subsequently failed; never turn it into an automatic retry.
            terminal = conn.execute(
                "SELECT json_extract(payload_json, '$.ownerToken'), "
                "json_extract(payload_json, '$.activityPhase'), json_extract(payload_json, '$.activityAttempt') "
                "FROM job_events WHERE entity_kind = 'discovery_enrichment_lease' "
                "AND json_extract(payload_json, '$.execution.workflowId') = ? "
                "AND json_extract(payload_json, '$.execution.runId') = ? "
                "AND tenant_id = ? ORDER BY 2 DESC, 3 DESC, event_id ASC LIMIT 1",
                (workflow_id, run_id, str(LOCAL_TENANT)),
            ).fetchone()
            if terminal is not None and tuple(terminal) == (f"cancellation:{workflow_id}:{run_id}", 3, 1):
                cancel_enrichment_cohort(conn, job_ids, workflow_id=workflow_id, workflow_run_id=run_id)
            continue
        repository = SqliteEnrichmentRepository(conn)
        now = datetime.now(timezone.utc).isoformat()
        conn.execute("BEGIN IMMEDIATE")
        try:
            for job_id in job_ids:
                row = conn.execute(
                    "SELECT * FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich' "
                    "AND state IN ('queued', 'running') AND json_extract(metadata_json, '$.workflowId') = ? "
                    "AND json_extract(metadata_json, '$.temporalRunId') = ?",
                    (str(LOCAL_TENANT), str(job_id), workflow_id, run_id),
                ).fetchone()
                if row is None:
                    continue
                aggregate = repository.load(LOCAL_TENANT, job_id)
                attempts = int(row["attempt_count"] or 0)
                error = None
                if aggregate is not None and aggregate.is_enriched:
                    state = "succeeded"
                    attempts = max(attempts, aggregate.attempt_count)
                else:
                    # An unclaimed row consumed no attempt. Leave its durable
                    # reservation for timeout recovery or closed-batch blocking.
                    if row["state"] == "queued":
                        continue
                    if row["state"] == "running" and (aggregate is None or not aggregate.is_failed):
                        aggregate = aggregate or JobEnrichment.empty(
                            tenant_id=LOCAL_TENANT, job_id=job_id, updated_at=now
                        )
                        if not aggregate.is_running:
                            aggregate = aggregate.start_attempt(
                                extraction_tier=ExtractionTier.JSON_LD, started_at=row["started_at"] or now
                            )
                        aggregate = aggregate.fail_attempt(
                            error=EnrichmentError(
                                code="ENRICH_ACTIVITY_OWNER_STOPPED",
                                message="Enrichment owner stopped before committing its result.",
                                retryable=True,
                            ),
                            finished_at=now,
                        )
                        repository.save(aggregate, commit=False)
                        attempts += 1
                    if aggregate is not None:
                        attempts = max(attempts, aggregate.attempt_count)
                        error = aggregate.last_attempt.error if aggregate.last_attempt else None
                    state = "exhausted" if attempts >= min(5, row["max_attempts"]) else "failed"
                set_stage_state(
                    conn,
                    job_id,
                    "enrich",
                    state,
                    attempt_count=attempts,
                    max_attempts=row["max_attempts"],
                    finished_at=now,
                    error_code=error.code if error else None,
                    error_message=error.message if error else None,
                    retryable=state != "exhausted" and (error is None or error.retryable),
                    metadata={"recoveredFromWorkflowId": workflow_id, "recoveredFromRunId": run_id},
                    validate_transition=False,
                    expected_version=row["version"],
                )
                record_job_event(
                    conn,
                    job_id,
                    "enrich",
                    "StageCompleted" if state == "succeeded" else "StageFailed",
                    message="Enrichment settled after its exact workflow execution stopped.",
                    payload={
                        "workflowId": workflow_id,
                        "temporalRunId": run_id,
                        "attemptCount": attempts,
                        "state": state,
                    },
                )
            conn.commit()
        except BaseException:
            conn.rollback()
            raise


async def _reconcile_stopped_activity_owners(client: Any, conn: sqlite3.Connection) -> None:
    """Settle running rows only after observing their exact execution closed."""
    from jobctrl.infrastructure.preparation_recovery import (
        CancelPreparationStateInput,
        RecoverPreparationStateInput,
        cancel_preparation_state_rows,
        recover_preparation_state_rows,
    )

    owners = conn.execute(
        "SELECT DISTINCT s.stage, "
        "COALESCE(json_extract(s.metadata_json, '$.workflowId'), r.workflow_id) AS workflow_id, "
        "json_extract(s.metadata_json, '$.activityOwner') AS temporal_run_id, "
        "CASE WHEN r.workflow_type='JobPreparationWorkflow' THEN s.job_id END AS selected_job_id "
        "FROM job_stage_states s LEFT JOIN workflow_run_projections r "
        "ON r.tenant_id = s.tenant_id "
        "AND r.temporal_run_id = json_extract(s.metadata_json, '$.activityOwner') "
        "WHERE s.tenant_id = ? AND s.stage IN ('score', 'tailor', 'cover') "
        "AND s.state = 'running' AND ("
        "(json_extract(s.metadata_json, '$.automaticRecovery') = 1 "
        "AND json_extract(s.metadata_json, '$.workflowId') IS NOT NULL "
        "AND json_extract(s.metadata_json, '$.temporalRunId') = json_extract(s.metadata_json, '$.activityOwner')) "
        "OR (r.workflow_type = 'JobPipelineWorkflow' AND r.workflow_id GLOB 'prepare-auto-local-*') "
        "OR (r.workflow_type = 'JobPreparationWorkflow' "
        "AND json_extract(r.input_summary_json, '$.jobId') = s.job_id "
        "AND EXISTS (SELECT 1 FROM json_each(r.input_summary_json, '$.steps') step "
        "WHERE step.value = s.stage)))",
        (str(LOCAL_TENANT),),
    ).fetchall()
    for owner in owners:
        # A projection is a lookup index, not proof of closure. Missing or
        # unavailable history leaves the original ownership intact.
        try:
            description = await client.get_workflow_handle(
                owner["workflow_id"], run_id=owner["temporal_run_id"]
            ).describe()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                continue
            raise
        if description.status not in {
            WorkflowExecutionStatus.COMPLETED, WorkflowExecutionStatus.FAILED,
            WorkflowExecutionStatus.CANCELED, WorkflowExecutionStatus.TERMINATED,
            WorkflowExecutionStatus.TIMED_OUT, WorkflowExecutionStatus.CONTINUED_AS_NEW,
        }:
            continue
        selected = (owner["selected_job_id"],) if owner["selected_job_id"] else ()
        conn.execute("BEGIN IMMEDIATE")
        try:
            if description.status == WorkflowExecutionStatus.CANCELED:
                cancel_preparation_state_rows(
                    conn,
                    CancelPreparationStateInput(
                        tenant_id=str(LOCAL_TENANT),
                        workflow_id=owner["temporal_run_id"],
                        stage=owner["stage"],
                        job_ids=selected,
                    ),
                )
            else:
                recover_preparation_state_rows(
                    conn,
                    RecoverPreparationStateInput(
                        tenant_id=str(LOCAL_TENANT),
                        workflow_id=owner["temporal_run_id"],
                        stage=owner["stage"],
                        job_ids=selected,
                    ),
                )
        except BaseException:
            conn.rollback()
            raise


def reserve_recovery_batch(
    conn: sqlite3.Connection,
    *,
    min_score: int = 7,
    now: datetime | None = None,
    active_preparations: dict[JobId, _ActivePreparation] | None = None,
    internal_concurrency: int = 1,
) -> RecoveryBatch | None:
    now = now or datetime.now(timezone.utc)
    active_preparations = active_preparations or {}
    conn.execute("BEGIN IMMEDIATE")
    try:
        from jobctrl.infrastructure.materials.manual_decline import release_manual_material_skips

        release_manual_material_skips(conn, tenant_id=LOCAL_TENANT)
        reconcile_cover_letter_policy(conn, tenant_id=LOCAL_TENANT, release_reserved=True)
        _release_declined_material_reservations(conn)
        reservations: dict[str, RecoveryBatch] = {}
        for existing in conn.execute(
            "SELECT metadata_json FROM job_stage_states "
            "WHERE tenant_id = ? AND state = 'queued' "
            "AND json_extract(metadata_json, '$.automaticPreparation.workflowId') IS NOT NULL "
            "ORDER BY updated_at, job_id",
            (str(LOCAL_TENANT),),
        ).fetchall():
            saved = json.loads(existing[0])["automaticPreparation"]
            batch = RecoveryBatch(
                workflow_id=saved["workflowId"], stage=saved["stage"],
                job_ids=tuple(canonical_job_id(value) for value in saved["jobIds"]),
                min_score=int(saved["minScore"]),
            )
            if batch.workflow_id in reservations and reservations[batch.workflow_id] != batch:
                conn.commit()
                return None
            reservations[batch.workflow_id] = batch
        pending = []
        for batch in reservations.values():
            if any(job_id in active_preparations for job_id in batch.job_ids):
                if not _active_reservation(batch, active_preparations):
                    conn.commit()
                    return None
            else:
                pending.append(batch)
        pending_jobs: set[JobId] = set()
        for batch in pending:
            if pending_jobs.intersection(batch.job_ids):
                conn.commit()
                return None
            pending_jobs.update(batch.job_ids)
        # Unknown producers still gate admission. An undispatched frozen cohort
        # can be reattached, while a verified executing cohort keeps its rows.
        busy = conn.execute(
            "SELECT job_id,stage,state,metadata_json FROM job_stage_states WHERE tenant_id = ? "
            "AND stage IN ('enrich', 'score', 'tailor', 'cover') "
            "AND state IN ('queued', 'running')",
            (str(LOCAL_TENANT),),
        ).fetchall()
        if any(
            not _belongs_to_active_preparation(row, active_preparations)
            and not any(_pending_reservation_row(row, batch) for batch in pending)
            for row in busy
        ):
            conn.commit()
            return None
        workers = _available_recovery_workers(conn, active_preparations, internal_concurrency)
        if workers < 1:
            conn.commit()
            return None
        if pending:
            # A queued row may already carry its activity's exact run. Describe
            # that execution before settling it or attempting any dispatch.
            recorded_runs = {
                json.loads(row["metadata_json"])["temporalRunId"]
                for row in busy if _pending_reservation_row(row, pending[0])
                and json.loads(row["metadata_json"]).get("temporalRunId") is not None
            }
            conn.commit()
            if len(recorded_runs) > 1:
                return None
            return replace(pending[0], workers=workers, run_id=next(iter(recorded_runs), None))
        _repair_completed_discovery_handoff(conn)
        candidates = _candidates(conn, min_score=min_score)
        for stage in _STAGES:
            due = [row for row in candidates[stage] if row["job_id"] not in active_preparations and _retry_due(row, now)][:_BATCH_SIZE]
            if not due:
                continue
            identity = [(row["job_id"], row["attempt_count"], row["updated_at"]) for row in due]
            digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
            batch = RecoveryBatch(
                workflow_id=f"prepare-auto-local-{stage}-{digest}",
                stage=stage,
                job_ids=tuple(canonical_job_id(row["job_id"]) for row in due),
                min_score=min_score,
                workers=workers,
            )
            repository = SqliteEnrichmentRepository(conn)
            for row in due:
                job_id = canonical_job_id(row["job_id"])
                if stage == "enrich":
                    aggregate = repository.load(LOCAL_TENANT, job_id)
                    if aggregate is not None and aggregate.current_status == "failed":
                        repository.save(aggregate.reset(reset_at=now.isoformat()), commit=False)
                set_stage_state(
                    conn,
                    job_id,
                    stage,
                    "queued",
                    attempt_count=row["attempt_count"],
                    max_attempts=row["max_attempts"],
                    validate_transition=False,
                    metadata={
                        "workflowId": batch.workflow_id,
                        "automaticPreparation": batch.metadata(),
                    },
                )
                record_job_event(
                    conn,
                    job_id,
                    stage,
                    "StageQueued",
                    message="Unfinished preparation queued for automatic recovery.",
                    payload={
                        **batch.metadata(),
                        "reason": "automatic_preparation_recovery",
                        "previousState": row["state"],
                        "attemptCount": row["attempt_count"],
                        "previousErrorCode": row["error_code"],
                    },
                )
            conn.commit()
            return batch
        conn.commit()
        return None
    except Exception:
        conn.rollback()
        raise



def _release_declined_material_reservations(conn: sqlite3.Connection) -> None:
    """Release unstarted automatic material ownership after a manual decline."""
    rows = conn.execute(
        f"SELECT s.* FROM job_stage_states s WHERE s.tenant_id = ? "
        "AND s.stage IN ('tailor', 'cover') AND s.state = 'queued' "
        "AND json_extract(s.metadata_json, '$.automaticPreparation.workflowId') IS NOT NULL "
        f"AND ({MANUAL_APPLY_DECLINE_SQL})",
        (str(LOCAL_TENANT),),
    ).fetchall()
    for row in rows:
        previous = json.loads(row["metadata_json"])
        reservation = previous.pop("automaticPreparation")
        previous.pop("workflowId", None)
        metadata = {
            **previous, "releasedAutomaticPreparation": reservation,
            "reason": "manual_apply_decline",
        }
        job_id = canonical_job_id(row["job_id"])
        set_stage_state(
            conn, job_id, row["stage"], "pending", attempt_count=row["attempt_count"],
            max_attempts=row["max_attempts"], retryable=bool(row["retryable"]),
            metadata=metadata, validate_transition=False, expected_version=row["version"],
        )
        record_job_event(
            conn, job_id, row["stage"], "StageReset",
            message="Unstarted automatic material reservation released after this job was marked skipped.",
            payload={"reason": "manual_apply_decline", "workflowId": reservation["workflowId"]},
        )


def _repair_completed_discovery_handoff(conn: sqlite3.Connection) -> None:
    """Repair only the historical consumer-stop bug with exact-run evidence.

    A completed Discover run claiming its terminal enrichment phase *after*
    the cancellation is positive evidence of an internal producer handoff.
    Any workflow cancellation request or terminal cancellation lease vetoes
    repair, including requests whose old audit lacks the exact run ID.
    """
    rows = conn.execute(
        """
        SELECT s.job_id, s.attempt_count, s.max_attempts, s.metadata_json
        FROM job_stage_states s
        JOIN workflow_run_projections r
          ON r.tenant_id = s.tenant_id
         AND r.workflow_id = json_extract(s.metadata_json, '$.workflowId')
         AND r.temporal_run_id = json_extract(s.metadata_json, '$.temporalRunId')
        WHERE s.tenant_id = ? AND s.stage = 'enrich' AND s.state = 'canceled'
          AND r.workflow_type = 'DiscoverWorkflow' AND r.status = 'succeeded'
          AND json_extract(s.metadata_json, '$.recoveryReason') = 'transient_interruption'
          AND json_extract(s.metadata_json, '$.cancellationReason') = 'workflow_canceled'
          AND EXISTS (
            SELECT 1 FROM job_events e WHERE e.tenant_id = s.tenant_id
              AND e.event_type = 'EnrichmentLeaseClaimed'
              AND json_extract(e.payload_json, '$.execution.workflowId') = r.workflow_id
              AND json_extract(e.payload_json, '$.execution.runId') = r.temporal_run_id
              AND json_extract(e.payload_json, '$.activityPhase') = 2
              AND julianday(e.occurred_at) > julianday(s.updated_at)
              AND julianday(e.occurred_at) <= julianday(r.finished_at)
          )
          AND NOT EXISTS (
            SELECT 1 FROM job_events e WHERE e.tenant_id = s.tenant_id AND (
              (e.event_type = 'WorkflowCancellationRequested'
                AND json_extract(e.payload_json, '$.workflowId') = r.workflow_id
                AND (json_extract(e.payload_json, '$.temporalRunId') IS NULL
                  OR json_extract(e.payload_json, '$.temporalRunId') = r.temporal_run_id))
              OR (e.event_type = 'EnrichmentLeaseClaimed'
                AND json_extract(e.payload_json, '$.execution.workflowId') = r.workflow_id
                AND json_extract(e.payload_json, '$.execution.runId') = r.temporal_run_id
                AND json_extract(e.payload_json, '$.activityPhase') >= 3)
            )
          )
        """,
        (str(LOCAL_TENANT),),
    ).fetchall()
    for row in rows:
        job_id = canonical_job_id(row["job_id"])
        previous = json.loads(row["metadata_json"])
        metadata = {
            "recoveredFromWorkflowId": previous["workflowId"],
            "recoveredFromRunId": previous["temporalRunId"],
            "reason": "completed_discovery_consumer_handoff",
        }
        set_stage_state(
            conn,
            job_id,
            "enrich",
            "pending",
            attempt_count=row["attempt_count"],
            max_attempts=row["max_attempts"],
            metadata=metadata,
            validate_transition=False,
        )
        record_job_event(
            conn,
            job_id,
            "enrich",
            "StageReset",
            message="Released enrichment after a confirmed completed discovery consumer handoff.",
            payload=metadata,
        )


def _candidates(conn: sqlite3.Connection, *, min_score: int) -> dict[str, list[dict[str, Any]]]:
    rows = conn.execute(
        f"""
        SELECT j.job_id, j.discovered_at, e.current_status, e.full_description,
               COALESCE(json_array_length(e.attempts_json), 0) AS enrich_attempts,
               s.stage, COALESCE(s.state, 'pending') AS state,
               COALESCE(s.attempt_count, 0) AS attempt_count,
               COALESCE(s.max_attempts, 5) AS max_attempts,
               COALESCE(s.retryable, 1) AS retryable, s.error_code,
               COALESCE(s.updated_at, j.discovered_at) AS updated_at,
               CASE WHEN s.stage = 'enrich' AND s.state = 'pending'
                 AND json_extract(s.metadata_json, '$.fetchRecovery.status') = 'retry_ready'
                 THEN json_extract(s.metadata_json, '$.fetchRecovery.retryEligibleAt') END AS retry_eligible_at
        FROM jobs j
        LEFT JOIN job_enrichments e ON e.tenant_id = j.tenant_id AND e.job_id = j.job_id
        JOIN job_stage_states s ON s.tenant_id = j.tenant_id AND s.job_id = j.job_id
        LEFT JOIN posting_snapshot_sets p ON p.tenant_id = j.tenant_id AND p.job_id = j.job_id
        WHERE j.tenant_id = ? AND s.stage IN ('enrich', 'score', 'tailor', 'cover')
          AND COALESCE(p.latest_active_state, '') NOT IN ('closed', 'expired', 'removed', 'location_incompatible')
          AND NOT (s.stage IN ('tailor', 'cover') AND ({MANUAL_APPLY_DECLINE_SQL}))
          AND NOT EXISTS (
            SELECT 1 FROM jobctrl_deleted_jobs d
            WHERE d.tenant_id = j.tenant_id AND d.job_id = j.job_id
              AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
          )
        ORDER BY s.updated_at, j.job_id
        """,
        (str(LOCAL_TENANT),),
    ).fetchall()
    eligible = {
        stage: {
            str(job["job_id"])
            for job in database.get_jobs_by_stage(conn=conn, stage=f"pending_{stage}", min_score=min_score, limit=0)
            if str(job["tenant_id"]) == str(LOCAL_TENANT)
        }
        for stage in ("score", "tailor", "cover")
    }
    result: dict[str, list[dict[str, Any]]] = {stage: [] for stage in _STAGES}
    cover_enabled = get_cover_letter_generation_enabled()
    for raw in rows:
        row = dict(raw)
        stage = row["stage"]
        if stage == "cover" and not cover_enabled:
            continue
        if stage == "enrich":
            if row["current_status"] not in (None, "pending", "failed") or row["full_description"]:
                continue
            row["attempt_count"] = max(row["attempt_count"], row["enrich_attempts"])
        elif row["job_id"] not in eligible[stage]:
            continue
        result[stage].append(row)
    return result


def _retry_due(row: dict[str, Any], now: datetime) -> bool:
    if row["state"] not in {"pending", "failed"} or not row["retryable"]:
        return False
    attempts = int(row["attempt_count"])
    if attempts >= min(5, int(row["max_attempts"])):
        return False
    if row.get("retry_eligible_at"):
        try:
            eligible_at = datetime.fromisoformat(str(row["retry_eligible_at"]).replace("Z", "+00:00"))
            if eligible_at.tzinfo is None:
                return False
            return now >= eligible_at
        except ValueError:
            return False
    try:
        updated = datetime.fromisoformat(str(row["updated_at"]).replace("Z", "+00:00"))
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    cooldown = min(1800, 60 * (2**attempts))
    return (now - updated).total_seconds() >= cooldown


async def _reconcile_interrupted_reservations(client: Any, conn: sqlite3.Connection) -> None:
    """Release unstarted work only after a confirmed, budgeted interruption."""
    owners = conn.execute(
        "SELECT DISTINCT stage, json_extract(metadata_json, '$.workflowId') AS workflow_id "
        "FROM job_stage_states WHERE tenant_id = ? AND stage IN ('enrich', 'score', 'tailor', 'cover') "
        "AND (state = 'queued' OR (state = 'blocked' AND error_code = 'PREPARATION_RECOVERY_STOPPED')) "
        "AND json_extract(metadata_json, '$.workflowId') GLOB 'prepare-auto-local-*'",
        (str(LOCAL_TENANT),),
    ).fetchall()
    for owner in owners:
        workflow_id, stage = owner["workflow_id"], owner["stage"]
        try:
            description = await client.get_workflow_handle(workflow_id).describe()
            if description.status not in {WorkflowExecutionStatus.COMPLETED, WorkflowExecutionStatus.FAILED}:
                continue
            history = await client.get_workflow_handle(workflow_id, run_id=description.run_id).fetch_history()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                continue
            raise
        interrupted = await _interrupted_batch(
            client, history, workflow_id=workflow_id, run_id=description.run_id, stage=stage
        )
        if interrupted is not None:
            batch, started_at, interrupted_at = interrupted
            _release_interrupted_reservations(
                conn, batch, run_id=description.run_id, started_at=started_at, interrupted_at=interrupted_at
            )


async def _interrupted_batch(client: Any, history: Any, *, workflow_id: str, run_id: str, stage: str):
    """Use the exact Temporal execution, including cancellation intent, as proof."""
    events = history.events
    if not events or any(event.HasField("workflow_execution_cancel_requested_event_attributes") for event in events):
        return None
    start = events[0].workflow_execution_started_event_attributes
    if start.workflow_type.name != "JobPipelineWorkflow" or start.original_execution_run_id != run_id:
        return None
    inputs = await client.data_converter.decode(start.input.payloads)
    if len(inputs) != 1 or not isinstance(inputs[0], dict):
        return None
    payload = inputs[0]
    job_ids = payload.get("job_ids")
    if (
        payload.get("tenant_id") != str(LOCAL_TENANT)
        or payload.get("automatic_recovery") is not True
        or payload.get("stages") != [stage]
        or not isinstance(job_ids, list)
        or not 1 <= len(job_ids) <= _BATCH_SIZE
    ):
        return None
    scheduled = {
        event.event_id: event.activity_task_scheduled_event_attributes
        for event in events
        if event.HasField("activity_task_scheduled_event_attributes")
        and event.activity_task_scheduled_event_attributes.activity_type.name == stage
    }
    started = {
        event.event_id: event.activity_task_started_event_attributes.scheduled_event_id
        for event in events if event.HasField("activity_task_started_event_attributes")
    }
    for event in events:
        if not event.HasField("activity_task_timed_out_event_attributes"):
            continue
        timeout = event.activity_task_timed_out_event_attributes
        activity_input = scheduled.get(timeout.scheduled_event_id)
        if (
            activity_input is None
            or started.get(timeout.started_event_id) != timeout.scheduled_event_id
            or timeout.failure.timeout_failure_info.timeout_type not in {
                TimeoutType.TIMEOUT_TYPE_HEARTBEAT, TimeoutType.TIMEOUT_TYPE_START_TO_CLOSE,
            }
        ):
            continue
        activity_payloads = await client.data_converter.decode(activity_input.input.payloads)
        if len(activity_payloads) != 1 or not isinstance(activity_payloads[0], dict):
            continue
        if (
            activity_payloads[0].get("recovery_workflow_id") != workflow_id
            or activity_payloads[0].get("job_ids") != job_ids
            or activity_payloads[0].get("workflow_id") != (workflow_id if stage == "enrich" else run_id)
            or (stage == "enrich" and activity_payloads[0].get("workflow_run_id") != run_id)
        ):
            continue
        batch = RecoveryBatch(
            workflow_id=workflow_id, stage=stage,
            job_ids=tuple(canonical_job_id(value) for value in job_ids), min_score=int(payload.get("min_score", 7)),
        )
        return batch, events[0].event_time.ToJsonString(), event.event_time.ToJsonString()
    return None


def _release_interrupted_reservations(
    conn: sqlite3.Connection, batch: RecoveryBatch, *, run_id: str, started_at: str, interrupted_at: str
) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        marks = ",".join("?" for _ in batch.job_ids)
        # A stage that never consumed a durable attempt remains blocked. This
        # prevents repeated preflight timeouts from creating unbounded retries.
        progress = conn.execute(
            "SELECT 1 FROM job_events consumed JOIN job_events reserved "
            "ON reserved.tenant_id = consumed.tenant_id AND reserved.job_id = consumed.job_id "
            "AND reserved.stage = consumed.stage AND reserved.event_type = 'StageQueued' "
            "JOIN job_stage_states s ON s.tenant_id = consumed.tenant_id "
            "AND s.job_id = consumed.job_id AND s.stage = consumed.stage "
            "WHERE consumed.tenant_id = ? AND consumed.stage = ? "
            f"AND consumed.job_id IN ({marks}) "
            "AND json_extract(reserved.payload_json, '$.workflowId') = ? "
            "AND consumed.event_id > reserved.event_id "
            "AND consumed.event_type IN ('StageCompleted', 'StageFailed', 'StageExhausted') "
            "AND s.attempt_count > json_extract(reserved.payload_json, '$.attemptCount') "
            "AND (json_extract(consumed.payload_json, '$.workflowId') = ? OR "
            "(json_extract(consumed.payload_json, '$.workflowId') = ? "
            "AND julianday(consumed.occurred_at) BETWEEN julianday(?) AND julianday(?))) LIMIT 1",
            (str(LOCAL_TENANT), batch.stage, *batch.job_ids, batch.workflow_id,
             run_id, batch.workflow_id, started_at, interrupted_at),
        ).fetchone()
        if progress is not None:
            eligible = {row["job_id"] for row in _candidates(conn, min_score=batch.min_score)[batch.stage]}
            rows = conn.execute(
                "SELECT job_id, attempt_count, max_attempts, version FROM job_stage_states "
                f"WHERE tenant_id = ? AND stage = ? AND job_id IN ({marks}) "
                "AND attempt_count < MIN(5, max_attempts) "
                "AND COALESCE(json_array_length(blocked_by_json), 0) = 0 "
                "AND ((state = 'queued' AND retryable = 1 "
                "AND json_extract(metadata_json, '$.automaticPreparation.workflowId') = ?) "
                "OR (state = 'blocked' AND error_code = 'PREPARATION_RECOVERY_STOPPED' "
                "AND json_extract(metadata_json, '$.workflowId') = ?))",
                (str(LOCAL_TENANT), batch.stage, *batch.job_ids, batch.workflow_id, batch.workflow_id),
            ).fetchall()
            for row in rows:
                if row["job_id"] not in eligible:
                    continue
                job_id = canonical_job_id(row["job_id"])
                metadata = {"recoveredFromWorkflowId": batch.workflow_id, "recoveredFromRunId": run_id,
                            "reason": "interrupted_preparation_reservation"}
                set_stage_state(
                    conn, job_id, batch.stage, "pending", attempt_count=row["attempt_count"],
                    max_attempts=row["max_attempts"], retryable=True, metadata=metadata,
                    validate_transition=False, expected_version=row["version"],
                )
                record_job_event(
                    conn, job_id, batch.stage, "StageReset",
                    message="Unstarted preparation released after its batch activity timed out.", payload=metadata,
                )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


def automatic_recovery_job_ids(payload: Any, stage: str) -> tuple[JobId, ...]:
    """Recheck cancellation, deletion, prerequisites and ownership at execution."""
    workflow_id = payload.recovery_workflow_id
    if not workflow_id:
        return payload.job_ids
    conn = database.get_connection()
    candidates = _candidates(conn, min_score=getattr(payload, "min_score", 7))[stage]
    eligible = {
        row["job_id"]
        for row in candidates
        if row["state"] == "queued" and row["retryable"] and row["attempt_count"] < min(5, row["max_attempts"])
    }
    owned = {
        str(row[0])
        for row in conn.execute(
            "SELECT job_id FROM job_stage_states WHERE tenant_id = ? AND stage = ? "
            "AND state = 'queued' AND json_extract(metadata_json, '$.automaticPreparation.workflowId') = ?",
            (payload.tenant_id, stage, workflow_id),
        ).fetchall()
    }
    return tuple(job_id for job_id in payload.job_ids if str(job_id) in eligible & owned)


def _settle_closed_reservation(
    conn: sqlite3.Connection, batch: RecoveryBatch, status: Any, *, run_id: str | None = None,
) -> None:
    """Stop unconsumed reservations; a preflight failure must not launch a loop."""
    canceled = status == WorkflowExecutionStatus.CANCELED
    conn.execute("BEGIN IMMEDIATE")
    try:
        rows = conn.execute(
            "SELECT * FROM job_stage_states "
            "WHERE tenant_id = ? AND stage = ? AND state = 'queued' "
            "AND json_extract(metadata_json, '$.automaticPreparation.workflowId') = ?",
            (str(LOCAL_TENANT), batch.stage, batch.workflow_id),
        ).fetchall()
        for row in rows:
            if not _pending_reservation_row(row, batch):
                continue
            metadata = json.loads(row["metadata_json"])
            if metadata.get("temporalRunId") not in (None, run_id):
                continue
            if metadata.get("activityOwner") is not None and (run_id is None or not _owner_matches_run(metadata, batch.stage, run_id)):
                continue
            job_id = canonical_job_id(row["job_id"])
            set_stage_state(
                conn,
                job_id,
                batch.stage,
                "canceled" if canceled else "blocked",
                attempt_count=row["attempt_count"],
                max_attempts=row["max_attempts"],
                error_code="WORKFLOW_CANCELED" if canceled else "PREPARATION_RECOVERY_STOPPED",
                error_message="Automatic preparation stopped before consuming this reservation.",
                retryable=False,
                next_action=f"retry {batch.stage}",
                metadata={"workflowId": batch.workflow_id},
                validate_transition=False,
                expected_version=row["version"],
            )
            record_job_event(
                conn,
                job_id,
                batch.stage,
                "StageCanceled" if canceled else "StageBlocked",
                level="warning",
                message="Automatic preparation reservation stopped with its workflow.",
                payload={"workflowId": batch.workflow_id, "reason": "automatic_preparation_stopped"},
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
