"""Discovery infrastructure adapters.

See ddd-target.md §5.1.

Today's discovery adapters are small — only the persistence side is
wired up. The scraper-port adapters (``JobSpyAdapter``,
``WorkdayApiAdapter``, ``SmartExtractAdapter``) are deferred per the
migration plan §8 (out of scope for Phase 7).
"""

from jobhunter.infrastructure.discovery.sqlite_repository import (
    SqliteJobRepository,
)

__all__ = ["SqliteJobRepository"]
