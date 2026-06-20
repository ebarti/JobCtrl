"""SQLite compensation fact persistence adapters."""

from jobhunter.infrastructure.compensation.sqlite_market_repository import (
    SqliteMarketCompensationRepository,
    load_reported_compensation_observations,
)
from jobhunter.infrastructure.compensation.sqlite_repository import SqlitePostedCompensationRepository

__all__ = [
    "SqliteMarketCompensationRepository",
    "SqlitePostedCompensationRepository",
    "load_reported_compensation_observations",
]
