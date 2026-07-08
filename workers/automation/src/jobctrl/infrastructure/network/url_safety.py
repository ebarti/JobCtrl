"""Public-destination checks for browser/network fetches."""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit


Resolver = Callable[..., list[tuple[Any, Any, Any, Any, tuple[Any, ...]]]]


@dataclass(frozen=True)
class PublicUrlDecision:
    allowed: bool
    reason: str | None = None


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
    """Abort Playwright requests that target non-public destinations."""

    def __init__(self, page: Any) -> None:
        self._page = page
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
            decision = validate_public_http_url(request_url)
            if decision.allowed:
                playwright_route.continue_()
                return
            self.blocked_url = request_url
            self.blocked_reason = decision.reason or "URL is not a public HTTP(S) destination"
            playwright_route.abort("blockedbyclient")

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
        return None


def _is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return bool(address.is_global)
