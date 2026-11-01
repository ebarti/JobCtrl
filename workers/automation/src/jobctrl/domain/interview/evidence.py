"""Immutable accepted evidence supplied by the canonical preparation input reader."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from jobctrl.domain.interview.catalog import InterviewSelectionError
from jobctrl.domain.tenant import TenantId

MAX_EVIDENCE_EXCERPT_CHARS = 4_000


@dataclass(frozen=True)
class InterviewEvidenceSource:
    evidence_id: str
    excerpt: str
    tags: tuple[str, ...]


@dataclass(frozen=True)
class InterviewEvidenceSnapshot:
    tenant_id: TenantId
    profile_id: str
    profile_version: int
    sources: tuple[InterviewEvidenceSource, ...]

    @classmethod
    def from_canonical_rows(
        cls, *, tenant_id: TenantId, profile_id: str, profile_version: int,
        rows: Sequence[Mapping[str, Any]],
    ) -> InterviewEvidenceSnapshot:
        """Validate raw rows without coercion, ID normalization or legacy synthesis."""
        if len(rows) > 400:
            raise ValueError("canonical evidence inventory exceeds preparation budget")
        seen: set[Any] = set()
        sources: list[InterviewEvidenceSource] = []
        for row in rows:
            evidence_id = row.get("evidence_id")
            if evidence_id in seen:
                raise InterviewSelectionError("invalid_evidence_selection")
            seen.add(evidence_id)
            confirmed = row.get("user_confirmed")
            if (type(confirmed) not in (int, bool) or confirmed != 1
                    or row.get("evidence_strength") not in {"supported", "verified"}):
                continue
            if not isinstance(evidence_id, str) or not evidence_id.strip() or len(evidence_id) > 200:
                continue
            fragments = [str(row.get(key) or "").strip() for key in ("source_text", "scope", "action", "outcome")]
            if not any(fragments):
                continue
            for key in ("metrics_json", "tools_json"):
                fragments.append(" ".join(_text_array(row.get(key))))
            excerpt = " | ".join(part for part in fragments if part)
            if len(excerpt) > MAX_EVIDENCE_EXCERPT_CHARS:
                raise ValueError("canonical evidence excerpt exceeds preparation budget")
            sources.append(InterviewEvidenceSource(evidence_id, excerpt, _text_array(row.get("tags_json"))))
        return cls(tenant_id, profile_id, profile_version, tuple(sources))


def _text_array(raw: Any) -> tuple[str, ...]:
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError) as exc:
        raise InterviewSelectionError("invalid_evidence_selection") from exc
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise InterviewSelectionError("invalid_evidence_selection")
    return tuple(value)
