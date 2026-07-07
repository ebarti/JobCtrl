"""Infrastructure adapters for the event system.

Exposes the process-wide ``InProcessEventBus`` singleton via
:func:`get_default_publisher`.  Cross-module callers (worker bootstrap,
projection builder subscription) should use this instead of importing
the per-context private factory.
"""

from __future__ import annotations

import threading

from jobctl.domain.ports.events import EventPublisher
from jobctl.infrastructure.events.in_process_bus import InProcessEventBus

_lock = threading.Lock()
_default_publisher: EventPublisher | None = None


def get_default_publisher() -> EventPublisher:
    """Return the process-wide ``InProcessEventBus`` singleton.

    Initialises lazily so import-time has no side effects.  Tests can
    reset via :func:`reset_default_publisher`.
    """
    global _default_publisher
    with _lock:
        if _default_publisher is None:
            _default_publisher = InProcessEventBus()
        return _default_publisher


def reset_default_publisher() -> None:
    """Drop the cached singleton — used by tests for isolation."""
    global _default_publisher
    with _lock:
        _default_publisher = None


__all__ = ["get_default_publisher", "reset_default_publisher"]
