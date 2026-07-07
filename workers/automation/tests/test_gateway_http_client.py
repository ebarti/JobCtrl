"""Tests for the gateway-routed urllib HTTP client (R10 P2)."""

from __future__ import annotations

import sqlite3
import urllib.error

from jobctl.domain.discovery.source_registry import (
    RobotsPolicy,
    SourcePolicy,
    SourcePolicyMethod,
)
from jobctl.domain.ports.politeness import (
    HonestUserAgent,
    RobotsPort,
    RobotsVerdict,
)
from jobctl.infrastructure.network.http_client import GatewayHttpClient, parse_retry_after
from jobctl.infrastructure.network.politeness import (
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
)
from jobctl.infrastructure.network.rate_limiter import HostRateLimiter
from jobctl.operational_metrics import ensure_operational_metric_tables

HONEST_UA = HonestUserAgent(product="JobCtl", version="test", contact_url="https://example.com/repo")


class _AllowAllRobots(RobotsPort):
    def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:
        return RobotsVerdict.ALLOW


class _DisallowRobots(RobotsPort):
    def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:
        return RobotsVerdict.DISALLOW


class _FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class _RecordingOpener:
    def __init__(self, body: bytes = b"{}", raise_exc: Exception | None = None) -> None:
        self.body = body
        self.raise_exc = raise_exc
        self.requests: list[object] = []

    def open(self, request: object, timeout: float | None = None) -> _FakeResponse:
        self.requests.append(request)
        if self.raise_exc is not None:
            raise self.raise_exc
        return _FakeResponse(self.body)


class _VirtualClock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += max(0.0, seconds)


def _policy(**overrides: object) -> SourcePolicy:
    base: dict[str, object] = {
        "policy_id": "client-test",
        "allowed_methods": (SourcePolicyMethod.API,),
        "robots_policy": RobotsPolicy.HONOR,
        "min_request_interval_seconds": 0.0,
        "max_concurrent_requests_per_host": 4,
        "max_requests_per_run": 100,
    }
    base.update(overrides)
    return SourcePolicy(**base)  # type: ignore[arg-type]


def _session(gateway: PolitenessGateway, *, policy: SourcePolicy, conn: sqlite3.Connection, budget_limit: int = 100):
    return PolitenessSession(
        gateway,
        policy=policy,
        budget=gateway.new_run_budget(budget_limit),
        context=PolitenessSourceContext(stage="discover", source_id="src", adapter="ats"),
        recorder_conn=conn,
    )


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_operational_metric_tables(conn)
    return conn


def test_allowed_fetch_returns_json_with_honest_user_agent() -> None:
    opener = _RecordingOpener(body=b'{"jobs": [1, 2]}')
    gateway = PolitenessGateway(user_agent=HONEST_UA, robots=_AllowAllRobots(), rate_limiter=HostRateLimiter())
    conn = _conn()
    client = GatewayHttpClient(_session(gateway, policy=_policy(), conn=conn), opener=opener)

    payload = client.fetch_json("http://api.example.com/jobs")
    assert payload == {"jobs": [1, 2]}
    request = opener.requests[0]
    assert request.get_header("User-agent") == "JobCtl/test (+https://example.com/repo)"
    assert "Mozilla" not in request.get_header("User-agent")


def test_robots_disallowed_returns_none_without_fetching_and_records() -> None:
    opener = _RecordingOpener()
    gateway = PolitenessGateway(user_agent=HONEST_UA, robots=_DisallowRobots(), rate_limiter=HostRateLimiter())
    conn = _conn()
    client = GatewayHttpClient(_session(gateway, policy=_policy(), conn=conn), opener=opener)

    assert client.fetch_json("http://host/jobs") is None
    assert opener.requests == []  # never fetched the disallowed URL
    row = conn.execute("SELECT * FROM operational_attempt_metrics WHERE outcome='blocked'").fetchone()
    assert row["failure_category"] == "robots_disallowed"
    assert row["is_scrape_failure"] == 0


def test_budget_exhaustion_returns_none_and_records() -> None:
    opener = _RecordingOpener(body=b"{}")
    gateway = PolitenessGateway(user_agent=HONEST_UA, robots=_AllowAllRobots(), rate_limiter=HostRateLimiter())
    conn = _conn()
    client = GatewayHttpClient(_session(gateway, policy=_policy(), conn=conn, budget_limit=1), opener=opener)

    assert client.fetch_json("http://host/a") == {}
    assert client.fetch_json("http://host/b") is None
    row = conn.execute(
        "SELECT * FROM operational_attempt_metrics WHERE failure_category='budget_exhausted'"
    ).fetchone()
    assert row is not None
    assert row["is_operational_failure"] == 0


def test_server_429_is_recorded_as_rate_limit_and_delays_next_request() -> None:
    clock = _VirtualClock()
    limiter = HostRateLimiter(clock=clock.now, sleep=clock.sleep)
    gateway = PolitenessGateway(user_agent=HONEST_UA, robots=_AllowAllRobots(), rate_limiter=limiter)
    conn = _conn()
    opener = _RecordingOpener(
        raise_exc=urllib.error.HTTPError(
            "http://host/jobs", 429, "Too Many Requests", {"Retry-After": "30"}, None  # type: ignore[arg-type]
        )
    )
    client = GatewayHttpClient(_session(gateway, policy=_policy(), conn=conn), opener=opener)

    assert client.fetch_json("http://host/jobs") is None
    row = conn.execute(
        "SELECT * FROM operational_attempt_metrics WHERE failure_category='rate_limited'"
    ).fetchone()
    assert row is not None
    assert row["is_scrape_failure"] == 0
    # Retry-After fed to the limiter: the next slot for the host waits ~30s.
    with limiter.slot("host", min_interval_seconds=0.0, max_concurrency=1):
        pass
    assert clock.now() >= 30.0


def test_absurd_retry_after_is_clamped_and_next_fetch_is_skipped() -> None:
    clock = _VirtualClock()
    limiter = HostRateLimiter(clock=clock.now, sleep=clock.sleep, max_retry_after_seconds=300.0)
    gateway = PolitenessGateway(user_agent=HONEST_UA, robots=_AllowAllRobots(), rate_limiter=limiter)
    conn = _conn()
    opener = _RecordingOpener(
        raise_exc=urllib.error.HTTPError(
            "http://host/jobs", 429, "Too Many Requests", {"Retry-After": "999999999"}, None  # type: ignore[arg-type]
        )
    )
    client = GatewayHttpClient(_session(gateway, policy=_policy(), conn=conn), opener=opener)

    # First fetch: the server issues a 429 with an absurd Retry-After.
    assert client.fetch_json("http://host/jobs") is None
    row = conn.execute(
        "SELECT * FROM operational_attempt_metrics WHERE failure_category='rate_limited'"
    ).fetchone()
    assert row is not None and row["is_scrape_failure"] == 0
    # Clamped at the sink: the host cooldown never reflects the absurd value.
    assert 0.0 < limiter.hard_rate_limit_remaining("host") <= 300.0

    # Second fetch to the same host is pre-empted by the gateway: recorded as a
    # rate-limit outcome and skipped, so it neither hits the opener nor parks the
    # thread on the (clamped) cooldown.
    assert client.fetch_json("http://host/jobs") is None
    assert len(opener.requests) == 1  # the skipped second fetch never reached urllib
    assert clock.now() <= 300.0
    count = conn.execute(
        "SELECT COUNT(*) AS c FROM operational_attempt_metrics WHERE failure_category='rate_limited'"
    ).fetchone()
    # Exactly two distinct fetches -> exactly two rows: the 429-ed request and
    # the pre-empted skip. The tight ``== 2`` bites if a future change ever
    # records a single request on both the server-429 and guard pre-empt paths.
    assert count["c"] == 2


def test_non_rate_limit_http_error_propagates() -> None:
    opener = _RecordingOpener(
        raise_exc=urllib.error.HTTPError("http://host/jobs", 500, "boom", {}, None)  # type: ignore[arg-type]
    )
    gateway = PolitenessGateway(user_agent=HONEST_UA, robots=_AllowAllRobots(), rate_limiter=HostRateLimiter())
    client = GatewayHttpClient(_session(gateway, policy=_policy(), conn=_conn()), opener=opener)
    try:
        client.fetch_json("http://host/jobs")
    except urllib.error.HTTPError as exc:
        assert exc.code == 500
    else:  # pragma: no cover
        raise AssertionError("expected the 500 to propagate")


def test_parse_retry_after_handles_seconds_and_dates_and_garbage() -> None:
    assert parse_retry_after("30") == 30.0
    assert parse_retry_after(None) is None
    assert parse_retry_after("not-a-date") is None
    # Far-future HTTP date yields a positive delay.
    assert (parse_retry_after("Wed, 21 Oct 2099 07:28:00 GMT") or 0) > 0
