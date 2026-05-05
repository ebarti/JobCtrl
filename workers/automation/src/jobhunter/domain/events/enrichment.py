"""Job Enrichment domain events.

See ddd-target.md §4.2.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from jobhunter.domain.tenant import TenantId
from jobhunter.domain.events.base import DomainEvent, create_domain_event


@dataclass(frozen=True)
class JobEnrichedPayload:
    job_id: str
    full_description: str
    application_url: str
    extraction_tier: str
    enriched_at: str


def create_job_enriched(tenant_id: TenantId, payload: JobEnrichedPayload) -> DomainEvent:
    return create_domain_event("JobEnriched", tenant_id, asdict(payload))


@dataclass(frozen=True)
class EnrichmentFailedPayload:
    job_id: str
    error: str
    attempt_number: int


def create_enrichment_failed(tenant_id: TenantId, payload: EnrichmentFailedPayload) -> DomainEvent:
    return create_domain_event("EnrichmentFailed", tenant_id, asdict(payload))
