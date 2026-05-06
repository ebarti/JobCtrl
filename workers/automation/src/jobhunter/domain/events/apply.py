"""Apply Automation domain events.

See ddd-target.md §4.6.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from jobhunter.domain.tenant import TenantId
from jobhunter.domain.events.base import DomainEvent, create_domain_event


@dataclass(frozen=True)
class ApplicationSubmittedPayload:
    job_id: str
    run_id: str
    applied_at: str
    verification_confidence: float


def create_application_submitted(tenant_id: TenantId, payload: ApplicationSubmittedPayload) -> DomainEvent:
    return create_domain_event("ApplicationSubmitted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ApplicationFailedPayload:
    job_id: str
    run_id: str
    result: dict[str, Any] = field(default_factory=dict)
    attempt_number: int = 0


def create_application_failed(tenant_id: TenantId, payload: ApplicationFailedPayload) -> DomainEvent:
    return create_domain_event("ApplicationFailed", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ApplyRunStartedPayload:
    job_id: str
    run_id: str
    worker_id: str
    model: str
    dry_run: bool
    started_at: str


def create_apply_run_started(tenant_id: TenantId, payload: ApplyRunStartedPayload) -> DomainEvent:
    return create_domain_event("ApplyRunStarted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ApplyRunEventRecordedPayload:
    run_id: str
    event: dict[str, Any] = field(default_factory=dict)


def create_apply_run_event_recorded(tenant_id: TenantId, payload: ApplyRunEventRecordedPayload) -> DomainEvent:
    return create_domain_event("ApplyRunEventRecorded", tenant_id, asdict(payload))
