"""Tests for InProcessEventBus — §6.3 in-process synchronous bus."""

from jobctl.domain.events.base import create_domain_event
from jobctl.domain.tenant import LOCAL_TENANT
from jobctl.infrastructure.events.in_process_bus import InProcessEventBus


def _event(event_type: str = "StageStarted"):
    return create_domain_event(event_type, LOCAL_TENANT, {"stage": "score"})


def test_typed_subscriber_receives_matching_event():
    bus = InProcessEventBus()
    received = []
    bus.subscribe("StageStarted", received.append)

    bus.publish(_event("StageStarted"))

    assert len(received) == 1
    assert received[0].event_type == "StageStarted"


def test_wildcard_subscriber_receives_all_events():
    bus = InProcessEventBus()
    received = []
    bus.subscribe(None, received.append)

    bus.publish(_event("StageStarted"))
    bus.publish(_event("StageCompleted"))

    assert len(received) == 2


def test_subscriber_ignores_other_event_types():
    bus = InProcessEventBus()
    received = []
    bus.subscribe("StageStarted", received.append)

    bus.publish(_event("StageCompleted"))

    assert len(received) == 0


def test_multiple_subscribers_all_notified():
    bus = InProcessEventBus()
    a, b = [], []
    bus.subscribe("StageStarted", a.append)
    bus.subscribe("StageStarted", b.append)

    bus.publish(_event("StageStarted"))

    assert len(a) == 1
    assert len(b) == 1


def test_handler_error_does_not_break_other_handlers():
    bus = InProcessEventBus()
    received = []

    def bad_handler(_event):
        raise RuntimeError("boom")

    bus.subscribe("StageStarted", bad_handler)
    bus.subscribe("StageStarted", received.append)

    bus.publish(_event("StageStarted"))

    assert len(received) == 1


def test_unsubscribe_removes_handler():
    bus = InProcessEventBus()
    received = []
    sub = bus.subscribe("StageStarted", received.append)

    sub.unsubscribe()
    bus.publish(_event("StageStarted"))

    assert len(received) == 0


def test_publish_with_no_subscribers_is_noop():
    bus = InProcessEventBus()
    bus.publish(_event("StageStarted"))  # Should not raise
