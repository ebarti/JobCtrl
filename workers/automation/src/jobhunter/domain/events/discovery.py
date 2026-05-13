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


@dataclass(frozen=True)
class SourceLocationCandidateDiscoveredPayload:
    candidate_id: str
    candidate_url: str
    source_kind: str
    confidence: float
    evidence_ref: str
    discovered_at: str


def create_source_location_candidate_discovered(
    tenant_id: TenantId,
    payload: SourceLocationCandidateDiscoveredPayload,
) -> DomainEvent:
    return create_domain_event("SourceLocationCandidateDiscovered", tenant_id, asdict(payload))


@dataclass(frozen=True)
class SourceLocationCandidatePromotedPayload:
    candidate_id: str
    source_id: str
    promoted_at: str


def create_source_location_candidate_promoted(
    tenant_id: TenantId,
    payload: SourceLocationCandidatePromotedPayload,
) -> DomainEvent:
    return create_domain_event("SourceLocationCandidatePromoted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class SourceRegistryEntryCreatedPayload:
    source_id: str
    kind: str
    policy_id: str
    state: str
    created_at: str


def create_source_registry_entry_created(
    tenant_id: TenantId,
    payload: SourceRegistryEntryCreatedPayload,
) -> DomainEvent:
    return create_domain_event("SourceRegistryEntryCreated", tenant_id, asdict(payload))


@dataclass(frozen=True)
class SourceRegistryEntryUpdatedPayload:
    source_id: str
    changed_fields: tuple[str, ...]
    updated_at: str


def create_source_registry_entry_updated(
    tenant_id: TenantId,
    payload: SourceRegistryEntryUpdatedPayload,
) -> DomainEvent:
    return create_domain_event("SourceRegistryEntryUpdated", tenant_id, asdict(payload))


@dataclass(frozen=True)
class SourceStateChangedPayload:
    source_id: str
    from_state: str
    to_state: str
    reason: str
    changed_at: str


def create_source_state_changed(
    tenant_id: TenantId,
    payload: SourceStateChangedPayload,
) -> DomainEvent:
    return create_domain_event("SourceStateChanged", tenant_id, asdict(payload))
