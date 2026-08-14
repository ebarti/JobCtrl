"""Regression tests for public-destination urllib helpers."""

from __future__ import annotations

import socket
import ssl
import urllib.request

import pytest

from jobctrl.infrastructure.network.public_http import (
    PublicDestinationHTTPSHandler,
    PublicDestinationRedirectHandler,
    UnsafePublicDestinationError,
    _verified_https_context,
    create_public_connection,
)


def _resolver_for(*addresses: str):
    def _resolve(_host: str, port: int, *_args: object, **_kwargs: object):
        infos = []
        for address in addresses:
            family = socket.AF_INET6 if ":" in address else socket.AF_INET
            sockaddr = (address, port, 0, 0) if family == socket.AF_INET6 else (address, port)
            infos.append((family, socket.SOCK_STREAM, 0, "", sockaddr))
        return infos

    return _resolve


class _RecordingSocket:
    def __init__(self) -> None:
        self.connected_to: tuple[object, ...] | None = None
        self.closed = False
        self.timeout: object = None

    def settimeout(self, timeout: object) -> None:
        self.timeout = timeout

    def bind(self, _source_address: tuple[str, int]) -> None:
        return None

    def connect(self, sockaddr: tuple[object, ...]) -> None:
        self.connected_to = sockaddr

    def close(self) -> None:
        self.closed = True


def test_public_connection_pins_socket_to_validated_numeric_address() -> None:
    sockets: list[_RecordingSocket] = []

    def socket_factory(_family: int, _socktype: int, _proto: int):
        sock = _RecordingSocket()
        sockets.append(sock)
        return sock

    sock = create_public_connection(
        ("jobs.example", 443),
        resolver=_resolver_for("93.184.216.34"),
        socket_factory=socket_factory,  # type: ignore[arg-type]
    )

    assert sock is sockets[0]
    assert sockets[0].connected_to == ("93.184.216.34", 443)


def test_public_connection_rejects_private_dns_answer_without_opening_socket() -> None:
    def socket_factory(_family: int, _socktype: int, _proto: int):
        raise AssertionError("private destination must be rejected before socket creation")

    with pytest.raises(UnsafePublicDestinationError, match="non-public"):
        create_public_connection(
            ("jobs.example", 443),
            resolver=_resolver_for("10.0.0.5"),
            socket_factory=socket_factory,  # type: ignore[arg-type]
        )


def test_public_https_context_keeps_verification_and_adds_bundled_roots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Context:
        check_hostname = True
        verify_mode = ssl.CERT_REQUIRED

        def __init__(self) -> None:
            self.loaded_cafile: str | None = None

        def load_verify_locations(self, *, cafile: str) -> None:
            self.loaded_cafile = cafile

    context = _Context()
    monkeypatch.setattr(ssl, "create_default_context", lambda: context)
    monkeypatch.setattr("jobctrl.infrastructure.network.public_http.certifi.where", lambda: "/bundled/cacert.pem")

    resolved = _verified_https_context()

    assert resolved is context
    assert context.check_hostname is True
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.loaded_cafile == "/bundled/cacert.pem"


def test_public_https_handler_forwards_verified_context_to_pinned_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = ssl.create_default_context()
    handler = PublicDestinationHTTPSHandler(
        resolver=_resolver_for("93.184.216.34"),
        context=context,
    )
    captured: dict[str, object] = {}

    def capture_do_open(connection_class, request, **kwargs):  # noqa: ANN001
        captured.update({"connection_class": connection_class, "request": request, **kwargs})
        return object()

    monkeypatch.setattr(handler, "do_open", capture_do_open)
    request = urllib.request.Request("https://jobs.example/feed")

    handler.https_open(request)

    assert captured["context"] is context
    assert context.check_hostname is True
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert captured["resolver"] is not None


def test_redirect_handler_blocks_private_redirect_target() -> None:
    handler = PublicDestinationRedirectHandler()
    request = urllib.request.Request("https://jobs.example/feed")

    with pytest.raises(UnsafePublicDestinationError, match="unsafe redirect"):
        handler.redirect_request(
            request,
            fp=None,
            code=302,
            msg="Found",
            headers={},
            newurl="http://127.0.0.1:8080/admin",
        )


def test_redirect_handler_strips_authorization_on_cross_origin_redirect() -> None:
    handler = PublicDestinationRedirectHandler(resolver=_resolver_for("93.184.216.34"))
    request = urllib.request.Request("https://jobs.example/feed")
    request.add_header("Authorization", "Bearer source-token")

    redirected = handler.redirect_request(
        request,
        fp=None,
        code=302,
        msg="Found",
        headers={},
        newurl="https://other.example/feed",
    )

    assert redirected is not None
    assert redirected.get_header("Authorization") is None


def test_redirect_handler_keeps_authorization_on_same_origin_redirect() -> None:
    handler = PublicDestinationRedirectHandler(resolver=_resolver_for("93.184.216.34"))
    request = urllib.request.Request("https://jobs.example/feed")
    request.add_header("Authorization", "Bearer source-token")

    redirected = handler.redirect_request(
        request,
        fp=None,
        code=302,
        msg="Found",
        headers={},
        newurl="https://jobs.example/feed?page=2",
    )

    assert redirected is not None
    assert redirected.get_header("Authorization") == "Bearer source-token"
