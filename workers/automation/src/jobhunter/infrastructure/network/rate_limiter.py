"""Process-shared, host-keyed rate limiter for the politeness gateway (R10 P1).

Implements :class:`RateLimiterPort`. The crawlers fan out with
``ThreadPoolExecutor`` (Workday, enrichment detail, smart-extract), so the
limiter MUST be process-shared and thread-safe: a per-thread or per-call limiter
would re-introduce the parallel-mode bypass this train exists to kill.

Per host it enforces two independent bounds:

* a **min-interval** between request *starts* (spacing), and
* a **max concurrency** of in-flight requests (a bounded semaphore).

A server ``Retry-After`` (429/503) recorded via :meth:`note_retry_after` pushes
the next allowed start out for that host.
"""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from typing import Callable, Iterator


class _HostSlot:
    """Per-host pacing + concurrency state."""

    def __init__(self, max_concurrency: int) -> None:
        self.semaphore = threading.BoundedSemaphore(max(1, max_concurrency))
        self.lock = threading.Lock()
        self.next_start_allowed = 0.0
        self.retry_after_until = 0.0


class HostRateLimiter:
    """Thread-safe rate limiter keyed by host.

    One instance is shared across all crawler threads (see
    :func:`get_shared_rate_limiter`). The bounded semaphore for a host is
    created on first use with that call's ``max_concurrency``; a host maps to a
    single :class:`SourcePolicy`, so the first-seen concurrency is authoritative.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._registry_lock = threading.Lock()
        self._hosts: dict[str, _HostSlot] = {}
        self._clock = clock
        self._sleep = sleep

    def _slot_for(self, host: str, max_concurrency: int) -> _HostSlot:
        with self._registry_lock:
            slot = self._hosts.get(host)
            if slot is None:
                slot = _HostSlot(max_concurrency)
                self._hosts[host] = slot
            return slot

    @contextmanager
    def slot(
        self,
        host: str,
        *,
        min_interval_seconds: float,
        max_concurrency: int,
    ) -> Iterator[None]:
        slot = self._slot_for(host, max_concurrency)
        slot.semaphore.acquire()
        try:
            self._wait_for_turn(slot, min_interval_seconds)
            yield
        finally:
            slot.semaphore.release()

    def _wait_for_turn(self, slot: _HostSlot, min_interval_seconds: float) -> None:
        interval = max(0.0, min_interval_seconds)
        while True:
            with slot.lock:
                now = self._clock()
                earliest = max(slot.next_start_allowed, slot.retry_after_until)
                if now >= earliest:
                    slot.next_start_allowed = now + interval
                    return
                wait = earliest - now
            self._sleep(wait)

    def note_retry_after(self, host: str, retry_after_seconds: float) -> None:
        slot = self._slot_for(host, 1)
        with slot.lock:
            slot.retry_after_until = max(
                slot.retry_after_until,
                self._clock() + max(0.0, retry_after_seconds),
            )


_SHARED_LOCK = threading.Lock()
_SHARED_RATE_LIMITER: HostRateLimiter | None = None


def get_shared_rate_limiter() -> HostRateLimiter:
    """Return the process-wide shared limiter, creating it on first use."""
    global _SHARED_RATE_LIMITER
    with _SHARED_LOCK:
        if _SHARED_RATE_LIMITER is None:
            _SHARED_RATE_LIMITER = HostRateLimiter()
        return _SHARED_RATE_LIMITER
