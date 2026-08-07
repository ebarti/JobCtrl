"""Durable audit facts for Temporal workflow cancellation requests.

Three evidence kinds cover every boundary a cancel can cross:

* ``request_intent`` — the local RPC witnessed the request (recorded by
  ``make_cancel_run`` once Temporal accepted delivery).
* ``temporal_history`` — the describe-based reconciler read Temporal's
  immutable requester identity from the execution's history while settling
  the canceled run.
* ``recovered_temporal_history`` — the backfill sweep recovered the requester
  for a run that had already terminalized without the fact (external
  CLI/Web cancels, cooperative cancels closed by finalize, and legacy runs).

Recording a fact only ever ENRICHES the run's audit stream: the projection
fold treats ``WorkflowCancellationRequested`` as timeline-only, so an
audit-only event group never rebuilds or overwrites a stored run row.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from datetime import timezone
from typing import Any

from jobctrl.domain.events.workflow import (
    WorkflowCancellationRequestedPayload,
    create_workflow_cancellation_requested,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId

log = logging.getLogger(__name__)


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
        raw_identity = str(getattr(attrs, "identity", "") or "").strip()
        raw_cause = getattr(attrs, "cause", None)
        reason = str(raw_cause).strip() if raw_cause not in (None, "", 0) else None
        return CancellationRequestObservation(
            requested_by=raw_identity or "unknown",
            # Classify the RAW identity: a blank requester is temporal_unknown,
            # never temporal_external (which would misattribute it to a real
            # external boundary).
            source=cancellation_source(raw_identity),
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


async def observe_and_record_cancellation_request(
    conn: Any,
    handle: Any,
    *,
    workflow_id: str,
    evidence_kind: str,
    workflow_type: str | None = None,
    temporal_run_id: str | None = None,
    tenant_id: str | TenantId = LOCAL_TENANT,
) -> bool:
    """Read the requester from one exact execution's history and record it.

    Returns ``True`` only when a cancel-request event was found AND its fact
    was newly appended (the idempotency key makes replays no-ops).
    """

    observation = await cancellation_request_from_history(handle)
    if observation is None:
        return False
    return record_workflow_cancellation_requested(
        conn,
        workflow_id=workflow_id,
        requested_by=observation.requested_by,
        source=observation.source,
        requested_at=observation.requested_at,
        evidence_kind=evidence_kind,
        reason=observation.reason,
        workflow_type=workflow_type,
        temporal_run_id=temporal_run_id,
        tenant_id=tenant_id,
    )


async def reconcile_cancellation_audit(
    temporal_client: Any,
    *,
    tenant_id: str | TenantId = LOCAL_TENANT,
    conn: Any | None = None,
) -> int:
    """Backfill the immutable requester fact for canceled runs lacking it.

    Runs in the worker heartbeat loop after the describe-based run reconciler.
    The target population is exactly ``workflow_runs_missing_cancellation_audit``:
    canceled rows with an exact Temporal run id and no history-evidence fact —
    external CLI/Web cancels, cooperative cancels closed by finalize, and runs
    canceled before this auditing existed. Each recovered fact is recorded with
    ``evidence_kind="recovered_temporal_history"``; per-run failures are logged
    and retried on the next sweep, and a vanished history (dev-server loss) is
    skipped quietly because the requester is unrecoverable until the
    authoritative history reappears.
    """

    from temporalio.service import RPCError, RPCStatusCode

    from jobctrl.database import get_connection
    from jobctrl.infrastructure.projections.sqlite_projection_store import (
        SqliteProjectionStore,
    )

    connection = conn or get_connection()
    try:
        missing = SqliteProjectionStore(connection).workflow_runs_missing_cancellation_audit(
            str(tenant_id)
        )
    except sqlite3.OperationalError:
        return 0

    recovered = 0
    for run in missing:
        workflow_id = str(run.get("workflow_id") or "")
        temporal_run_id = str(run.get("temporal_run_id") or "") or None
        if not workflow_id or not temporal_run_id:
            continue
        try:
            handle = temporal_client.get_workflow_handle(
                workflow_id, run_id=temporal_run_id
            )
            changed = await observe_and_record_cancellation_request(
                connection,
                handle,
                workflow_id=workflow_id,
                evidence_kind="recovered_temporal_history",
                workflow_type=str(run.get("workflow_type") or "") or None,
                temporal_run_id=temporal_run_id,
                tenant_id=str(run.get("tenant_id") or tenant_id),
            )
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                continue
            log.warning(
                "Cancellation-audit history read failed for %s; will retry",
                workflow_id,
                exc_info=True,
            )
            continue
        except Exception:
            log.warning(
                "Cancellation-audit recovery failed for %s; will retry",
                workflow_id,
                exc_info=True,
            )
            continue
        if changed:
            recovered += 1
    return recovered


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
