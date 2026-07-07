"""Compensation feeds route through the politeness gateway (R10 P2b, surface #9)."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from jobctl.infrastructure.compensation.sqlite_market_repository import (
    COMPENSATION_FEED_POLICY,
    load_default_reported_compensation_observations,
    load_euro_top_tech_observations,
)


def test_compensation_feed_policy_is_robots_exempt() -> None:
    # Documented public API / licensed feed relies on its usage contract (D2).
    assert COMPENSATION_FEED_POLICY.robots_policy.value == "exempt_documented_api"


def test_euro_top_tech_stops_when_gateway_blocks() -> None:
    # A gateway-blocked page returns None; loaded rows are kept, no raise.
    calls = 0

    def blocked_after_first(url: str):
        nonlocal calls
        calls += 1
        if calls == 1:
            return {
                "rows": [
                    {
                        "country": "Spain",
                        "jobTitle": "Staff Software Engineer",
                        "company": "Airbnb",
                        "seniority": "Staff",
                        "preTaxTC": 242000,
                        "submittedMonth": "2026-06",
                    }
                ],
                "hasMore": True,
                "nextCursor": "cursor-2",
            }
        return None  # gateway blocked

    observations = load_euro_top_tech_observations(max_pages=5, http=blocked_after_first)
    assert calls == 2
    assert len(observations) == 1


class _FeedServer:
    def __init__(self, body: bytes) -> None:
        self.seen_user_agents: list[str] = []
        server_self = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - stdlib name
                server_self.seen_user_agents.append(self.headers.get("User-Agent", ""))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: object) -> None:
                pass

        self._httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self._httpd.server_port}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def __enter__(self) -> "_FeedServer":
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=2)


def test_licensed_feed_url_fetched_with_honest_user_agent() -> None:
    feed = json.dumps(
        {
            "observations": [
                {
                    "source_id": "levels_fyi",
                    "company": "Airbnb",
                    "role": "Staff Software Engineer",
                    "minimum_amount": 240000,
                    "maximum_amount": 240000,
                    "currency": "EUR",
                    "location": "Barcelona, Spain",
                }
            ]
        }
    ).encode("utf-8")
    with _FeedServer(feed) as server:
        env = {
            "JOBCTL_LEVELS_FYI_ACCESS_MODE": "licensed_data_feed",
            "JOBCTL_LEVELS_FYI_EUROPE_COVERAGE": "true",
            "JOBCTL_LEVELS_FYI_OBSERVATIONS_URL": f"{server.base_url}/levels.json",
        }
        load_default_reported_compensation_observations(
            include_eurotoptech=False,
            env=env,
        )
    # The licensed URL feed was fetched through the gateway with the honest UA.
    assert server.seen_user_agents, "licensed feed URL was never fetched"
    assert all(ua.startswith("JobCtl/") for ua in server.seen_user_agents)
    assert all("Mozilla" not in ua for ua in server.seen_user_agents)
