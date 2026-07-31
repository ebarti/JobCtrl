"""Interview Preparation domain events."""

from __future__ import annotations

from dataclasses import asdict, dataclass

from jobctrl.domain.events.base import DomainEvent, create_domain_event
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import TenantId


@dataclass(frozen=True)
class InterviewPrepGeneratedPayload:
    job_id: JobId
    generation: int
    item_count: int
    generated_at: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))


def create_interview_prep_generated(
    tenant_id: TenantId,
    payload: InterviewPrepGeneratedPayload,
) -> DomainEvent:
    return create_domain_event("InterviewPrepGenerated", tenant_id, asdict(payload))


@dataclass(frozen=True)
class InterviewPrepFailedPayload:
    job_id: JobId
    generation: int
    failed_at: str
    reason_count: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))


def create_interview_prep_failed(
    tenant_id: TenantId,
    payload: InterviewPrepFailedPayload,
) -> DomainEvent:
    return create_domain_event("InterviewPrepFailed", tenant_id, asdict(payload))


__all__ = [
    "InterviewPrepFailedPayload",
    "InterviewPrepGeneratedPayload",
    "create_interview_prep_failed",
    "create_interview_prep_generated",
]
