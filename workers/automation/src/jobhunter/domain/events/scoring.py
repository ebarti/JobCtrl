"""Scoring domain events.

See ddd-target.md §4.4.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from jobhunter.domain.tenant import TenantId
from jobhunter.domain.events.base import DomainEvent, create_domain_event


@dataclass(frozen=True)
class JobScoredPayload:
    job_id: str
    fit_score: int
    breakdown: dict[str, Any] = field(default_factory=dict)
    keywords: tuple[str, ...] = ()
    version: int = 1
    scored_at: str = ""


def create_job_scored(tenant_id: TenantId, payload: JobScoredPayload) -> DomainEvent:
    return create_domain_event("JobScored", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ScoreCorrectedPayload:
    job_id: str
    original_score: int
    corrected_score: int
    reason: str
    corrected_at: str


def create_score_corrected(tenant_id: TenantId, payload: ScoreCorrectedPayload) -> DomainEvent:
    return create_domain_event("ScoreCorrected", tenant_id, asdict(payload))
