"""Job Discovery domain events.

See ddd-target.md §4.1.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from jobhunter.domain.tenant import TenantId
from jobhunter.domain.events.base import DomainEvent, create_domain_event


@dataclass(frozen=True)
class JobDiscoveredPayload:
    job_id: str
    posting_url: str
    source: str
    employer: str
    metadata: dict[str, Any] = field(default_factory=dict)
    discovered_at: str = ""


def create_job_discovered(tenant_id: TenantId, payload: JobDiscoveredPayload) -> DomainEvent:
    return create_domain_event("JobDiscovered", tenant_id, asdict(payload))


@dataclass(frozen=True)
class JobUpdatedPayload:
    job_id: str
    changed_fields: dict[str, Any] = field(default_factory=dict)


def create_job_updated(tenant_id: TenantId, payload: JobUpdatedPayload) -> DomainEvent:
    return create_domain_event("JobUpdated", tenant_id, asdict(payload))


@dataclass(frozen=True)
class JobDeletedPayload:
    job_id: str
    reason: str
    deleted_at: str


def create_job_deleted(tenant_id: TenantId, payload: JobDeletedPayload) -> DomainEvent:
    return create_domain_event("JobDeleted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class JobRestoredPayload:
    job_id: str
    restored_at: str


def create_job_restored(tenant_id: TenantId, payload: JobRestoredPayload) -> DomainEvent:
    return create_domain_event("JobRestored", tenant_id, asdict(payload))
