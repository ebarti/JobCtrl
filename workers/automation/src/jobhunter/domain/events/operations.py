"""Operations domain events."""

from __future__ import annotations

from dataclasses import dataclass

from jobhunter.domain.events.base import DomainEvent, create_domain_event
from jobhunter.domain.tenant import TenantId


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
