"""Job aggregate root for the Discovery context.

See ddd-target.md §4.1. ``Job`` is the canonical fact about a discovered
posting: identity ``(TenantId, JobId)``, dedup by ``(TenantId, PostingUrl)``.
The aggregate is immutable; lifecycle transitions (re-discovery,
soft-delete, restore) return a NEW instance via the ``with_*`` helpers
rather than mutating in place.

Persistence is the responsibility of ``JobRepository``
(``jobhunter.domain.ports.discovery``); the aggregate is purely data so
the same value can be hydrated from SQLite today and Postgres tomorrow
without touching domain code.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from jobhunter.domain.discovery.value_objects import (
    Employer,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import TenantId


@dataclass(frozen=True)
class Job:
    """Aggregate root capturing one discovered job posting.

    Identity is the tuple ``(tenant_id, job_id)``. The repository enforces
    the §4.1 invariant: duplicate ``PostingUrl`` within a ``TenantId`` is
    rejected — the same URL from different boards is the same job, not a
    new one. ``deleted_at`` is the soft-delete tombstone (matches the
    ``jobhunter_deleted_jobs.deleted_at`` column for backward
    compatibility); a job with ``deleted_at IS NOT NULL`` is hidden from
    default reads but its row is preserved so ``restore`` can reverse the
    decision without losing history.
    """

    tenant_id: TenantId
    job_id: JobId
    posting_url: PostingUrl
    source: Source
    employer: Employer
    search_strategy: SearchStrategy
    metadata: JobMetadata
    discovered_at: str
    deleted_at: str | None = None
    delete_reason: str | None = None

    # ------------------------------------------------------------------
    # Invariants
    # ------------------------------------------------------------------

    def __post_init__(self) -> None:
        if not isinstance(self.posting_url, PostingUrl):
            raise ValueError("Job.posting_url must be a PostingUrl")
        if not isinstance(self.source, Source):
            raise ValueError("Job.source must be a Source")
        if not isinstance(self.employer, Employer):
            raise ValueError("Job.employer must be an Employer")
        if not isinstance(self.search_strategy, SearchStrategy):
            raise ValueError("Job.search_strategy must be a SearchStrategy")
        if not isinstance(self.metadata, JobMetadata):
            raise ValueError("Job.metadata must be a JobMetadata")
        if not isinstance(self.discovered_at, str) or not self.discovered_at.strip():
            raise ValueError("Job.discovered_at must be a non-empty ISO-8601 timestamp")
        if self.deleted_at is not None:
            if not isinstance(self.deleted_at, str) or not self.deleted_at.strip():
                raise ValueError(
                    "Job.deleted_at must be a non-empty ISO-8601 timestamp or None"
                )

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------

    @classmethod
    def discover(
        cls,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        posting_url: PostingUrl,
        source: Source,
        employer: Employer,
        search_strategy: SearchStrategy,
        metadata: JobMetadata,
        discovered_at: str,
    ) -> "Job":
        """Create a freshly-discovered Job (never deleted)."""
        return cls(
            tenant_id=tenant_id,
            job_id=job_id,
            posting_url=posting_url,
            source=source,
            employer=employer,
            search_strategy=search_strategy,
            metadata=metadata,
            discovered_at=discovered_at,
            deleted_at=None,
            delete_reason=None,
        )

    # ------------------------------------------------------------------
    # Lifecycle transitions — each returns a NEW Job instance
    # ------------------------------------------------------------------

    def with_metadata(self, metadata: JobMetadata) -> "Job":
        """Return a new Job with updated metadata (re-discovery flow)."""
        return replace(self, metadata=metadata)

    def with_employer(self, employer: Employer) -> "Job":
        """Return a new Job whose employer was upgraded from ``Unknown``.

        Useful when a later enrichment / scraper run extracts the company
        name that was missing at first discovery time.
        """
        return replace(self, employer=employer)

    def soft_delete(self, *, reason: str | None, deleted_at: str) -> "Job":
        """Return a new Job marked as soft-deleted.

        Idempotent: re-deleting an already-deleted job overwrites the
        ``deleted_at`` / ``reason`` fields with the new values, matching
        the ``ON CONFLICT(job_url) DO UPDATE`` semantics in
        ``apps/api/src/write-model.ts:softDeleteJobs``.
        """
        if not isinstance(deleted_at, str) or not deleted_at.strip():
            raise ValueError("soft_delete requires a non-empty deleted_at timestamp")
        return replace(self, deleted_at=deleted_at, delete_reason=reason)

    def restore(self) -> "Job":
        """Return a new Job with the soft-delete tombstone cleared.

        Restoring a job that was never deleted is a no-op (returns the
        same fields). The repository is responsible for clearing the
        ``jobhunter_deleted_jobs.restored_at`` row.
        """
        return replace(self, deleted_at=None, delete_reason=None)

    # ------------------------------------------------------------------
    # Predicates
    # ------------------------------------------------------------------

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None

    # ------------------------------------------------------------------
    # Serialisation (used by the SQLite adapter)
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "tenant_id": str(self.tenant_id),
            "job_id": str(self.job_id),
            "posting_url": self.posting_url.value,
            "source": self.source.board,
            "employer": self.employer.name,
            "search_strategy": self.search_strategy.value,
            "metadata": self.metadata.to_dict(),
            "discovered_at": self.discovered_at,
            "deleted_at": self.deleted_at,
            "delete_reason": self.delete_reason,
        }
