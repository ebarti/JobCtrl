"""Workflow lifecycle domain events (Temporal loop closure — P0).

Every Temporal workflow durably records its own lifecycle: a
``WorkflowStarted`` marker at the top and exactly one terminal event
(``WorkflowCompleted`` / ``WorkflowFailed`` / ``WorkflowCanceled`` /
``WorkflowTimedOut`` / ``WorkflowTerminated``) emitted by the finalize
activity or the describe-based reconciler. Together they make execution
visible in the read-model without a trigger-coupled reaper.

Wire shape: these events carry **camelCase** payload keys because they
cross the JSON-RPC / SSE boundary to the TypeScript read-model, matching
the ``@jobctrl/domain-types`` ``Workflow*`` payload types and the
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

from jobctrl.domain.discovery.execution import DISCOVERY_PREPARATION_STEPS, DiscoveryExecutionRef
from jobctrl.domain.events.base import DomainEvent, create_domain_event
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import TenantId

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
    # Set only by the reconciler after the exact Temporal execution that was
    # previously misclassified as missing becomes authoritative again.
    recovered_from_missing_history: bool = False


def create_workflow_started(tenant_id: TenantId, payload: WorkflowStartedPayload) -> DomainEvent:
    event_payload: dict[str, Any] = {
        "tenantId": str(tenant_id),
        "workflowId": payload.workflow_id,
        "workflowType": payload.workflow_type,
        "status": WORKFLOW_STATUS_IN_PROGRESS,
        "inputSummary": payload.input_summary,
        "startedAt": payload.started_at,
        "temporalRunId": payload.temporal_run_id,
    }
    if payload.recovered_from_missing_history:
        event_payload["recoveredFromMissingHistory"] = True
    return create_domain_event(
        "WorkflowStarted",
        tenant_id,
        event_payload,
    )


@dataclass(frozen=True)
class WorkflowCancellationRequestedPayload:
    """Audit fact for who requested cancellation and through which boundary."""

    workflow_id: str
    workflow_type: str
    requested_by: str
    source: str
    requested_at: str
    evidence_kind: str
    reason: str | None = None
    temporal_run_id: str | None = None


def create_workflow_cancellation_requested(
    tenant_id: TenantId,
    payload: WorkflowCancellationRequestedPayload,
) -> DomainEvent:
    if payload.evidence_kind == "recovered_temporal_history":
        message = (
            "Cancellation requester recovered from a prior Temporal history "
            f"observation: {payload.requested_by} via {payload.source}."
        )
    else:
        message = f"Cancellation requested by {payload.requested_by} via {payload.source}."
    if payload.reason:
        message = f"{message} Reason: {payload.reason}"
    return create_domain_event(
        "WorkflowCancellationRequested",
        tenant_id,
        {
            "tenantId": str(tenant_id),
            "workflowId": payload.workflow_id,
            "workflowType": payload.workflow_type,
            "requestedBy": payload.requested_by,
            "source": payload.source,
            "evidenceKind": payload.evidence_kind,
            "reason": payload.reason,
            "requestedAt": payload.requested_at,
            "temporalRunId": payload.temporal_run_id,
            "message": message,
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


@dataclass(frozen=True)
class PreparationWorkflowOutcomeObservedPayload:
    """Bounded successful result read from one exact preparation execution."""

    workflow_id: str
    temporal_run_id: str
    job_id: JobId
    idempotency_key: str
    required_steps: tuple[str, ...]
    discovery_execution: DiscoveryExecutionRef
    terminal_history_event_id: int
    steps_completed: tuple[str, ...]
    steps_skipped: tuple[str, ...]


def create_preparation_workflow_outcome_observed(
    tenant_id: TenantId,
    payload: PreparationWorkflowOutcomeObservedPayload,
) -> DomainEvent:
    if (
        not isinstance(payload.discovery_execution, DiscoveryExecutionRef)
        or payload.discovery_execution.tenant_id != str(tenant_id)
        or any(
            not isinstance(value, str) or not value or value != value.strip() or len(value) > 1024
            for value in (
                payload.workflow_id, payload.temporal_run_id, payload.idempotency_key,
                payload.discovery_execution.tenant_id, payload.discovery_execution.workflow_id,
                payload.discovery_execution.temporal_run_id,
            )
        )
        or payload.workflow_id != "prep-" + payload.idempotency_key
        or type(payload.terminal_history_event_id) is not int
        or payload.terminal_history_event_id <= 0
    ):
        raise ValueError("invalid preparation outcome identity")
    required, done, skipped = payload.required_steps, payload.steps_completed, payload.steps_skipped
    for steps in (required, done, skipped):
        if (
            not isinstance(steps, tuple)
            or len(steps) > 4
            or any(step not in DISCOVERY_PREPARATION_STEPS for step in steps)
            or len(set(steps)) != len(steps)
        ):
            raise ValueError("invalid preparation outcome steps")
    if (
        not required
        or "pdf" not in required
        or tuple(step for step in DISCOVERY_PREPARATION_STEPS if step in required) != required
        or len(skipped) > 1
        or (skipped and (skipped[0] not in required or done != required[: required.index(skipped[0])]))
        or (not skipped and done != required)
    ):
        raise ValueError("contradictory preparation outcome result")
    return create_domain_event(
        "PreparationWorkflowOutcomeObserved",
        tenant_id,
        {
            "tenantId": str(tenant_id),
            "decoderVersion": 1,
            "evidenceKind": "temporal_history",
            "workflowType": "JobPreparationWorkflow",
            "workflowId": payload.workflow_id,
            "temporalRunId": payload.temporal_run_id,
            "jobId": str(canonical_job_id(str(payload.job_id))),
            "idempotencyKey": payload.idempotency_key,
            "requiredSteps": list(required),
            "discoveryExecution": payload.discovery_execution.safe_summary(),
            "terminalHistoryEventId": payload.terminal_history_event_id,
            "result": {
                "stepsCompleted": list(done),
                "stepsSkipped": list(skipped),
                "stepsFailed": [],
                "failure": None,
                "errorCode": None,
            },
        },
    )
