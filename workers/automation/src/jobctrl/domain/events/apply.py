"""Apply Automation domain events.

See ddd-target.md §4.6.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from jobctrl.domain.tenant import TenantId
from jobctrl.domain.events.base import DomainEvent, create_domain_event


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
class ApplySubmitIntendedPayload:
    tenant_id: str
    job_key: str
    run_id: str
    material_version: str
    intended_at: str


def create_apply_submit_intended(tenant_id: TenantId, payload: ApplySubmitIntendedPayload) -> DomainEvent:
    return create_domain_event("ApplySubmitIntended", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ApplyRunEventRecordedPayload:
    run_id: str
    event: dict[str, Any] = field(default_factory=dict)


def create_apply_run_event_recorded(tenant_id: TenantId, payload: ApplyRunEventRecordedPayload) -> DomainEvent:
    return create_domain_event("ApplyRunEventRecorded", tenant_id, asdict(payload))


@dataclass(frozen=True)
class EmailApplicationCandidateRecordedPayload:
    run_id: str
    recipient: str
    subject: str
    body: str
    attachment_artifact_id: str
    attachment_name: str


def create_email_application_candidate_recorded(
    tenant_id: TenantId,
    payload: EmailApplicationCandidateRecordedPayload,
) -> DomainEvent:
    return create_domain_event("EmailApplicationCandidateRecorded", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ApplicationEmailFeedbackIngestedPayload:
    job_key: str
    evidence_id: str
    suggestion_id: str
    provider: str = "gmail"
    suggested_kind: str = "unknown"
    classification_confidence: float = 0.0
    link_confidence: float = 0.0
    link_signals: list[str] = field(default_factory=list)


def create_application_email_feedback_ingested(
    tenant_id: TenantId,
    payload: ApplicationEmailFeedbackIngestedPayload,
) -> DomainEvent:
    return create_domain_event("ApplicationEmailFeedbackIngested", tenant_id, asdict(payload))
