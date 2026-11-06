"""Reviewed history proposals in the existing Discovery queue and event ledger.

Coordinates parse URL syntax, never employer identity or posting meaning. The
explicit proposal command validates public destinations but never fetches them.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import urlsplit


@dataclass(frozen=True)
class SourceCoordinate:
    url: str
    source_id: str
    ats_kind: str | None
    board_token: str | None

    @property
    def candidate_id(self) -> str:
        return "locator:" + hashlib.sha256(self.url.encode()).hexdigest()[:16]


def source_coordinate(raw_url: str) -> SourceCoordinate | None:
    """A conservative, local parse; fetching still requires network policy checks."""
    if not isinstance(raw_url, str) or re.search(r"[\s\\\x00-\x1f\x7f]", raw_url):
        return None
    try:
        parsed = urlsplit(raw_url)
        host = (parsed.hostname or "").lower().rstrip(".").encode("idna").decode("ascii")
        port = parsed.port
    except (ValueError, UnicodeError):
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 80, 443}
    ):
        return None
    if (
        ":" in host
        or "." not in host
        or host.endswith((".localhost", ".local", ".internal", ".lan", ".home", ".localdomain"))
    ):
        return None
    try:
        address = ipaddress.ip_address(host)
        if not address.is_global:
            return None
    except ValueError:
        if not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in host.split(".")):
            return None
        # Reject alternative numeric IP spellings accepted by browser URL parsers.
        if re.fullmatch(r"[0-9a-fx.]+", host) and any(
            part.startswith("0x") or part.isdigit() for part in host.split(".")
        ):
            return None
    parts = [part for part in parsed.path.split("/") if part]
    kind: str | None = None
    token: str | None = None
    board_host = host
    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io", "boards-api.greenhouse.io"}:
        kind = "greenhouse"
        if host == "boards-api.greenhouse.io":
            token = parts[2] if len(parts) >= 3 and parts[:2] == ["v1", "boards"] else None
        else:
            token = parts[0] if parts else None
        board_host = "boards.greenhouse.io"
    elif host in {"jobs.lever.co", "api.lever.co", "jobs.eu.lever.co", "api.eu.lever.co"}:
        kind = "lever"
        token = (
            (parts[2] if len(parts) >= 3 and parts[:2] == ["v0", "postings"] else None)
            if host.startswith("api.")
            else (parts[0] if parts else None)
        )
        board_host = "jobs.eu.lever.co" if ".eu." in host else "jobs.lever.co"
    elif host in {"jobs.ashbyhq.com", "api.ashbyhq.com"}:
        kind = "ashby"
        token = (
            (parts[2] if len(parts) >= 3 and parts[:2] == ["posting-api", "job-board"] else None)
            if host.startswith("api.")
            else (parts[0] if parts else None)
        )
        board_host = "jobs.ashbyhq.com"
    elif host.endswith(".myworkdayjobs.com"):
        kind = "workday"
        if parts and re.fullmatch(r"[a-z]{2}-[A-Z]{2}", parts[0]):
            parts = parts[1:]
        token = (
            parts[3] if len(parts) >= 4 and parts[0] == "wday" and parts[1] == "cxs" else (parts[0] if parts else None)
        )
    if kind:
        if not token or not re.fullmatch(r"[A-Za-z0-9_-]+", token):
            return None
        # Registry identity retains literal board tokens and regional hosts;
        # display slugs must not collapse distinct provider coordinates.
        source_token = f"eu:{token}" if kind == "lever" and board_host == "jobs.eu.lever.co" else token
        if kind == "workday":
            source_token = f"{host}:{token}"
        return SourceCoordinate(f"https://{board_host}/{token}", f"{kind}:{source_token}", kind, token)
    return SourceCoordinate(f"https://{host}/", f"employer_careers_page:{host}", None, None)
