"""Explicit network admission, process-shared pacing and run budgets.

No configuration/database lookup or canonical writer exists in this module.
Feature adapters supply settings and persist their own acquisition outcomes.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator
from urllib.parse import urlsplit

from .policy import SourcePolicy
from .ports import (HonestUserAgent, PolitenessDecision, PolitenessGatewayPort,
                    PolitenessOutcome, RateLimiterPort, RunBudget, default_honest_user_agent)
from .rate_limiter import get_shared_rate_limiter

class RunBudgetCounter(RunBudget):
    """Thread-safe per-run outbound-request counter."""

    def __init__(self, limit: int) -> None:
        if limit <= 0:
            raise ValueError("RunBudgetCounter limit must be positive")
        self._limit = limit
        self._used = 0
        self._lock = threading.Lock()

    @property
    def limit(self) -> int:
        return self._limit

    def consumed(self) -> int:
        with self._lock:
            return self._used

    def remaining(self) -> int:
        with self._lock:
            return max(0, self._limit - self._used)

    def try_consume(self, count: int = 1) -> bool:
        with self._lock:
            if self._used + count > self._limit:
                return False
            self._used += count
            return True


class PolitenessGateway(PolitenessGatewayPort):
    """The single facade every outbound fetch surface calls."""

    def __init__(
        self,
        *,
        user_agent: HonestUserAgent | None = None,
        request_headers: Mapping[str, str] | None = None,
        rate_limiter: RateLimiterPort | None = None,
    ) -> None:
        if request_headers is not None:
            self._request_headers = {str(key): str(value) for key, value in request_headers.items()}
            if not self._request_headers.get("User-Agent") or any(
                "\r" in key or "\n" in key or "\r" in value or "\n" in value
                for key, value in self._request_headers.items()
            ):
                raise ValueError("Explicit crawler headers require a valid User-Agent.")
        else:
            self._request_headers = (
                {"User-Agent": (user_agent or default_honest_user_agent()).header_value()}
            )
        self._ua_header = self._request_headers["User-Agent"]
        # Acquisition surfaces share host pacing unless a caller supplies its
        # own limiter explicitly at this I/O boundary.
        self._rate_limiter = rate_limiter or get_shared_rate_limiter()

    @property
    def user_agent(self) -> str:
        """The selected ``User-Agent`` header value stamped on every fetch."""
        return self._ua_header

    @property
    def request_headers(self) -> dict[str, str]:
        return dict(self._request_headers)

    def new_run_budget(self, max_requests: int) -> RunBudget:
        return RunBudgetCounter(max_requests)

    def check(self, url: str, policy: SourcePolicy, budget: RunBudget) -> PolitenessDecision:
        if budget.remaining() <= 0:
            return self._budget_exhausted()
        return PolitenessDecision(True, PolitenessOutcome.ALLOWED, self._ua_header, request_headers=self.request_headers)

    @contextmanager
    def guard(
        self, url: str, policy: SourcePolicy, budget: RunBudget, *, timeout_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> Iterator[PolitenessDecision]:
        if budget.remaining() <= 0:
            yield self._budget_exhausted()
            return
        host = urlsplit(url).netloc or url
        cooldown = self._rate_limiter.hard_rate_limit_remaining(host)
        if cooldown > 0.0:
            # The server asked to wait longer than the limiter's cap: record a
            # rate-limited outcome and skip rather than park a worker thread for
            # the (clamped) cooldown. Consumes no budget and holds no slot.
            yield self._rate_limited(cooldown)
            return
        if not budget.try_consume(1):
            yield self._budget_exhausted()
            return
        with self._rate_limiter.slot(
            host,
            min_interval_seconds=policy.min_request_interval_seconds,
            max_concurrency=policy.max_concurrent_requests_per_host,
            **({"timeout_seconds": timeout_seconds} if timeout_seconds is not None else {}),
            **({"cancel_event": cancel_event} if cancel_event is not None else {}),
        ):
            yield PolitenessDecision(True, PolitenessOutcome.ALLOWED, self._ua_header, request_headers=self.request_headers)

    def note_retry_after(self, url: str, retry_after_seconds: float) -> float:
        """Forward a server ``Retry-After`` for ``url``'s host to the limiter.

        Returns the effective (clamped) seconds the limiter honored.
        """
        host = urlsplit(url).netloc or url
        return self._rate_limiter.note_retry_after(host, retry_after_seconds)

    def _budget_exhausted(self) -> PolitenessDecision:
        return PolitenessDecision(
            False,
            PolitenessOutcome.BUDGET_EXHAUSTED,
            self._ua_header,
            reason="per-run request budget exhausted",
        )

    def _rate_limited(self, retry_after_seconds: float) -> PolitenessDecision:
        return PolitenessDecision(
            False,
            PolitenessOutcome.RATE_LIMITED,
            self._ua_header,
            retry_after_seconds=retry_after_seconds,
            reason="server Retry-After exceeded the limiter cap; deferring this host",
        )


@dataclass(frozen=True)
class PolitenessSourceContext:
    """Recording dimensions for one source's politeness outcomes."""

    stage: str
    source_id: str | None = None
    source_kind: str | None = None
    source_priority: str | None = None
    source_role: str | None = None
    adapter: str | None = None
    run_id: str | None = None


class PolitenessSession:
    """A run's gateway, policy, budget and optional feature-owned outcome port."""

    def __init__(self, gateway: PolitenessGatewayPort, *, policy: SourcePolicy, budget: RunBudget,
                 context: PolitenessSourceContext,
                 record_outcome: Callable[[PolitenessDecision, PolitenessSourceContext, str], None] | None = None):
        self._gateway, self._policy, self._budget = gateway, policy, budget
        self._context, self._record_outcome = context, record_outcome

    @property
    def user_agent(self) -> str:
        return self._gateway.user_agent

    @property
    def request_headers(self) -> Mapping[str, str]:
        return self._gateway.request_headers

    @property
    def budget(self) -> RunBudget:
        return self._budget

    def check(self, url: str) -> PolitenessDecision:
        return self._gateway.check(url, self._policy, self._budget)

    def record(self, decision: PolitenessDecision, url: str) -> None:
        if not decision.allowed and self._record_outcome is not None:
            self._record_outcome(decision, self._context, url)

    @contextmanager
    def guard(self, url: str, *, timeout_seconds: float | None = None,
              cancel_event: threading.Event | None = None) -> Iterator[PolitenessDecision]:
        with self._gateway.guard(url, self._policy, self._budget, timeout_seconds=timeout_seconds,
                                 cancel_event=cancel_event) as decision:
            self.record(decision, url)
            yield decision

    def note_retry_after(self, url: str, retry_after_seconds: float) -> None:
        self._gateway.note_retry_after(url, retry_after_seconds)

    def record_server_rate_limit(self, url: str, retry_after_seconds: float | None = None) -> None:
        self.record(PolitenessDecision(False, PolitenessOutcome.RATE_LIMITED, self.user_agent,
                                      retry_after_seconds, "server responded 429/503", self.request_headers), url)
