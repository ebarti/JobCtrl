"""Saved cover-letter opt-in at planning, recovery and generation admission."""

from __future__ import annotations

import json

from jobctrl.config import get_cover_letter_generation_enabled
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.preparation_recovery import MANUAL_APPLY_DECLINE_SQL
from jobctrl.state import record_job_event, set_stage_state

COVER_LETTER_DISABLED = "COVER_LETTER_GENERATION_DISABLED"
COVER_LETTER_DISABLED_REASON = "cover_letter_generation_disabled"


def configured_preparation_steps(steps: list[str]) -> list[str]:
    """Read once outside workflow replay and freeze the resulting plan."""
    return list(steps) if get_cover_letter_generation_enabled() else [step for step in steps if step != "cover"]


def reconcile_cover_letter_policy(conn, *, tenant_id, job_id=None, workflow_id=None, release_reserved=False) -> bool:
    """Change only this policy's unstarted state; retain every accepted artifact.

    Recovery may release its own frozen unstarted reservation only after proving
    the worker idle. A runner may release only its exact queued owner. Other
    holds, failures, cancellation and already-admitted work retain their state.
    """
    enabled = get_cover_letter_generation_enabled()
    owns_transaction = not conn.in_transaction
    if owns_transaction:
        conn.execute("BEGIN IMMEDIATE")
    try:
        clauses = ["s.tenant_id=?", "s.stage='cover'", f"NOT ({MANUAL_APPLY_DECLINE_SQL})"]
        params = [str(tenant_id)]
        if job_id is not None:
            clauses.append("s.job_id=?")
            params.append(str(job_id))
        rows = conn.execute("SELECT s.* FROM job_stage_states s WHERE " + " AND ".join(clauses), params).fetchall()
        for row in rows:
            metadata = json.loads(row["metadata_json"] or "{}")
            if enabled:
                if row["state"] != "skipped" or row["error_code"] != COVER_LETTER_DISABLED:
                    continue
            else:
                reservation = metadata.get("automaticPreparation")
                own_reservation = (
                    release_reserved
                    and isinstance(reservation, dict)
                    and reservation.get("stage") == "cover"
                    and metadata.get("workflowId") == reservation.get("workflowId")
                )
                owns_queue = bool(workflow_id) and metadata.get("workflowId") == workflow_id
                if row["state"] != "pending" and not (row["state"] == "queued" and (owns_queue or own_reservation)):
                    continue
            if reservation := metadata.pop("automaticPreparation", None):
                metadata["releasedAutomaticPreparation"] = reservation
            reason = "cover_letter_generation_enabled" if enabled else COVER_LETTER_DISABLED_REASON
            metadata.update(reason=reason)
            stable_job = canonical_job_id(row["job_id"])
            set_stage_state(
                conn,
                stable_job,
                "cover",
                "pending" if enabled else "skipped",
                tenant_id=TenantId(str(tenant_id)),
                retryable=enabled,
                error_code=None if enabled else COVER_LETTER_DISABLED,
                error_message=None if enabled else "Cover-letter generation is turned off in Settings.",
                metadata=metadata,
                validate_transition=False,
                expected_version=row["version"],
            )
            record_job_event(
                conn,
                stable_job,
                "cover",
                "StageReset" if enabled else "StageSkipped",
                tenant_id=TenantId(str(tenant_id)),
                message="Cover-letter generation enabled."
                if enabled
                else "Cover-letter generation disabled by Settings.",
                payload={"reason": reason},
            )
        if owns_transaction:
            conn.commit()
    except BaseException:
        if owns_transaction:
            conn.rollback()
        raise
    return enabled


def cover_letter_request_disabled(conn, *, tenant_id, job_id, workflow_id=None) -> bool:
    return not reconcile_cover_letter_policy(conn, tenant_id=tenant_id, job_id=job_id, workflow_id=workflow_id)
