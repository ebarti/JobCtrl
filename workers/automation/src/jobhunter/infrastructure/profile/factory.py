"""Process-wide factory for the local Profile repository.

The Phase-3 in-process event bus is a singleton (see
``infrastructure.events``); the profile repository follows the same pattern:
a single ``JsonFileProfileRepository`` is shared across the worker process
so callers in ``actions.py``, ``pipeline.py``, and the CLI all see the same
in-memory version counter and event publisher.

Tests can override the singleton via ``reset_profile_repository`` plus a
custom ``build_profile_repository`` invocation.
"""

from __future__ import annotations

import threading
from pathlib import Path

from jobhunter import config
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.infrastructure.events import in_process_bus
from jobhunter.infrastructure.profile.json_file import JsonFileProfileRepository
from jobhunter.infrastructure.profile.pdf_parser import PyPdfProfileParser

_lock = threading.Lock()
_singleton: JsonFileProfileRepository | None = None
_default_publisher: EventPublisher | None = None


def _get_default_publisher() -> EventPublisher:
    global _default_publisher
    if _default_publisher is None:
        _default_publisher = in_process_bus.InProcessEventBus()
    return _default_publisher


def build_profile_repository(
    *,
    profile_path: Path | None = None,
    publisher: EventPublisher | None = None,
) -> JsonFileProfileRepository:
    """Construct a fresh repository — bypasses the singleton.

    Tests should prefer this so each test gets an isolated bus + tmp file.
    """
    return JsonFileProfileRepository(
        profile_path=profile_path or config.PROFILE_PATH,
        publisher=publisher or _get_default_publisher(),
        pdf_parser=PyPdfProfileParser(),
    )


def get_profile_repository() -> JsonFileProfileRepository:
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
    global _singleton, _default_publisher
    with _lock:
        _singleton = None
        _default_publisher = None
