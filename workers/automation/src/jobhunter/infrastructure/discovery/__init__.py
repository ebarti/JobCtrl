"""Discovery infrastructure adapters.

See ddd-target.md §5.1 and PR 2 of the Job Search Discovery RFC.

Two adapter families live here:

* ``SqliteJobRepository`` — local-mode persistence for the Discovery
  ``Job`` aggregate, source observations, canonical identity, and
  duplicate links.
* ATS board adapters (``WorkdayBoardAdapter``, ``GreenhouseBoardAdapter``,
  ``LeverBoardAdapter``, ``AshbyBoardAdapter``) — local-mode
  ``JobBoardScraperPort`` implementations for the Tier 1 sources called
  out in the RFC §"Source Hierarchy" table.
"""

from jobhunter.infrastructure.discovery.ats_adapters import (
    AshbyBoardAdapter,
    GreenhouseBoardAdapter,
    HttpFetcher,
    LeverBoardAdapter,
    WorkdayBoardAdapter,
    WorkdayEmployer,
    default_http_fetcher,
)
from jobhunter.infrastructure.discovery.sqlite_repository import (
    SqliteJobRepository,
)

__all__ = [
    "AshbyBoardAdapter",
    "GreenhouseBoardAdapter",
    "HttpFetcher",
    "LeverBoardAdapter",
    "SqliteJobRepository",
    "WorkdayBoardAdapter",
    "WorkdayEmployer",
    "default_http_fetcher",
]
