"""Materials Generation domain events.

See ddd-target.md §4.5.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from jobhunter.domain.tenant import TenantId
from jobhunter.domain.events.base import DomainEvent, create_domain_event


@dataclass(frozen=True)
class ResumeApprovedPayload:
    job_id: str
    artifact_id: str
    generation: int
    approved_at: str


def create_resume_approved(tenant_id: TenantId, payload: ResumeApprovedPayload) -> DomainEvent:
    return create_domain_event("ResumeApproved", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ResumeFailedPayload:
    job_id: str
    validation_errors: tuple[str, ...] = ()
    attempt_number: int = 0


def create_resume_failed(tenant_id: TenantId, payload: ResumeFailedPayload) -> DomainEvent:
    return create_domain_event("ResumeFailed", tenant_id, asdict(payload))


@dataclass(frozen=True)
class CoverLetterGeneratedPayload:
    job_id: str
    artifact_id: str
    generated_at: str


def create_cover_letter_generated(tenant_id: TenantId, payload: CoverLetterGeneratedPayload) -> DomainEvent:
    return create_domain_event("CoverLetterGenerated", tenant_id, asdict(payload))


@dataclass(frozen=True)
class PdfRenderedPayload:
    job_id: str
    artifact_type: str
    artifact_id: str
    rendered_at: str


def create_pdf_rendered(tenant_id: TenantId, payload: PdfRenderedPayload) -> DomainEvent:
    return create_domain_event("PdfRendered", tenant_id, asdict(payload))


@dataclass(frozen=True)
class MaterialsExhaustedPayload:
    job_id: str
    stage: str
    attempt_count: int
    max_attempts: int


def create_materials_exhausted(tenant_id: TenantId, payload: MaterialsExhaustedPayload) -> DomainEvent:
    return create_domain_event("MaterialsExhausted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class EmployerAnalyzedPayload:
    """Phase 1 — a canonical employer analysis was persisted for a job.

    Carries the generation, the snapshot+version cache key, and the
    degraded-ensemble signal (``legs_succeeded`` / ``legs_attempted``) so the
    read-side and audit trail see a degraded ensemble immediately (D-08).
    """

    job_id: str
    generation: int
    snapshot_hash: str
    cache_key: str
    legs_attempted: int
    legs_succeeded: int
    analyzed_at: str
    cached: bool = False


def create_employer_analyzed(tenant_id: TenantId, payload: EmployerAnalyzedPayload) -> DomainEvent:
    return create_domain_event("EmployerAnalyzed", tenant_id, asdict(payload))
