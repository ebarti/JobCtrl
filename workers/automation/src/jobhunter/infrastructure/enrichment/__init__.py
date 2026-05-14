"""Enrichment infrastructure adapters.

See ddd-target.md §5.2.

Two adapters are wired up here:

  * :class:`SqliteEnrichmentRepository` — local-mode persistence on the
    ``job_enrichments`` table (created by ``database.ensure_enrichment_tables``).
  * :class:`PlaywrightDetailPageFetcher` — local-mode browser fetcher
    used by ``EnrichJobUseCase``.
"""

from jobhunter.infrastructure.enrichment.sqlite_repository import (
    SqliteEnrichmentRepository,
    SqlitePostingSnapshotSetRepository,
)
from jobhunter.infrastructure.enrichment.playwright_fetcher import (
    PlaywrightDetailPageFetcher,
)

__all__ = [
    "PlaywrightDetailPageFetcher",
    "SqliteEnrichmentRepository",
    "SqlitePostingSnapshotSetRepository",
]
