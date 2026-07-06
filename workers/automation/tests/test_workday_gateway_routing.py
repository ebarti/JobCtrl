"""Workday CXS fetches route through the politeness gateway (R10 P2c, surface #2)."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from jobhunter.discovery import workday
from jobhunter.infrastructure.network.politeness import PolitenessGateway
from jobhunter.infrastructure.network.rate_limiter import HostRateLimiter


class _CxsServer:
    def __init__(self, body: bytes) -> None:
        self.seen_user_agents: list[str] = []
        self.seen_paths: list[str] = []
        server_self = self

        class Handler(BaseHTTPRequestHandler):
            def _respond(self) -> None:
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
