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


def recover_preparation_state_rows(
    conn: Any,
    payload: RecoverPreparationStateInput,
) -> RecoverPreparationStateOutput:
    """Accept committed work or fail only rows owned by the stopped workflow."""
    if payload.stage not in {"score", "tailor", "cover"}:
        raise ValueError("preparation recovery supports score, tailor, or cover")
    from jobctrl.domain.materials.value_objects import ArtifactStatus
    from jobctrl.domain.tenant import TenantId
    from jobctrl.infrastructure.materials import SqliteMaterialsRepository
    from jobctrl.state import utc_now

    rows = conn.execute(
        """
        SELECT job_id, attempt_count, started_at, metadata_json
          FROM job_stage_states
         WHERE tenant_id = ?
           AND stage = ?
           AND state = 'running'
           AND json_extract(metadata_json, '$.activityOwner') = ?
        """,
        (payload.tenant_id, payload.stage, payload.workflow_id),
    ).fetchall()
    tenant_id = TenantId(payload.tenant_id)
    repository = SqliteMaterialsRepository(conn) if payload.stage != "score" else None
    finished_at = utc_now()
    restored = 0
    failed = 0
    for row in rows:
        job_id = canonical_job_id(str(row["job_id"]))
        metadata = _metadata(row["metadata_json"])
        committed = False
        if payload.stage == "score":
            score_row = conn.execute(
                "SELECT COALESCE(MAX(version), 0) AS version FROM job_scores WHERE tenant_id = ? AND job_id = ?",
                (payload.tenant_id, str(job_id)),
            ).fetchone()
            current_version = int(score_row["version"] if score_row else 0)
            prior_version = int(metadata.get("priorScoreVersion") or 0)
            committed = current_version > prior_version if bool(metadata.get("rescore")) else current_version > 0
        elif payload.stage == "tailor":
            assert repository is not None
            materials = repository.load_current_approved(tenant_id, job_id)
            if materials is not None and materials.is_resume_approved:
                prior_generation = int(metadata.get("priorApprovedGeneration") or 0)
                committed = (
                    not bool(metadata.get("retailor"))
                    or int(materials.generation) > prior_generation
                )
        else:
            assert repository is not None
            materials = repository.load_current_approved(tenant_id, job_id)
            committed = (
                materials is not None
                and materials.cover_letter is not None
                and materials.cover_letter.status is ArtifactStatus.APPROVED
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


def _restore_committed(conn, *, payload, tenant_id, job_id, row, finished_at) -> None:
    from jobctrl.state import record_job_event, set_stage_state

    reason = f"orphaned_activity_restored_committed_{payload.stage}"
    set_stage_state(
        conn,
        job_id,
        payload.stage,
        "succeeded",
        tenant_id=tenant_id,
        attempt_count=max(1, int(row["attempt_count"] or 0)),
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
        message="Committed result restored after its activity owner stopped.",
        payload={"reason": reason, "workflowId": payload.workflow_id},
    )


def _fail_uncommitted(conn, *, payload, tenant_id, job_id, row, finished_at) -> None:
    from jobctrl.state import record_job_event, set_stage_state

    error_code = f"{payload.stage.upper()}_ACTIVITY_OWNER_STOPPED"
    set_stage_state(
        conn,
        job_id,
        payload.stage,
        "failed",
        tenant_id=tenant_id,
        attempt_count=int(row["attempt_count"] or 0) + 1,
        started_at=str(row["started_at"] or finished_at),
        finished_at=finished_at,
        error_code=error_code,
        error_message="The activity stopped before committing its result.",
        retryable=True,
        next_action=f"retry {payload.stage}",
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
        "StageFailed",
        tenant_id=tenant_id,
        level="error",
        message="Activity stopped before completion.",
        payload={
            "reason": "orphaned_activity_failed",
            "retryable": True,
            "workflowId": payload.workflow_id,
        },
    )


def _metadata(value: object) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}
