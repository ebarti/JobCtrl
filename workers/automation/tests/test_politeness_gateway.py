"""Politeness gateway enforcement tests (R10 P1).

The two mandated fixtures live here — a robots-deny fixture and a rate-limit
fixture — plus robots cache TTL, unreachable-robots (D6) semantics, and
budget-exhaustion recording. All network is loopback (127.0.0.1) or stubbed; no
live board traffic, nothing spendful.
"""

from __future__ import annotations

import sqlite3
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Iterator

from jobhunter.domain.discovery.source_registry import (
    RobotsPolicy,
    SourcePolicy,
    SourcePolicyMethod,
)
from jobhunter.domain.ports.politeness import (
    HonestUserAgent,
    PolitenessOutcome,
    RobotsPort,
    RobotsVerdict,
)
from jobhunter.infrastructure.network.politeness import (
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
)
from jobhunter.infrastructure.network.rate_limiter import HostRateLimiter
from jobhunter.infrastructure.network.robots import RobotsCache
from jobhunter.operational_metrics import ensure_operational_metric_tables

HONEST_UA = HonestUserAgent(product="JobHunter", version="test", contact_url="https://example.com/repo")


def _page_policy(**overrides: object) -> SourcePolicy:
    base: dict[str, object] = {
        "policy_id": "test-page",
        "allowed_methods": (SourcePolicyMethod.RENDERED_DETAIL,),
        "robots_policy": RobotsPolicy.HONOR,
        "min_request_interval_seconds": 0.0,
        "max_concurrent_requests_per_host": 4,
        "max_requests_per_run": 100,
    }
    base.update(overrides)
    return SourcePolicy(**base)  # type: ignore[arg-type]


class _AllowAllRobots(RobotsPort):
    def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:
        return RobotsVerdict.ALLOW


# ---------------------------------------------------------------------------
# Loopback robots server
# ---------------------------------------------------------------------------


class _RobotsServer:
    def __init__(self, robots_body: str, robots_status: int) -> None:
        self.requested_paths: list[str] = []
        self.seen_user_agents: list[str] = []
        server_self = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - stdlib name
                server_self.requested_paths.append(self.path)
                server_self.seen_user_agents.append(self.headers.get("User-Agent", ""))
                if self.path == "/robots.txt":
                    self.send_response(robots_status)
                    self.end_headers()
                    if 200 <= robots_status < 300:
                        self.wfile.write(robots_body.encode("utf-8"))
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"ok")

            def log_message(self, *_args: object) -> None:
                pass

        self._httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self._httpd.server_port}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def __enter__(self) -> "_RobotsServer":
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=2)


@contextmanager
def loopback_robots(body: str, status: int = 200) -> Iterator[_RobotsServer]:
    with _RobotsServer(body, status) as server:
        yield server


def _memory_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    ensure_operational_metric_tables(conn)
    return conn


def _blocked_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    return list(
        conn.execute(
            "SELECT * FROM operational_attempt_metrics WHERE outcome = 'blocked'"
        )
    )


# ---------------------------------------------------------------------------
# Mandated fixture 1: robots-deny
# ---------------------------------------------------------------------------


def test_robots_deny_fixture_blocks_records_and_never_fetches_disallowed_path() -> None:
    robots_txt = "User-agent: *\nDisallow: /jobs\n"
    with loopback_robots(robots_txt) as server:
        gateway = PolitenessGateway(
            user_agent=HONEST_UA,
            robots=RobotsCache(),
            rate_limiter=HostRateLimiter(),
        )
        conn = _memory_conn()
        session = PolitenessSession(
            gateway,
            policy=_page_policy(),
            budget=gateway.new_run_budget(100),
            context=PolitenessSourceContext(stage="discover", source_id="src-1", adapter="browser"),
            recorder_conn=conn,
        )

        content_url = f"{server.base_url}/jobs/1"
        fetched = False
        with session.guard(content_url) as decision:
            if decision.allowed:
                urllib.request.urlopen(content_url, timeout=2)  # pragma: no cover
                fetched = True

        assert decision.allowed is False
        assert decision.outcome is PolitenessOutcome.ROBOTS_DISALLOWED
        assert fetched is False
        # The gateway consulted robots.txt but never the disallowed content path.
        assert "/robots.txt" in server.requested_paths
        assert "/jobs/1" not in server.requested_paths
        # Honest UA on the robots fetch — no browser impersonation.
        assert any(ua.startswith("JobHunter/") for ua in server.seen_user_agents)
        assert all("Mozilla" not in ua for ua in server.seen_user_agents)

    rows = _blocked_rows(conn)
    assert len(rows) == 1
    row = rows[0]
    assert row["failure_category"] == "robots_disallowed"
    # Recorded as a first-class outcome, NOT a scrape/operational error.
    assert row["is_operational_failure"] == 0
    assert row["is_scrape_failure"] == 0
    assert row["source_id"] == "src-1"


def test_robots_allow_path_proceeds_and_consumes_budget() -> None:
    robots_txt = "User-agent: *\nDisallow: /private\n"
    with loopback_robots(robots_txt) as server:
        gateway = PolitenessGateway(
            user_agent=HONEST_UA, robots=RobotsCache(), rate_limiter=HostRateLimiter()
        )
        budget = gateway.new_run_budget(5)
        session = PolitenessSession(
            gateway,
            policy=_page_policy(),
            budget=budget,
            context=PolitenessSourceContext(stage="discover", source_id="src-ok"),
            recorder_conn=_memory_conn(),
        )
        with session.guard(f"{server.base_url}/public/1") as decision:
            assert decision.allowed is True
            assert decision.outcome is PolitenessOutcome.ALLOWED
            assert decision.user_agent.startswith("JobHunter/")
        assert budget.consumed() == 1


# ---------------------------------------------------------------------------
# Mandated fixture 2: rate-limit (interval + concurrency + Retry-After + budget)
# ---------------------------------------------------------------------------


class _VirtualClock:
    def __init__(self) -> None:
        self.t = 0.0
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(max(0.0, seconds))
        self.t += max(0.0, seconds)


def test_rate_limiter_respects_min_interval_between_starts() -> None:
    clock = _VirtualClock()
    limiter = HostRateLimiter(clock=clock.now, sleep=clock.sleep)
    starts: list[float] = []
    for _ in range(4):
        with limiter.slot("host", min_interval_seconds=2.0, max_concurrency=1):
            starts.append(clock.now())
    # Each start is spaced by at least the min interval.
    gaps = [b - a for a, b in zip(starts, starts[1:])]
    assert all(gap >= 2.0 for gap in gaps)


def test_rate_limiter_honors_retry_after() -> None:
    clock = _VirtualClock()
    limiter = HostRateLimiter(clock=clock.now, sleep=clock.sleep)
    limiter.note_retry_after("host", 30.0)
    with limiter.slot("host", min_interval_seconds=0.0, max_concurrency=1):
        pass
    assert clock.now() >= 30.0


def test_rate_limiter_never_exceeds_per_host_concurrency() -> None:
    limiter = HostRateLimiter()
    gateway = PolitenessGateway(
        user_agent=HONEST_UA, robots=_AllowAllRobots(), rate_limiter=limiter
    )
    policy = _page_policy(max_concurrent_requests_per_host=2, min_request_interval_seconds=0.0)
    budget = gateway.new_run_budget(1000)

    active = 0
    max_active = 0
    guard_lock = threading.Lock()
    barrier = threading.Barrier(6)

    def worker() -> None:
        nonlocal active, max_active
        barrier.wait()
        with gateway.guard("http://host/x", policy, budget) as decision:
            assert decision.allowed is True
            with guard_lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.05)
            with guard_lock:
                active -= 1

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert max_active <= 2


def test_run_budget_exhaustion_is_recorded_as_non_error_outcome() -> None:
    gateway = PolitenessGateway(
        user_agent=HONEST_UA, robots=_AllowAllRobots(), rate_limiter=HostRateLimiter()
    )
    conn = _memory_conn()
    session = PolitenessSession(
        gateway,
        policy=_page_policy(min_request_interval_seconds=0.0),
        budget=gateway.new_run_budget(2),
        context=PolitenessSourceContext(stage="discover", source_id="src-budget", adapter="browser"),
        recorder_conn=conn,
    )
    outcomes = []
    for index in range(3):
        with session.guard(f"http://host/page/{index}") as decision:
            outcomes.append(decision.outcome)
    assert outcomes[:2] == [PolitenessOutcome.ALLOWED, PolitenessOutcome.ALLOWED]
    assert outcomes[2] is PolitenessOutcome.BUDGET_EXHAUSTED

    rows = _blocked_rows(conn)
    assert len(rows) == 1
    assert rows[0]["failure_category"] == "budget_exhausted"
    assert rows[0]["is_scrape_failure"] == 0


# ---------------------------------------------------------------------------
# Robots cache TTL + unreachable-robots (D6)
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class _CountingOpener:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.calls = 0

    def open(self, request: object, timeout: float | None = None) -> _FakeResponse:
        self.calls += 1
        return _FakeResponse(self.body)


def test_robots_cache_refetches_only_after_ttl_expires() -> None:
    clock = _VirtualClock()
    opener = _CountingOpener(b"User-agent: *\nDisallow: /jobs\n")
    cache = RobotsCache(ttl_seconds=100.0, opener=opener, clock=clock.now)

    assert cache.evaluate("http://host/jobs", "JobHunter/test") is RobotsVerdict.DISALLOW
    assert cache.evaluate("http://host/ok", "JobHunter/test") is RobotsVerdict.ALLOW
    assert opener.calls == 1  # cached within TTL

    clock.t = 200.0  # past TTL
    assert cache.evaluate("http://host/jobs", "JobHunter/test") is RobotsVerdict.DISALLOW
    assert opener.calls == 2


class _RaisingOpener:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    def open(self, request: object, timeout: float | None = None) -> _FakeResponse:
        raise self.exc


def test_unreachable_robots_5xx_fails_closed() -> None:
    opener = _RaisingOpener(
        urllib.error.HTTPError("http://host/robots.txt", 503, "unavailable", {}, None)  # type: ignore[arg-type]
    )
    cache = RobotsCache(opener=opener)
    # D6: 5xx is unreachable => fail-closed (UNKNOWN), gateway treats as blocked.
    assert cache.evaluate("http://host/jobs", "JobHunter/test") is RobotsVerdict.UNKNOWN


def test_missing_robots_404_allows() -> None:
    opener = _RaisingOpener(
        urllib.error.HTTPError("http://host/robots.txt", 404, "not found", {}, None)  # type: ignore[arg-type]
    )
    cache = RobotsCache(opener=opener)
    # RFC 9309: 4xx robots unavailable => allow.
    assert cache.evaluate("http://host/jobs", "JobHunter/test") is RobotsVerdict.ALLOW


def test_definitively_absent_robots_connection_refused_fails_open() -> None:
    opener = _RaisingOpener(urllib.error.URLError("Connection refused"))
    cache = RobotsCache(opener=opener)
    # D6: definitive network absence => fail-open with warning (allow).
    assert cache.evaluate("http://host/jobs", "JobHunter/test") is RobotsVerdict.ALLOW


def test_unknown_robots_verdict_blocks_at_gateway_fail_closed() -> None:
    class _UnknownRobots(RobotsPort):
        def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:
            return RobotsVerdict.UNKNOWN

    gateway = PolitenessGateway(
        user_agent=HONEST_UA, robots=_UnknownRobots(), rate_limiter=HostRateLimiter()
    )
    decision = gateway.check("http://host/jobs", _page_policy(), gateway.new_run_budget(5))
    assert decision.allowed is False
    assert decision.outcome is PolitenessOutcome.ROBOTS_DISALLOWED


def test_documented_api_policy_skips_robots() -> None:
    class _ExplodingRobots(RobotsPort):
        def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:
            raise AssertionError("robots must not be consulted for exempt sources")

    gateway = PolitenessGateway(
        user_agent=HONEST_UA, robots=_ExplodingRobots(), rate_limiter=HostRateLimiter()
    )
    policy = _page_policy(robots_policy=RobotsPolicy.EXEMPT_DOCUMENTED_API)
    decision = gateway.check("http://api.example.com/jobs", policy, gateway.new_run_budget(5))
    assert decision.allowed is True


def test_gateway_user_agent_is_honest() -> None:
    gateway = PolitenessGateway(user_agent=HONEST_UA)
    assert gateway.user_agent == "JobHunter/test (+https://example.com/repo)"
    assert "Mozilla" not in gateway.user_agent


# ---------------------------------------------------------------------------
# Retry-After clamp at the sink (R10 P3b) — a hostile/absurd header must never
# freeze a host (and its pooled worker thread) for an attacker-chosen duration.
# ---------------------------------------------------------------------------


def test_note_retry_after_clamps_absurd_value_at_the_sink() -> None:
    clock = _VirtualClock()
    limiter = HostRateLimiter(clock=clock.now, sleep=clock.sleep, max_retry_after_seconds=300.0)

    effective = limiter.note_retry_after("host", 10**9)

    # The sink caps the deferral: a hostile header cannot push the host out beyond
    # the ceiling, no matter what value the server sent.
    assert effective == 300.0
    assert 0.0 < limiter.hard_rate_limit_remaining("host") <= 300.0
    # The next low-level slot for the host waits the clamped cooldown, never 1e9s.
    with limiter.slot("host", min_interval_seconds=0.0, max_concurrency=1):
        pass
    assert clock.now() == 300.0


def test_within_cap_retry_after_paces_but_is_not_a_hard_skip() -> None:
    clock = _VirtualClock()
    limiter = HostRateLimiter(clock=clock.now, sleep=clock.sleep, max_retry_after_seconds=300.0)

    limiter.note_retry_after("host", 30.0)

    # A within-cap Retry-After is honored by pacing, not flagged for skip.
    assert limiter.hard_rate_limit_remaining("host") == 0.0
    with limiter.slot("host", min_interval_seconds=0.0, max_concurrency=1):
        pass
    assert clock.now() >= 30.0


def test_hard_rate_limit_clears_after_the_clamped_cooldown() -> None:
    clock = _VirtualClock()
    limiter = HostRateLimiter(clock=clock.now, sleep=clock.sleep, max_retry_after_seconds=120.0)

    limiter.note_retry_after("host", 10**9)
    assert limiter.hard_rate_limit_remaining("host") > 0.0

    clock.t = 121.0  # past the clamped cooldown
    assert limiter.hard_rate_limit_remaining("host") == 0.0


def test_wait_for_turn_single_nap_never_exceeds_the_cap() -> None:
    clock = _VirtualClock()
    limiter = HostRateLimiter(clock=clock.now, sleep=clock.sleep, max_retry_after_seconds=60.0)

    # Defensive ceiling: even if a future writer set an unbounded deadline
    # directly (bypassing the sink clamp), no single nap exceeds the cap — the
    # loop re-checks between naps rather than sleeping the whole delta at once.
    slot = limiter._slot_for("host", 1)
    slot.retry_after_until = 1000.0

    with limiter.slot("host", min_interval_seconds=0.0, max_concurrency=1):
        pass

    assert clock.sleeps  # it waited
    assert max(clock.sleeps) <= 60.0
    assert clock.now() >= 1000.0  # the deadline is still honored, just in bounded naps


def test_guard_skips_hard_rate_limited_host_without_slot_or_budget() -> None:
    clock = _VirtualClock()
    limiter = HostRateLimiter(clock=clock.now, sleep=clock.sleep, max_retry_after_seconds=300.0)
    limiter.note_retry_after("host", 10**9)  # over-clamp => host is hard rate-limited
    gateway = PolitenessGateway(
        user_agent=HONEST_UA, robots=_AllowAllRobots(), rate_limiter=limiter
    )
    budget = gateway.new_run_budget(5)

    with gateway.guard("http://host/x", _page_policy(), budget) as decision:
        assert decision.allowed is False
        assert decision.outcome is PolitenessOutcome.RATE_LIMITED
        assert decision.retry_after_seconds and decision.retry_after_seconds > 0.0

    # A hard-limited host is recorded and skipped: no budget spent, no slot held,
    # no worker parked for the clamped cooldown.
    assert budget.consumed() == 0
    assert clock.now() == 0.0
    assert clock.sleeps == []
