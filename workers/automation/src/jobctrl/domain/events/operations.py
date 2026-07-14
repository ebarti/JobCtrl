"""Operations domain events."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Protocol

from jobctrl.domain.events.base import DomainEvent, create_domain_event
from jobctrl.domain.tenant import TenantId


PipelineStepKind = Literal[
    "source_planning",
    "source_family",
    "enrichment_pass",
    "preparation_fanout",
    "existing_backlog_sweep",
    "pdf_render",
]
PipelineStepState = Literal["queued", "running", "succeeded", "failed"]
PipelineStepDetailCode = Literal[
    "source_plan",
    "source_family",
    "streaming_pass",
    "terminal_reconciliation",
    "existing_backlog",
    "pdf_render",
]

PIPELINE_STEP_KINDS: tuple[PipelineStepKind, ...] = (
    "source_planning",
    "source_family",
    "enrichment_pass",
    "preparation_fanout",
    "existing_backlog_sweep",
    "pdf_render",
)
PIPELINE_STEP_STATES: tuple[PipelineStepState, ...] = (
    "queued",
    "running",
    "succeeded",
    "failed",
)
PIPELINE_STEP_DETAIL_CODES: tuple[PipelineStepDetailCode, ...] = (
    "source_plan",
    "source_family",
    "streaming_pass",
    "terminal_reconciliation",
    "existing_backlog",
    "pdf_render",
)

_SAFE_PIPELINE_ITEM_KEY = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,159}$")
_SAFE_PIPELINE_ERROR_CODE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,79}$")
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


class DiscoveryExecutionRefLike(Protocol):
    """Structural match for ``domain.discovery.execution.DiscoveryExecutionRef``."""

    tenant_id: str
    workflow_id: str
    temporal_run_id: str


@dataclass(frozen=True)
class PipelineStepSafeDetail:
    code: PipelineStepDetailCode
    item_count: int | None = None


@dataclass(frozen=True)
class PipelineStepQueuedPayload:
    execution: DiscoveryExecutionRefLike
    step_kind: PipelineStepKind
    item_key: str
    attempt: int
    queued_at: str
    detail: PipelineStepSafeDetail | None = None


@dataclass(frozen=True)
class PipelineStepStartedPayload:
    execution: DiscoveryExecutionRefLike
    step_kind: PipelineStepKind
    item_key: str
    attempt: int
    started_at: str
    detail: PipelineStepSafeDetail | None = None


@dataclass(frozen=True)
class PipelineStepCompletedPayload:
    execution: DiscoveryExecutionRefLike
    step_kind: PipelineStepKind
    item_key: str
    attempt: int
    completed_at: str
    duration_ms: int | None
    detail: PipelineStepSafeDetail | None = None


@dataclass(frozen=True)
class PipelineStepFailedPayload:
    execution: DiscoveryExecutionRefLike
    step_kind: PipelineStepKind
    item_key: str
    attempt: int
    failed_at: str
    duration_ms: int | None
    error_code: str
    retryable: bool
    detail: PipelineStepSafeDetail | None = None


def _pipeline_step_identity_payload(
    tenant_id: TenantId,
    *,
    execution: DiscoveryExecutionRefLike,
    step_kind: PipelineStepKind,
    item_key: str,
    attempt: int,
    detail: PipelineStepSafeDetail | None,
) -> dict[str, object]:
    if str(execution.tenant_id) != str(tenant_id):
        raise ValueError("pipeline step execution tenant must match the event tenant")
    if not execution.workflow_id.strip() or not execution.temporal_run_id.strip():
        raise ValueError("pipeline step execution ids must be non-empty")
    if step_kind not in PIPELINE_STEP_KINDS:
        raise ValueError(f"unknown pipeline step kind: {step_kind}")
    if not _SAFE_PIPELINE_ITEM_KEY.fullmatch(item_key):
        raise ValueError("pipeline step item_key must be a bounded safe scope key")
    if (
        isinstance(attempt, bool)
        or not isinstance(attempt, int)
        or attempt < 1
        or attempt > _MAX_SAFE_INTEGER
    ):
        raise ValueError("pipeline step attempt must be a positive safe integer")
    serialized_detail: dict[str, object] | None = None
    if detail is not None:
        if detail.code not in PIPELINE_STEP_DETAIL_CODES:
            raise ValueError(f"unknown pipeline step detail code: {detail.code}")
        if (
            detail.item_count is not None
            and (
                isinstance(detail.item_count, bool)
                or not isinstance(detail.item_count, int)
                or detail.item_count < 0
                or detail.item_count > _MAX_SAFE_INTEGER
            )
        ):
            raise ValueError("pipeline step detail item_count must be non-negative")
        serialized_detail = {
            "code": detail.code,
            "itemCount": detail.item_count,
        }
    return {
        "execution": {
            "tenantId": str(execution.tenant_id),
            "workflowId": execution.workflow_id,
            "temporalRunId": execution.temporal_run_id,
        },
        "stepKind": step_kind,
        "itemKey": item_key,
        "attempt": attempt,
        "detail": serialized_detail,
    }


def _require_pipeline_timestamp(value: str, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be non-empty")
    return value


def _normalize_pipeline_duration(value: int | None) -> int | None:
    if value is not None and (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > _MAX_SAFE_INTEGER
    ):
        raise ValueError(
            "pipeline step duration_ms must be a non-negative safe integer or None"
        )
    return value


def create_pipeline_step_queued(
    tenant_id: TenantId, payload: PipelineStepQueuedPayload
) -> DomainEvent:
    identity = _pipeline_step_identity_payload(
        tenant_id,
        execution=payload.execution,
        step_kind=payload.step_kind,
        item_key=payload.item_key,
        attempt=payload.attempt,
        detail=payload.detail,
    )
    return create_domain_event(
        "PipelineStepQueued",
        tenant_id,
        {
            **identity,
            "queuedAt": _require_pipeline_timestamp(
                payload.queued_at, "queued_at"
            ),
        },
    )


def create_pipeline_step_started(
    tenant_id: TenantId, payload: PipelineStepStartedPayload
) -> DomainEvent:
    identity = _pipeline_step_identity_payload(
        tenant_id,
        execution=payload.execution,
        step_kind=payload.step_kind,
        item_key=payload.item_key,
        attempt=payload.attempt,
        detail=payload.detail,
    )
    return create_domain_event(
        "PipelineStepStarted",
        tenant_id,
        {
            **identity,
            "startedAt": _require_pipeline_timestamp(
                payload.started_at, "started_at"
            ),
        },
    )


def create_pipeline_step_completed(
    tenant_id: TenantId, payload: PipelineStepCompletedPayload
) -> DomainEvent:
    identity = _pipeline_step_identity_payload(
        tenant_id,
        execution=payload.execution,
        step_kind=payload.step_kind,
        item_key=payload.item_key,
        attempt=payload.attempt,
        detail=payload.detail,
    )
    return create_domain_event(
        "PipelineStepCompleted",
        tenant_id,
        {
            **identity,
            "completedAt": _require_pipeline_timestamp(
                payload.completed_at, "completed_at"
            ),
            "durationMs": _normalize_pipeline_duration(payload.duration_ms),
        },
    )


def create_pipeline_step_failed(
    tenant_id: TenantId, payload: PipelineStepFailedPayload
) -> DomainEvent:
    if not isinstance(payload.error_code, str) or not _SAFE_PIPELINE_ERROR_CODE.fullmatch(
        payload.error_code
    ):
        raise ValueError("pipeline step error_code must be a bounded safe code")
    if not isinstance(payload.retryable, bool):
        raise ValueError("pipeline step retryable must be a boolean")
    identity = _pipeline_step_identity_payload(
        tenant_id,
        execution=payload.execution,
        step_kind=payload.step_kind,
        item_key=payload.item_key,
        attempt=payload.attempt,
        detail=payload.detail,
    )
    return create_domain_event(
        "PipelineStepFailed",
        tenant_id,
        {
            **identity,
            "failedAt": _require_pipeline_timestamp(payload.failed_at, "failed_at"),
            "durationMs": _normalize_pipeline_duration(payload.duration_ms),
            "errorCode": payload.error_code,
            "retryable": payload.retryable,
        },
    )


@dataclass(frozen=True)
class DigestReviewedPayload:
    acknowledged_at: str
    previous_acknowledged_at: str | None = None
    reviewed_at: str = ""


def create_digest_reviewed(tenant_id: TenantId, payload: DigestReviewedPayload) -> DomainEvent:
    return create_domain_event(
        "DigestReviewed",
        tenant_id,
        {
            "acknowledgedAt": payload.acknowledged_at,
            "previousAcknowledgedAt": payload.previous_acknowledged_at,
            "reviewedAt": payload.reviewed_at,
        },
    )
