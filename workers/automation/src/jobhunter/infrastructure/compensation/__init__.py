"""SQLite compensation fact persistence adapters."""

from jobhunter.infrastructure.compensation.sqlite_market_repository import SqliteMarketCompensationRepository
from jobhunter.infrastructure.compensation.sqlite_repository import SqlitePostedCompensationRepository

__all__ = ["SqliteMarketCompensationRepository", "SqlitePostedCompensationRepository"]
