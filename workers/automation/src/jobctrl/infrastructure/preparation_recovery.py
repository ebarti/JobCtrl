"""One owner-scoped recovery rule for preparation activity exhaustion."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from temporalio import activity

from jobctrl.domain.identifiers import canonical_job_id


@dataclass(frozen=True)
class RecoverPreparationStateInput:
    tenant_id: str
    workflow_id: str
    stage: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None


@dataclass(frozen=True)
class RecoverPreparationStateOutput:
    restored: int = 0
    failed: int = 0


@dataclass(frozen=True)
class CancelPreparationStateInput:
    tenant_id: str
    workflow_id: str
    stage: str
    job_ids: tuple[str, ...]
    expected_app_dir: str | None = None
    expected_db_path: str | None = None


@dataclass(frozen=True)
class CancelPreparationStateOutput:
    canceled: int = 0
    restored: int = 0


@activity.defn(name="recover_preparation_state")
async def recover_preparation_state_activity(
    payload: RecoverPreparationStateInput,
) -> RecoverPreparationStateOutput:
    from jobctrl.database import get_connection
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )
    return recover_preparation_state_rows(get_connection(), payload)


@activity.defn(name="cancel_preparation_state")
async def cancel_preparation_state_activity(
    payload: CancelPreparationStateInput,
) -> CancelPreparationStateOutput:
    from jobctrl.database import get_connection
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )
    return cancel_preparation_state_rows(get_connection(), payload)


def cancel_preparation_state_rows(
    conn: Any,
    payload: CancelPreparationStateInput,
) -> CancelPreparationStateOutput:
    """Cancel only unfinished selected material rows still owned by this run."""

    if payload.stage not in {"tailor", "cover"}:
        raise ValueError("material cancellation supports tailor or cover")
    from jobctrl.domain.tenant import TenantId
    from jobctrl.state import record_job_event, set_stage_state, utc_now

    job_ids = tuple(dict.fromkeys(str(canonical_job_id(value)) for value in payload.job_ids))
    if job_ids:
        placeholders = ", ".join("?" for _ in job_ids)
        rows = conn.execute(
            "SELECT job_id, state, attempt_count, started_at, metadata_json "
            "FROM job_stage_states WHERE tenant_id = ? AND stage = ? "
            f"AND job_id IN ({placeholders})",
            (payload.tenant_id, payload.stage, *job_ids),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT job_id, state, attempt_count, started_at, metadata_json "
            "FROM job_stage_states WHERE tenant_id = ? AND stage = ? "
            "AND json_extract(metadata_json, '$.activityOwner') = ?",
            (payload.tenant_id, payload.stage, payload.workflow_id),
        ).fetchall()
    tenant_id = TenantId(payload.tenant_id)
    finished_at = utc_now()
    canceled = 0
    restored = 0
    try:
        for row in rows:
            state = str(row["state"])
            metadata = _metadata(row["metadata_json"])
            owner = str(metadata.get("activityOwner") or "")
            if state in {"succeeded", "skipped", "exhausted", "canceled"}:
                continue
            if state in {"queued", "running"} and owner != payload.workflow_id:
                continue
            if state not in {"pending", "queued", "running"}:
                continue
            job_id = canonical_job_id(str(row["job_id"]))
            if state == "running" and owner == payload.workflow_id and _material_commit_exists(
                conn,
                payload=payload,
                tenant_id=tenant_id,
                job_id=job_id,
                metadata=metadata,
            ):
                _restore_committed(
                    conn,
                    payload=payload,
                    tenant_id=tenant_id,
                    job_id=job_id,
                    row=row,
                    finished_at=finished_at,
                    reason=f"canceled_activity_preserved_committed_{payload.stage}",
                    message="Committed result preserved while its workflow was canceled.",
                )
                restored += 1
                continue
            set_stage_state(
                conn,
                job_id,
                payload.stage,
                "canceled",
                tenant_id=tenant_id,
                attempt_count=int(row["attempt_count"] or 0),
                finished_at=finished_at,
                error_code="WORKFLOW_CANCELED",
                error_message="Stage canceled with its owning workflow.",
                retryable=True,
                next_action=f"retry {payload.stage}",
                metadata={
                    "activityOwner": payload.workflow_id,
                    "cancellationReason": "workflow_canceled",
                },
                validate_transition=False,
            )
            record_job_event(
                conn,
                job_id,
                payload.stage,
                "StageCanceled",
                tenant_id=tenant_id,
                level="warning",
                message="Stage canceled with its owning workflow.",
                payload={
                    "reason": "workflow_canceled",
                    "workflowId": payload.workflow_id,
                    "canceledAt": finished_at,
                },
            )
            canceled += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return CancelPreparationStateOutput(canceled=canceled, restored=restored)


def recover_preparation_state_rows(
    conn: Any,
    payload: RecoverPreparationStateInput,
) -> RecoverPreparationStateOutput:
    """Accept committed work or fail only rows owned by the stopped workflow."""
    if payload.stage not in {"score", "tailor", "cover"}:
        raise ValueError("preparation recovery supports score, tailor, or cover")
    from jobctrl.domain.tenant import TenantId
    from jobctrl.state import utc_now

    rows = conn.execute(
        """
        SELECT job_id, attempt_count, max_attempts, started_at, metadata_json
          FROM job_stage_states
         WHERE tenant_id = ?
           AND stage = ?
           AND state = 'running'
           AND json_extract(metadata_json, '$.activityOwner') = ?
        """,
        (payload.tenant_id, payload.stage, payload.workflow_id),
    ).fetchall()
    tenant_id = TenantId(payload.tenant_id)
    finished_at = utc_now()
    restored = 0
    failed = 0
    for row in rows:
        job_id = canonical_job_id(str(row["job_id"]))
        metadata = _metadata(row["metadata_json"])
        committed = _preparation_commit_exists(
            conn,
            payload=payload,
            tenant_id=tenant_id,
            job_id=job_id,
            metadata=metadata,
        )
        if committed:
            _restore_committed(
                conn,
                payload=payload,
                tenant_id=tenant_id,
                job_id=job_id,
                row=row,
                finished_at=finished_at,
            )
            restored += 1
        else:
            _fail_uncommitted(
                conn,
                payload=payload,
                tenant_id=tenant_id,
                job_id=job_id,
                row=row,
                finished_at=finished_at,
            )
            failed += 1
    conn.commit()
    return RecoverPreparationStateOutput(restored=restored, failed=failed)


def stage_completed_by_activity_owner(
    conn: Any,
    *,
    tenant_id: str,
    job_id: str,
    stage: str,
    workflow_id: str,
) -> bool:
    row = conn.execute(
        "SELECT state, metadata_json FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = ?",
        (tenant_id, job_id, stage),
    ).fetchone()
    if row is None or str(row["state"]) != "succeeded":
        return False
    return _metadata(row["metadata_json"]).get("activityOwner") == workflow_id


def assert_material_activity_commit_allowed(
    conn: Any,
    *,
    tenant_id: str,
    job_id: str,
    stage: str,
    workflow_id: str | None,
    cancel_event: Any | None = None,
) -> None:
    """Fence a material write against cancellation or a successor owner."""

    if cancel_event is not None and cancel_event.is_set():
        raise RuntimeError(f"{stage} activity canceled before persistence")
    if not workflow_id:
        return
    row = conn.execute(
        "SELECT state, metadata_json FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = ?",
        (tenant_id, job_id, stage),
    ).fetchone()
    if (
        row is None
        or str(row["state"]) != "running"
        or _metadata(row["metadata_json"]).get("activityOwner") != workflow_id
    ):
        raise RuntimeError(f"{stage} activity no longer owns artifact persistence")


def _preparation_commit_exists(
    conn,
    *,
    payload,
    tenant_id,
    job_id,
    metadata: dict[str, Any],
) -> bool:
    if payload.stage == "score":
        score_row = conn.execute(
            "SELECT COALESCE(MAX(version), 0) AS version FROM job_scores "
            "WHERE tenant_id = ? AND job_id = ?",
            (payload.tenant_id, str(job_id)),
        ).fetchone()
        current_version = int(score_row["version"] if score_row else 0)
        prior_version = int(metadata.get("priorScoreVersion") or 0)
        return (
            current_version > prior_version
            if bool(metadata.get("rescore"))
            else current_version > 0
        )
    return _material_commit_exists(
        conn,
        payload=payload,
        tenant_id=tenant_id,
        job_id=job_id,
        metadata=metadata,
    )


def _material_commit_exists(
    conn,
    *,
    payload,
    tenant_id,
    job_id,
    metadata: dict[str, Any],
) -> bool:
    from jobctrl.domain.materials.value_objects import ArtifactStatus
    from jobctrl.infrastructure.materials import SqliteMaterialsRepository

    repository = SqliteMaterialsRepository(conn)
    materials = repository.load_current_approved(tenant_id, job_id)
    if payload.stage == "tailor":
        if materials is None or not materials.is_resume_approved:
            return False
        prior_generation = int(metadata.get("priorApprovedGeneration") or 0)
        return (
            not bool(metadata.get("retailor"))
            or int(materials.generation) > prior_generation
        )
    if payload.stage == "cover":
        return bool(
            materials is not None
            and materials.cover_letter is not None
            and materials.cover_letter.status is ArtifactStatus.APPROVED
        )
    raise ValueError("material commit check supports tailor or cover")


def _restore_committed(
    conn,
    *,
    payload,
    tenant_id,
    job_id,
    row,
    finished_at,
    reason: str | None = None,
    message: str = "Committed result restored after its activity owner stopped.",
) -> None:
    from jobctrl.state import record_job_event, set_stage_state

    reason = reason or f"orphaned_activity_restored_committed_{payload.stage}"
    recovered_attempt_count = _recovered_attempt_count(payload=payload, row=row)
    set_stage_state(
        conn,
        job_id,
        payload.stage,
        "succeeded",
        tenant_id=tenant_id,
        attempt_count=recovered_attempt_count,
        started_at=str(row["started_at"] or finished_at),
        finished_at=finished_at,
        metadata={
            "activityOwner": payload.workflow_id,
            "recoveredFromWorkflowId": payload.workflow_id,
            "reason": reason,
        },
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_id,
        payload.stage,
        "StageCompleted",
        tenant_id=tenant_id,
        message=message,
        payload={"reason": reason, "workflowId": payload.workflow_id},
    )


def _fail_uncommitted(conn, *, payload, tenant_id, job_id, row, finished_at) -> None:
    from jobctrl.state import record_job_event, set_stage_state

    error_code = f"{payload.stage.upper()}_ACTIVITY_OWNER_STOPPED"
    recovered_attempt_count = _recovered_attempt_count(payload=payload, row=row)
    max_attempts = int(row["max_attempts"]) if row["max_attempts"] is not None else None
    exhausted = max_attempts is not None and recovered_attempt_count >= max_attempts
    set_stage_state(
        conn,
        job_id,
        payload.stage,
        "exhausted" if exhausted else "failed",
        tenant_id=tenant_id,
        attempt_count=recovered_attempt_count,
        started_at=str(row["started_at"] or finished_at),
        finished_at=finished_at,
        error_code=error_code,
        error_message="The activity stopped before committing its result.",
        retryable=not exhausted,
        next_action=(
            f"retry {payload.stage} --reset-attempts"
            if exhausted
            else f"retry {payload.stage}"
        ),
        metadata={
            "recoveredFromWorkflowId": payload.workflow_id,
            "reason": "orphaned_activity_failed",
        },
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_id,
        payload.stage,
        "StageExhausted" if exhausted else "StageFailed",
        tenant_id=tenant_id,
        level="error",
        message=(
            "Activity stopped after exhausting the durable retry budget."
            if exhausted
            else "Activity stopped before completion."
        ),
        payload={
            "reason": "orphaned_activity_failed",
            "retryable": not exhausted,
            "attemptCount": recovered_attempt_count,
            "maxAttempts": max_attempts,
            "workflowId": payload.workflow_id,
        },
    )


def _recovered_attempt_count(*, payload, row) -> int:
    """Count an interrupted durable execution once across worker versions."""
    current = int(row["attempt_count"] or 0)
    metadata = _metadata(row["metadata_json"])
    # Cover historically pre-incremented its running row. New material runners
    # mark the row as a completed-count basis, matching Score and Tailor. Keep
    # old open Cover histories replay-safe while advancing all new executions.
    if payload.stage == "cover" and metadata.get("attemptCountBasis") != "completed":
        return max(1, current)
    return current + 1


def _metadata(value: object) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}
