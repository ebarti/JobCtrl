"""Job Enrichment bounded context — domain layer.

See ddd-target.md §4.2 (JobEnrichment aggregate, EnrichmentAttempt entity,
extraction tiers, lifecycle).

Public API barrel: aggregate root, child entity, value objects, ports
re-exports, and the domain services (extractors). Adapters live under
``jobhunter.infrastructure.enrichment``.
"""

from jobhunter.domain.enrichment.aggregate import (
    EnrichmentLifecycle,
    EnrichmentStatus,
    JobEnrichment,
)
from jobhunter.domain.enrichment.entities import (
    AttemptStatus,
    EnrichmentAttempt,
)
from jobhunter.domain.enrichment.value_objects import (
    ApplicationUrl,
    DetailPage,
    EnrichmentError,
    ExtractionTier,
    FullDescription,
)

__all__ = [
    "ApplicationUrl",
    "AttemptStatus",
    "DetailPage",
    "EnrichmentAttempt",
    "EnrichmentError",
    "EnrichmentLifecycle",
    "EnrichmentStatus",
    "ExtractionTier",
    "FullDescription",
    "JobEnrichment",
]
