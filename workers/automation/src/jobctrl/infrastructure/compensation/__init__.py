"""SQLite compensation fact persistence adapters."""

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
    load_default_reported_compensation_observations,
    load_euro_top_tech_observations,
    load_reported_compensation_observations,
)
from jobctrl.infrastructure.compensation.sqlite_repository import (
    SqlitePostedCompensationRepository,
    posted_compensation_source_from_job,
)

__all__ = [
    "LEVELS_FYI_ATTRIBUTION",
    "LevelsFyiPublicTarget",
    "SqliteMarketCompensationRepository",
    "SqlitePostedCompensationRepository",
    "levels_fyi_location_slug",
    "levels_fyi_public_url",
    "levels_fyi_role_slug",
    "load_default_reported_compensation_observations",
    "load_euro_top_tech_observations",
    "load_levels_fyi_public_observations",
    "load_reported_compensation_observations",
    "posted_compensation_source_from_job",
]
