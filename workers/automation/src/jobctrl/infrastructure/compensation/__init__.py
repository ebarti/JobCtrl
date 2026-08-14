"""SQLite compensation fact persistence adapters."""

from jobctrl.infrastructure.compensation.benchmark_ingestion import (
    BenchmarkObservationBatch,
    BenchmarkObservationRejection,
    FxRateToEur,
    canonicalize_reported_observations,
)
from jobctrl.infrastructure.compensation.levels_fyi_public import (
    LEVELS_FYI_ATTRIBUTION,
    LevelsFyiPublicTarget,
    levels_fyi_location_slug,
    levels_fyi_public_url,
    levels_fyi_role_slug,
    load_levels_fyi_public_observations,
)
from jobctrl.infrastructure.compensation.sqlite_market_repository import (
    SqliteMarketCompensationRepository,
    compensation_feed_client,
    load_default_reported_compensation_observations,
    load_euro_top_tech_observations,
    load_reported_compensation_observations,
)
from jobctrl.infrastructure.compensation.sqlite_benchmark_repository import (
    SqliteCompensationBenchmarkRepository,
)
from jobctrl.infrastructure.compensation.sqlite_repository import (
    SqlitePostedCompensationRepository,
    posted_compensation_source_from_job,
)

__all__ = [
    "BenchmarkObservationBatch",
    "BenchmarkObservationRejection",
    "FxRateToEur",
    "LEVELS_FYI_ATTRIBUTION",
    "LevelsFyiPublicTarget",
    "SqliteCompensationBenchmarkRepository",
    "SqliteMarketCompensationRepository",
    "SqlitePostedCompensationRepository",
    "compensation_feed_client",
    "levels_fyi_location_slug",
    "levels_fyi_public_url",
    "levels_fyi_role_slug",
    "load_default_reported_compensation_observations",
    "load_euro_top_tech_observations",
    "load_levels_fyi_public_observations",
    "load_reported_compensation_observations",
    "posted_compensation_source_from_job",
    "canonicalize_reported_observations",
]
