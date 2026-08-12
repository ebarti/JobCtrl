"""urllib helpers that pin HTTP(S) sockets to validated public destinations."""

from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import urllib.request
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import certifi

from jobctrl.infrastructure.network.url_safety import Resolver, validate_public_http_url

AddrInfo = tuple[int, int, int, str, tuple[Any, ...]]
SocketFactory = Callable[[int, int, int], socket.socket]


class UnsafePublicDestinationError(ValueError):
    """Raised when an HTTP request would connect to a non-public destination."""


def build_public_http_opener(
    *handlers: urllib.request.BaseHandler,
    resolver: Resolver | None = None,
    socket_factory: SocketFactory | None = None,
    follow_redirects: bool = True,
) -> urllib.request.OpenerDirector:
    """Build a urllib opener that validates and pins each direct connection.

    Validation happens in the connection helper immediately before the socket is
    opened, and the socket connects to the validated numeric address. That keeps
    urllib from doing a second hostname resolution after the public-destination
    decision. Redirects are revalidated before urllib follows them.
    """

    public_handlers: list[urllib.request.BaseHandler] = [
        PublicDestinationHTTPHandler(resolver=resolver, socket_factory=socket_factory),
        PublicDestinationHTTPSHandler(
            resolver=resolver,
            socket_factory=socket_factory,
            context=_verified_https_context(),
        ),
    ]
    if follow_redirects:
        public_handlers.append(PublicDestinationRedirectHandler(resolver=resolver))
    else:
        public_handlers.append(NoRedirectHandler())
    public_handlers.extend(handlers)
    return urllib.request.build_opener(*public_handlers)


def _verified_https_context() -> ssl.SSLContext:
    """Combine platform roots with JobCtrl's bundled Mozilla CA store."""

    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    return context


def create_public_connection(
    address: tuple[str, int],
    timeout: object = socket._GLOBAL_DEFAULT_TIMEOUT,
    source_address: tuple[str, int] | None = None,
    *,
    resolver: Resolver | None = None,
    socket_factory: SocketFactory | None = None,
) -> socket.socket:
    """Open a socket to a public address resolved from ``address``.

    Every address returned by DNS must be globally routable. The socket is then
    connected to one of those numeric addresses rather than to the hostname.
    """

    host, port = address
    addrinfos = resolve_public_addrinfos(host, port, resolver=resolver)
    make_socket = socket_factory or socket.socket
    last_error: OSError | None = None
    for family, socktype, proto, _canonname, sockaddr in addrinfos:
        sock = make_socket(family, socktype, proto)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)  # type: ignore[arg-type]
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            last_error = exc
            sock.close()
    if last_error is not None:
        raise last_error
    raise UnsafePublicDestinationError(f"{host}:{port} did not resolve to a public address")


def resolve_public_addrinfos(
    host: str,
    port: int,
    *,
    resolver: Resolver | None = None,
) -> tuple[AddrInfo, ...]:
    """Resolve ``host`` and return only validated public stream addrinfos."""

    hostname = _normalize_host(host)
    literal = _ip_literal(hostname)
    if literal is not None and not literal.is_global:
        raise UnsafePublicDestinationError(f"URL host is not a public address: {hostname}")

    try:
        ascii_host = hostname.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise UnsafePublicDestinationError("URL host is not a valid IDNA hostname") from exc

    resolve = resolver or socket.getaddrinfo
    try:
        raw_infos = resolve(ascii_host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise UnsafePublicDestinationError(f"URL host could not be resolved: {exc}") from exc

    addrinfos: list[AddrInfo] = []
    addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for info in raw_infos:
        if len(info) < 5:
            continue
        family, socktype, proto, canonname, sockaddr = info
        try:
            raw_address = sockaddr[0]
        except (IndexError, TypeError):
            continue
        parsed = _ip_literal(str(raw_address))
        if parsed is None:
            continue
        if parsed not in addresses:
            addresses.append(parsed)
        addrinfos.append((family, socktype, proto, canonname, sockaddr))

    if not addrinfos:
        raise UnsafePublicDestinationError("URL host did not resolve to an IP address")

    for address in addresses:
        if not address.is_global:
            raise UnsafePublicDestinationError(f"URL host resolves to a non-public address: {address}")

    return tuple(addrinfos)


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """urllib redirect handler that turns redirects into HTTPError responses."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ARG002
        return None


class PublicDestinationRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Validate redirect targets and avoid leaking sensitive headers cross-origin."""

    def __init__(self, *, resolver: Resolver | None = None) -> None:
        self._resolver = resolver
        super().__init__()

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        decision = validate_public_http_url(newurl, resolver=self._resolver)
        if not decision.allowed:
            reason = decision.reason or "URL is not a public HTTP(S) destination"
            raise UnsafePublicDestinationError(f"unsafe redirect target {newurl}: {reason}")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and _origin(req.full_url) != _origin(newurl):
            _remove_sensitive_redirect_headers(redirected)
        return redirected


class _PublicConnectionMixin:
    def _init_public_destination(
        self,
        *,
        resolver: Resolver | None,
        socket_factory: SocketFactory | None,
    ) -> None:
        self._public_resolver = resolver
        self._public_socket_factory = socket_factory
        self._create_connection = self._create_public_connection

    def _create_public_connection(
        self,
        address: tuple[str, int],
        timeout: object = socket._GLOBAL_DEFAULT_TIMEOUT,
        source_address: tuple[str, int] | None = None,
    ) -> socket.socket:
        return create_public_connection(
            address,
            timeout,
            source_address,
            resolver=self._public_resolver,
            socket_factory=self._public_socket_factory,
        )


class _PublicHTTPConnection(_PublicConnectionMixin, http.client.HTTPConnection):
    def __init__(
        self, *args: Any, resolver: Resolver | None = None, socket_factory: SocketFactory | None = None, **kwargs: Any
    ) -> None:
        super().__init__(*args, **kwargs)
        self._init_public_destination(resolver=resolver, socket_factory=socket_factory)


class _PublicHTTPSConnection(_PublicConnectionMixin, http.client.HTTPSConnection):
    def __init__(
        self, *args: Any, resolver: Resolver | None = None, socket_factory: SocketFactory | None = None, **kwargs: Any
    ) -> None:
        super().__init__(*args, **kwargs)
        self._init_public_destination(resolver=resolver, socket_factory=socket_factory)


class PublicDestinationHTTPHandler(urllib.request.HTTPHandler):
    def __init__(
        self,
        *,
        resolver: Resolver | None = None,
        socket_factory: SocketFactory | None = None,
    ) -> None:
        self._resolver = resolver
        self._socket_factory = socket_factory
        super().__init__()

    def http_open(self, req):  # noqa: ANN001
        return self.do_open(
            _PublicHTTPConnection,
            req,
            resolver=self._resolver,
            socket_factory=self._socket_factory,
        )


class PublicDestinationHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(
        self,
        *,
        resolver: Resolver | None = None,
        socket_factory: SocketFactory | None = None,
        context: ssl.SSLContext | None = None,
    ) -> None:
        self._resolver = resolver
        self._socket_factory = socket_factory
        super().__init__(context=context or _verified_https_context())

    def https_open(self, req):  # noqa: ANN001
        return self.do_open(
            _PublicHTTPSConnection,
            req,
            resolver=self._resolver,
            socket_factory=self._socket_factory,
            context=self._context,
        )


def _remove_sensitive_redirect_headers(request: urllib.request.Request) -> None:
    for header in ("Authorization", "Proxy-Authorization", "Cookie"):
        request.remove_header(header)


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").rstrip(".").lower()
    return (scheme, host, parsed.port or _default_port(scheme))


def _default_port(scheme: str) -> int | None:
    if scheme == "http":
        return 80
    if scheme == "https":
        return 443
    return None


def _normalize_host(host: str) -> str:
    normalized = host.strip().strip("[]").rstrip(".").lower()
    if not normalized:
        raise UnsafePublicDestinationError("URL host is required")
    return normalized


def _ip_literal(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


__all__ = [
    "NoRedirectHandler",
    "PublicDestinationHTTPHandler",
    "PublicDestinationHTTPSHandler",
    "PublicDestinationRedirectHandler",
    "UnsafePublicDestinationError",
    "build_public_http_opener",
    "create_public_connection",
    "resolve_public_addrinfos",
]
