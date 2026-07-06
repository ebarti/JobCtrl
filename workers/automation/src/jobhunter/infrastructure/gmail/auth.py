"""OAuth helpers for the first-party Gmail connector."""

from __future__ import annotations

import json
import secrets
import threading
import time
import urllib.parse
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx

from jobhunter import config

GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
GMAIL_SCOPES = (GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE)
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"


class GmailAuthError(RuntimeError):
    """Raised when Gmail OAuth configuration or token refresh fails."""


@dataclass(frozen=True)
class OAuthClient:
    client_id: str
    client_secret: str
    kind: str
    redirect_uris: tuple[str, ...] = ()


def load_oauth_client(path: Path | None = None) -> OAuthClient:
    oauth_path = Path(path) if path else config.get_gmail_mcp_oauth_keys_path()
    try:
        payload = json.loads(oauth_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise GmailAuthError(f"missing OAuth client at {oauth_path}") from exc
    except json.JSONDecodeError as exc:
        raise GmailAuthError(f"invalid OAuth client JSON at {oauth_path}") from exc

    raw = payload.get("installed") or payload.get("web")
    kind = "installed" if payload.get("installed") else "web"
    if not isinstance(raw, dict):
        raise GmailAuthError("OAuth client JSON must contain installed or web credentials")
    client_id = str(raw.get("client_id") or "").strip()
    client_secret = str(raw.get("client_secret") or "").strip()
    if not client_id or not client_secret:
        raise GmailAuthError("OAuth client JSON is missing client_id or client_secret")
    redirects = tuple(str(uri) for uri in raw.get("redirect_uris") or ())
    return OAuthClient(
        client_id=client_id,
        client_secret=client_secret,
        kind=kind,
        redirect_uris=redirects,
    )


def choose_redirect_uri(client: OAuthClient, *, port: int | None = None) -> str:
    """Return the redirect URI this auth flow will use."""
    if client.kind == "installed":
        if port is None:
            return "http://127.0.0.1:0/oauth2callback"
        return f"http://127.0.0.1:{port}/oauth2callback"
    local = [
        uri
        for uri in client.redirect_uris
        if uri.startswith(("http://localhost:", "http://127.0.0.1:"))
    ]
    if not local:
        raise GmailAuthError(
            "OAuth web client has no local redirect URI; use a Desktop client "
            "or add http://localhost:3000/oauth2callback"
        )
    return local[0]


def build_authorization_url(client: OAuthClient, redirect_uri: str, state: str) -> str:
    params = {
        "client_id": client.client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(GMAIL_SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return f"{AUTH_URL}?{urllib.parse.urlencode(params)}"


def authenticate(*, open_browser: bool = True, timeout_seconds: int = 180) -> Path:
    """Run the local OAuth callback flow and save a Gmail token."""
    client = load_oauth_client()
    token_path = config.get_gmail_mcp_credentials_path()
    token_path.parent.mkdir(parents=True, exist_ok=True)
    state = secrets.token_urlsafe(24)
    result: dict[str, str] = {}
    done = threading.Event()

    if client.kind == "installed":
        host = "127.0.0.1"
        port = 0
        path = "/oauth2callback"
    else:
        provisional = choose_redirect_uri(client, port=None)
        parsed = urllib.parse.urlparse(provisional)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port if parsed.port is not None else 0
        path = parsed.path or "/oauth2callback"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
            url = urllib.parse.urlparse(self.path)
            if url.path != path:
                self.send_response(404)
                self.end_headers()
                return
            query = urllib.parse.parse_qs(url.query)
            if query.get("state", [""])[0] != state:
                result["error"] = "state mismatch"
            elif query.get("error"):
                result["error"] = query["error"][0]
            else:
                result["code"] = query.get("code", [""])[0]
            self.send_response(200 if result.get("code") else 400)
            self.end_headers()
            body = (
                "Gmail auth complete. You can close this tab."
                if result.get("code")
                else "Gmail auth failed. Return to the terminal."
            )
            self.wfile.write(body.encode("utf-8"))
            done.set()

    try:
        server = ThreadingHTTPServer((host, port), Handler)
    except OSError as exc:
        raise GmailAuthError(f"could not start local OAuth callback on {host}:{port}") from exc
    actual_port = server.server_address[1]
    redirect_uri = (
        choose_redirect_uri(client, port=actual_port)
        if client.kind == "installed"
        else choose_redirect_uri(client, port=None)
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        auth_url = build_authorization_url(client, redirect_uri, state)
        print(f"Open this URL to authorize Gmail connector access:\n{auth_url}")
        if open_browser:
            webbrowser.open(auth_url)
        if not done.wait(timeout_seconds):
            raise GmailAuthError("timed out waiting for Gmail OAuth callback")
        if result.get("error"):
            raise GmailAuthError(f"Gmail OAuth failed: {result['error']}")
        token = exchange_code(client, redirect_uri, result["code"])
        token_path.write_text(json.dumps(token, indent=2), encoding="utf-8")
        token_path.chmod(0o600)
        return token_path
    finally:
        server.shutdown()
        server.server_close()


def exchange_code(client: OAuthClient, redirect_uri: str, code: str) -> dict[str, Any]:
    with httpx.Client(timeout=20) as http:
        response = http.post(
            TOKEN_URL,
            data={
                "client_id": client.client_id,
                "client_secret": client.client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
        )
        response.raise_for_status()
        token = response.json()
    token["expires_at"] = int(time.time()) + int(token.get("expires_in", 3600)) - 60
    token["scope"] = token.get("scope") or GMAIL_READONLY_SCOPE
    return token


def load_token(path: Path | None = None) -> dict[str, Any]:
    token_path = Path(path) if path else config.get_gmail_mcp_credentials_path()
    try:
        return json.loads(token_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise GmailAuthError(f"missing Gmail token at {token_path}") from exc
    except json.JSONDecodeError as exc:
        raise GmailAuthError(f"invalid Gmail token JSON at {token_path}") from exc


def save_token(token: dict[str, Any], path: Path | None = None) -> None:
    token_path = Path(path) if path else config.get_gmail_mcp_credentials_path()
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(json.dumps(token, indent=2), encoding="utf-8")
    token_path.chmod(0o600)


def get_access_token() -> str:
    token = load_token()
    if token.get("access_token") and int(token.get("expires_at", 0) or 0) > int(time.time()):
        return str(token["access_token"])
    refreshed = refresh_token(token)
    save_token(refreshed)
    return str(refreshed["access_token"])


def refresh_token(token: dict[str, Any]) -> dict[str, Any]:
    refresh = str(token.get("refresh_token") or "").strip()
    if not refresh:
        raise GmailAuthError("Gmail token has no refresh_token; run jobhunter gmail-auth")
    client = load_oauth_client()
    with httpx.Client(timeout=20) as http:
        response = http.post(
            TOKEN_URL,
            data={
                "client_id": client.client_id,
                "client_secret": client.client_secret,
                "refresh_token": refresh,
                "grant_type": "refresh_token",
            },
        )
        response.raise_for_status()
        payload = response.json()
    merged = {**token, **payload}
    merged["refresh_token"] = refresh
    merged["expires_at"] = int(time.time()) + int(payload.get("expires_in", 3600)) - 60
    return merged
