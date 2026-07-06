"""Infrastructure adapters for the Contact & Outreach context."""

from jobhunter.infrastructure.contact.research_fetcher import GatewayContactResearchFetcher
from jobhunter.infrastructure.contact.research_repository import (
    SqliteContactResearchTaskRepository,
)
from jobhunter.infrastructure.contact.sqlite_repository import SqliteContactRepository

__all__ = [
    "GatewayContactResearchFetcher",
    "SqliteContactRepository",
    "SqliteContactResearchTaskRepository",
]
