"""Driven ports for the Job Discovery context.

See ddd-target.md §5.1 and the PR 2 section of the Job Search Discovery
RFC (`docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md`).

Three ports declared here. ``JobRepository`` is materialised by
``SqliteJobRepository``. ``JobBoardScraperPort`` is materialised by the
PR 2 ATS adapters (``WorkdayBoardAdapter``, ``GreenhouseBoardAdapter``,
``LeverBoardAdapter``, ``AshbyBoardAdapter``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol

from jobhunter.domain.discovery.aggregate import Job
from jobhunter.domain.discovery.identity import (
    AtsKind,
    CanonicalJobIdentity,
    DuplicateJobLink,
    JobSourceObservation,
)
from jobhunter.domain.discovery.scheduler import DiscoveryRun
from jobhunter.domain.discovery.value_objects import (
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.job_content_identity import ContentMatchBasis
from jobhunter.domain.tenant import TenantId


@dataclass(frozen=True)
class ScrapedJobPosting:
    """Raw posting hand-off from a board scraper to the Discovery context.

    Pure data — the value object every ``JobBoardScraperPort`` yields per
    result. The Discovery use case (``DiscoverJobsUseCase``) is
    responsible for turning these into ``Job`` aggregates and handing
    them to ``JobRepository.save``. Splitting the wire shape from the
    aggregate keeps the scrapers free of TenantId / JobId allocation
    concerns.

    Per PR 2 the scraped value object carries the canonical-identity
    inputs needed by the Discovery write boundary: the source-native id
    that uniquely identifies the posting on its source, the canonical
    URL the source advertises (typically the ATS detail URL), the ATS
    kind detected by the adapter, and the source registry id the
    posting was scraped from.
    """

    posting_url: PostingUrl
    source: Source
    metadata: JobMetadata
    strategy: SearchStrategy
    source_id: str
    source_native_id: str
    canonical_url: str
    ats_kind: AtsKind = AtsKind.OTHER


@dataclass(frozen=True)
class ContentOwnerMatch:
    """An existing Job resolved by content identity, plus how it matched.

    ``find_content_owner`` returns this (rather than a bare ``JobId``) so the
    caller can record an honest duplicate-link reason: the fingerprint and
    shingle paths carry different confidence and must not be conflated.
    """

    job_id: JobId
    basis: ContentMatchBasis


class JobBoardScraperPort(Protocol):
    """Driven port for external job-board scraping.

    Per ddd-target.md §5.1: "Scrape job postings from external
    boards". Each adapter wraps one board (jobspy multi-board,
    Workday CXS API, smart-extract Playwright + LLM). The port
    yields ``ScrapedJobPosting`` value objects so the use case can
    deduplicate + persist without re-implementing the scraper's
    output shape.

    Per migration plan §8 the per-scraper refactor that materialises
    ``JobSpyAdapter`` / ``WorkdayApiAdapter`` / ``SmartExtractAdapter``
    is deferred; the existing modules under
    ``jobhunter.discovery.{jobspy,workday,smartextract}`` continue to
    call ``database.store_jobs`` directly until that work lands. This
    Protocol declares the target shape so the future cutover can
    proceed without re-arguing the contract.
    """

    def scrape(
        self,
        *,
        tenant_id: TenantId,
        query: str,
        location: str,
    ) -> Iterable[ScrapedJobPosting]:
        """Yield postings for one search.

        Implementations are responsible for paging / rate-limiting
        / retry; the use case treats the iterable as the canonical
        result set for the search. Empty results are valid (no
        matching postings) and MUST NOT raise.
        """
        ...


class JobRepository(Protocol):
    """Persistence port for the ``Job`` aggregate.

    All methods are tenant-scoped. Local adapters accept ``tenant_id``
    and ignore the value (single-tenant); hosted adapters use it for row
    isolation.

    Dedup contract:

      * ``save`` enforces the §4.1 invariant — duplicate
        ``(tenant_id, posting_url)`` is rejected. Callers should
        ``load_by_url`` first if they want to update an existing job
        rather than insert a new one.
      * ``load_by_url`` returns the canonical ``Job`` for a posting URL,
        regardless of tombstone state, so the URL-resolution flow in
        enrichment can find the row even after a soft-delete.
    """

    def load(self, tenant_id: TenantId, job_id: JobId) -> Job | None:
        """Return the Job by aggregate id, or ``None``."""
        ...

    def load_by_url(self, tenant_id: TenantId, posting_url: PostingUrl) -> Job | None:
        """Return the Job whose ``posting_url`` matches, or ``None``."""
        ...

    def save(self, job: Job) -> None:
        """Persist the aggregate.

        Inserts on first save; subsequent saves with the same
        ``(tenant_id, job_id)`` perform an upsert that preserves
        ``discovered_at``. The repository is responsible for refusing
        a save whose ``(tenant_id, posting_url)`` collides with a
        DIFFERENT ``job_id``.
        """
        ...

    def list_recent(
        self,
        tenant_id: TenantId,
        *,
        limit: int = 100,
        include_deleted: bool = False,
    ) -> list[Job]:
        """Return the most recently discovered jobs.

        ``include_deleted=False`` (default) hides soft-deleted rows by
        joining the ``jobhunter_deleted_jobs`` tombstone table; passing
        ``True`` returns every row including those with a non-null
        ``deleted_at``. ``limit=0`` means no upper bound.
        """
        ...

    def soft_delete(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        reason: str | None,
        deleted_at: str,
    ) -> Job | None:
        """Mark the Job as soft-deleted.

        Returns the updated aggregate, or ``None`` if the job did not
        exist. Idempotent: re-deleting an already-deleted job overwrites
        the ``deleted_at`` / ``reason`` fields with the new values.
        """
        ...

    def restore(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        restored_at: str | None = None,
    ) -> Job | None:
        """Clear the soft-delete tombstone.

        Returns the updated aggregate, or ``None`` if the job did not
        exist. No-op on a non-deleted job.
        """
        ...

    # ------------------------------------------------------------------
    # PR 2: canonical identity, source observations, duplicate links
    # ------------------------------------------------------------------

    def find_canonical_owner(
        self,
        tenant_id: TenantId,
        *,
        source_id: str,
        source_native_id: str,
        canonical_url: str,
    ) -> JobId | None:
        """Look up the canonical Job that already owns a posting identity.

        Resolution order matches the RFC §"Recommended identity checks"
        table:

          1. ``(tenant_id, source_id, source_native_id)`` — the strongest
             match because the source guarantees its native id is unique
             on that source.
          2. ``(tenant_id, normalized_canonical_url)`` — catches the case
             where two adapters resolve the same canonical URL but
             advertise different source-native ids (rare but real).
          3. ``(tenant_id, normalized_observed_url)`` — catches the case
             where one source-native id is missing but the observed URL
             matches an existing observation.

        Returns the surviving ``JobId`` for the first match, or ``None``
        when the posting is genuinely new.
        """
        ...

    def find_content_owner(
        self,
        tenant_id: TenantId,
        *,
        title: str,
        company: str,
        description: str,
    ) -> ContentOwnerMatch | None:
        """Look up the canonical Job by content identity when identity checks miss.

        Called by ``DiscoverJobsUseCase`` after ``find_canonical_owner`` returns
        ``None`` so a posting re-discovered on a different source (different
        native id AND canonical URL) collapses onto the existing Job instead of
        creating a second aggregate. Matches the JobSpy content-dedup strictness:
        an exact normalized title + employer + description fingerprint, or a
        substantial-description shingle match, both gated on title + employer
        equality so genuinely distinct roles stay separate.

        Merges MUST key on a genuine employer on BOTH sides: an empty /
        ``Unknown`` / platform-sentinel employer (a job board, the manual-capture
        board, or the Workday fallback) is shared across employers, so the
        implementation returns ``None`` rather than collapse two distinct
        employers' postings. On a match it returns a :class:`ContentOwnerMatch`
        carrying the surviving ``JobId`` and the ``basis`` (fingerprint vs
        shingle) so the caller records an honest duplicate-link reason. Returns
        ``None`` when either side lacks a genuine employer, the posting cannot be
        fingerprinted, or no existing Job matches.
        """
        ...

    def attach_source_observation(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        observation: JobSourceObservation,
    ) -> None:
        """Persist an observation under an existing canonical Job.

        Idempotent on ``(tenant_id, source_id, source_native_id)`` — the
        same source emitting the same posting in a later run REPLACES
        the previous observation row rather than appending a duplicate.
        """
        ...

    def set_canonical_identity(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        identity: CanonicalJobIdentity,
    ) -> None:
        """Persist the canonical identity decision for a Job."""
        ...

    def record_duplicate_link(
        self,
        tenant_id: TenantId,
        link: DuplicateJobLink,
    ) -> None:
        """Persist a confirmed duplicate-link audit record.

        Per the RFC failure mode "A duplicate link points to a job the
        user later dismisses", the link must be reversible. Storing the
        link does NOT delete the superseded observation; it only records
        the merge decision so Operations can surface it and a future
        user correction can split the candidate back out.
        """
        ...

    def record_rejected_duplicate_link(
        self,
        tenant_id: TenantId,
        *,
        owner_job_id: JobId,
        candidate_url: str,
        reason: str,
        rejected_at: str,
    ) -> bool:
        """Record a rejected duplicate link idempotently per (owner, candidate).

        Returns ``True`` the first time a given (owner job, candidate URL)
        rejection is recorded and ``False`` when it already exists, so the write
        boundary publishes the ``DuplicateJobLinkRejected`` audit event exactly
        once instead of on every re-ingest of the same persistently-rejected
        duplicate.
        """
        ...


class DiscoveryRunRepository(Protocol):
    """Persistence port for the ``DiscoveryRun`` aggregate."""

    def save(self, run: DiscoveryRun) -> None:
        """Insert or update one scheduled discovery run."""
        ...

    def load(self, tenant_id: TenantId, run_id: str) -> DiscoveryRun | None:
        """Return a scheduled discovery run by id, if present."""
        ...
