"""First-party Gmail HTTP adapter; approval and durable intent belong to Applications.

Provider responses and OAuth credentials never escape this adapter. Sending has
one transport attempt: a timeout, invalid acknowledgement or lost connection is
an unknown external outcome for the caller's existing durable intent.
"""

from __future__ import annotations

import asyncio
import base64
from datetime import datetime
from email.message import EmailMessage
from email.utils import getaddresses
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import math
import os
from pathlib import Path
import secrets
import stat
import threading
import time
from urllib.parse import parse_qs, quote, urlsplit
import webbrowser

import httpx

from jobctrl.app.errors import AppError
from jobctrl.app.synthetic import synthetic_boundary
from .mail_support import (
    GMAIL_READONLY_SCOPE,
    GMAIL_SEND_SCOPE,
    GmailAuthError,
    build_authorization_url,
    choose_redirect_uri,
    exchange_code,
    load_oauth_client,
    load_token,
    save_token,
)
from .mail_privacy import private_gmail_operation
from .mail_values import validate_recipient

API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me"
TOKEN_URL = "https://oauth2.googleapis.com/token"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_BODY_CHARACTERS = 12000
_HEADERS = ("From", "To", "Subject", "Date")
def _reject_constant(_value: str):
    raise ValueError("invalid_json_constant")


def _json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate_json_key")
        value[key] = item
    return value


def validate_send_confirmation(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        raise AppError("gmail_send_invalid_confirmation", "Gmail did not return a valid send receipt.", 502)
    message_id = value.get("id")
    if not isinstance(message_id, str) or not message_id.strip() or len(message_id) > 512:
        raise AppError("gmail_send_invalid_confirmation", "Gmail did not return a valid send receipt.", 502)
    receipt = {"id": message_id}
    if "threadId" in value:
        thread = value["threadId"]
        if not isinstance(thread, str) or not thread.strip() or len(thread) > 512:
            raise AppError("gmail_send_invalid_confirmation", "Gmail did not return a valid send receipt.", 502)
        receipt["threadId"] = thread
    return receipt


def _bounded_id(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 512 or any(ord(c) < 32 for c in value):
        raise AppError("gmail_provider_response_invalid", "Gmail returned an invalid message identity.", 502)
    return value


def _credential_paths(workspace: Path) -> tuple[Path, Path]:
    directory = Path(os.environ.get("JOBCTRL_GMAIL_DIR") or os.environ.get("GMAIL_MCP_DIR") or workspace / "gmail").expanduser()
    token = Path(os.environ.get("JOBCTRL_GMAIL_TOKEN_PATH") or os.environ.get("GMAIL_MCP_CREDENTIALS_PATH") or directory / "token.json").expanduser()
    oauth = Path(os.environ.get("JOBCTRL_GMAIL_OAUTH_CLIENT_PATH") or os.environ.get("GMAIL_MCP_OAUTH_KEYS_PATH") or directory / "oauth-client.json").expanduser()
    return token, oauth


def _synthetic_oauth_paths(workspace: Path, paths: tuple[Path, Path]) -> None:
    """A QA selector may never read or replace credentials outside its marker."""
    for path in paths:
        try:
            if not path.resolve().is_relative_to(workspace) or path.resolve() == workspace:
                raise ValueError
            if path.exists() or path.is_symlink():
                metadata = path.lstat()
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                    raise ValueError
        except (OSError, ValueError):
            raise AppError("synthetic_boundary_unowned", "Synthetic OAuth credentials must belong to its owned workspace.", 503) from None


def _synthetic_exchange(workspace, root, oauth, redirect, code) -> dict:
    boundary = synthetic_boundary(workspace, root)
    if boundary is None:
        raise AppError("synthetic_boundary_unowned", "Synthetic OAuth requires an owned workspace.", 503)
    try:
        with private_gmail_operation("gmail.authorization"):
            with httpx.Client(timeout=20, trust_env=False, follow_redirects=False) as client:
                with client.stream("POST", root.rstrip("/") + "/token",
                    headers={"Authorization": "Bearer " + boundary["token"]}, data={
                        "client_id": oauth.client_id, "client_secret": oauth.client_secret,
                        "code": code, "grant_type": "authorization_code", "redirect_uri": redirect,
                    }) as response:
                    if response.status_code != 200:
                        raise ValueError
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        content.extend(chunk)
                        if len(content) > MAX_RESPONSE_BYTES:
                            raise ValueError
        token = json.loads(content, parse_constant=_reject_constant, object_pairs_hook=_json_object)
        expires = token.get("expires_in") if isinstance(token, dict) else None
        if (not isinstance(token, dict) or not isinstance(token.get("access_token"), str) or not token["access_token"].strip()
                or type(expires) not in {int, float} or not math.isfinite(expires) or expires <= 0):
            raise ValueError
        token["expires_at"] = int(time.time() + expires)
        return token
    except (httpx.HTTPError, ValueError, TypeError, UnicodeError):
        raise GmailAuthError("synthetic_token_exchange_failed") from None


def authenticate_gmail(workspace: Path, *, open_browser: bool = True, timeout_seconds: int = 180) -> Path:
    """Explicit CLI OAuth setup using the retained, atomic first-party token store."""
    workspace = Path(workspace).expanduser().resolve(strict=True)
    oauth_root = os.environ.get("JOBCTRL_GMAIL_OAUTH_ROOT")
    boundary = synthetic_boundary(workspace, oauth_root)
    if oauth_root and boundary is None:
        raise AppError("synthetic_boundary_unowned", "An OAuth override requires an owned synthetic workspace.", 503)
    if (boundary is not None and not oauth_root) or (boundary is None and os.environ.get("JOBCTRL_GMAIL_API_ROOT")):
        raise AppError("gmail_auth_requires_live_boundary", "Gmail authorization is unavailable in a synthetic workspace.", 409)
    if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 600:
        raise AppError("invalid_auth_timeout", "Gmail authorization requires a bounded timeout.")
    token_path, oauth_path = _credential_paths(workspace)
    if boundary is not None:
        _synthetic_oauth_paths(workspace, (token_path, oauth_path))
    try:
        oauth = load_oauth_client(oauth_path)
        state, result, done = secrets.token_urlsafe(32), {}, threading.Event()
        redirect = choose_redirect_uri(oauth, port=None)
        parsed = urlsplit(redirect)
        host = parsed.hostname
        if host not in {"localhost", "127.0.0.1"}:
            raise GmailAuthError("invalid_callback_host")
        port = 0 if oauth.kind == "installed" else parsed.port
        path = parsed.path or "/oauth2callback"

        class Callback(BaseHTTPRequestHandler):
            def log_message(self, _format, *_args):
                pass

            def do_GET(self):  # noqa: N802 - stdlib HTTP callback
                request = urlsplit(self.path)
                query = parse_qs(request.query)
                if request.path != path:
                    self.send_error(404)
                    return
                supplied = query.get("state", [""])
                if len(supplied) != 1 or not hmac.compare_digest(supplied[0], state):
                    self.send_error(400)
                    return
                codes = query.get("code", [])
                if query.get("error") or len(codes) != 1 or not codes[0]:
                    result["error"] = True
                else:
                    result["code"] = codes[0]
                self.send_response(400 if result.get("error") else 200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(b"Return to JobCtrl to finish Gmail authorization.")
                done.set()

        server = ThreadingHTTPServer(("127.0.0.1", port), Callback)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            redirect = choose_redirect_uri(oauth, port=server.server_address[1]) if oauth.kind == "installed" else redirect
            url = build_authorization_url(oauth, redirect, state)
            if boundary is not None:
                synthetic_boundary(workspace, oauth_root)
                url = oauth_root.rstrip("/") + "/authorize?" + urlsplit(url).query
            print("Open this URL to authorize Gmail connector access:\n" + url, flush=True)
            if open_browser:
                webbrowser.open(url)
            if not done.wait(timeout_seconds) or result.get("error") or "code" not in result:
                raise GmailAuthError("authorization_not_completed")
            with private_gmail_operation("gmail.authorization"):
                token = (_synthetic_exchange(workspace, oauth_root, oauth, redirect, result["code"])
                         if boundary is not None else exchange_code(oauth, redirect, result["code"]))
            if (not isinstance(token.get("refresh_token"), str) or not token["refresh_token"].strip()
                    or not {GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE}.issubset(str(token.get("scope", "")).split())):
                raise GmailAuthError("authorization_scopes_incomplete")
            if boundary is not None:
                synthetic_boundary(workspace, oauth_root)
                _synthetic_oauth_paths(workspace, (token_path, oauth_path))
            save_token(token, token_path)
            return token_path
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
    except (GmailAuthError, OSError, ValueError, TypeError):
        raise AppError("gmail_auth_required", "Gmail authorization did not complete. Review the OAuth configuration and retry.", 503) from None


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.chunks: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.hidden += 1
        elif tag in {"br", "p", "div", "li"} and not self.hidden:
            self.chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"} and self.hidden:
            self.hidden -= 1
        elif tag in {"p", "div", "li"} and not self.hidden:
            self.chunks.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.chunks.append(data)


def _body_text(payload: object) -> str:
    chunks: list[str] = []
    pending = [payload]
    count = 0
    while pending:
        part = pending.pop()
        count += 1
        if not isinstance(part, dict) or count > 300:
            raise AppError("gmail_provider_response_invalid", "Gmail returned an invalid message.", 502)
        children = part.get("parts", [])
        if not isinstance(children, list):
            raise AppError("gmail_provider_response_invalid", "Gmail returned an invalid message.", 502)
        pending.extend(reversed(children))
        body = part.get("body") or {}
        data = body.get("data") if isinstance(body, dict) else None
        mime = part.get("mimeType", "")
        if data and mime in {"text/plain", "text/html", ""}:
            if not isinstance(data, str):
                raise AppError("gmail_provider_response_invalid", "Gmail returned an invalid message.", 502)
            try:
                text = base64.b64decode(data + "=" * (-len(data) % 4), altchars=b"-_", validate=True).decode("utf-8", errors="replace")
            except (ValueError, UnicodeError):
                raise AppError("gmail_provider_response_invalid", "Gmail returned an invalid message.", 502) from None
            if mime == "text/html":
                parser = _Text()
                parser.feed(text)
                text = "".join(parser.chunks)
            chunks.append(text)
    return "\n\n".join(chunks)[:MAX_BODY_CHARACTERS]


class MailAdapter:
    def __init__(self, runtime):
        self.workspace = Path(runtime.workspace).resolve()
        override = os.environ.get("JOBCTRL_GMAIL_API_ROOT")
        self.synthetic = synthetic_boundary(self.workspace, override)
        if override and not self.synthetic:
            raise AppError("gmail_boundary_invalid", "Synthetic Gmail requires an owned loopback HTTP boundary.", 409)
        # An owned QA workspace without a configured Gmail server may use other
        # features, but cannot fall through to the live mailbox.
        self.api_root = override.rstrip("/") if override else None if self.synthetic else API_ROOT
        self.token_path, self.oauth_path = _credential_paths(self.workspace)
        self._token_lock = asyncio.Lock()

    async def _request(self, method: str, url: str, *, headers=None, params=None, json_body=None, data=None) -> dict:
        try:
            # Disabling environment proxies and redirects preserves the approved
            # fixed provider (or literal loopback) destination for credentials.
            with private_gmail_operation("gmail." + ("send" if method == "POST" else "read")):
                async with httpx.AsyncClient(timeout=httpx.Timeout(20), follow_redirects=False, trust_env=False) as client:
                    async with client.stream(method, url, headers=headers, params=params, json=json_body, data=data) as response:
                        if response.status_code in {401, 403}:
                            raise AppError("gmail_auth_required", "Reconnect Gmail before retrying.", 503)
                        if response.status_code == 429:
                            raise AppError("gmail_rate_limited", "Gmail rate limited this operation.", 503)
                        if not 200 <= response.status_code < 300:
                            raise AppError("gmail_provider_error", "Gmail could not complete this operation.", 503)
                        content = bytearray()
                        async for chunk in response.aiter_bytes():
                            content.extend(chunk)
                            if len(content) > MAX_RESPONSE_BYTES:
                                raise AppError("gmail_response_too_large", "Gmail returned more data than the bounded operation permits.", 502)
            result = json.loads(content, parse_constant=_reject_constant, object_pairs_hook=_json_object)
            if not isinstance(result, dict):
                raise ValueError
            return result
        except AppError:
            raise
        except httpx.TimeoutException:
            raise AppError("gmail_timeout", "Gmail did not acknowledge this operation in time.", 503) from None
        except httpx.HTTPError:
            raise AppError("gmail_transport_error", "The Gmail connection failed.", 503) from None
        except (ValueError, UnicodeError):
            raise AppError("gmail_provider_response_invalid", "Gmail returned an invalid response.", 502) from None

    async def _headers(self, scope: str) -> dict[str, str]:
        if self.synthetic:
            if not self.api_root:
                raise AppError("gmail_boundary_invalid", "The synthetic Gmail boundary is not configured.", 503)
            synthetic_boundary(self.workspace, self.api_root)
            return {"Authorization": "Bearer " + self.synthetic["token"]}
        async with self._token_lock:
            try:
                token = await asyncio.to_thread(load_token, self.token_path)
                if not isinstance(token, dict) or scope not in str(token.get("scope", "")).split():
                    raise GmailAuthError("scope_missing")
                if not token.get("access_token") or float(token.get("expires_at") or 0) <= time.time() + 15:
                    refresh = token.get("refresh_token")
                    if not isinstance(refresh, str) or not refresh:
                        raise GmailAuthError("refresh_missing")
                    oauth = await asyncio.to_thread(load_oauth_client, self.oauth_path)
                    replacement = await self._request("POST", TOKEN_URL, data={
                        "client_id": oauth.client_id, "client_secret": oauth.client_secret,
                        "refresh_token": refresh, "grant_type": "refresh_token",
                    })
                    if not isinstance(replacement.get("access_token"), str) or not replacement["access_token"]:
                        raise GmailAuthError("refresh_invalid")
                    expires = replacement.get("expires_in")
                    if type(expires) not in {int, float} or not math.isfinite(expires) or expires <= 0:
                        raise GmailAuthError("refresh_invalid")
                    token = {**token, **replacement, "refresh_token": refresh, "expires_at": int(time.time() + expires)}
                    if scope not in str(token.get("scope", "")).split():
                        raise GmailAuthError("scope_missing")
                    await asyncio.to_thread(save_token, token, self.token_path)
                return {"Authorization": "Bearer " + token["access_token"]}
            except (GmailAuthError, OSError, ValueError, TypeError):
                raise AppError("gmail_auth_required", "Reconnect Gmail before retrying.", 503) from None

    @staticmethod
    def validate_payload(*, recipient: str, subject: str, body: str, attachment_bytes: bytes, attachment_name: str) -> None:
        """Pure transport admission, shared before final intent and before send."""
        validate_recipient(recipient)
        if (not isinstance(subject, str) or not subject or len(subject) > 998
                or any(c in subject for c in "\r\n\x00") or not isinstance(body, str) or len(body) > 32000
                or not isinstance(attachment_bytes, bytes) or not attachment_bytes
                or len(attachment_bytes) > 20 * 1024 * 1024
                or not isinstance(attachment_name, str) or not attachment_name
                or len(attachment_name) > 240 or any(c in attachment_name for c in "/\\\r\n\x00")):
            raise AppError("gmail_send_invalid_payload", "The approved email payload is invalid.", 409)

    async def send(self, *, recipient: str, subject: str, body: str, attachment_bytes: bytes, attachment_name: str) -> dict[str, str]:
        self.validate_payload(recipient=recipient, subject=subject, body=body,
                              attachment_bytes=attachment_bytes, attachment_name=attachment_name)
        recipient = validate_recipient(recipient)
        headers = await self._headers(GMAIL_SEND_SCOPE)
        message = EmailMessage()
        message["To"], message["Subject"] = recipient, subject
        message.set_content(body)
        message.add_attachment(attachment_bytes, maintype="application", subtype="pdf", filename=attachment_name)
        raw = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii").rstrip("=")
        # Deliberately one POST. The durable intent owner handles every failure
        # as possibly sent; this adapter never refreshes/retries a failed send.
        result = await self._request("POST", self.api_root + "/messages/send", headers=headers, json_body={"raw": raw})
        return validate_send_confirmation(result)

    async def _message(self, message_id: str, *, full: bool) -> dict:
        message_id = _bounded_id(message_id)
        params = {"format": "full" if full else "metadata"}
        if not full:
            params["metadataHeaders"] = list(_HEADERS)
        auth_headers = await self._headers(GMAIL_READONLY_SCOPE)
        result = await self._request("GET", self.api_root + "/messages/" + quote(message_id, safe=""),
                                     headers=auth_headers, params=params)
        if _bounded_id(result.get("id")) != message_id:
            raise AppError("message_identity_changed", "Gmail returned a different message identity.", 409)
        payload = result.get("payload")
        if not isinstance(payload, dict) or not isinstance(payload.get("headers", []), list):
            raise AppError("gmail_provider_response_invalid", "Gmail returned invalid message headers.", 502)
        headers = {}
        for header in payload.get("headers", []):
            if not isinstance(header, dict) or not isinstance(header.get("name"), str) or not isinstance(header.get("value"), str):
                raise AppError("gmail_provider_response_invalid", "Gmail returned invalid message headers.", 502)
            name = header["name"].lower()
            if name in {"from", "to", "subject", "date"}:
                if name in headers:
                    raise AppError("gmail_provider_response_invalid", "Gmail returned duplicate message headers.", 502)
                headers[name] = header["value"][:8000]
        thread = result.get("threadId", "")
        if not isinstance(thread, str):
            raise AppError("gmail_provider_response_invalid", "Gmail returned an invalid thread identity.", 502)
        metadata = {"id": message_id, "threadId": thread, **{key: headers.get(key, "") for key in ("from", "to", "subject", "date")},
                    "internalDate": str(result.get("internalDate", "")), "snippet": ""}
        if full:
            snippet = result.get("snippet", "")
            if not isinstance(snippet, str):
                raise AppError("gmail_provider_response_invalid", "Gmail returned an invalid message.", 502)
            metadata.update(snippet=snippet[:4000], body_text=_body_text(payload))
        return metadata

    async def read_email(self, *, message_id: str) -> dict:
        return await self._message(message_id, full=True)

    async def search_feedback_emails(self, *, to_email: str, after: datetime, before: datetime, max_results: int) -> list[dict]:
        recipient = validate_recipient(to_email)
        if (not isinstance(after, datetime) or not isinstance(before, datetime) or after.utcoffset() is None
                or before.utcoffset() is None or after > before or type(max_results) is not int or not 1 <= max_results <= 20):
            raise AppError("invalid_search", "Supply a bounded Gmail search window and result count.")
        query = f'to:"{recipient}" after:{math.floor(after.timestamp()) - 1} before:{math.ceil(before.timestamp()) + 1}'
        auth_headers = await self._headers(GMAIL_READONLY_SCOPE)
        result = await self._request("GET", self.api_root + "/messages", headers=auth_headers,
                                     params={"q": query, "maxResults": max_results})
        items = result.get("messages", [])
        if not isinstance(items, list) or len(items) > max_results:
            raise AppError("gmail_provider_response_invalid", "Gmail returned an invalid bounded search.", 502)
        output = []
        seen = set()
        for item in items:
            identity = _bounded_id(item.get("id") if isinstance(item, dict) else None)
            if identity in seen:
                continue
            seen.add(identity)
            metadata = await self._message(identity, full=False)
            try:
                received = int(metadata["internalDate"])
            except (ValueError, TypeError, OverflowError):
                raise AppError("gmail_provider_response_invalid", "Gmail returned an invalid message date.", 502) from None
            recipients = {address.lower() for _, address in getaddresses([metadata["to"]])}
            if recipient.lower() in recipients and math.ceil(after.timestamp() * 1000) <= received <= math.floor(before.timestamp() * 1000):
                output.append(metadata)
        return output
