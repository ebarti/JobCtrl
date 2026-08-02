"""Job Discovery domain events.

See ddd-target.md §4.1.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from jobctrl.domain.tenant import TenantId
from jobctrl.domain.events.base import DomainEvent, create_domain_event


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


# -- PR 2 events: Canonical ATS adapters + identity dedupe ------------------
# Each event shape mirrors the §"Domain Events" table in
# docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md so the
# Operations projections can stay exhaustive and the SSE invalidation
# router can stay parity-safe.


@dataclass(frozen=True)
class JobSourceObservedPayload:
    """Per-source evidence attached to a canonical Job aggregate.

    Emitted whenever a scraper run sees a posting for an existing
    canonical Job (same source-native id, canonical URL, ATS identity,
    or a confirmed duplicate). A first-time observation for a new
    canonical Job is emitted alongside ``JobDiscovered`` so source
    quality aggregations see every hit.
    """

    job_id: str
    source_observation_id: str
    source_id: str
    source_native_id: str
    observed_url: str
    run_id: str
    observed_at: str


def create_job_source_observed(
    tenant_id: TenantId,
    payload: JobSourceObservedPayload,
) -> DomainEvent:
    return create_domain_event("JobSourceObserved", tenant_id, asdict(payload))


@dataclass(frozen=True)
class DiscoveryRunStartedPayload:
    run_id: str
    source_ids: tuple[str, ...]
    profile_snapshot_id: str | None
    started_at: str


def create_discovery_run_started(
    tenant_id: TenantId,
    payload: DiscoveryRunStartedPayload,
) -> DomainEvent:
    return create_domain_event("DiscoveryRunStarted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class DiscoveryRunCountsPayload:
    total: int = 0
    new_jobs: int = 0
    existing_jobs: int = 0
    observed_jobs: int = 0
    duplicate_jobs: int = 0
    rejected_duplicates: int = 0


@dataclass(frozen=True)
class DiscoveryRunCompletedPayload:
    run_id: str
    counts: DiscoveryRunCountsPayload
    error_classes: tuple[str, ...]
    completed_at: str


def create_discovery_run_completed(
    tenant_id: TenantId,
    payload: DiscoveryRunCompletedPayload,
) -> DomainEvent:
    event_payload = asdict(payload)
    return create_domain_event("DiscoveryRunCompleted", tenant_id, event_payload)


@dataclass(frozen=True)
class DiscoveryRunFailedPayload:
    run_id: str
    source_id: str
    error_class: str
    retryable: bool
    failed_at: str


def create_discovery_run_failed(
    tenant_id: TenantId,
    payload: DiscoveryRunFailedPayload,
) -> DomainEvent:
    return create_domain_event("DiscoveryRunFailed", tenant_id, asdict(payload))


@dataclass(frozen=True)
class CanonicalJobIdentityResolvedPayload:
    """Discovery-owned identity decision for a Job.

    Carries the canonical URL, ATS kind, and source-native id used to
    deduplicate later scraper hits. Confidence is a scalar in [0, 1] so
    Operations can chart canonicalization quality over time.
    """

    job_id: str
    canonical_url: str
    ats_kind: str
    source_native_id: str
    confidence: float


def create_canonical_job_identity_resolved(
    tenant_id: TenantId,
    payload: CanonicalJobIdentityResolvedPayload,
) -> DomainEvent:
    return create_domain_event(
        "CanonicalJobIdentityResolved", tenant_id, asdict(payload)
    )


@dataclass(frozen=True)
class DuplicateJobLinkedPayload:
    """A duplicate observation has been merged into a surviving Job."""

    duplicate_link_id: str
    surviving_job_id: str
    superseded_job_or_observation_id: str
    reason: str
    confidence: float


def create_duplicate_job_linked(
    tenant_id: TenantId,
    payload: DuplicateJobLinkedPayload,
) -> DomainEvent:
    return create_domain_event("DuplicateJobLinked", tenant_id, asdict(payload))


@dataclass(frozen=True)
class DuplicateJobLinkRejectedPayload:
    """A proposed duplicate link was rejected by Discovery dedupe.

    Attributed to the surviving ``job_id`` (the accepted owner the duplicate
    matched) so the rejected link shows in that job's audit history — ``job_id``
    is the standard attribution key both the durable event publisher and the API
    audit read model key on. ``candidate_posting_url`` is the distinct posting
    locator that was declined; it is not a Job identity.
    """

    duplicate_link_id: str
    job_id: str
    candidate_posting_url: str
    reason: str
    rejected_at: str


def create_duplicate_job_link_rejected(
    tenant_id: TenantId,
    payload: DuplicateJobLinkRejectedPayload,
) -> DomainEvent:
    return create_domain_event(
        "DuplicateJobLinkRejected", tenant_id, asdict(payload)
    )


@dataclass(frozen=True)
class DiscoveryFeedbackRecordedPayload:
    """User/system feedback that feeds source-quality metrics.

    The payload intentionally carries IDs and feedback kind only. Free-form
    notes and raw posting content stay out of domain events.
    """

    feedback_id: str
    job_id: str
    source_id: str | None
    kind: str
    recorded_at: str


def create_discovery_feedback_recorded(
    tenant_id: TenantId,
    payload: DiscoveryFeedbackRecordedPayload,
) -> DomainEvent:
    return create_domain_event("DiscoveryFeedbackRecorded", tenant_id, asdict(payload))
