"""Process-wide factory for the local Profile repository.

The Phase-3 in-process event bus is a process-wide singleton owned by
``infrastructure.events.get_default_publisher``; the profile repository
follows the same pattern: a single ``SqliteProfileRepository`` is
shared across the worker process so callers in ``actions.py``,
``pipeline.py``, and the CLI all share the same SQLite-backed profile
versioning and event publisher.

Tests can override the singleton via ``reset_profile_repository`` plus a
custom ``build_profile_repository`` invocation.
"""

from __future__ import annotations

import threading
from pathlib import Path

from jobhunter import config
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.database import init_db
from jobhunter.infrastructure.events import get_default_publisher, reset_default_publisher
from jobhunter.infrastructure.profile.pdf_parser import PyPdfProfileParser
from jobhunter.infrastructure.profile.sqlite_repository import SqliteProfileRepository

_lock = threading.Lock()
_singleton: SqliteProfileRepository | None = None


def build_profile_repository(
    *,
    db_path: Path | None = None,
    profile_path: Path | None = None,
    publisher: EventPublisher | None = None,
) -> SqliteProfileRepository:
    """Construct a fresh repository — bypasses the singleton.

    Tests should prefer this so each test gets an isolated bus + tmp DB.
    ``profile_path`` is retained as the legacy-import seed path and, when
    ``db_path`` is omitted, implies a sibling ``jobhunter.db``.
    """
    legacy_profile_path = profile_path or config.PROFILE_PATH
    resolved_db_path = db_path or legacy_profile_path.parent / "jobhunter.db"
    conn = init_db(resolved_db_path)
    return SqliteProfileRepository(
        conn,
        publisher=publisher or get_default_publisher(),
        pdf_parser=PyPdfProfileParser(),
        legacy_profile_path=legacy_profile_path,
        legacy_style_path=legacy_profile_path.parent / "resume_style.json",
        legacy_template_path=legacy_profile_path.parent / "resume_template.tex",
    )


def get_profile_repository() -> SqliteProfileRepository:
    """Return the process-wide singleton repository.

    Initialises lazily so that import-time has no side effects (matches the
    pattern used by Phase 3's ``InProcessEventBus`` singleton).
    """
    global _singleton
    with _lock:
        if _singleton is None:
            _singleton = build_profile_repository()
        return _singleton


def reset_profile_repository() -> None:
    """Drop the cached singleton — used by tests to reset between cases."""
    global _singleton
    with _lock:
        _singleton = None
    # Clear the shared bus singleton too so the next test starts clean.
    reset_default_publisher()
