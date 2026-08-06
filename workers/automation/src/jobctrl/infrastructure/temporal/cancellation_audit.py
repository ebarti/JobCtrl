"""Durable audit facts for Temporal workflow cancellation requests."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timezone
from typing import Any

from jobctrl.domain.events.workflow import (
    WorkflowCancellationRequestedPayload,
    create_workflow_cancellation_requested,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId


@dataclass(frozen=True)
class CancellationRequestObservation:
    requested_by: str
    source: str
    requested_at: str
    reason: str | None = None


def cancellation_source(identity: str) -> str:
    """Classify the boundary from Temporal's immutable requester identity."""

    normalized = identity.strip().lower()
    if normalized.startswith("temporal-cli:"):
        return "temporal_cli"
    if normalized.startswith("temporal-web:"):
        return "temporal_web"
    if normalized:
        return "temporal_external"
    return "temporal_unknown"


async def cancellation_request_from_history(
    handle: Any,
) -> CancellationRequestObservation | None:
    """Read the authoritative cancel-request event from one exact execution."""

    async for event in handle.fetch_history_events(wait_new_event=False):
        if event.WhichOneof("attributes") != "workflow_execution_cancel_requested_event_attributes":
            continue
        attrs = event.workflow_execution_cancel_requested_event_attributes
        identity = str(getattr(attrs, "identity", "") or "").strip() or "unknown"
        raw_cause = getattr(attrs, "cause", None)
        reason = str(raw_cause).strip() if raw_cause not in (None, "", 0) else None
        return CancellationRequestObservation(
            requested_by=identity,
            source=cancellation_source(identity),
            requested_at=_event_timestamp(event),
            reason=reason,
        )
    return None


def record_workflow_cancellation_requested(
    conn: Any,
    *,
    workflow_id: str,
    requested_by: str,
    source: str,
    requested_at: str,
    evidence_kind: str,
    reason: str | None = None,
    workflow_type: str | None = None,
    temporal_run_id: str | None = None,
    tenant_id: str | TenantId = LOCAL_TENANT,
    refresh_projection: bool = True,
) -> bool:
    """Append one idempotent cancellation-request fact and refresh its read model."""

    from jobctrl.database import get_connection
    from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
    from jobctrl.state import record_job_event

    if not workflow_id.strip():
        return False
    if evidence_kind not in {
        "request_intent",
        "temporal_history",
        "recovered_temporal_history",
    }:
        raise ValueError("unknown cancellation evidence kind")
    row = conn.execute(
        "SELECT workflow_type, temporal_run_id FROM workflow_run_projections "
        "WHERE tenant_id = ? AND workflow_id = ?",
        (str(tenant_id), workflow_id),
    ).fetchone()
    resolved_type = workflow_type or (str(row[0] or "") if row is not None else "")
    resolved_run_id = temporal_run_id or (str(row[1] or "") if row is not None else "") or None
    event = create_workflow_cancellation_requested(
        TenantId(str(tenant_id)),
        WorkflowCancellationRequestedPayload(
            workflow_id=workflow_id,
            workflow_type=resolved_type,
            requested_by=requested_by.strip() or "unknown",
            source=source.strip() or "unknown",
            requested_at=requested_at,
            evidence_kind=evidence_kind,
            reason=reason.strip() if isinstance(reason, str) and reason.strip() else None,
            temporal_run_id=resolved_run_id,
        ),
    )
    before = conn.total_changes
    record_job_event(
        conn,
        None,
        "workflow",
        event.event_type,
        tenant_id=TenantId(str(tenant_id)),
        message=str(event.payload.get("message") or "Workflow cancellation requested."),
        payload=dict(event.payload),
        occurred_at=requested_at,
        entity_kind="workflow_run",
        entity_ref=workflow_id,
        idempotency_key=(
            f"workflow-cancellation-request:{evidence_kind}:{tenant_id}:{workflow_id}:"
            f"{resolved_run_id or 'unknown'}"
        ),
    )
    changed = conn.total_changes > before
    conn.commit()
    if changed and refresh_projection:
        ProjectionBuilder(conn_factory=get_connection).refresh()
    return changed


def _event_timestamp(event: Any) -> str:
    from jobctrl.state import utc_now

    timestamp = getattr(event, "event_time", None)
    if timestamp is None or not hasattr(timestamp, "ToDatetime"):
        return utc_now()
    try:
        observed = timestamp.ToDatetime(tzinfo=timezone.utc)
    except TypeError:
        observed = timestamp.ToDatetime().replace(tzinfo=timezone.utc)
    return observed.isoformat()
