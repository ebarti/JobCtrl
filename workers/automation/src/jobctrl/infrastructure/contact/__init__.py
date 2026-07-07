"""Infrastructure adapters for the Contact & Outreach context."""

from jobctrl.infrastructure.contact.outreach_repository import (
    SqliteOutreachThreadRepository,
)
from jobctrl.infrastructure.contact.research_fetcher import GatewayContactResearchFetcher
from jobctrl.infrastructure.contact.research_repository import (
    SqliteContactResearchTaskRepository,
)
from jobctrl.infrastructure.contact.sqlite_repository import SqliteContactRepository

__all__ = [
    "GatewayContactResearchFetcher",
    "SqliteContactRepository",
    "SqliteContactResearchTaskRepository",
    "SqliteOutreachThreadRepository",
]
