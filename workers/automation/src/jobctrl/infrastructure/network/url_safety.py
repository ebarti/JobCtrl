"""Public-destination checks for browser/network fetches."""

from __future__ import annotations

import ipaddress
import socket
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from email.message import Message
from typing import Any, Callable
from urllib.parse import urlsplit


Resolver = Callable[..., list[tuple[Any, Any, Any, Any, tuple[Any, ...]]]]
RouteRequestFetcher = Callable[[str, str, Mapping[str, str]], "RouteFulfillment"]

_ROUTE_FETCH_TIMEOUT_SECONDS = 20
_ROUTE_FETCH_MAX_BYTES = 2_000_000
_UNSAFE_REQUEST_HEADERS = {
    "authorization",
    "cookie",
    "host",
    "proxy-authorization",
    "proxy-connection",
}
_IGNORABLE_BROWSER_LOCAL_SCHEMES = {"chrome-extension"}
_HOP_BY_HOP_RESPONSE_HEADERS = {
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


@dataclass(frozen=True)
class PublicUrlDecision:
    allowed: bool
    reason: str | None = None


@dataclass(frozen=True)
class RouteFulfillment:
    status: int
    headers: dict[str, str]
    body: bytes


def validate_public_http_url(url: str, *, resolver: Resolver | None = None) -> PublicUrlDecision:
    """Allow only public HTTP(S) URLs.

    Hostnames are resolved and every returned address must be globally routable.
    If resolution fails, fail closed: the browser would otherwise make the real
    routing decision later, outside this security control.
    """

    if not isinstance(url, str) or not url.strip():
        return PublicUrlDecision(False, "URL must be a non-empty string")

    try:
        parsed = urlsplit(url.strip())
        port = parsed.port
    except ValueError as exc:
        return PublicUrlDecision(False, f"URL is invalid: {exc}")

    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return PublicUrlDecision(False, "URL scheme must be http or https")

    if parsed.username is not None or parsed.password is not None:
        return PublicUrlDecision(False, "URL must not contain embedded credentials")

    hostname = parsed.hostname
    if not hostname:
        return PublicUrlDecision(False, "URL host is required")

    host = hostname.rstrip(".")
    if not host:
        return PublicUrlDecision(False, "URL host is required")

    literal = _ip_literal(host)
    if literal is not None:
        return _decision_for_ip(host, literal)

    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return PublicUrlDecision(False, "URL host is not a valid IDNA hostname")

    resolve = resolver or socket.getaddrinfo
    try:
        infos = resolve(ascii_host, port or (443 if scheme == "https" else 80), type=socket.SOCK_STREAM)
    except OSError as exc:
        return PublicUrlDecision(False, f"URL host could not be resolved: {exc}")

    addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for info in infos:
        try:
            raw_address = info[4][0]
        except (IndexError, TypeError):
            continue
        parsed_address = _ip_literal(str(raw_address))
        if parsed_address is not None and parsed_address not in addresses:
            addresses.append(parsed_address)

    if not addresses:
        return PublicUrlDecision(False, "URL host did not resolve to an IP address")

    for address in addresses:
        if not _is_public_address(address):
            return PublicUrlDecision(
                False,
                f"URL host resolves to a non-public address: {address}",
            )

    return PublicUrlDecision(True)


class PublicHttpUrlRouteGuard:
    """Abort or safely fulfill Playwright requests to public destinations."""

    def __init__(
        self,
        page: Any,
        *,
        resolver: Resolver | None = None,
        fetch_public_requests: bool = False,
        request_fetcher: RouteRequestFetcher | None = None,
    ) -> None:
        self._page = page
        self._resolver = resolver
        self._fetch_public_requests = fetch_public_requests
        self._request_fetcher = request_fetcher or _fetch_public_route_request
        self._handler: Callable[[Any, Any], None] | None = None
        self.blocked_url: str | None = None
        self.blocked_reason: str | None = None

    @property
    def blocked(self) -> bool:
        return self.blocked_reason is not None

    def install(self) -> "PublicHttpUrlRouteGuard":
        route = getattr(self._page, "route", None)
        if not callable(route):
            return self

        def handler(playwright_route: Any, request: Any) -> None:
            request_url = str(getattr(request, "url", ""))
            request_scheme = urlsplit(request_url).scheme.lower()
            if request_scheme in _IGNORABLE_BROWSER_LOCAL_SCHEMES:
                # Adopted Chrome profiles may start installed extensions while
                # the job page loads. Keep local extension resources blocked,
                # but do not misattribute that browser-owned noise to the
                # remote posting as a fatal unsafe redirect.
                playwright_route.abort("blockedbyclient")
                return
            decision = validate_public_http_url(request_url, resolver=self._resolver)
            if not decision.allowed:
                self.blocked_url = request_url
                self.blocked_reason = decision.reason or "URL is not a public HTTP(S) destination"
                playwright_route.abort("blockedbyclient")
                return
            if not self._fetch_public_requests:
                playwright_route.continue_()
                return
            method = str(getattr(request, "method", "GET") or "GET").upper()
            if method not in {"GET", "HEAD"}:
                # Public pages commonly emit analytics, telemetry, or API
                # writes while loading. We deliberately do not replay those
                # side-effecting requests through the pinned fetcher, but
                # aborting one must not poison an otherwise safe top-level
                # read. Non-public destinations above remain fatal and keep
                # the page-wide blocked marker.
                playwright_route.abort("blockedbyclient")
                return
            headers = getattr(request, "headers", {}) or {}
            try:
                fulfillment = self._request_fetcher(request_url, method, dict(headers))
            except Exception as exc:
                self.blocked_url = request_url
                self.blocked_reason = str(exc) or "Public route fetch failed"
                playwright_route.abort("blockedbyclient")
                return
            playwright_route.fulfill(
                status=fulfillment.status,
                headers=fulfillment.headers,
                body=b"" if method == "HEAD" else fulfillment.body,
            )

        self._handler = handler
        route("**/*", handler)
        return self

    def close(self) -> None:
        if self._handler is None:
            return
        unroute = getattr(self._page, "unroute", None)
        if callable(unroute):
            unroute("**/*", self._handler)
        self._handler = None


def _decision_for_ip(host: str, address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> PublicUrlDecision:
    if _is_public_address(address):
        return PublicUrlDecision(True)
    return PublicUrlDecision(False, f"URL host is not a public address: {host}")


def _ip_literal(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        pass
    # Browsers use WHATWG IPv4 parsing, which accepts legacy one-to-four-part
    # decimal, octal, and hexadecimal forms. ``inet_aton`` follows the same
    # numeric grammar on supported local platforms; canonicalize it before DNS
    # so strings such as ``0177.0.0.1`` cannot be resolved as a different host.
    try:
        return ipaddress.IPv4Address(socket.inet_aton(value))
    except (OSError, ValueError):
        return None


def _is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return bool(address.is_global)


def _fetch_public_route_request(
    url: str,
    method: str,
    headers: Mapping[str, str],
) -> RouteFulfillment:
    from jobctrl.infrastructure.network.public_http import build_public_http_opener

    opener = build_public_http_opener(follow_redirects=False)
    request = urllib.request.Request(
        url,
        method=method,
        headers=_safe_request_headers(headers),
    )
    try:
        with opener.open(request, timeout=_ROUTE_FETCH_TIMEOUT_SECONDS) as response:
            return RouteFulfillment(
                status=int(getattr(response, "status", 200)),
                headers=_response_headers(response.headers),
                body=_read_limited(response),
            )
    except urllib.error.HTTPError as exc:
        return RouteFulfillment(
            status=int(exc.code),
            headers=_response_headers(exc.headers),
            body=_read_limited(exc),
        )


def _safe_request_headers(headers: Mapping[str, str]) -> dict[str, str]:
    safe: dict[str, str] = {}
    for name, value in headers.items():
        normalized = str(name).lower()
        if normalized in _UNSAFE_REQUEST_HEADERS:
            continue
        if normalized == "accept-encoding":
            continue
        safe[str(name)] = str(value)
    safe.setdefault("Accept-Encoding", "identity")
    return safe


def _response_headers(headers: Message | Mapping[str, str]) -> dict[str, str]:
    response_headers: dict[str, str] = {}
    items = headers.items() if hasattr(headers, "items") else ()
    for name, value in items:
        normalized = str(name).lower()
        if normalized in _HOP_BY_HOP_RESPONSE_HEADERS:
            continue
        response_headers[str(name)] = str(value)
    return response_headers


def _read_limited(response: Any) -> bytes:
    body = response.read(_ROUTE_FETCH_MAX_BYTES + 1)
    if len(body) > _ROUTE_FETCH_MAX_BYTES:
        raise ValueError("Public route response exceeded the maximum allowed size")
    return bytes(body)
