"""Captured transport facts, before any model interpretation."""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit


@dataclass(frozen=True)
class PostingNavigationResponse:
    host: str
    status: int
    requested: datetime
    received: datetime
    retry_after: str | None


# The browser thread inherits the owning refresh's context. Manual refreshes,
# captures and other simultaneous assessments have their own scope.
navigation_observer = ContextVar("posting_navigation_observer", default=None)


def report_navigation(observer, url, status, requested, received, retry_after):
    if observer is not None:
        target = urlsplit(url)
        if target.scheme in {"http", "https"} and target.hostname and target.username is None and target.password is None:
            observer(PostingNavigationResponse(target.hostname.lower().rstrip("."), status, requested.astimezone(timezone.utc),
                                               received.astimezone(timezone.utc),
                                               retry_after if retry_after and len(retry_after) <= 128 else None))


@dataclass(frozen=True)
class DetailPage:
    url: str
    final_url: str = ""
    page_title: str = ""
    html: str = ""
    json_ld: tuple[Any, ...] = field(default_factory=tuple)
    status: int | None = None
    fetched_at: str = ""
    status_html: str = ""
    status_evidence_complete: bool = True
    status_evidence_reason: str = ""
    status_visibility_verified: bool = False
    raw_html_hash: str = ""
    embedded_pages: tuple[DetailPage, ...] = field(default_factory=tuple)
