"""Captured transport facts, before any model interpretation."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


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
