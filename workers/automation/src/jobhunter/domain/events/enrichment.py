"""Job Enrichment domain events.

See ddd-target.md §4.2.

PR3 additions: ``PostingContentSnapshotCaptured``,
``PostingContentSnapshotFailed``, ``JobActiveStateChanged``,
``ContentDuplicateCandidateDetected``. Each event shape mirrors the
§"Domain Events" table in
``docs/plans/proposed/2026-05-12-job-search-discovery-rfc.md`` so the
Operations projections can stay exhaustive and the SSE invalidation
router can stay parity-safe.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

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


# -- PR 3 events: PostingSnapshotSet + active verification + content dedupe -


@dataclass(frozen=True)
class PostingContentSnapshotCapturedPayload:
    """A new ``PostingContentSnapshot`` was written to the aggregate.

    Carries the snapshot's identity / provenance so Operations can
    update source-quality projections and the dedupe service can
    react on the description-hash join. ``snapshot_ref`` is a stable
    reference into the aggregate (``"<jobId>:<snapshotVersion>"``).
    """

    job_id: str
    snapshot_version: int
    snapshot_ref: str
    source_id: str
    extraction_tier: str
    captured_at: str


def create_posting_content_snapshot_captured(
    tenant_id: TenantId,
    payload: PostingContentSnapshotCapturedPayload,
) -> DomainEvent:
    return create_domain_event(
        "PostingContentSnapshotCaptured", tenant_id, asdict(payload)
    )


@dataclass(frozen=True)
class PostingContentSnapshotFailedPayload:
    """A snapshot capture attempt failed without writing a snapshot.

    ``error_class`` is the coarse classification used by source
    quality and the scheduler retry policy (``timeout`` / ``http_4xx``
    / ``parse_error`` etc.). The full error message stays out of the
    payload to keep the event small and observable-safe.
    """

    job_id: str
    source_id: str
    error_class: str
    retryable: bool
    failed_at: str


def create_posting_content_snapshot_failed(
    tenant_id: TenantId,
    payload: PostingContentSnapshotFailedPayload,
) -> DomainEvent:
    return create_domain_event(
        "PostingContentSnapshotFailed", tenant_id, asdict(payload)
    )


@dataclass(frozen=True)
class JobActiveStateChangedPayload:
    """The Enrichment-owned active-state for a Job changed.

    Emitted whenever the active verifier observes a transition (e.g.
    ``unknown`` → ``active``, ``active`` → ``closed``). The previous
    value is included so consumers can record audits without keeping
    their own state.
    """

    job_id: str
    active_state: str
    previous_state: str
    verification_method: str
    verified_at: str


def create_job_active_state_changed(
    tenant_id: TenantId,
    payload: JobActiveStateChangedPayload,
) -> DomainEvent:
    return create_domain_event("JobActiveStateChanged", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ContentDuplicateCandidateDetectedPayload:
    """A new content-duplicate candidate was registered on the aggregate.

    Discovery confirms or rejects the link via ``DuplicateJobLink``;
    this event lets Operations show the queue without listening to
    Discovery's reaction. ``evidence`` is a list of dict rows so the
    payload stays serialisable.
    """

    job_id: str
    candidate_job_id: str
    evidence: list[dict[str, Any]] = field(default_factory=list)
    confidence: float = 0.0
    detected_at: str = ""


def create_content_duplicate_candidate_detected(
    tenant_id: TenantId,
    payload: ContentDuplicateCandidateDetectedPayload,
) -> DomainEvent:
    return create_domain_event(
        "ContentDuplicateCandidateDetected", tenant_id, asdict(payload)
    )
