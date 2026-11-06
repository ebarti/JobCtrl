"""Loopback peer/host, browser origin and local capability admission."""

from __future__ import annotations

import hmac
import ipaddress
import os
import secrets
import stat
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

from jobctrl.app.errors import AppError

MAX_REQUEST_BYTES = 20 * 1024 * 1024
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
EXTENSION_PREFIXES = ("/v1/extension/", "/v1/discovery/browser-extension/")


def is_loopback(value: str) -> bool:
    if value.lower() == "localhost":
        return True
    try:
        address = ipaddress.ip_address(value)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return address.is_loopback
    except ValueError:
        return False


class CapabilityToken:
    def __init__(self, workspace: Path):
        self.path = workspace / "extension-capability-token"

    def read_or_create(self) -> str:
        try:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "w") as stream:
                stream.write(secrets.token_hex(32))
                stream.flush()
                os.fsync(stream.fileno())
        return self._read()

    def _read(self) -> str:
        info = self.path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (os.name != "nt" and info.st_mode & 0o077):
            raise AppError("unsafe_capability_token", "The local capability file must be private.", 503)
        value = self.path.read_text().strip()
        if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
            raise AppError("invalid_capability_token", "The local capability file is invalid.", 503)
        return value

    def rotate(self) -> str:
        # Check the accepted file before publishing an owned private replacement.
        self.read_or_create()
        temporary = self.path.with_name(f".{self.path.name}-{uuid.uuid4().hex}")
        value = secrets.token_hex(32)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(value)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)
        return value

    def verify(self, authorization: str | None) -> bool:
        if not authorization or not authorization.startswith("Bearer "):
            return False
        try:
            return hmac.compare_digest(authorization[7:], self._read())
        except (OSError, AppError):
            return False


class LocalSecurity:
    def __init__(self, app, *, workspace: Path, port: int, database_instance_id: str | None = None):
        self.app = app
        self.database_instance_id = database_instance_id
        self.token = CapabilityToken(workspace)
        self.token.read_or_create()
        self.ports = {5173, 5174, port}
        for key in ("JOBCTRL_WEB_PORT", "JOBCTRL_E2E_WEB_PORT"):
            value = os.environ.get(key, "")
            if value.isdecimal() and 1 <= int(value) <= 65535:
                self.ports.add(int(value))

    def trusted_origin(self, value: str, *, referer=False) -> bool:
        try:
            url = urlsplit(value)
            return bool(url.scheme in {"http", "https"} and url.hostname and is_loopback(url.hostname)
                        and not url.username and not url.password and (referer or url.path in {"", "/"})
                        and not url.fragment and (referer or not url.query)
                        and (url.port or (443 if url.scheme == "https" else 80)) in self.ports)
        except ValueError:
            return False

    @staticmethod
    def extension_origin(value: str) -> bool:
        try:
            url = urlsplit(value)
        except ValueError:
            return False
        return (url.scheme == "chrome-extension" and len(url.netloc) == 32
                and all(character in "abcdefghijklmnop" for character in url.netloc)
                and url.path in {"", "/"} and not url.query and not url.fragment)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers: dict[str, list[str]] = {}
        for key, value in scope["headers"]:
            headers.setdefault(key.decode("latin1").lower(), []).append(value.decode("latin1"))
        def one(key):
            return headers.get(key, [""])[0]
        request_id = uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        head_request = scope["method"] == "HEAD"
        scope["state"]["original_method"] = scope["method"]
        error = None
        try:
            host = urlsplit("//" + one("host"))
            valid_host = len(headers.get("host", [])) == 1 and bool(host.hostname and is_loopback(host.hostname))
            valid_host = (valid_host and host.path == "" and not host.username and not host.password
                          and not host.query and not host.fragment and (host.port is None or 1 <= host.port <= 65535))
        except ValueError:
            valid_host = False
        if not valid_host:
            error = AppError("forbidden_host", "Requests must target a loopback host.", 403)
        elif not scope.get("client") or not is_loopback(scope["client"][0]):
            error = AppError("forbidden_remote_client", "Requests must originate from a loopback address.", 403)
        origin, referer = one("origin"), one("referer")
        extension = self.extension_origin(origin) if origin else False
        extension_path = scope["path"].startswith(EXTENSION_PREFIXES)
        pairing = scope["path"] in {"/v1/extension/pairing-token", "/v1/extension/pairing-token/rotate"}
        token_ok = len(headers.get("authorization", [])) == 1 and self.token.verify(one("authorization"))
        metadata = bool(origin or referer or one("sec-fetch-site"))
        local_token = token_ok and (not metadata or (extension and extension_path and not pairing))
        source_ok = bool(origin or referer) and all(
            self.trusted_origin(item, referer=key == "referer")
            for key in ("origin", "referer") for item in headers.get(key, [])
        )
        same_origin_read = (scope["method"] in {"GET", "HEAD"} and not origin and not referer
                            and one("sec-fetch-site") == "same-origin")
        first_party_status = (scope["path"] == "/v1/discovery/browser-extension/status"
                              and scope["method"] in {"GET", "HEAD"} and not extension
                              and (source_ok or same_origin_read)
                              and one("sec-fetch-site") in {"", "same-origin", "same-site", "none"})
        if scope["method"] in UNSAFE_METHODS and not local_token:
            if not source_ok or one("sec-fetch-site") not in {"", "same-origin", "same-site", "none"}:
                error = error or AppError("cross_site_request", "A first-party local origin or capability token is required.", 403)
        if extension and (not extension_path or pairing or not token_ok) and scope["method"] != "OPTIONS":
            error = error or AppError("invalid_extension_capability_token", "This extension request is not authorized.", 401)
        if extension_path and not pairing and not first_party_status and scope["method"] != "OPTIONS" and not token_ok:
            error = error or AppError("invalid_extension_capability_token", "A valid local capability token is required.", 401)
        if pairing and metadata and (not (source_ok or same_origin_read) or one("sec-fetch-site") not in {"same-origin", "same-site", "none"}):
            error = error or AppError("cross_site_request", "Pairing requires a first-party request.", 403)
        expected_instance = one("expected-database-instance-id")
        if "expected-database-instance-id" in headers:
            if (len(headers["expected-database-instance-id"]) != 1 or len(expected_instance) != 64
                    or any(character not in "0123456789abcdef" for character in expected_instance)):
                error = error or AppError("invalid_database_precondition", "Supply the saved database instance identity.", 400)
            elif not self.database_instance_id or not hmac.compare_digest(expected_instance, self.database_instance_id):
                error = error or AppError("workspace_changed", "This request belongs to a different database instance. Reload before continuing.", 409)
        if len(headers.get("content-length", [])) > 1:
            error = error or AppError("invalid_content_length", "The request length is invalid.", 400)
        content_length = one("content-length")
        if content_length and (not content_length.isdecimal() or len(content_length) > 8 or int(content_length) > MAX_REQUEST_BYTES):
            error = error or AppError("request_too_large", "The request exceeds the upload limit.", 413)
        cors = origin if self.trusted_origin(origin) or (extension and extension_path and not pairing) else None

        async def secure_send(message):
            if message["type"] == "http.response.start":
                response_headers = list(message.get("headers", []))
                response_headers.extend([
                    (b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"no-referrer"),
                    (b"x-frame-options", b"DENY"), (b"x-request-id", request_id.encode()),
                ])
                if scope["path"].startswith("/v1/"):
                    response_headers.append((b"cache-control", b"no-store"))
                if cors:
                    response_headers.extend([(b"access-control-allow-origin", cors.encode()), (b"vary", b"Origin")])
                message["headers"] = response_headers
            elif head_request and message["type"] == "http.response.body":
                message = {**message, "body": b""}
            await send(message)

        if error:
            return await JSONResponse(error.payload(), status_code=error.status_code)(scope, receive, secure_send)
        if scope["method"] == "OPTIONS":
            response = JSONResponse({}, headers={
                "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, expected-database-instance-id, last-event-id, x-jobctrl-extension-installation, x-jobctrl-extension-version",
                "Access-Control-Max-Age": "600",
            })
            return await response(scope, receive, secure_send)
        consumed = 0

        async def bounded_receive():
            nonlocal consumed
            message = await receive()
            if message["type"] == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > MAX_REQUEST_BYTES:
                    raise AppError("request_too_large", "The request exceeds the upload limit.", 413)
            return message

        # Starlette automatically registers HEAD beside GET. Mixed-method
        # adapters must never interpret that implicit safe request as their
        # write branch. Preserve wire HEAD semantics while invoking only GET.
        if head_request:
            scope = {**scope, "method": "GET"}
        return await self.app(scope, bounded_receive, secure_send)
