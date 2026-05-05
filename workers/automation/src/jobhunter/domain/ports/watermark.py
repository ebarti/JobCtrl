"""EventWatermarkRepository port — driven port for projection bookkeeping.

See ddd-target.md §6.3 (crash recovery — startup reconciliation pass).

Each projection records the highest ``event_id`` it has processed so that on
restart the projection builder (Phase 9) can resume from
``last_event_id + 1``.  Reading a watermark for a projection that has never
run returns ``0`` (initial-zero behavior).
"""

from __future__ import annotations

from typing import Protocol


class EventWatermarkRepository(Protocol):
    """Driven port — read and update per-projection event watermarks."""

    def get(self, projection_name: str) -> int:
        """Return the last processed ``event_id`` for *projection_name*.

        Returns ``0`` when no row exists yet.
        """
        ...

    def set(self, projection_name: str, last_event_id: int) -> None:
        """Upsert *projection_name* → *last_event_id*.

        Implementations must be transactional.
        """
        ...
