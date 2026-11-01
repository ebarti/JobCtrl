"""Shared acquisition pacing, concurrency and request-budget enforcement.

Discovery and Enrich do not request or evaluate robots.txt. Legacy robots
policy values and injected ports cannot reactivate enforcement. ``check`` peeks
at the budget; ``guard`` consumes it and holds the shared host slot. Sessions
record rate-limit and budget outcomes without treating them as scrape failures.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator
from urllib.parse import urlsplit

import ua_generator
from ua_generator.options import Options

from jobctrl.domain.discovery.source_registry import SourcePolicy
from jobctrl.domain.ports.politeness import (
    HonestUserAgent,
    PolitenessDecision,
    PolitenessGatewayPort,
    PolitenessOutcome,
    RateLimiterPort,
    RobotsPort,
    RunBudget,
    default_honest_user_agent,
)
from jobctrl.infrastructure.network.rate_limiter import get_shared_rate_limiter
from jobctrl.operational_metrics import record_operational_attempt_metric

POLITENESS_ATTEMPT_KIND = "politeness_gate"
"""``attempt_kind`` for recorded politeness outcomes."""

POLITENESS_BLOCKED_OUTCOME = "blocked"
"""Non-terminal ``outcome`` so ``classify_failure`` never reads it as an error."""

def resolve_honest_user_agent(
    search_cfg: Mapping[str, object] | None = None,
) -> HonestUserAgent:
    """Build the legacy product/version/contact identity used when browser headers are off."""
    base = default_honest_user_agent()
    if search_cfg is None:
        from jobctrl import config

        search_cfg = config.load_discovery_crawler_settings()
    crawl_user_agent = search_cfg.get("crawl_user_agent") if search_cfg else None
    crawl_user_agent = crawl_user_agent if isinstance(crawl_user_agent, Mapping) else {}
    configured_product = str(crawl_user_agent.get("product") or "").strip()
    configured_contact = crawl_user_agent.get("contact")
    product = configured_product or base.product
    if configured_contact is not None:
        contact = str(configured_contact).strip() or None
    else:
        contact = base.contact_url
    return HonestUserAgent(product=product, version=base.version, contact_url=contact)


def resolve_request_headers(search_cfg: Mapping[str, object] | None = None) -> dict[str, str]:
    """Snapshot the saved request identity; only an explicit boolean true opts in.

    Generate once per gateway, retaining matching client hints for the session.
    Versions come from the installed package; this performs no network lookup.
    """
    if search_cfg is None:
        from jobctrl import config

        search_cfg = config.load_discovery_crawler_settings()
    identity = search_cfg.get("crawl_user_agent")
    if isinstance(identity, Mapping) and identity.get("use_browser_headers") is True:
        generated = ua_generator.generate(
            device="desktop", browser="chrome", options=Options(latest_versions=True)
        )
        headers = dict(generated.headers.get())
        headers["User-Agent"] = headers.pop("user-agent")
        return headers
    return {"User-Agent": resolve_honest_user_agent(search_cfg).header_value()}


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
        self._request_headers = (
            {"User-Agent": user_agent.header_value()} if user_agent is not None else resolve_request_headers()
        )
        self._ua_header = self._request_headers["User-Agent"]
        # Retain the injection argument for older callers; never consult it.
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

    def with_robots(self, robots: RobotsPort) -> PolitenessGateway:
        """Compatibility shim: replacing a legacy robots port has no effect."""
        return self

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

    Does NOT commit: the caller owns the transaction so the outcome persists
    atomically with the surrounding write path. A caller that records an outcome
    and then short-circuits (e.g. breaks out of a crawl loop) must commit itself.
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
        defer_recording: bool = False,
    ) -> None:
        self._gateway = gateway
        self._policy = policy
        self._budget = budget
        self._context = context
        self._recorder_conn = recorder_conn
        self._defer_recording = defer_recording
        self._pending_outcomes: list[tuple[PolitenessDecision, str]] = []

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
        """Record a blocked decision observed via :meth:`check` (peek).

        A caller that peeks with :meth:`check` to branch its control flow (e.g.
        the enrichment lifecycle must fold a robots block into ``Pending ->
        Blocked`` *before* entering ``running``) commits the outcome with this
        method. No-op for an allowed decision or when no ``recorder_conn`` is
        bound. :meth:`guard` records automatically, so never pair it with this.
        """
        self._record(decision, url)

    @contextmanager
    def guard(
        self, url: str, *, timeout_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> Iterator[PolitenessDecision]:
        kwargs = {"timeout_seconds": timeout_seconds} if timeout_seconds is not None else {}
        if cancel_event is not None:
            kwargs["cancel_event"] = cancel_event
        with self._gateway.guard(url, self._policy, self._budget, **kwargs) as decision:
            self._record(decision, url)
            yield decision

    def note_retry_after(self, url: str, retry_after_seconds: float) -> None:
        self._gateway.note_retry_after(url, retry_after_seconds)

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
        self._record(decision, url)

    def _record(self, decision: PolitenessDecision, url: str) -> None:
        if self._recorder_conn is None or decision.allowed:
            return
        if self._defer_recording:
            self._pending_outcomes.append((decision, url))
            return
        record_politeness_outcome(
            self._recorder_conn,
            decision=decision,
            context=self._context,
            url=url,
        )

    def flush_deferred(self) -> None:
        """Commit only this session's buffered outcomes, from a clean connection."""
        if not self._pending_outcomes or self._recorder_conn is None:
            return
        if self._recorder_conn.in_transaction:
            raise RuntimeError("Cannot flush contact outcomes inside another transaction")
        with self._recorder_conn:
            for decision, url in self._pending_outcomes:
                record_politeness_outcome(
                    self._recorder_conn, decision=decision, context=self._context, url=url,
                )
        self._pending_outcomes.clear()
