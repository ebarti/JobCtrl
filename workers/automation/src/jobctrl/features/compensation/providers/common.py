"""Source-bound values and acquisition receipts for compensation adapters."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlsplit, urlunsplit

from jobctrl.features.compensation.core.ports import Observation, Source


@dataclass(frozen=True)
class ProviderLoad:
    """Partial data and non-sensitive acquisition diagnostics for one source.

    A nonempty ``errors`` means the lookup was incomplete. Callers may inspect
    observations but must not publish an incomplete lookup as a successful
    replacement of accepted evidence.
    """

    observations: tuple[Observation, ...] = ()
    errors: tuple[str, ...] = ()
    levels_fyi_targets: tuple[Any, ...] = ()
    diagnostics: tuple[tuple[str, Any], ...] = ()

    @property
    def complete(self) -> bool:
        return not self.errors

    def require_complete(self) -> tuple[Observation, ...]:
        if self.errors:
            raise ProviderUnavailable(self)
        return self.observations


class ProviderUnavailable(RuntimeError):
    """Typed incomplete lookup with its safe receipt; never includes source bodies."""

    def __init__(self, receipt: ProviderLoad) -> None:
        super().__init__(", ".join(receipt.errors))
        self.receipt = receipt


def row_source(
    provider: str,
    row: Mapping[str, Any],
    *,
    snapshot: str,
    as_of: str | None = None,
    url: str | None = None,
    attribution: str | None = None,
) -> Source:
    """Bind a deterministic row to the exact classification input and snapshot."""

    text = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    snapshot_hash = hashlib.sha256(snapshot.encode("utf-8")).hexdigest()
    return Source(
        reference=f"{provider}:{snapshot_hash}:{digest}",
        text=text,
        as_of=as_of,
        url=safe_source_url(url),
        attribution=attribution,
    )


def safe_source_url(value: Any) -> str | None:
    """Retain public source locations only, without credentials or private tokens."""

    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parts = urlsplit(value.strip())
        if parts.scheme not in {"http", "https"} or not parts.netloc or parts.username or parts.password:
            return None
        if any(
            term in (parts.netloc + parts.path).casefold()
            for term in ("/users/", "\\users\\", "credential", "secret", "token", "password", "api_key", "private")
        ):
            return None
        host = (parts.hostname or "").lower().rstrip(".")
        if not host or host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan")):
            return None
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            return None
        if address is None and ("." not in host or not re.search(r"[a-z]", host.rsplit(".", 1)[-1])):
            # Refuse single-label intranet hosts and noncanonical numeric IP
            # forms such as 127.1; no DNS lookup is made merely to display a
            # source. Network acquisition has a separate resolved-IP guard.
            return None
        # Query parameters may contain feed credentials or private account state.
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    except ValueError:
        return None


def levels_company_reference(url: str | None) -> str | None:
    """Use only a provider-owned company salary URL as an employer identity."""
    if not url:
        return None
    try:
        parts = urlsplit(url)
        match = re.fullmatch(r"/companies/([a-z0-9-]+)/salaries(?:/.*)?", parts.path)
        if parts.scheme == "https" and parts.netloc == "www.levels.fyi" and match:
            return f"levels_fyi:company:{match.group(1)}"
    except ValueError:
        pass
    return None
