"""Discovery use cases — the write boundary for ``Job`` aggregates.

PR 2 introduces ``DiscoverJobsUseCase``: the single place where
``ScrapedJobPosting`` values become ``Job`` aggregates plus
``JobSourceObservation`` rows. Pre-PR-2 every adapter wrote directly to
SQLite; post-PR-2 every adapter yields ``ScrapedJobPosting`` values into
this use case which:

* resolves the canonical identity for the posting,
* asks the repository whether a Job already owns that identity,
* on a fresh identity, creates the Job + a first observation +
  publishes ``JobDiscovered`` and ``JobSourceObserved``,
* on a known identity, attaches the new observation, refreshes the
  canonical identity if it was unknown, and publishes
  ``JobSourceObserved`` (and ``DuplicateJobLinked`` when two Job
  aggregates collapse into one),
* publishes ``CanonicalJobIdentityResolved`` whenever the canonical
  identity changes,
* publishes ``DuplicateJobLinkRejected`` when the identity is too
  low-confidence to merge automatically.

The use case is pure orchestration — it depends only on the typed
ports (``JobRepository``, ``EventPublisher``) and the
``CanonicalJobIdentityResolver`` value object, so it can be unit-tested
without sqlite, http, or temporal.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Protocol

from jobhunter.domain.discovery.aggregate import Job
from jobhunter.domain.discovery.identity import (
    AtsKind,
    CanonicalJobIdentity,
    DuplicateJobLink,
    JobSourceObservation,
    normalize_observed_url,
)
from jobhunter.domain.discovery.value_objects import Employer, PostingUrl
from jobhunter.domain.events import (
    CanonicalJobIdentityResolvedPayload,
    DuplicateJobLinkedPayload,
    DuplicateJobLinkRejectedPayload,
    JobDiscoveredPayload,
    JobSourceObservedPayload,
    create_canonical_job_identity_resolved,
    create_duplicate_job_link_rejected,
    create_duplicate_job_linked,
    create_job_discovered,
    create_job_source_observed,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.ports.discovery import JobRepository, ScrapedJobPosting
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.tenant import TenantId
from jobhunter.infrastructure.observability.adapter_spans import (
    canonicalize_span,
    dedupe_span,
)


MIN_AUTO_MERGE_CONFIDENCE: float = 0.75
"""Confidence threshold for auto-merging duplicate observations.

Below this threshold, the use case publishes ``DuplicateJobLinkRejected``
and keeps the candidate quarantined per the RFC §"Deduplication
Boundary" failure mode "Canonicalization merges distinct jobs". The
0.75 value lines up with the locator's ``minPromotionConfidence``.
"""


def default_canonical_identity(posting: ScrapedJobPosting) -> CanonicalJobIdentity:
    """Resolve a canonical identity for a ``ScrapedJobPosting``.

    The default resolver mirrors the rules in the RFC §"Recommended
    identity checks" table: when the adapter has supplied a canonical
    URL and a source-native id, confidence is high (0.9). When only the
    canonical URL is known, confidence drops to 0.6. When neither is
    available (Smart Extract escape hatch) the resolver falls back to
    the posting URL with low confidence (0.3) so the dedupe stage
    quarantines the result.
    """

    canonical_url = posting.canonical_url.strip() or posting.posting_url.value
    source_native_id = posting.source_native_id.strip()
    confidence: float
    if source_native_id and posting.canonical_url.strip():
        confidence = 0.9
    elif posting.canonical_url.strip():
        confidence = 0.6
        source_native_id = source_native_id or canonical_url
    else:
        confidence = 0.3
        source_native_id = source_native_id or canonical_url
    return CanonicalJobIdentity(
        canonical_url=canonical_url,
        ats_kind=posting.ats_kind if isinstance(posting.ats_kind, AtsKind) else AtsKind.OTHER,
        source_native_id=source_native_id,
        confidence=float(confidence),
    )


class CanonicalIdentityResolver(Protocol):
    """Function signature for canonical-identity resolution.

    The default resolver above is sufficient for ATS adapters; tests
    inject deterministic resolvers when they want to drive the
    confidence threshold logic.
    """

    def __call__(self, posting: ScrapedJobPosting) -> CanonicalJobIdentity: ...


@dataclass(frozen=True)
class DiscoveryDecision:
    """Outcome of a single ``ScrapedJobPosting`` ingest."""

    job_id: JobId
    is_new_job: bool
    observation_id: str
    duplicate_link_id: str | None
    rejected_reason: str | None
    confidence: float


@dataclass(frozen=True)
class DiscoveryRunSummary:
    """Aggregate counts for a single ``DiscoverJobsUseCase.execute`` call."""

    total: int
    new_jobs: int
    observed: int
    duplicates_linked: int
    duplicates_rejected: int


class DiscoverJobsUseCase:
    """Discovery write boundary — the only place ``Job`` aggregates are created.

    Wire-up:

      * ``repository`` — local-mode ``SqliteJobRepository`` today;
        hosted-mode adapter tomorrow.
      * ``publisher`` — process-wide ``InProcessEventBus`` today; cloud
        bus + outbox tomorrow.
      * ``resolver`` — defaults to :func:`default_canonical_identity`;
        tests inject deterministic resolvers.

    The use case is intentionally synchronous — the surrounding
    Temporal activity owns retries and progress reporting.
    """

    def __init__(
        self,
        *,
        repository: JobRepository,
        publisher: EventPublisher,
        resolver: CanonicalIdentityResolver | None = None,
        run_id_factory: object | None = None,
        clock: object | None = None,
    ) -> None:
        self._repository = repository
        self._publisher = publisher
        self._resolver = resolver or default_canonical_identity
        self._run_id_factory = run_id_factory or (lambda: f"run:{uuid.uuid4().hex}")
        self._clock = clock or (lambda: datetime.now(timezone.utc).isoformat())

    def execute(
        self,
        *,
        tenant_id: TenantId,
        postings: Iterable[ScrapedJobPosting],
        run_id: str | None = None,
    ) -> DiscoveryRunSummary:
        """Ingest a batch of ``ScrapedJobPosting`` values.

        ``postings`` may be any iterable; the use case materialises it
        once so the same adapter can be replayed in tests.
        """

        materialised = list(postings)
        run_id = run_id or self._run_id_factory()
        decisions: list[DiscoveryDecision] = [
            self._ingest_one(tenant_id=tenant_id, posting=p, run_id=run_id)
            for p in materialised
        ]
        return DiscoveryRunSummary(
            total=len(decisions),
            new_jobs=sum(1 for d in decisions if d.is_new_job),
            observed=sum(1 for d in decisions if not d.is_new_job and d.rejected_reason is None),
            duplicates_linked=sum(1 for d in decisions if d.duplicate_link_id is not None),
            duplicates_rejected=sum(1 for d in decisions if d.rejected_reason is not None),
        )

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _ingest_one(
        self,
        *,
        tenant_id: TenantId,
        posting: ScrapedJobPosting,
        run_id: str,
    ) -> DiscoveryDecision:
        identity = self._resolver(posting)
        owner_id = self._repository.find_canonical_owner(
            tenant_id,
            source_id=posting.source_id,
            source_native_id=identity.source_native_id,
            canonical_url=identity.canonical_url,
        )

        with canonicalize_span(
            tenant_id=str(tenant_id),
            job_id=str(owner_id) if owner_id else identity.canonical_url,
            source_id=posting.source_id,
            canonical_url_present=bool(identity.canonical_url),
            ats_kind=identity.ats_kind.value,
            confidence=identity.confidence,
        ):
            pass  # span carries the identity decision metadata

        observed_at = self._clock()
        observation_id = f"obs:{uuid.uuid4().hex}"

        if owner_id is None:
            return self._create_new_job(
                tenant_id=tenant_id,
                posting=posting,
                identity=identity,
                run_id=run_id,
                observation_id=observation_id,
                observed_at=observed_at,
            )

        return self._observe_existing_job(
            tenant_id=tenant_id,
            posting=posting,
            identity=identity,
            owner_id=owner_id,
            run_id=run_id,
            observation_id=observation_id,
            observed_at=observed_at,
        )

    def _create_new_job(
        self,
        *,
        tenant_id: TenantId,
        posting: ScrapedJobPosting,
        identity: CanonicalJobIdentity,
        run_id: str,
        observation_id: str,
        observed_at: str,
    ) -> DiscoveryDecision:
        canonical_posting_url = PostingUrl(value=identity.canonical_url)
        job_id = JobId(canonical_posting_url.value)
        job = Job.discover(
            tenant_id=tenant_id,
            job_id=job_id,
            posting_url=canonical_posting_url,
            source=posting.source,
            employer=Employer.unknown(),
            search_strategy=posting.strategy,
            metadata=posting.metadata,
            discovered_at=observed_at,
        )
        with dedupe_span(
            tenant_id=str(tenant_id),
            job_id=str(job_id),
            stage="listing_ingest",
            result="new_job",
            confidence=identity.confidence,
        ):
            self._repository.save(job)
            self._repository.set_canonical_identity(tenant_id, job_id, identity)
            self._repository.attach_source_observation(
                tenant_id,
                job_id,
                JobSourceObservation(
                    source_observation_id=observation_id,
                    source_id=posting.source_id,
                    source_native_id=identity.source_native_id,
                    observed_url=identity.canonical_url,
                    run_id=run_id,
                    observed_at=observed_at,
                ),
            )
        self._publisher.publish(
            create_job_discovered(
                tenant_id,
                JobDiscoveredPayload(
                    job_id=str(job_id),
                    posting_url=canonical_posting_url.value,
                    source=posting.source.board,
                    employer="Unknown",
                    metadata=posting.metadata.to_dict(),
                    discovered_at=observed_at,
                ),
            )
        )
        self._publisher.publish(
            create_canonical_job_identity_resolved(
                tenant_id,
                CanonicalJobIdentityResolvedPayload(
                    job_id=str(job_id),
                    canonical_url=identity.canonical_url,
                    ats_kind=identity.ats_kind.value,
                    source_native_id=identity.source_native_id,
                    confidence=identity.confidence,
                ),
            )
        )
        self._publisher.publish(
            create_job_source_observed(
                tenant_id,
                JobSourceObservedPayload(
                    job_id=str(job_id),
                    source_observation_id=observation_id,
                    source_id=posting.source_id,
                    source_native_id=identity.source_native_id,
                    observed_url=identity.canonical_url,
                    run_id=run_id,
                    observed_at=observed_at,
                ),
            )
        )
        return DiscoveryDecision(
            job_id=job_id,
            is_new_job=True,
            observation_id=observation_id,
            duplicate_link_id=None,
            rejected_reason=None,
            confidence=identity.confidence,
        )

    def _observe_existing_job(
        self,
        *,
        tenant_id: TenantId,
        posting: ScrapedJobPosting,
        identity: CanonicalJobIdentity,
        owner_id: JobId,
        run_id: str,
        observation_id: str,
        observed_at: str,
    ) -> DiscoveryDecision:
        observed_url = identity.canonical_url or posting.posting_url.value
        normalized_observed = normalize_observed_url(observed_url)
        is_distinct_url = (
            normalized_observed != normalize_observed_url(str(owner_id))
            and normalized_observed != ""
        )

        if identity.confidence < MIN_AUTO_MERGE_CONFIDENCE and is_distinct_url:
            duplicate_link_id = f"dup:{uuid.uuid4().hex}"
            with dedupe_span(
                tenant_id=str(tenant_id),
                job_id=str(owner_id),
                stage="canonical_identity",
                result="rejected",
                confidence=identity.confidence,
            ):
                pass
            self._publisher.publish(
                create_duplicate_job_link_rejected(
                    tenant_id,
                    DuplicateJobLinkRejectedPayload(
                        duplicate_link_id=duplicate_link_id,
                        candidate_ids=(str(owner_id), observation_id),
                        reason="confidence_below_threshold",
                        rejected_at=observed_at,
                    ),
                )
            )
            return DiscoveryDecision(
                job_id=owner_id,
                is_new_job=False,
                observation_id=observation_id,
                duplicate_link_id=None,
                rejected_reason="confidence_below_threshold",
                confidence=identity.confidence,
            )

        with dedupe_span(
            tenant_id=str(tenant_id),
            job_id=str(owner_id),
            stage="listing_ingest",
            result="observed",
            confidence=identity.confidence,
        ):
            self._repository.attach_source_observation(
                tenant_id,
                owner_id,
                JobSourceObservation(
                    source_observation_id=observation_id,
                    source_id=posting.source_id,
                    source_native_id=identity.source_native_id,
                    observed_url=observed_url,
                    run_id=run_id,
                    observed_at=observed_at,
                ),
            )
        self._publisher.publish(
            create_job_source_observed(
                tenant_id,
                JobSourceObservedPayload(
                    job_id=str(owner_id),
                    source_observation_id=observation_id,
                    source_id=posting.source_id,
                    source_native_id=identity.source_native_id,
                    observed_url=observed_url,
                    run_id=run_id,
                    observed_at=observed_at,
                ),
            )
        )

        duplicate_link_id: str | None = None
        if is_distinct_url:
            duplicate_link_id = f"dup:{uuid.uuid4().hex}"
            link = DuplicateJobLink(
                duplicate_link_id=duplicate_link_id,
                surviving_job_id=str(owner_id),
                superseded_job_or_observation_id=observation_id,
                reason="canonical_url_match"
                if identity.canonical_url
                else "source_native_id_match",
                confidence=identity.confidence,
                linked_at=observed_at,
            )
            self._repository.record_duplicate_link(tenant_id, link)
            self._publisher.publish(
                create_duplicate_job_linked(
                    tenant_id,
                    DuplicateJobLinkedPayload(
                        duplicate_link_id=duplicate_link_id,
                        surviving_job_id=str(owner_id),
                        superseded_job_or_observation_id=observation_id,
                        reason=link.reason,
                        confidence=identity.confidence,
                    ),
                )
            )

        return DiscoveryDecision(
            job_id=owner_id,
            is_new_job=False,
            observation_id=observation_id,
            duplicate_link_id=duplicate_link_id,
            rejected_reason=None,
            confidence=identity.confidence,
        )


__all__ = [
    "CanonicalIdentityResolver",
    "DiscoverJobsUseCase",
    "DiscoveryDecision",
    "DiscoveryRunSummary",
    "MIN_AUTO_MERGE_CONFIDENCE",
    "default_canonical_identity",
]
