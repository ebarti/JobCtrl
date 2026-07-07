"""InProcessEventBus — synchronous in-process event bus.

Per ddd-target.md §6.3, event dispatch happens AFTER the producing
transaction commits.  Each handler runs in its own transaction scope.
Handler errors are caught and logged without breaking other handlers.

Subscribers keyed by event_type or ``None`` (wildcard = receive all).

**Phase-3 deviation from §6.3** (round-1 review M2): the bus is currently
fan-out-only — ``state.py::record_job_event`` does the ``job_events``
INSERT inline and then calls ``publisher.publish`` as a side effect.
The §6.3 pattern (a wildcard ``JobEventStoreHandler`` subscribed to the
bus, with ``record_job_event`` reduced to constructing+publishing the
domain event) is deferred to Phase 9 where the cloud-outbox cutover
forces the swap.  Until then, dispatch fires *before* the producing
transaction commits, so subscribers MUST NOT read the persisted row
back through a fresh connection — they only get the in-memory
``DomainEvent``.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from jobctrl.domain.ports.events import EventHandler, Subscription

if TYPE_CHECKING:
    from jobctrl.domain.events.base import DomainEvent

logger = logging.getLogger(__name__)

_WILDCARD = "__ALL__"


class InProcessEventBus:
    """Synchronous in-process event publisher/subscriber.

    Implements the ``EventPublisher`` protocol.
    """

    def __init__(self) -> None:
        self._handlers: dict[str, list[EventHandler]] = {}

    def publish(self, event: DomainEvent) -> None:
        """Publish an event to all matching subscribers."""
        for handler in self._handlers.get(event.event_type, []):
            self._safe_call(handler, event)
        for handler in self._handlers.get(_WILDCARD, []):
            self._safe_call(handler, event)

    def subscribe(
        self,
        event_type: str | None,
        handler: EventHandler,
    ) -> Subscription:
        """Subscribe to events of a specific type, or all events (None)."""
        key = event_type if event_type is not None else _WILDCARD
        self._handlers.setdefault(key, []).append(handler)

        def _unsubscribe() -> None:
            handlers = self._handlers.get(key, [])
            if handler in handlers:
                handlers.remove(handler)

        return Subscription(_unsubscribe)

    @staticmethod
    def _safe_call(handler: EventHandler, event: DomainEvent) -> None:
        try:
            handler(event)
        except Exception:
            logger.exception(
                "Event handler %s failed for %s",
                getattr(handler, "__name__", handler),
                event.event_type,
            )
