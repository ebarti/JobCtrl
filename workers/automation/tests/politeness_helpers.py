"""Offline politeness test doubles for the R10 browser-gate suites.

These keep enrichment unit tests hermetic: no real ``robots.txt`` fetch and no
real ``time.sleep`` while still exercising the same gateway/session code path the
production enrichment crawl uses. Not a ``test_*`` module, so pytest never
collects it as a test file.
"""

from __future__ import annotations

import sqlite3
import socket
import threading
import urllib.request
from typing import Any

from jobctrl.domain.discovery.source_registry import ENRICHMENT_CRAWL_POLICY
from jobctrl.domain.ports.politeness import RobotsVerdict
from jobctrl.infrastructure.network import (
    HostRateLimiter,
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    RunBudgetCounter,
    build_public_http_opener,
)


class AllowAllRobots:
    """``RobotsPort`` that allows every URL and records what it was asked."""

    def __init__(self) -> None:
        self.checked: list[str] = []

    def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:  # noqa: ARG002
        self.checked.append(url)
        return RobotsVerdict.ALLOW


class DenyAllRobots:
    """``RobotsPort`` that disallows every URL and records what it was asked."""

    def __init__(self) -> None:
        self.checked: list[str] = []

    def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:  # noqa: ARG002
        self.checked.append(url)
        return RobotsVerdict.DISALLOW


class VirtualClock:
    """Monotonic virtual clock whose ``sleep`` advances time instead of blocking.

    Lets the real :class:`HostRateLimiter` run its min-interval loop
    deterministically (no wall-clock sleeps) and lets tests assert the pacing
    that was applied via :attr:`sleeps`.
    """

    def __init__(self) -> None:
        self._t = 0.0
        self._lock = threading.Lock()
        self.sleeps: list[float] = []

    def now(self) -> float:
        with self._lock:
            return self._t

    def sleep(self, seconds: float) -> None:
        with self._lock:
            if seconds > 0:
                self.sleeps.append(seconds)
                self._t += seconds


def no_sleep_limiter(clock: VirtualClock | None = None) -> HostRateLimiter:
    """A real host limiter driven by a virtual clock (never blocks the suite)."""
    vc = clock or VirtualClock()
    return HostRateLimiter(clock=vc.now, sleep=vc.sleep)


class _LoopbackRedirectSocket:
    def __init__(self, family: int, socktype: int, proto: int) -> None:
        self._socket = socket.socket(family, socktype, proto)

    def connect(self, sockaddr: tuple[object, ...]) -> None:
        self._socket.connect(("127.0.0.1", int(sockaddr[1])))

    def __getattr__(self, name: str) -> object:
        return getattr(self._socket, name)


def public_loopback_opener() -> urllib.request.OpenerDirector:
    """Public-destination opener that connects approved test hosts to loopback."""

    def resolver(_host: str, port: int, **_kwargs: object):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", port))]

    def socket_factory(family: int, socktype: int, proto: int) -> Any:
        return _LoopbackRedirectSocket(family, socktype, proto)

    return build_public_http_opener(resolver=resolver, socket_factory=socket_factory)


def offline_gateway(*, robots: object | None = None) -> PolitenessGateway:
    """A gateway that never fetches robots.txt and never really sleeps."""
    return PolitenessGateway(
        robots=robots or AllowAllRobots(),
        rate_limiter=no_sleep_limiter(),
    )


def offline_session(
    conn: sqlite3.Connection | None = None,
    *,
    robots: object | None = None,
    budget: int | None = None,
    site: str | None = None,
) -> PolitenessSession:
    """An enrichment session bound to an offline gateway for direct-call tests."""
    return PolitenessSession(
        offline_gateway(robots=robots),
        policy=ENRICHMENT_CRAWL_POLICY,
        budget=RunBudgetCounter(budget or ENRICHMENT_CRAWL_POLICY.max_requests_per_run),
        context=PolitenessSourceContext(stage="enrich", source_id=site, adapter="enrichment_browser"),
        recorder_conn=conn,
    )
