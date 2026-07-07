"""Thread-local factory for the local Profile repository.

The Phase-3 in-process event bus is a process-wide singleton owned by
``infrastructure.events.get_default_publisher``. The profile repository
cannot follow that process-wide pattern because it owns a SQLite
connection, and SQLite connections are thread-bound in local mode.
Callers in ``actions.py``, ``pipeline.py``, and the CLI therefore share
the same SQLite-backed profile tables and event publisher while each
thread gets its own repository/connection pair.

Tests can reset the thread-local cache via ``reset_profile_repository``
plus a custom ``build_profile_repository`` invocation.
"""

from __future__ import annotations

import threading
from pathlib import Path

from jobctrl import config
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.database import init_db
from jobctrl.infrastructure.events import get_default_publisher, reset_default_publisher
from jobctrl.infrastructure.profile.pdf_parser import PyPdfProfileParser
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository

_lock = threading.Lock()
_generation = 0
_local = threading.local()


def build_profile_repository(
    *,
    db_path: Path | None = None,
    publisher: EventPublisher | None = None,
) -> SqliteProfileRepository:
    """Construct a fresh repository — bypasses the singleton.

    Tests should prefer this so each test gets an isolated bus + tmp DB.
    """
    resolved_db_path = db_path or config.DB_PATH
    conn = init_db(resolved_db_path)
    return SqliteProfileRepository(
        conn,
        publisher=publisher or get_default_publisher(),
        pdf_parser=PyPdfProfileParser(),
    )


def get_profile_repository() -> SqliteProfileRepository:
    """Return this thread's cached repository.

    Initialises lazily so that import-time has no side effects (matches the
    pattern used by Phase 3's ``InProcessEventBus`` singleton). The cache is
    deliberately thread-local: ``SqliteProfileRepository`` holds a
    ``sqlite3.Connection``, and SQLite forbids using that object from a
    different thread than the one that created it.
    """
    with _lock:
        generation = _generation
    cached = getattr(_local, "repository", None)
    cached_generation = getattr(_local, "generation", None)
    if cached is None or cached_generation != generation:
        cached = build_profile_repository()
        _local.repository = cached
        _local.generation = generation
    return cached


def reset_profile_repository() -> None:
    """Invalidate cached repositories — used by tests to reset between cases."""
    global _generation
    with _lock:
        _generation += 1
    if hasattr(_local, "repository"):
        delattr(_local, "repository")
    if hasattr(_local, "generation"):
        delattr(_local, "generation")
    # Clear the shared bus singleton too so the next test starts clean.
    reset_default_publisher()
