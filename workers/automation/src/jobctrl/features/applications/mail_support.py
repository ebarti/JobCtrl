"""Neutral Gmail OAuth/token primitives with explicit paths and private writes.

This module has no workspace defaults, global configuration, application state,
or legacy runtime imports. The Applications mail adapter chooses every path.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import tempfile
import time
from urllib.parse import urlencode, urlsplit

import httpx

from .mail_privacy import private_gmail_operation

GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
GMAIL_SCOPES = (GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE)
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"


class GmailAuthError(RuntimeError):
    """Safe OAuth/storage failure; never retain credentials or provider bodies."""


@dataclass(frozen=True)
class OAuthClient:
    client_id: str
    client_secret: str
    kind: str
    redirect_uris: tuple[str, ...] = ()


def load_oauth_client(path: Path) -> OAuthClient:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        raw = payload.get("installed") or payload.get("web")
        kind = "installed" if payload.get("installed") else "web"
        if not isinstance(raw, dict):
            raise ValueError
        client_id, client_secret = raw.get("client_id"), raw.get("client_secret")
        redirects = raw.get("redirect_uris", [])
        if (not isinstance(client_id, str) or not client_id.strip() or not isinstance(client_secret, str)
                or not client_secret.strip() or not isinstance(redirects, list)
                or any(not isinstance(uri, str) for uri in redirects)):
            raise ValueError
        return OAuthClient(client_id, client_secret, kind, tuple(redirects))
    except (OSError, ValueError, AttributeError, TypeError):
        raise GmailAuthError("The Gmail OAuth client configuration is unavailable or invalid.") from None


def choose_redirect_uri(client: OAuthClient, *, port: int | None = None) -> str:
    if client.kind == "installed":
        return f"http://127.0.0.1:{port or 0}/oauth2callback"
    for uri in client.redirect_uris:
        parsed = urlsplit(uri)
        if (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}
                and parsed.port and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment):
            return uri
    raise GmailAuthError("The Gmail OAuth client has no local callback URI.")


def build_authorization_url(client: OAuthClient, redirect_uri: str, state: str) -> str:
    return AUTH_URL + "?" + urlencode({"client_id": client.client_id, "redirect_uri": redirect_uri,
        "response_type": "code", "scope": " ".join(GMAIL_SCOPES), "access_type": "offline", "prompt": "consent", "state": state})


def load_token(path: Path) -> dict:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (OSError, ValueError, TypeError):
        raise GmailAuthError("The Gmail token is unavailable or invalid.") from None


def save_token(token: dict, path: Path) -> None:
    """Publish a complete private token without truncating the accepted file.

    Windows creates the stage with its protected current-user/LocalSystem DACL
    before any credential byte is written. POSIX uses the private mkstemp mode.
    Replacement denial preserves the prior token and cleans the owned stage.
    """
    if not isinstance(token, dict) or not isinstance(token.get("access_token"), str) or not token["access_token"].strip():
        raise GmailAuthError("The Gmail token replacement is invalid.")
    try:
        serialized = json.dumps(token, indent=2, allow_nan=False)
    except (TypeError, ValueError):
        raise GmailAuthError("The Gmail token replacement is invalid.") from None
    descriptor, temporary = None, None
    try:
        destination = Path(path).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            from .mail_windows import create_private_stage
            descriptor, name = create_private_stage(destination)
        else:
            descriptor, name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
        temporary = Path(name)
        if os.name != "nt":
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = None
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        temporary = None
    except Exception:
        raise GmailAuthError("Could not save the Gmail token.") from None
    finally:
        cleanup_failed = False
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                cleanup_failed = True
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                cleanup_failed = True
        if cleanup_failed:
            raise GmailAuthError("Could not clean up a private temporary Gmail token.") from None


def exchange_code(client: OAuthClient, redirect_uri: str, code: str) -> dict:
    try:
        with private_gmail_operation("gmail.authorization"):
            with httpx.Client(timeout=20, trust_env=False, follow_redirects=False) as http:
                with http.stream("POST", TOKEN_URL, data={"client_id": client.client_id, "client_secret": client.client_secret,
                    "code": code, "grant_type": "authorization_code", "redirect_uri": redirect_uri}) as response:
                    if response.status_code != 200:
                        raise ValueError
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        content.extend(chunk)
                        if len(content) > 2 * 1024 * 1024:
                            raise ValueError
        def constant(_value):
            raise ValueError
        token = json.loads(content, parse_constant=constant)
        expires = token.get("expires_in") if isinstance(token, dict) else None
        if (not isinstance(token, dict) or not isinstance(token.get("access_token"), str) or not token["access_token"].strip()
                or type(expires) not in {int, float} or not math.isfinite(expires) or expires <= 0):
            raise ValueError
        token["expires_at"] = int(time.time() + expires) - 60
        return token
    except (httpx.HTTPError, ValueError, TypeError, UnicodeError):
        raise GmailAuthError("The Gmail token exchange did not complete.") from None
