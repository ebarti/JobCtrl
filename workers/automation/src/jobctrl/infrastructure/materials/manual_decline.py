"""Literal user work controls at implicit material admission."""

from __future__ import annotations

import json
from contextlib import contextmanager

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.preparation_recovery import MANUAL_APPLY_DECLINE_SQL
from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state

MANUAL_MATERIAL_DECLINE_CODE = "MANUAL_APPLY_DECLINED"


def release_manual_material_skips(conn, *, tenant_id, job_id=None, explicit_stage=None) -> int:
    """Release only this cause after Apply reset or a scoped explicit request.

    The caller owns the write transaction. Automatic selectors call this before
    selecting work, because a skipped row cannot invoke its own runner to reopen.
    """
    if not conn.in_transaction:
        raise RuntimeError("manual material skip reconciliation requires a write transaction")
    if explicit_stage is not None and (job_id is None or explicit_stage not in {"tailor", "cover"}):
        raise ValueError("explicit material release requires one job and stage")
    clauses = ["s.tenant_id=?", "s.stage IN ('tailor','cover')", "s.state='skipped'", "s.retryable=0", "s.error_code=?"]
    params = [str(tenant_id), MANUAL_MATERIAL_DECLINE_CODE]
    if job_id is not None:
        clauses.append("s.job_id=?")
        params.append(str(job_id))
    if explicit_stage is not None:
        clauses.append("s.stage=?")
        params.append(explicit_stage)
    else:
        clauses.append(f"NOT ({MANUAL_APPLY_DECLINE_SQL})")
    rows = conn.execute("SELECT s.* FROM job_stage_states s WHERE " + " AND ".join(clauses), params).fetchall()
    for row in rows:
        metadata = json.loads(row["metadata_json"] or "{}")
        prior = metadata.pop("manualMaterialDecline", None)
        metadata.update(reason="manual_apply_decline_released", releasedManualMaterialDecline=prior)
        stable_job = canonical_job_id(row["job_id"])
        set_stage_state(
            conn,
            stable_job,
            row["stage"],
            "pending",
            tenant_id=TenantId(str(tenant_id)),
            retryable=True,
            error_code=None,
            error_message=None,
            metadata=metadata,
            validate_transition=False,
            expected_version=row["version"],
        )
        record_job_event(
            conn,
            stable_job,
            row["stage"],
            "StageReset",
            tenant_id=TenantId(str(tenant_id)),
            message="Material preparation released after an Apply reset or explicit material request.",
            payload={"reason": "manual_apply_decline_released", "explicitMaterialRequest": explicit_stage is not None},
        )
    return len(rows)


@contextmanager
def _write_transaction(conn):
    owns_transaction = not conn.in_transaction
    if owns_transaction:
        conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        if owns_transaction:
            conn.commit()
    except BaseException:
        if owns_transaction:
            conn.rollback()
        raise


def material_request_declined(conn, *, tenant_id, job_id, stage, explicit_material_request, workflow_id=None) -> bool:
    """Recheck the exact Apply control under the stage-admission write lock.

    Early calls own a short transaction; calls from the locked stage claim join
    that transaction. Never replace admitted work, accepted state, or another stop.
    """
    if type(explicit_material_request) is not bool:
        raise ValueError("explicit_material_request must be a boolean")
    if stage not in {"tailor", "cover"}:
        raise ValueError("manual material admission requires tailor or cover")
    stable_job = canonical_job_id(str(job_id))
    with _write_transaction(conn):
        release_manual_material_skips(
            conn,
            tenant_id=tenant_id,
            job_id=stable_job,
            explicit_stage=stage if explicit_material_request else None,
        )
        declined = (
            conn.execute(
                "SELECT 1 FROM job_stage_states s WHERE s.tenant_id=? AND s.job_id=? AND s.stage='apply' AND "
                + MANUAL_APPLY_DECLINE_SQL,
                (str(tenant_id), str(stable_job)),
            ).fetchone()
            is not None
        )
        if not declined or explicit_material_request:
            return False
        # Apply is authoritative even when a runner has not created its stage.
        ensure_job_stage_rows(conn, stable_job, tenant_id=TenantId(str(tenant_id)))
        stages = ("tailor", "cover") if stage == "tailor" else ("cover",)
        for selected in stages:
            row = conn.execute(
                "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage=?",
                (str(tenant_id), str(stable_job), selected),
            ).fetchone()
            if row is None:
                continue
            metadata = json.loads(row["metadata_json"] or "{}")
            owns_queue = bool(workflow_id) and metadata.get("workflowId") == workflow_id
            if row["state"] != "pending" and not (row["state"] == "queued" and owns_queue):
                continue
            if reservation := metadata.pop("automaticPreparation", None):
                metadata["releasedAutomaticPreparation"] = reservation
            metadata.update(reason="manual_apply_decline", manualMaterialDecline={"workflowId": workflow_id})
            set_stage_state(
                conn,
                stable_job,
                selected,
                "skipped",
                tenant_id=TenantId(str(tenant_id)),
                retryable=False,
                error_code=MANUAL_MATERIAL_DECLINE_CODE,
                error_message="Automatic materials stopped because the job was marked skipped.",
                metadata=metadata,
                validate_transition=False,
                expected_version=row["version"],
            )
            record_job_event(
                conn,
                stable_job,
                selected,
                "StageSkipped",
                tenant_id=TenantId(str(tenant_id)),
                message="Automatic materials stopped by the saved manual Apply skip.",
                payload={"reason": "manual_apply_decline", "workflowId": workflow_id},
            )
        return True
