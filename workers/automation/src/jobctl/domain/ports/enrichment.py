"""Driven ports for the Job Enrichment context.

See ddd-target.md §5.2 (``DetailPageFetcherPort``, ``LlmPort``,
``EnrichmentRepository``).

The shared ``LlmPort`` lives in ``jobctl.domain.ports.llm`` and is
re-exported here for callers that want a single Enrichment-context
import.
"""

from __future__ import annotations

from typing import Protocol

from jobctl.domain.enrichment.aggregate import JobEnrichment
from jobctl.domain.enrichment.value_objects import DetailPage
from jobctl.domain.identifiers import JobId
from jobctl.domain.tenant import TenantId

# Re-export the shared LLM port — Enrichment is one of its consumers.
from jobctl.domain.ports.llm import LlmMessage, LlmPort, LlmRole

__all__ = [
    "DetailPageFetcherPort",
    "EnrichmentRepository",
    "LlmMessage",
    "LlmPort",
    "LlmRole",
]


class DetailPageFetcherPort(Protocol):
    """Adapter that navigates to a job detail page and returns its payload.

    Local mode wraps Playwright (see
    ``jobctl.infrastructure.enrichment.playwright_fetcher``); cloud
    mode wraps Browserbase (deferred). Implementations are
    responsible for the network I/O — extractors are pure functions
    over the returned ``DetailPage``.
    """

    def fetch(self, url: str) -> DetailPage:
        """Fetch the detail page at ``url`` and return its payload.

        Raises an implementation-specific exception on hard failure
        (timeout, navigation error). The use case decides whether the
        failure is retryable based on the exception type / HTTP status.
        """
        ...


class EnrichmentRepository(Protocol):
    """Persistence port for the ``JobEnrichment`` aggregate.

    All methods are tenant-scoped. ``save`` is an upsert — the
    aggregate identity ``(tenant_id, job_id)`` is the primary key,
    so saving an aggregate that already exists overwrites it
    (versioning is per-attempt inside the aggregate, not per-aggregate).
    """

    def load(self, tenant_id: TenantId, job_id: JobId) -> JobEnrichment | None:
        """Return the persisted ``JobEnrichment`` for ``(tenant, job)``, or None."""
        ...

    def save(self, enrichment: JobEnrichment) -> None:
        """Upsert the aggregate.

        Implementations MUST update ``updated_at`` to the aggregate's
        own ``updated_at`` field on every call so consumers can detect
        the most recently touched rows.
        """
        ...

    def list_pending(self, tenant_id: TenantId, *, limit: int = 0) -> list[JobId]:
        """Return job_ids whose enrichment is `pending`.

        "Pending" means: a Job exists in the discovery context, the
        enrichment row is missing OR its ``current_status`` is
        ``pending``. ``limit=0`` means no upper bound.
        """
        ...

    def list_failed(self, tenant_id: TenantId, *, limit: int = 0) -> list[JobEnrichment]:
        """Return aggregates currently in the ``failed`` state.

        Useful for dashboard displays of stuck enrichments and for the
        retry batch job. Returns full aggregates so callers can
        inspect the latest attempt's error metadata.
        """
        ...
