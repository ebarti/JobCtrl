"""Pipeline Orchestration domain events.

See ddd-target.md §4.7.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from jobctrl.domain.tenant import TenantId
from jobctrl.domain.events.base import DomainEvent, create_domain_event


@dataclass(frozen=True)
class StageStartedPayload:
    job_id: str
    stage: str
    attempt_number: int
    started_at: str


def create_stage_started(tenant_id: TenantId, payload: StageStartedPayload) -> DomainEvent:
    return create_domain_event("StageStarted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class StageCompletedPayload:
    job_id: str
    stage: str
    finished_at: str
    duration_ms: int


def create_stage_completed(tenant_id: TenantId, payload: StageCompletedPayload) -> DomainEvent:
    return create_domain_event("StageCompleted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class StageFailedPayload:
    job_id: str
    stage: str
    error_code: str
    error_message: str
    retryable: bool
    attempt_number: int


def create_stage_failed(tenant_id: TenantId, payload: StageFailedPayload) -> DomainEvent:
    return create_domain_event("StageFailed", tenant_id, asdict(payload))


@dataclass(frozen=True)
class StageExhaustedPayload:
    job_id: str
    stage: str
    attempt_count: int
    max_attempts: int


def create_stage_exhausted(tenant_id: TenantId, payload: StageExhaustedPayload) -> DomainEvent:
    return create_domain_event("StageExhausted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class StageResetPayload:
    job_id: str
    stage: str
    reset_attempts: bool
    reset_at: str


def create_stage_reset(tenant_id: TenantId, payload: StageResetPayload) -> DomainEvent:
    return create_domain_event("StageReset", tenant_id, asdict(payload))


@dataclass(frozen=True)
class StageBlockedPayload:
    job_id: str
    stage: str
    blocked_by: tuple[str, ...] = ()


def create_stage_blocked(tenant_id: TenantId, payload: StageBlockedPayload) -> DomainEvent:
    return create_domain_event("StageBlocked", tenant_id, asdict(payload))


@dataclass(frozen=True)
class StageSkippedPayload:
    job_id: str
    stage: str
    reason: str


def create_stage_skipped(tenant_id: TenantId, payload: StageSkippedPayload) -> DomainEvent:
    return create_domain_event("StageSkipped", tenant_id, asdict(payload))


@dataclass(frozen=True)
class StageCanceledPayload:
    job_id: str
    stage: str
    canceled_at: str
    reason: str | None = None


def create_stage_canceled(tenant_id: TenantId, payload: StageCanceledPayload) -> DomainEvent:
    return create_domain_event("StageCanceled", tenant_id, asdict(payload))
