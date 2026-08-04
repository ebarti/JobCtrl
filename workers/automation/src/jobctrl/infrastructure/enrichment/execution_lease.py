"""Event-backed fencing for Discover enrichment activity attempts."""

from __future__ import annotations

import hashlib
import json
import sqlite3

from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.enrichment import (
    EnrichmentExecutionLease,
    StaleEnrichmentExecutionLease,
)
from jobctrl.domain.tenant import TenantId
from jobctrl.state import record_job_event

_ENTITY_KIND = "discovery_enrichment_lease"


def claim_enrichment_execution_lease(
    conn: sqlite3.Connection,
    execution: DiscoveryExecutionRef,
    *,
    owner_token: str,
    activity_phase: int,
    activity_attempt: int,
) -> EnrichmentExecutionLease:
    """Claim the newest workflow-assigned enrichment phase and attempt."""

    owner = owner_token.strip()
    if not owner:
        raise ValueError("activity_owner_token must be non-empty")
    if activity_phase < 1 or activity_attempt < 1:
        raise ValueError("activity_phase and activity_attempt must be positive")
    entity_ref = _execution_entity_ref(
        execution.tenant_id,
        execution.workflow_id,
        execution.temporal_run_id,
    )
    idempotency_key = f"enrichment-lease:{entity_ref}:{owner}"
    # Serialize the semantic comparison and append. Arrival order is not
    # authority: a disconnected old worker can resume after Temporal has
    # already started a later attempt, and the terminal phase must supersede
    # every producer-lifetime attempt regardless of its retry number.
    conn.execute("BEGIN IMMEDIATE")
    try:
        current = conn.execute(
            "SELECT event_id, json_extract(payload_json, '$.ownerToken'), "
            "COALESCE(CAST(json_extract(payload_json, '$.activityPhase') AS INTEGER), 1), "
            "CAST(json_extract(payload_json, '$.activityAttempt') AS INTEGER) "
            "FROM job_events WHERE entity_kind = ? AND entity_ref = ? "
            "ORDER BY 3 DESC, 4 DESC, event_id ASC LIMIT 1",
            (_ENTITY_KIND, entity_ref),
        ).fetchone()
        if current is not None:
            current_owner = str(current[1] or "")
            current_key = (int(current[2] or 1), int(current[3] or 1))
            requested_key = (activity_phase, activity_attempt)
            if current_key > requested_key or (
                current_key == requested_key and current_owner != owner
            ):
                raise StaleEnrichmentExecutionLease(
                    "enrichment activity claim is older than the current workflow phase"
                )

        record_job_event(
            conn,
            None,
            "workflow",
            "EnrichmentLeaseClaimed",
            tenant_id=TenantId(execution.tenant_id),
            message="Discover enrichment activity lease claimed",
            payload={
                "execution": {
                    "tenantId": execution.tenant_id,
                    "workflowId": execution.workflow_id,
                    "runId": execution.temporal_run_id,
                },
                "ownerToken": owner,
                "activityPhase": activity_phase,
                "activityAttempt": activity_attempt,
            },
            entity_kind=_ENTITY_KIND,
            entity_ref=entity_ref,
            idempotency_key=idempotency_key,
        )
        row = conn.execute(
            "SELECT event_id FROM job_events WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    if row is None:
        raise RuntimeError("enrichment lease claim was not persisted")
    event_id = int(row[0])
    generation = int(
        conn.execute(
            "SELECT COUNT(*) FROM job_events "
            "WHERE entity_kind = ? AND entity_ref = ? AND event_id <= ?",
            (_ENTITY_KIND, entity_ref, event_id),
        ).fetchone()[0]
    )
    return EnrichmentExecutionLease(
        tenant_id=TenantId(execution.tenant_id),
        workflow_id=execution.workflow_id,
        run_id=execution.temporal_run_id,
        owner_token=owner,
        epoch=event_id,
        generation=generation,
        activity_phase=activity_phase,
        activity_attempt=activity_attempt,
    )


def fence_enrichment_execution_lease(
    conn: sqlite3.Connection,
    lease: EnrichmentExecutionLease,
) -> None:
    """Acquire writer ordering and reject any superseded lease event."""

    entity_ref = _execution_entity_ref(
        str(lease.tenant_id),
        lease.workflow_id,
        lease.run_id,
    )
    fenced = conn.execute(
        "UPDATE job_events SET event_id = event_id "
        "WHERE event_id = ? AND entity_kind = ? AND entity_ref = ? "
        "AND json_extract(payload_json, '$.ownerToken') = ? "
        "AND COALESCE(CAST(json_extract(payload_json, '$.activityPhase') AS INTEGER), 1) = ? "
        "AND CAST(json_extract(payload_json, '$.activityAttempt') AS INTEGER) = ? "
        "AND NOT EXISTS (SELECT 1 FROM job_events newer "
        "WHERE newer.entity_kind = ? AND newer.entity_ref = ? AND ("
        "COALESCE(CAST(json_extract(newer.payload_json, '$.activityPhase') AS INTEGER), 1) > ? "
        "OR (COALESCE(CAST(json_extract(newer.payload_json, '$.activityPhase') AS INTEGER), 1) = ? "
        "AND CAST(json_extract(newer.payload_json, '$.activityAttempt') AS INTEGER) > ?) "
        "OR (COALESCE(CAST(json_extract(newer.payload_json, '$.activityPhase') AS INTEGER), 1) = ? "
        "AND CAST(json_extract(newer.payload_json, '$.activityAttempt') AS INTEGER) = ? "
        "AND json_extract(newer.payload_json, '$.ownerToken') != ?)))",
        (
            lease.epoch,
            _ENTITY_KIND,
            entity_ref,
            lease.owner_token,
            lease.activity_phase,
            lease.activity_attempt,
            _ENTITY_KIND,
            entity_ref,
            lease.activity_phase,
            lease.activity_phase,
            lease.activity_attempt,
            lease.activity_phase,
            lease.activity_attempt,
            lease.owner_token,
        ),
    )
    if fenced.rowcount != 1:
        conn.rollback()
        raise StaleEnrichmentExecutionLease(
            "enrichment activity was superseded by a newer execution lease"
        )


def _execution_entity_ref(tenant_id: str, workflow_id: str, run_id: str) -> str:
    canonical = json.dumps(
        [tenant_id, workflow_id, run_id],
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


__all__ = [
    "claim_enrichment_execution_lease",
    "fence_enrichment_execution_lease",
]
