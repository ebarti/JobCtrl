"""Driven ports for the Job Discovery context.

See ddd-target.md §5.1.

Two ports declared here. ``JobRepository`` is materialised by
``SqliteJobRepository`` today. ``JobBoardScraperPort`` is a
**placeholder Protocol** — no adapter exists yet because the per-
scraper refactor is deferred per the migration plan §8 — but the
typed shape is published now so the future
``JobSpyAdapter`` / ``WorkdayApiAdapter`` / ``SmartExtractAdapter``
extraction (S-25 "Files touched") has its target.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol

from jobhunter.domain.discovery.aggregate import Job
from jobhunter.domain.discovery.value_objects import (
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import TenantId


@dataclass(frozen=True)
class ScrapedJobPosting:
    """Raw posting hand-off from a board scraper to the Discovery context.

    Pure data — the value object the future ``JobBoardScraperPort``
    yields per result. The Discovery use case (``DiscoverJobsUseCase``)
    is responsible for turning these into ``Job`` aggregates and
    handing them to ``JobRepository.save``. Splitting the wire shape
    from the aggregate keeps the scrapers free of TenantId / JobId
    allocation concerns.
    """

    posting_url: PostingUrl
    source: Source
    metadata: JobMetadata
    strategy: SearchStrategy


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

    def restore(self, tenant_id: TenantId, job_id: JobId) -> Job | None:
        """Clear the soft-delete tombstone.

        Returns the updated aggregate, or ``None`` if the job did not
        exist. No-op on a non-deleted job.
        """
        ...
