"""Infrastructure adapters for the Contact & Outreach context."""

from jobctl.infrastructure.contact.outreach_repository import (
    SqliteOutreachThreadRepository,
)
from jobctl.infrastructure.contact.research_fetcher import GatewayContactResearchFetcher
from jobctl.infrastructure.contact.research_repository import (
    SqliteContactResearchTaskRepository,
)
from jobctl.infrastructure.contact.sqlite_repository import SqliteContactRepository

__all__ = [
    "GatewayContactResearchFetcher",
    "SqliteContactRepository",
    "SqliteContactResearchTaskRepository",
    "SqliteOutreachThreadRepository",
]
