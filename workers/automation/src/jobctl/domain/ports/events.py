"""EventPublisher port — driven port for publishing domain events.

See ddd-target.md §6.1 (Integration Backbone), §6.3 (Event Bus).

The domain layer calls ``publish()`` after each transaction commits.
Infrastructure adapters provide either an in-process synchronous bus
(local-first) or a cloud adapter (SQS FIFO via transactional outbox).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable, Protocol

if TYPE_CHECKING:
    from jobctl.domain.events.base import DomainEvent


EventHandler = Callable[["DomainEvent"], None]


class Subscription:
    """Handle returned by ``subscribe()`` — call ``unsubscribe()`` to detach."""

    def __init__(self, unsubscribe_fn: Callable[[], None]) -> None:
        self._unsubscribe = unsubscribe_fn

    def unsubscribe(self) -> None:
        self._unsubscribe()


class EventPublisher(Protocol):
    """Driven port for publishing domain events."""

    def publish(self, event: DomainEvent) -> None:
        """Publish a domain event to all registered subscribers."""
        ...

    def subscribe(
        self,
        event_type: str | None,
        handler: EventHandler,
    ) -> Subscription:
        """Subscribe to events of a specific type, or all events (None)."""
        ...
