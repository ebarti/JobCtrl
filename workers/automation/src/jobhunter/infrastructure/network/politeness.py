"""Shared crawl-politeness gateway (R10 P1) — the enforcement core.

One code path every outbound fetch routes through. It consults each source's
:class:`SourcePolicy` plus the target host's ``robots.txt``, applies a per-host
rate limit + concurrency cap + per-run request budget, stamps an honest
user-agent, and records robots-denial / rate-limit / budget-exhaustion as
first-class *outcomes* — never scrape errors — in ``operational_attempt_metrics``.

Design notes:

* :meth:`PolitenessGateway.check` is a pure, side-effect-free verdict (peek).
  :meth:`PolitenessGateway.guard` is the real fetch/navigation path: it consumes
  one budget unit and holds the per-host rate/concurrency slot for the duration.
  Both ``urllib`` callers and Playwright callers use ``guard``; browser callers
  wrap ``page.goto`` in it.
* The run budget bounds *content* fetches. ``robots.txt`` fetches are bounded
  separately by per-host caching + TTL (:mod:`.robots`) and are not double-charged
  to the content budget, which keeps the budget meaning crisp.
* :class:`PolitenessSession` binds the gateway + a run budget + a source's
  recording context so P2/P3 call ``session.guard(url)`` and blocked outcomes are
  recorded automatically.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator
from urllib.parse import urlsplit

from jobhunter.domain.discovery.source_registry import RobotsPolicy, SourcePolicy
from jobhunter.domain.ports.politeness import (
    HonestUserAgent,
    PolitenessDecision,
    PolitenessGatewayPort,
    PolitenessOutcome,
    RateLimiterPort,
    RobotsPort,
    RobotsVerdict,
    RunBudget,
    default_honest_user_agent,
)
from jobhunter.infrastructure.network.rate_limiter import get_shared_rate_limiter
from jobhunter.infrastructure.network.robots import RobotsCache
from jobhunter.operational_metrics import record_operational_attempt_metric

POLITENESS_ATTEMPT_KIND = "politeness_gate"
"""``attempt_kind`` for recorded politeness outcomes."""

POLITENESS_BLOCKED_OUTCOME = "blocked"
"""Non-terminal ``outcome`` so ``classify_failure`` never reads it as an error."""


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
        robots: RobotsPort | None = None,
        rate_limiter: RateLimiterPort | None = None,
    ) -> None:
        self._user_agent = user_agent or default_honest_user_agent()
        self._ua_header = self._user_agent.header_value()
        self._robots = robots or RobotsCache()
        self._rate_limiter = rate_limiter or get_shared_rate_limiter()

    @property
    def user_agent(self) -> str:
        """The honest ``User-Agent`` header value stamped on every fetch."""
        return self._ua_header

    def new_run_budget(self, max_requests: int) -> RunBudget:
        return RunBudgetCounter(max_requests)

    def check(self, url: str, policy: SourcePolicy, budget: RunBudget) -> PolitenessDecision:
        if budget.remaining() <= 0:
            return self._budget_exhausted()
        robots_block = self._robots_block(url, policy)
        if robots_block is not None:
            return robots_block
        return PolitenessDecision(True, PolitenessOutcome.ALLOWED, self._ua_header)

    @contextmanager
    def guard(
        self, url: str, policy: SourcePolicy, budget: RunBudget
    ) -> Iterator[PolitenessDecision]:
        if budget.remaining() <= 0:
            yield self._budget_exhausted()
            return
        robots_block = self._robots_block(url, policy)
        if robots_block is not None:
            # A blocked fetch consumes no content budget and holds no slot.
            yield robots_block
            return
        if not budget.try_consume(1):
            yield self._budget_exhausted()
            return
        host = urlsplit(url).netloc or url
        with self._rate_limiter.slot(
            host,
            min_interval_seconds=policy.min_request_interval_seconds,
            max_concurrency=policy.max_concurrent_requests_per_host,
        ):
            yield PolitenessDecision(True, PolitenessOutcome.ALLOWED, self._ua_header)

    def note_retry_after(self, url: str, retry_after_seconds: float) -> None:
        """Forward a server ``Retry-After`` for ``url``'s host to the limiter."""
        host = urlsplit(url).netloc or url
        self._rate_limiter.note_retry_after(host, retry_after_seconds)

    def _robots_block(self, url: str, policy: SourcePolicy) -> PolitenessDecision | None:
        if policy.robots_policy is not RobotsPolicy.HONOR:
            return None
        verdict = self._robots.evaluate(url, self._ua_header)
        if verdict is RobotsVerdict.ALLOW:
            return None
        if verdict is RobotsVerdict.DISALLOW:
            return PolitenessDecision(
                False,
                PolitenessOutcome.ROBOTS_DISALLOWED,
                self._ua_header,
                reason="robots.txt disallows this path",
            )
        # UNKNOWN: robots unreachable => fail-closed (D6), re-checked next run.
        return PolitenessDecision(
            False,
            PolitenessOutcome.ROBOTS_DISALLOWED,
            self._ua_header,
            reason="robots.txt unreachable; treating as disallowed (will retry)",
        )

    def _budget_exhausted(self) -> PolitenessDecision:
        return PolitenessDecision(
            False,
            PolitenessOutcome.BUDGET_EXHAUSTED,
            self._ua_header,
            reason="per-run request budget exhausted",
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


def record_politeness_outcome(
    conn: sqlite3.Connection,
    *,
    decision: PolitenessDecision,
    context: PolitenessSourceContext,
    url: str | None = None,
    occurred_at: str | None = None,
) -> None:
    """Record a blocked politeness decision as a first-class non-error outcome.

    No-op for an allowed decision. Robots-deny / rate-limit / budget-exhaustion
    land in ``operational_attempt_metrics`` with ``is_operational_failure`` and
    ``is_scrape_failure`` both false, so a source that yields nothing shows *why*
    without being counted as a scrape failure (RCA discipline).
    """
    if decision.allowed:
        return
    metadata: dict[str, object] = {}
    if decision.reason:
        metadata["reason"] = decision.reason
    if decision.retry_after_seconds is not None:
        metadata["retry_after_seconds"] = decision.retry_after_seconds
    record_operational_attempt_metric(
        conn,
        stage=context.stage,
        attempt_kind=POLITENESS_ATTEMPT_KIND,
        outcome=POLITENESS_BLOCKED_OUTCOME,
        source_id=context.source_id,
        source_kind=context.source_kind,
        source_priority=context.source_priority,
        source_role=context.source_role,
        adapter=context.adapter,
        run_id=context.run_id,
        job_url=url,
        failure_category=decision.outcome.value,
        is_operational_failure=False,
        is_scrape_failure=False,
        is_retryable=True,
        metadata=metadata,
        occurred_at=occurred_at,
    )


class PolitenessSession:
    """Gateway + run budget + source recording context, bound for one source.

    ``guard(url)`` is the fetch/navigation path — it records a blocked outcome
    automatically when a ``recorder_conn`` is provided. ``check(url)`` is a pure
    peek and never records (use ``guard`` to commit). This split avoids
    double-recording when a caller peeks before committing.
    """

    def __init__(
        self,
        gateway: PolitenessGatewayPort,
        *,
        policy: SourcePolicy,
        budget: RunBudget,
        context: PolitenessSourceContext,
        recorder_conn: sqlite3.Connection | None = None,
    ) -> None:
        self._gateway = gateway
        self._policy = policy
        self._budget = budget
        self._context = context
        self._recorder_conn = recorder_conn

    @property
    def user_agent(self) -> str:
        return self._gateway.user_agent  # type: ignore[attr-defined]

    @property
    def budget(self) -> RunBudget:
        return self._budget

    def check(self, url: str) -> PolitenessDecision:
        return self._gateway.check(url, self._policy, self._budget)

    def record(self, decision: PolitenessDecision, url: str) -> None:
        """Record a blocked decision observed via :meth:`check` (peek).

        A caller that peeks with :meth:`check` to branch its control flow (e.g.
        the enrichment lifecycle must fold a robots block into ``Pending ->
        Blocked`` *before* entering ``running``) commits the outcome with this
        method. No-op for an allowed decision or when no ``recorder_conn`` is
        bound. :meth:`guard` records automatically, so never pair it with this.
        """
        self._record(decision, url)

    @contextmanager
    def guard(self, url: str) -> Iterator[PolitenessDecision]:
        with self._gateway.guard(url, self._policy, self._budget) as decision:
            self._record(decision, url)
            yield decision

    def note_retry_after(self, url: str, retry_after_seconds: float) -> None:
        note = getattr(self._gateway, "note_retry_after", None)
        if callable(note):
            note(url, retry_after_seconds)

    def record_server_rate_limit(self, url: str, retry_after_seconds: float | None = None) -> None:
        """Record a server-issued 429/503 as a first-class rate-limit outcome."""
        if self._recorder_conn is None:
            return
        decision = PolitenessDecision(
            allowed=False,
            outcome=PolitenessOutcome.RATE_LIMITED,
            user_agent=self.user_agent,
            retry_after_seconds=retry_after_seconds,
            reason="server responded 429/503",
        )
        record_politeness_outcome(
            self._recorder_conn, decision=decision, context=self._context, url=url
        )

    def _record(self, decision: PolitenessDecision, url: str) -> None:
        if self._recorder_conn is None or decision.allowed:
            return
        record_politeness_outcome(
            self._recorder_conn,
            decision=decision,
            context=self._context,
            url=url,
        )
