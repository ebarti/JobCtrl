"""Process-shared, host-keyed rate limiter for the politeness gateway (R10 P1).

Implements :class:`RateLimiterPort`. The crawlers fan out with
``ThreadPoolExecutor`` (Workday, enrichment detail, smart-extract), so the
limiter MUST be process-shared and thread-safe: a per-thread or per-call limiter
would re-introduce the parallel-mode bypass this train exists to kill.

Per host it enforces two independent bounds:

* a **min-interval** between request *starts* (spacing), and
* a **max concurrency** of in-flight requests (a bounded semaphore).

A server ``Retry-After`` (429/503) recorded via :meth:`note_retry_after` pushes
the next allowed start out for that host. Because the limiter is a process-lifetime
singleton, that deferral is **clamped** to :data:`_DEFAULT_MAX_RETRY_AFTER_SECONDS`
at the sink: a hostile or absurd ``Retry-After`` header must never freeze a host
(and the pooled worker thread waiting on it) for an attacker-chosen duration. When
a server asks for longer than the cap, the host is flagged so the gateway records a
rate-limited *outcome* and skips it (see :meth:`hard_rate_limit_remaining`) instead
of parking a worker for the whole clamped cooldown.
"""

from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from typing import Callable, Iterator

log = logging.getLogger(__name__)

_DEFAULT_MAX_RETRY_AFTER_SECONDS = 300.0
"""Hard ceiling (5 min) on how far a server ``Retry-After`` can defer a host.

The limiter is a process-lifetime singleton shared across pooled worker threads,
so an uncapped deferral is a denial-of-service amplifier: one 429/503 with an
absurd ``Retry-After`` would otherwise hold the host's slot — and the worker
thread that next reaches it — for the attacker-chosen duration.
"""


class _HostSlot:
    """Per-host pacing + concurrency state."""

    def __init__(self, max_concurrency: int) -> None:
        self.semaphore = threading.BoundedSemaphore(max(1, max_concurrency))
        self.lock = threading.Lock()
        self.next_start_allowed = 0.0
        self.retry_after_until = 0.0
        # True while the active Retry-After cooldown came from a value that
        # exceeded the cap (the server asked us to wait longer than we will).
        self.retry_after_capped = False


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
        max_retry_after_seconds: float = _DEFAULT_MAX_RETRY_AFTER_SECONDS,
    ) -> None:
        self._registry_lock = threading.Lock()
        self._hosts: dict[str, _HostSlot] = {}
        self._clock = clock
        self._sleep = sleep
        self._max_retry_after_seconds = max(0.0, max_retry_after_seconds)

    @property
    def max_retry_after_seconds(self) -> float:
        """The hard ceiling a server ``Retry-After`` is clamped to at the sink."""
        return self._max_retry_after_seconds

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
        cap = self._max_retry_after_seconds
        while True:
            with slot.lock:
                now = self._clock()
                earliest = max(slot.next_start_allowed, slot.retry_after_until)
                if now >= earliest:
                    slot.next_start_allowed = now + interval
                    return
                wait = earliest - now
            # No single nap exceeds the cap. ``retry_after_until`` is already
            # bounded at the sink (:meth:`note_retry_after`); this is a defensive
            # ceiling on any one sleep so a future writer of the deadline cannot
            # freeze the thread, and it keeps the wait responsive between naps.
            self._sleep(min(wait, cap) if cap > 0 else wait)

    def note_retry_after(self, host: str, retry_after_seconds: float) -> float:
        """Record a server ``Retry-After`` so the next slot for ``host`` waits.

        Clamps the deferral to :attr:`max_retry_after_seconds` at this sink so a
        hostile/absurd header cannot park a host (and a worker thread) for an
        attacker-chosen duration. Returns the effective (clamped) seconds; logs
        and flags the host when the requested value exceeded the cap.
        """
        requested = max(0.0, retry_after_seconds)
        cap = self._max_retry_after_seconds
        capped = min(requested, cap) if cap > 0 else requested
        over_clamp = cap > 0 and requested > cap
        if over_clamp:
            log.warning(
                "Retry-After %.0fs for host %s exceeds the %.0fs cap; clamping so a "
                "hostile header cannot freeze a worker (host reported rate-limited)",
                requested,
                host,
                cap,
            )
        slot = self._slot_for(host, 1)
        with slot.lock:
            slot.retry_after_until = max(slot.retry_after_until, self._clock() + capped)
            if over_clamp:
                slot.retry_after_capped = True
        return capped

    def hard_rate_limit_remaining(self, host: str) -> float:
        """Seconds left in an *over-clamp* ``Retry-After`` cooldown for ``host`` (0 if none).

        A positive value means the server asked us to wait longer than the cap:
        the gateway records a rate-limited outcome and skips the fetch rather than
        holding a worker for the clamped cooldown. A within-cap ``Retry-After``
        returns 0 here — those are paced normally by :meth:`slot`.
        """
        with self._registry_lock:
            slot = self._hosts.get(host)
        if slot is None:
            return 0.0
        with slot.lock:
            if not slot.retry_after_capped:
                return 0.0
            remaining = slot.retry_after_until - self._clock()
            if remaining <= 0.0:
                slot.retry_after_capped = False
                return 0.0
            return remaining


_SHARED_LOCK = threading.Lock()
_SHARED_RATE_LIMITER: HostRateLimiter | None = None


def get_shared_rate_limiter() -> HostRateLimiter:
    """Return the process-wide shared limiter, creating it on first use."""
    global _SHARED_RATE_LIMITER
    with _SHARED_LOCK:
        if _SHARED_RATE_LIMITER is None:
            _SHARED_RATE_LIMITER = HostRateLimiter()
        return _SHARED_RATE_LIMITER
