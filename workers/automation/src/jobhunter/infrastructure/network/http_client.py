"""Gateway-routed urllib HTTP client (R10 P2).

The single ``urllib`` transport for non-browser fetch surfaces. Every request is
wrapped in a :class:`PolitenessSession` guard so robots.txt, per-host rate limit
+ concurrency, the per-run request budget, and the honest user-agent all apply at
one choke point. A blocked decision returns ``None`` (the block is recorded as a
first-class outcome by the session, never raised as a scrape error). A server
``429``/``503`` is honored as a rate-limit outcome (``Retry-After`` fed back to
the limiter) rather than surfaced as a failure.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from typing import Any, Mapping

from jobhunter.infrastructure.network.politeness import PolitenessSession
from jobhunter.infrastructure.network.proxy import parse_proxy


def build_opener(proxy: str | None = None) -> urllib.request.OpenerDirector:
    """Build a urllib opener, optionally routed through a ``host:port[:user:pass]`` proxy.

    Centralizes proxy-opener construction in the network package so fetch
    surfaces (e.g. Workday) route through the gateway without importing raw
    ``urllib`` themselves.
    """
    if not proxy:
        return urllib.request.build_opener()
    config = parse_proxy(proxy)
    proxy_url = f"http://{config.jobspy}"
    handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    return urllib.request.build_opener(handler)


def parse_retry_after(value: str | None) -> float | None:
    """Parse a ``Retry-After`` header (delta-seconds or HTTP-date) to seconds."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    delta = (when - datetime.now(timezone.utc)).total_seconds()
    return max(0.0, delta)


class GatewayHttpClient:
    """urllib JSON/text fetches routed through the politeness gateway.

    ``fetch_json`` matches the ``HttpFetcher`` callable the ATS adapters inject,
    so wiring it at the composition root replaces each adapter's ad-hoc urllib.
    """

    def __init__(
        self,
        session: PolitenessSession,
        *,
        default_timeout: float = 20.0,
        opener: urllib.request.OpenerDirector | None = None,
    ) -> None:
        self._session = session
        self._default_timeout = default_timeout
        self._opener = opener or urllib.request.build_opener()

    def fetch_json(
        self,
        url: str,
        *,
        method: str = "GET",
        json_body: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        raw = self._request(
            url,
            method=method,
            json_body=json_body,
            timeout=timeout,
            accept="application/json",
        )
        return None if raw is None else json.loads(raw.decode("utf-8"))

    def fetch_text(
        self,
        url: str,
        *,
        timeout: float | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> str | None:
        raw = self._request(
            url,
            method="GET",
            json_body=None,
            timeout=timeout,
            accept="application/json, text/csv;q=0.9, */*;q=0.8",
            extra_headers=extra_headers,
        )
        return None if raw is None else raw.decode("utf-8")

    def _request(
        self,
        url: str,
        *,
        method: str,
        json_body: dict[str, Any] | None,
        timeout: float | None,
        accept: str,
        extra_headers: Mapping[str, str] | None = None,
    ) -> bytes | None:
        with self._session.guard(url) as decision:
            if not decision.allowed:
                return None
            data = json.dumps(json_body).encode("utf-8") if json_body is not None else None
            request = urllib.request.Request(url, data=data, method=method)
            request.add_header("Accept", accept)
            if json_body is not None:
                request.add_header("Content-Type", "application/json")
            request.add_header("User-Agent", decision.user_agent)
            for key, value in (extra_headers or {}).items():
                request.add_header(key, value)
            try:
                with self._opener.open(request, timeout=timeout or self._default_timeout) as response:
                    return response.read()
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 503):
                    retry_after = parse_retry_after(
                        exc.headers.get("Retry-After") if exc.headers else None
                    )
                    if retry_after:
                        self._session.note_retry_after(url, retry_after)
                    self._session.record_server_rate_limit(url, retry_after)
                    return None
                raise
