"""Workday CXS fetches route through the politeness gateway (R10 P2c, surface #2)."""

from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

from jobhunter.database import get_connection
from jobhunter.discovery import workday
from jobhunter.domain.discovery.source_registry import WORKDAY_API_POLICY
from jobhunter.infrastructure.network.politeness import PolitenessGateway
from jobhunter.infrastructure.network.rate_limiter import HostRateLimiter


class _CxsServer:
    def __init__(self, body: bytes) -> None:
        self.seen_user_agents: list[str] = []
        self.seen_paths: list[str] = []
        self.seen_times: list[float] = []
        self._times_lock = threading.Lock()
        server_self = self

        class Handler(BaseHTTPRequestHandler):
            def _respond(self) -> None:
                with server_self._times_lock:
                    server_self.seen_times.append(time.monotonic())
                server_self.seen_user_agents.append(self.headers.get("User-Agent", ""))
                server_self.seen_paths.append(self.path)
                length = int(self.headers.get("Content-Length", 0) or 0)
                if length:
                    self.rfile.read(length)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802 - stdlib name
                self._respond()

            def do_POST(self) -> None:  # noqa: N802 - stdlib name
                self._respond()

            def log_message(self, *_args: object) -> None:
                pass

        self._httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self._httpd.server_port}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def __enter__(self) -> "_CxsServer":
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=2)


def test_workday_search_routes_through_gateway_with_honest_ua() -> None:
    body = json.dumps({"total": 0, "jobPostings": []}).encode("utf-8")
    with _CxsServer(body) as server:
        workday.configure_workday_politeness(
            gateway=PolitenessGateway(rate_limiter=HostRateLimiter()),
            run_id="discovery:workday:test",
        )
        employer = {
            "name": "Acme",
            "base_url": server.base_url,
            "tenant": "acme",
            "site_id": "External",
            "_source_id": "workday:acme",
        }
        result = workday.workday_search(employer, "Platform Engineer", limit=20, offset=0)

    assert result == {"total": 0, "jobPostings": []}
    assert any("/wday/cxs/acme/External/jobs" in path for path in server.seen_paths)
    assert server.seen_user_agents
    assert all(ua.startswith("JobHunter/") for ua in server.seen_user_agents)
    assert all("Mozilla" not in ua for ua in server.seen_user_agents)


def test_workday_search_returns_empty_dict_when_gateway_blocks() -> None:
    # When the gateway blocks a fetch (here: an exhausted per-run budget), the
    # search returns {} gracefully rather than raising. A budget of 1 is forced
    # via a source policy override so no real network round-trips are needed.
    from jobhunter.domain.discovery.source_registry import RobotsPolicy, SourcePolicy, SourcePolicyMethod
    from jobhunter.domain.ports.politeness import RobotsPort, RobotsVerdict
    from jobhunter.infrastructure.network.politeness import (
        PolitenessSession,
        PolitenessSourceContext,
    )
    from jobhunter.infrastructure.network.http_client import GatewayHttpClient

    class _AllowAll(RobotsPort):
        def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:
            return RobotsVerdict.ALLOW

    gateway = PolitenessGateway(robots=_AllowAll(), rate_limiter=HostRateLimiter())
    policy = SourcePolicy(
        policy_id="workday-budget-1",
        allowed_methods=(SourcePolicyMethod.API,),
        robots_policy=RobotsPolicy.EXEMPT_DOCUMENTED_API,
        min_request_interval_seconds=0.0,
        max_requests_per_run=1,
    )

    class _StubOpener:
        def open(self, request: object, timeout: float | None = None):
            raise AssertionError("budget-exhausted fetch must not hit the network")

    session = PolitenessSession(
        gateway,
        policy=policy,
        budget=gateway.new_run_budget(1),
        context=PolitenessSourceContext(stage="discover", source_id="workday:acme"),
    )
    session.budget.try_consume(1)  # exhaust the single-unit budget
    client = GatewayHttpClient(session, opener=_StubOpener())
    assert client.fetch_json("http://host/wday/cxs/acme/External/jobs") is None


# ---------------------------------------------------------------------------
# Concurrency: the load-bearing claims (per-host limiter keying + thread-local
# recorder capture) are threaded, so pin them under a real ThreadPoolExecutor.
# ---------------------------------------------------------------------------


def test_parallel_employers_pace_per_host_and_run_concurrently() -> None:
    body = json.dumps({"total": 0, "jobPostings": []}).encode("utf-8")
    with _CxsServer(body) as server_a, _CxsServer(body) as server_b:
        workday.configure_workday_politeness(
            gateway=PolitenessGateway(rate_limiter=HostRateLimiter()),
            run_id="discovery:workday:p5a-pacing",
        )
        employers = {
            "acme": {
                "name": "Acme",
                "base_url": server_a.base_url,
                "tenant": "acme",
                "site_id": "External",
                "_source_id": "workday:acme",
                "employer_key": "acme",
            },
            "beta": {
                "name": "Beta",
                "base_url": server_b.base_url,
                "tenant": "beta",
                "site_id": "External",
                "_source_id": "workday:beta",
                "employer_key": "beta",
            },
        }

        def hit(employer: dict) -> None:
            # Two same-host requests so per-host spacing is observable.
            for _ in range(2):
                workday.workday_search(employer, "Engineer", limit=20, offset=0)

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(hit, emp) for emp in employers.values()]
            for future in futures:
                future.result()  # surface any check_same_thread / other error

    interval = WORKDAY_API_POLICY.min_request_interval_seconds
    # (a) Per-host pacing holds under concurrency: same-host starts spaced by the
    #     min interval.
    for server in (server_a, server_b):
        assert len(server.seen_times) == 2
        assert server.seen_times[1] - server.seen_times[0] >= interval * 0.9
    # (b) Different hosts proceed in parallel: their request windows overlap
    #     rather than serializing one host fully before the other (which a shared
    #     single-bucket limiter would do).
    assert min(server_b.seen_times) < max(server_a.seen_times)
    assert min(server_a.seen_times) < max(server_b.seen_times)


def test_parallel_blocked_outcomes_record_on_owning_thread_under_source_id() -> None:
    # Two employers that resolve to the SAME source_id but distinct employer_keys
    # on distinct hosts. Both hosts are hard rate-limited, so each worker records
    # a rate-limited outcome via ITS OWN thread-local connection. Keying the
    # client cache by employer_key (not source_id) is what keeps the second
    # thread from reusing the first thread's connection (a check_same_thread
    # ProgrammingError) -- so future.result() not raising is the assertion.
    run_id = "discovery:workday:p5a-blocked"
    shared_source_id = "workday:shared-tenant"
    limiter = HostRateLimiter()
    gateway = PolitenessGateway(rate_limiter=limiter)
    workday.configure_workday_politeness(gateway=gateway, run_id=run_id)

    employers = {
        "unit-a": {
            "name": "Unit A",
            "base_url": "http://unit-a.invalid",
            "tenant": "a",
            "site_id": "External",
            "_source_id": shared_source_id,
            "employer_key": "unit-a",
        },
        "unit-b": {
            "name": "Unit B",
            "base_url": "http://unit-b.invalid",
            "tenant": "b",
            "site_id": "External",
            "_source_id": shared_source_id,
            "employer_key": "unit-b",
        },
    }
    for emp in employers.values():
        # Over-clamp Retry-After => host is hard rate-limited => guard skips the
        # fetch (never touches the .invalid host) and records the outcome.
        limiter.note_retry_after(urlsplit(emp["base_url"]).netloc, 10**9)

    def hit(employer: dict) -> dict:
        result = workday.workday_search(employer, "Engineer", limit=20, offset=0)
        get_connection().commit()  # persist this thread's recorded outcome
        return result

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [f.result() for f in [pool.submit(hit, emp) for emp in employers.values()]]

    assert results == [{}, {}]  # both blocked, returned gracefully
    rows = get_connection().execute(
        """
        SELECT COUNT(*) AS c FROM operational_attempt_metrics
        WHERE run_id = ? AND source_id = ? AND failure_category = 'rate_limited'
          AND is_scrape_failure = 0
        """,
        (run_id, shared_source_id),
    ).fetchone()
    assert rows["c"] == 2  # one per worker thread, both under the shared source_id
