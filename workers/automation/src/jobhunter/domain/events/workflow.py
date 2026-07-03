"""Workflow lifecycle domain events (Temporal loop closure — P0).

Every Temporal workflow durably records its own lifecycle: a
``WorkflowStarted`` marker at the top and exactly one terminal event
(``WorkflowCompleted`` / ``WorkflowFailed`` / ``WorkflowCanceled`` /
``WorkflowTimedOut`` / ``WorkflowTerminated``) emitted by the finalize
activity or the describe-based reconciler. Together they make execution
visible in the read-model without a trigger-coupled reaper.

Wire shape: these events carry **camelCase** payload keys because they
cross the JSON-RPC / SSE boundary to the TypeScript read-model, matching
the ``@jobhunter/domain-types`` ``Workflow*`` payload types and the
``GET /v1/events/stream`` contract. The Python fold
(``_rebuild_workflow_runs``) reads the same camelCase keys, so the
finalize writer, the projection reader, and the web handler agree on one
convention.

See ``docs/plans/2026-07-03-temporal-native-rearchitecture.md`` (P0) and
ddd-target.md §4.7 (Pipeline Orchestration).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from jobhunter.domain.tenant import TenantId
from jobhunter.domain.events.base import DomainEvent, create_domain_event

# Terminal status strings live inside the 12-state ``WORKFLOW_RUN_STATUSES``
# contract (packages/contracts/src/schemas.ts). Kept here so the finalize
# activity and the reconciler map to the same vocabulary.
WORKFLOW_STATUS_IN_PROGRESS = "in_progress"
WORKFLOW_STATUS_SUCCEEDED = "succeeded"
WORKFLOW_STATUS_FAILED = "failed"
WORKFLOW_STATUS_CANCELED = "canceled"
WORKFLOW_STATUS_TIMED_OUT = "timed_out"
WORKFLOW_STATUS_TERMINATED = "terminated"


@dataclass(frozen=True)
class WorkflowStartedPayload:
    workflow_id: str
    workflow_type: str
    input_summary: dict[str, Any] = field(default_factory=dict)
    started_at: str | None = None
    temporal_run_id: str | None = None


def create_workflow_started(tenant_id: TenantId, payload: WorkflowStartedPayload) -> DomainEvent:
    return create_domain_event(
        "WorkflowStarted",
        tenant_id,
        {
            "tenantId": str(tenant_id),
            "workflowId": payload.workflow_id,
            "workflowType": payload.workflow_type,
            "status": WORKFLOW_STATUS_IN_PROGRESS,
            "inputSummary": payload.input_summary,
            "startedAt": payload.started_at,
            "temporalRunId": payload.temporal_run_id,
        },
    )


@dataclass(frozen=True)
class WorkflowCompletedPayload:
    workflow_id: str
    workflow_type: str
    finished_at: str | None = None
    duration_ms: int | None = None
    temporal_run_id: str | None = None


def create_workflow_completed(tenant_id: TenantId, payload: WorkflowCompletedPayload) -> DomainEvent:
    return create_domain_event(
        "WorkflowCompleted",
        tenant_id,
        {
            "tenantId": str(tenant_id),
            "workflowId": payload.workflow_id,
            "workflowType": payload.workflow_type,
            "status": WORKFLOW_STATUS_SUCCEEDED,
            "finishedAt": payload.finished_at,
            "durationMs": payload.duration_ms,
            "temporalRunId": payload.temporal_run_id,
        },
    )


@dataclass(frozen=True)
class WorkflowFailedPayload:
    workflow_id: str
    workflow_type: str
    error_code: str = ""
    error_message: str = ""
    retryable: bool = False
    finished_at: str | None = None
    duration_ms: int | None = None
    temporal_run_id: str | None = None


def create_workflow_failed(tenant_id: TenantId, payload: WorkflowFailedPayload) -> DomainEvent:
    return create_domain_event(
        "WorkflowFailed",
        tenant_id,
        {
            "tenantId": str(tenant_id),
            "workflowId": payload.workflow_id,
            "workflowType": payload.workflow_type,
            "status": WORKFLOW_STATUS_FAILED,
            "errorCode": payload.error_code,
            "errorMessage": payload.error_message,
            "retryable": payload.retryable,
            "finishedAt": payload.finished_at,
            "durationMs": payload.duration_ms,
            "temporalRunId": payload.temporal_run_id,
        },
    )


@dataclass(frozen=True)
class WorkflowCanceledPayload:
    workflow_id: str
    workflow_type: str
    # Cancellation carries no app-level failure, so these are empty on the normal
    # path; the describe-based reconciler fills them in with its own provenance
    # (why it closed the row) when it terminalizes a CANCELED execution.
    error_code: str = ""
    error_message: str = ""
    finished_at: str | None = None
    duration_ms: int | None = None
    temporal_run_id: str | None = None


def create_workflow_canceled(tenant_id: TenantId, payload: WorkflowCanceledPayload) -> DomainEvent:
    return create_domain_event(
        "WorkflowCanceled",
        tenant_id,
        {
            "tenantId": str(tenant_id),
            "workflowId": payload.workflow_id,
            "workflowType": payload.workflow_type,
            "status": WORKFLOW_STATUS_CANCELED,
            "errorCode": payload.error_code,
            "errorMessage": payload.error_message,
            "finishedAt": payload.finished_at,
            "durationMs": payload.duration_ms,
            "temporalRunId": payload.temporal_run_id,
        },
    )


@dataclass(frozen=True)
class WorkflowTimedOutPayload:
    workflow_id: str
    workflow_type: str
    error_code: str = ""
    error_message: str = ""
    finished_at: str | None = None
    duration_ms: int | None = None
    temporal_run_id: str | None = None


def create_workflow_timed_out(tenant_id: TenantId, payload: WorkflowTimedOutPayload) -> DomainEvent:
    return create_domain_event(
        "WorkflowTimedOut",
        tenant_id,
        {
            "tenantId": str(tenant_id),
            "workflowId": payload.workflow_id,
            "workflowType": payload.workflow_type,
            "status": WORKFLOW_STATUS_TIMED_OUT,
            "errorCode": payload.error_code,
            "errorMessage": payload.error_message,
            "finishedAt": payload.finished_at,
            "durationMs": payload.duration_ms,
            "temporalRunId": payload.temporal_run_id,
        },
    )


@dataclass(frozen=True)
class WorkflowTerminatedPayload:
    workflow_id: str
    workflow_type: str
    error_code: str = ""
    error_message: str = ""
    finished_at: str | None = None
    duration_ms: int | None = None
    temporal_run_id: str | None = None


def create_workflow_terminated(tenant_id: TenantId, payload: WorkflowTerminatedPayload) -> DomainEvent:
    return create_domain_event(
        "WorkflowTerminated",
        tenant_id,
        {
            "tenantId": str(tenant_id),
            "workflowId": payload.workflow_id,
            "workflowType": payload.workflow_type,
            "status": WORKFLOW_STATUS_TERMINATED,
            "errorCode": payload.error_code,
            "errorMessage": payload.error_message,
            "finishedAt": payload.finished_at,
            "durationMs": payload.duration_ms,
            "temporalRunId": payload.temporal_run_id,
        },
    )
