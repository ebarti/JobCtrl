"""Saved header selection through real urllib and an owned local HTTP server."""

from __future__ import annotations

import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

import pytest

from jobctrl import config
from jobctrl.domain.discovery.source_registry import ENRICHMENT_CRAWL_POLICY
from jobctrl.infrastructure.network.http_client import GatewayHttpClient
from jobctrl.infrastructure.network.politeness import (
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    resolve_honest_user_agent,
    resolve_request_headers,
)

from .politeness_helpers import no_sleep_limiter


@pytest.mark.parametrize("value", [None, False, "true", "false", 0, 1])
def test_only_explicit_true_enables_generated_headers(monkeypatch, value):
    identity = {"product": "SyntheticBot", "contact": "https://example.test/contact"}
    if value is not None:
        identity["use_browser_headers"] = value
    cfg = {"crawl_user_agent": identity}
    generate = Mock(side_effect=AssertionError("Off mode must not invoke ua-generator"))
    monkeypatch.setattr("jobctrl.infrastructure.network.politeness.ua_generator.generate", generate)
    assert resolve_request_headers(cfg) == {"User-Agent": resolve_honest_user_agent(cfg).header_value()}
    generate.assert_not_called()
    assert config.effective_discovery_search_config(cfg)["crawl_user_agent"]["use_browser_headers"] is False


def test_generation_failure_is_not_silently_replaced_with_legacy_identity(monkeypatch):
    generate = Mock(side_effect=RuntimeError("synthetic generator failure"))
    monkeypatch.setattr("jobctrl.infrastructure.network.politeness.ua_generator.generate", generate)
    with pytest.raises(RuntimeError, match="synthetic generator failure"):
        resolve_request_headers({"crawl_user_agent": {"use_browser_headers": True}})


def test_gateway_keeps_generated_identity_until_next_session(monkeypatch):
    cfg = {"crawl_user_agent": {"use_browser_headers": True}}
    monkeypatch.setattr(config, "load_saved_search_settings", lambda: cfg)
    gateway = PolitenessGateway(rate_limiter=no_sleep_limiter())
    headers = gateway.request_headers
    assert headers["User-Agent"].startswith("Mozilla/")
    assert "Chrome/" in headers["User-Agent"]
    assert headers["sec-ch-ua-mobile"] == "?0"
    assert "sec-ch-ua" in headers and "sec-ch-ua-platform" in headers
    cfg["crawl_user_agent"]["use_browser_headers"] = False
    assert gateway.request_headers == headers
    headers["User-Agent"] = "caller-mutated-copy"
    assert gateway.user_agent != "caller-mutated-copy"
    assert PolitenessGateway().request_headers == resolve_request_headers(cfg)


@pytest.mark.parametrize("enabled", [False, True])
def test_real_http_requests_use_selected_headers_and_keep_request_semantics(monkeypatch, enabled):
    cfg = {"crawl_user_agent": {"use_browser_headers": enabled, "product": "SyntheticBot", "contact": ""}}
    monkeypatch.setattr(config, "load_saved_search_settings", lambda: cfg)
    seen: list[dict[str, object]] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            seen.append({"headers": {k.lower(): v for k, v in self.headers.items()}, "method": self.command})
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"synthetic response")

        def do_POST(self):
            seen.append({
                "headers": {k.lower(): v for k, v in self.headers.items()}, "method": self.command,
                "body": json.loads(self.rfile.read(int(self.headers["Content-Length"]))),
            })
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok": true}')

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    gateway = PolitenessGateway(rate_limiter=no_sleep_limiter())
    session = PolitenessSession(
        gateway, policy=ENRICHMENT_CRAWL_POLICY, budget=gateway.new_run_budget(2),
        context=PolitenessSourceContext(stage="enrich"),
    )
    # The only injected transport is an opener permitting this owned loopback
    # endpoint. Production URL safety and redirect checks have separate coverage.
    client = GatewayHttpClient(session, opener=urllib.request.build_opener(urllib.request.ProxyHandler({})))
    url = f"http://127.0.0.1:{server.server_port}/synthetic"
    try:
        assert client.fetch_text(url, extra_headers={"Accept-Encoding": "gzip"}) == "synthetic response"
        assert client.fetch_json(url, method="POST", json_body={"synthetic": True}) == {"ok": True}
        assert client.fetch_text(url) is None  # Budget remains enforced in both modes.
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert len(seen) == 2
    expected = {key.lower(): value for key, value in gateway.request_headers.items()}
    for item in seen:
        headers = item["headers"]
        assert {key: headers[key] for key in expected} == expected
        assert "cookie" not in headers and "authorization" not in headers
        assert ("sec-ch-ua" in headers) is enabled
    assert seen[0]["headers"]["accept-encoding"] == "gzip"
    assert seen[0]["headers"]["accept"] == "application/json, text/csv;q=0.9, */*;q=0.8"
    assert seen[1]["headers"]["accept"] == "application/json"
    assert seen[1]["headers"]["content-type"] == "application/json"
    assert seen[1]["body"] == {"synthetic": True}
    if not enabled:
        assert expected == {"user-agent": resolve_honest_user_agent(cfg).header_value()}
