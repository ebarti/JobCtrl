"""Settle only the material attempt that still owns its stage."""
from __future__ import annotations

import json
from functools import wraps

from jobctrl.infrastructure.materials.unit_of_work import SqliteUnitOfWork
from jobctrl.infrastructure.preparation_recovery import MaterialAttemptSuperseded
from jobctrl.state import record_job_event, set_stage_state, utc_now


def preserve_direct_attempt_result(stage: str):
    """Return the existing stale result when a direct caller loses ownership."""
    def decorate(fn):
        @wraps(fn)
        def invoke(job_id, *args, **kwargs):
            try:
                return fn(job_id, *args, **kwargs)
            except MaterialAttemptSuperseded as exc:
                if kwargs.get("workflow_id") or kwargs.get("temporal_attempt") is not None:
                    raise
                if stage == "tailor":
                    return {"url": exc.material_url, "job_id": str(job_id), "status": "skipped",
                            "reason": "materials_changed_during_tailoring"}
                return {"jobId": str(job_id), "url": exc.material_url, "status": "skipped",
                        "reason": "materials_changed_during_cover", "generated": 0, "errors": 0, "elapsed": 0.0}
        return invoke
    return decorate


def settle_stale_material_attempt(
    conn, *, tenant_id, job_id, stage: str, attempt_id: str, started_at: str,
    prior_attempts: int, workflow_id: str | None, reason: str,
) -> bool:
    """Mark an unchanged owner stale without touching a successor's state."""
    with SqliteUnitOfWork(conn):
        row = conn.execute(
            "SELECT state,started_at,metadata_json FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage=?",
            (str(tenant_id), str(job_id), stage),
        ).fetchone()
        latest = conn.execute(
            "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage=? "
            "AND event_type='StageStarted' ORDER BY event_id DESC LIMIT 1",
            (str(tenant_id), str(job_id), stage),
        ).fetchone()
        try:
            metadata = json.loads(row["metadata_json"]) if row and row["metadata_json"] else None
            payload = json.loads(latest[0]) if latest else None
        except (TypeError, ValueError):
            return False
        if (
            row is None or row["state"] != "running" or row["started_at"] != started_at
            or not isinstance(payload, dict) or payload.get("materialAttemptId") != attempt_id
            or (metadata is not None and not isinstance(metadata, dict))
            or (workflow_id and (metadata or {}).get("activityOwner") != workflow_id)
        ):
            return False
        set_stage_state(
            conn, job_id, stage, "stale", tenant_id=tenant_id, attempt_count=prior_attempts,
            started_at=started_at, finished_at=utc_now(), error_code="MATERIAL_SOURCE_CHANGED",
            error_message="Materials changed during generation; retry with the current sources.",
            retryable=True, metadata=metadata, validate_transition=False,
        )
        record_job_event(
            conn, job_id, stage, "StageStale", tenant_id=tenant_id,
            message="Materials changed during generation; retry with the current sources.",
            payload={"reason": reason, "materialAttemptId": attempt_id},
        )
        return True
