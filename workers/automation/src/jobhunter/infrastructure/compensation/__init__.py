"""SQLite compensation fact persistence adapters."""

from jobhunter.infrastructure.compensation.sqlite_market_repository import (
    SqliteMarketCompensationRepository,
    load_default_reported_compensation_observations,
    load_euro_top_tech_observations,
    load_reported_compensation_observations,
)
from jobhunter.infrastructure.compensation.sqlite_repository import (
    SqlitePostedCompensationRepository,
    posted_compensation_source_from_job,
)

__all__ = [
    "SqliteMarketCompensationRepository",
    "SqlitePostedCompensationRepository",
    "load_default_reported_compensation_observations",
    "load_euro_top_tech_observations",
    "load_reported_compensation_observations",
    "posted_compensation_source_from_job",
]
