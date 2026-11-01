"""Gateway-routed urllib HTTP client (R10 P2).

The single ``urllib`` transport for non-browser fetch surfaces. Every request is
wrapped in a :class:`PolitenessSession` guard so per-host rate limit
+ concurrency, the per-run request budget, and the selected request headers apply at
one choke point. A blocked decision returns ``None`` (the block is recorded as a
first-class outcome by the session, never raised as a scrape error). A server
``429``/``503`` is honored as a rate-limit outcome (``Retry-After`` fed back to
the limiter) rather than surfaced as a failure.
"""

from __future__ import annotations

import gzip
import json
import math
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from typing import Any, Mapping

from jobctrl.infrastructure.network.politeness import PolitenessSession
from jobctrl.infrastructure.network.proxy import parse_proxy
from jobctrl.infrastructure.network.public_http import (
    UnsafePublicDestinationError,
    build_public_http_opener,
)


def build_opener(proxy: str | None = None) -> urllib.request.OpenerDirector:
    """Build a urllib opener, optionally routed through a ``host:port[:user:pass]`` proxy.

    Centralizes proxy-opener construction in the network package so fetch
    surfaces (e.g. Workday) route through the gateway without importing raw
    ``urllib`` themselves.
    """
    if not proxy:
        return build_public_http_opener()
    config = parse_proxy(proxy)
    proxy_url = f"http://{config.jobspy}"
    handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    return build_public_http_opener(handler)


def parse_retry_after(value: str | None) -> float | None:
    """Parse a ``Retry-After`` header (delta-seconds or HTTP-date) to seconds."""
    if not value:
        return None
    value = value.strip()
    if value.isascii() and value.isdigit():
        seconds = float(value)
        return seconds if math.isfinite(seconds) else None
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


def record_rate_limited_response(
    session: PolitenessSession,
    url: str,
    status: int | None,
    headers: Mapping[str, str] | None = None,
) -> float | None:
    """Feed a server deferral into the shared host limiter on every transport.

    A missing or invalid Retry-After still needs a cooldown, rather than a
    rapid series of requests for different jobs on the throttled host. The
    limiter bounds long server delays; zero retains normal minimum pacing.
    """
    if status not in (429, 503):
        return None
    header = next((value for name, value in (headers or {}).items() if name.lower() == "retry-after"), None)
    retry_after = parse_retry_after(header)
    if retry_after is None:
        retry_after = 60.0
    session.note_retry_after(url, retry_after)
    session.record_server_rate_limit(url, retry_after)
    return retry_after


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
        self._opener = opener or build_public_http_opener()

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
            for key, value in decision.request_headers.items():
                request.add_header(key, value)
            request.add_header("User-Agent", decision.user_agent)
            for key, value in (extra_headers or {}).items():
                request.add_header(key, value)
            try:
                with self._opener.open(request, timeout=timeout or self._default_timeout) as response:
                    raw = response.read()
                    headers = getattr(response, "headers", None)
                    content_encoding = headers.get("Content-Encoding") if headers is not None else None
                    return gzip.decompress(raw) if str(content_encoding or "").casefold() == "gzip" else raw
            except UnsafePublicDestinationError:
                return None
            except urllib.error.HTTPError as exc:
                if record_rate_limited_response(self._session, url, exc.code, exc.headers) is not None:
                    return None
                raise
