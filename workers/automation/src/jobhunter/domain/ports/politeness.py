"""Driven ports for crawl politeness (R10).

The politeness gateway is the single choke point every outbound fetch —
``urllib``, the ``python-jobspy`` invocation boundary, and every Playwright
navigation — routes through. It consults each source's :class:`SourcePolicy`
plus the target host's ``robots.txt``, applies a per-host rate limit +
concurrency cap + per-run request budget, stamps an honest user-agent, and
records robots-denial / rate-limit / budget-exhaustion as first-class
*outcomes* (never scrape errors).

These are declarations only (P0). The concrete adapter lands in
``jobhunter.infrastructure.network`` (P1); the fetch surfaces route through it
in P2/P3. Value objects that are part of the port contract live here,
following the Protocol-per-context pattern in this package (``discovery.py``
co-locates ``ScrapedJobPosting`` with ``JobBoardScraperPort``).
"""

from __future__ import annotations

import importlib.metadata
from contextlib import AbstractContextManager
from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from jobhunter.domain.discovery.source_registry import SourcePolicy

PROJECT_REPOSITORY_URL = "https://github.com/ebarti/JobHunter"
"""Public repository URL used as the honest-UA contact by default (D1).

The rename train (R0) updates the product name; the owner may override the
entire user-agent (product + contact) via config/env in P5. This is the
project's public location, not the owner's personal identity.
"""


def _package_version() -> str:
    try:
        return importlib.metadata.version("jobhunter")
    except importlib.metadata.PackageNotFoundError:  # pragma: no cover - dev tree
        return "0"


class RobotsVerdict(str, Enum):
    """Result of evaluating a URL against a host's ``robots.txt``."""

    ALLOW = "allow"
    DISALLOW = "disallow"
    UNKNOWN = "unknown"


class PolitenessOutcome(str, Enum):
    """First-class outcome of a gateway decision, recorded in source quality.

    Only :attr:`ALLOWED` proceeds to a fetch. The other three are *outcomes*,
    not errors: they explain why a source produced nothing without being
    counted as a scrape failure.
    """

    ALLOWED = "allowed"
    ROBOTS_DISALLOWED = "robots_disallowed"
    RATE_LIMITED = "rate_limited"
    BUDGET_EXHAUSTED = "budget_exhausted"


@dataclass(frozen=True)
class HonestUserAgent:
    """The product's single outbound identity (owner decision D1).

    Replaces the four divergent UA literals scattered across the fetch paths.
    Never impersonates a browser on a surface the product controls.
    """

    product: str
    version: str
    contact_url: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.product, str) or not self.product.strip():
            raise ValueError("HonestUserAgent.product must be a non-empty string")
        if not isinstance(self.version, str) or not self.version.strip():
            raise ValueError("HonestUserAgent.version must be a non-empty string")

    def header_value(self) -> str:
        """Render the ``User-Agent`` header value.

        ``<product>/<version> (+<contact_url>)`` when a contact is set,
        otherwise ``<product>/<version>``.
        """
        base = f"{self.product}/{self.version}"
        contact = (self.contact_url or "").strip()
        return f"{base} (+{contact})" if contact else base


def default_honest_user_agent() -> HonestUserAgent:
    """The built-in honest UA: ``JobHunter/<version> (+<repo url>)`` (D1)."""
    return HonestUserAgent(
        product="JobHunter",
        version=_package_version(),
        contact_url=PROJECT_REPOSITORY_URL,
    )


@dataclass(frozen=True)
class PolitenessDecision:
    """The gateway's verdict for one prospective fetch or navigation.

    ``allowed`` gates the fetch. ``user_agent`` is the honest UA the caller
    must stamp (``urllib`` header / Playwright context). ``outcome`` is the
    recordable reason; ``retry_after_seconds`` carries a honored ``Retry-After``
    when the limiter deferred; ``reason`` is a human-readable detail.
    """

    allowed: bool
    outcome: PolitenessOutcome
    user_agent: str
    retry_after_seconds: float | None = None
    reason: str | None = None


class RunBudget(Protocol):
    """A per-run outbound-request counter.

    The concrete, thread-safe implementation lives with the gateway (P1);
    scoping a budget to a discovery/enrichment run bounds total outbound
    requests independently of the result-volume cap (``max_pages_per_run``).
    """

    @property
    def limit(self) -> int:
        """Maximum outbound requests allowed for this run."""
        ...

    def consumed(self) -> int:
        """Requests consumed so far."""
        ...

    def remaining(self) -> int:
        """Requests still available (never negative)."""
        ...

    def try_consume(self, count: int = 1) -> bool:
        """Atomically consume ``count`` units if available.

        Returns ``True`` when the units fit within the budget (and were
        consumed) and ``False`` when the budget is exhausted (no consumption).
        """
        ...


class RobotsPort(Protocol):
    """Fetch, cache, and evaluate a host's ``robots.txt`` for a user-agent."""

    def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:
        """Return whether ``user_agent`` may fetch ``url`` per ``robots.txt``.

        Implementations cache per host with a TTL and treat an unreachable
        ``robots.txt`` conservatively — a repeated ``5xx``/timeout is never a
        silent :attr:`RobotsVerdict.ALLOW`.
        """
        ...


class RateLimiterPort(Protocol):
    """Process-shared, host-keyed rate limiter + concurrency semaphore.

    MUST be thread-safe: the crawlers fan out with ``ThreadPoolExecutor``, so a
    per-thread or per-call limiter would re-introduce the parallel-mode bypass.
    """

    def slot(
        self,
        host: str,
        *,
        min_interval_seconds: float,
        max_concurrency: int,
    ) -> AbstractContextManager[None]:
        """Acquire a per-host slot, blocking to honor min-interval + concurrency.

        The slot is held for the duration of the ``with`` block (one fetch or
        navigation) and released on exit.
        """
        ...

    def note_retry_after(self, host: str, retry_after_seconds: float) -> float:
        """Record a server ``Retry-After`` so the next slot for ``host`` waits.

        Implementations clamp the deferral to a bounded ceiling at this sink so a
        hostile/absurd header cannot freeze a host (and a pooled worker thread) for
        an attacker-chosen duration. Returns the effective (clamped) seconds.
        """
        ...

    def hard_rate_limit_remaining(self, host: str) -> float:
        """Seconds a host must wait due to an *over-clamp* server ``Retry-After`` (0 if none).

        A positive value means the server's ``Retry-After`` exceeded the limiter's
        cap; the gateway records a rate-limited outcome and skips the fetch instead
        of holding a worker thread for the clamped cooldown. Within-cap
        ``Retry-After`` values return 0 and are paced by :meth:`slot`.
        """
        ...


class PolitenessGatewayPort(Protocol):
    """The single facade every outbound fetch surface calls.

    Transport-agnostic by design: ``urllib`` callers and Playwright callers
    share one contract. :meth:`check` returns a pre-fetch verdict (used
    directly by browser callers before ``page.goto``); :meth:`guard`
    additionally holds the per-host rate/concurrency slot and consumes the run
    budget for the duration of the fetch.
    """

    @property
    def user_agent(self) -> str:
        """The honest ``User-Agent`` header value stamped on every fetch."""
        ...

    def new_run_budget(self, max_requests: int) -> RunBudget:
        """Create a per-run request budget (typically ``SourcePolicy`` sized)."""
        ...

    def note_retry_after(self, url: str, retry_after_seconds: float) -> float:
        """Forward a server ``Retry-After`` for ``url``'s host to the limiter.

        Returns the effective (clamped) seconds the limiter honored.
        """
        ...

    def check(
        self,
        url: str,
        policy: SourcePolicy,
        budget: RunBudget,
    ) -> PolitenessDecision:
        """Evaluate robots + budget for ``url`` without acquiring a slot.

        Used by browser callers as the pre-navigation verdict. Does NOT consume
        the budget or hold a rate-limit slot; :meth:`guard` does both.
        """
        ...

    def guard(
        self,
        url: str,
        policy: SourcePolicy,
        budget: RunBudget,
    ) -> AbstractContextManager[PolitenessDecision]:
        """Context manager wrapping exactly one fetch or navigation.

        On entry it evaluates robots + budget; if allowed it consumes one
        budget unit and acquires the per-host slot (blocking for pacing), then
        yields the :class:`PolitenessDecision`. On exit it releases the slot. A
        disallowed / budget-exhausted decision yields ``allowed=False`` and
        acquires no slot, so the caller records the outcome and skips.
        """
        ...
