"""Deterministic EEO red-flag screen — the protected-attribute guardrail (D-9).

AI-SPEC §6 lists an EEO red-flag screen as an *online* (generation-time)
guardrail whose **code** half — not just the prompt instruction — is the real
gate: "denylist/regex screen of requirement+keyword text against EEO red-flag
terms … Block from the requirement/keyword set + flag. Drop the offending item
from requirements/keywords (it must not become something to satisfy) and record
the screen hit as an audit note. Does not abort the run."

This module is pure, deterministic code with NO LLM call (the prompt asks the
models not to emit protected-class signals; this screen is what enforces it when
a model does anyway). A :class:`Requirement` or :class:`ReasonedKeyword` whose
``text`` / ``keyword`` / ``evidence_span`` matches a protected-attribute pattern
is **dropped** from the canonical set before persistence, and the hit is
recorded as an :class:`EeoScreenHit` audit note so the drop is inspectable
(never silently swallowed).

The denylist is deliberately focused on the unambiguous ad-language signals the
EEOC treats as evidence of unlawful preference (per AI-SPEC §1b Regulatory):
age ("recent grad", "digital native", "young/energetic"), gendered role nouns,
and a few explicit protected-class phrasings. It is intentionally NOT a
sentiment model — word-boundary regex only, to keep false positives near zero
on legitimate requirement text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from jobhunter.domain.materials.analysis import (
        JobAnalysis,
        ReasonedKeyword,
        Requirement,
    )

# Protected-attribute red-flag patterns. Each entry is (label, compiled regex).
# Patterns use word boundaries and are case-insensitive; they target ad-language
# preference signals, NOT incidental word use in a genuine requirement. Keep this
# list focused and documented — every addition must be an unambiguous EEO signal.
_RED_FLAG_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # Age (ADEA): proxies for "we want someone young / early-career only".
    ("age", re.compile(r"\brecent\s+(?:college\s+)?grad(?:uate)?s?\b", re.IGNORECASE)),
    ("age", re.compile(r"\bdigital\s+natives?\b", re.IGNORECASE)),
    ("age", re.compile(r"\byoung\s+and\s+energetic\b", re.IGNORECASE)),
    ("age", re.compile(r"\byoung,?\s+energetic\b", re.IGNORECASE)),
    ("age", re.compile(r"\byouthful\b", re.IGNORECASE)),
    # Sex / gender (Title VII): explicitly gendered job-title nouns. Matched as
    # whole words only (so "management"/"human" never trip) and restricted to the
    # unambiguous gendered occupational titles the EEOC flags in ad language —
    # NOT bare "man"/"men", which appears innocuously in real requirement text.
    (
        "gender",
        re.compile(
            r"\b(?:salesman|salesmen|foreman|foremen|handyman|craftsman|"
            r"waitress|stewardess|hostess)\b",
            re.IGNORECASE,
        ),
    ),
    # National origin / citizenship preference phrased as a candidate trait.
    ("national_origin", re.compile(r"\bnative\s+english\s+speakers?\b", re.IGNORECASE)),
    # Explicit protected-class preference language.
    ("protected_class", re.compile(r"\bable[- ]bodied\b", re.IGNORECASE)),
)


@dataclass(frozen=True)
class EeoScreenHit:
    """One requirement/keyword dropped by the EEO red-flag screen (audit data)."""

    kind: str  # "requirement" | "keyword"
    ref_id: str  # requirement id or keyword text
    category: str  # protected-class category, e.g. "age" | "gender"
    matched_text: str  # the offending phrase that triggered the drop

    def describe(self) -> str:
        return (
            f"{self.kind} {self.ref_id!r} dropped (EEO {self.category}): "
            f"matched protected-attribute signal {self.matched_text!r}"
        )

    def to_dict(self) -> dict[str, str]:
        return {
            "kind": self.kind,
            "ref_id": self.ref_id,
            "category": self.category,
            "matched_text": self.matched_text,
        }

    @classmethod
    def from_dict(cls, data: dict[str, str]) -> EeoScreenHit:
        return cls(
            kind=str(data.get("kind") or ""),
            ref_id=str(data.get("ref_id") or ""),
            category=str(data.get("category") or ""),
            matched_text=str(data.get("matched_text") or ""),
        )


@dataclass(frozen=True)
class EeoScreenResult:
    """The screen outcome: the cleaned analysis plus the recorded hits.

    ``hits`` is empty when nothing matched (the common, clean case). When it is
    non-empty the matching requirements/keywords have been dropped from
    ``analysis`` and each drop is recorded here as an audit note.
    """

    analysis: JobAnalysis
    hits: tuple[EeoScreenHit, ...] = field(default_factory=tuple)

    @property
    def has_hits(self) -> bool:
        return bool(self.hits)


def _first_match(*texts: str) -> tuple[str, str] | None:
    """Return ``(category, matched_text)`` for the first red-flag hit, or None."""
    for text in texts:
        if not text:
            continue
        for category, pattern in _RED_FLAG_PATTERNS:
            match = pattern.search(text)
            if match is not None:
                return category, match.group(0)
    return None


def find_eeo_hits(analysis: JobAnalysis) -> list[EeoScreenHit]:
    """Return every requirement/keyword that trips the protected-attribute screen.

    An empty list means the analysis is clean. Each hit names the offending
    requirement id (or keyword text), the protected-class category, and the
    matched phrase so the audit trail shows exactly what was dropped and why.
    """
    hits: list[EeoScreenHit] = []
    for requirement in analysis.requirements:
        match = _first_match(requirement.text, requirement.evidence_span)
        if match is not None:
            category, matched_text = match
            hits.append(
                EeoScreenHit(
                    kind="requirement",
                    ref_id=requirement.id,
                    category=category,
                    matched_text=matched_text,
                )
            )
    for keyword in analysis.keywords:
        match = _first_match(keyword.keyword, keyword.evidence_span)
        if match is not None:
            category, matched_text = match
            hits.append(
                EeoScreenHit(
                    kind="keyword",
                    ref_id=keyword.keyword,
                    category=category,
                    matched_text=matched_text,
                )
            )
    return hits


def screen_eeo_red_flags(analysis: JobAnalysis) -> EeoScreenResult:
    """Drop protected-class red-flag requirements/keywords; record the hits.

    The generation-time guardrail (AI-SPEC §6 Dimension 9). Returns the analysis
    unchanged when clean; otherwise returns a NEW :class:`JobAnalysis` with the
    offending requirements and keywords removed and an :class:`EeoScreenHit`
    recorded for each drop. Never raises — a red flag is dropped + flagged, never
    a hard abort (the spec is explicit: "Does not abort the run").

    Keywords are dropped both when the keyword/evidence itself trips the screen
    AND when the parent requirement they reference was dropped (a keyword that
    only supported a protected-class requirement must not survive it).
    """
    hits = find_eeo_hits(analysis)
    if not hits:
        return EeoScreenResult(analysis=analysis, hits=())

    dropped_requirement_ids = {h.ref_id for h in hits if h.kind == "requirement"}
    dropped_keyword_texts = {h.ref_id for h in hits if h.kind == "keyword"}

    kept_requirements: list[Requirement] = [
        req for req in analysis.requirements if req.id not in dropped_requirement_ids
    ]
    kept_keywords: list[ReasonedKeyword] = [
        kw
        for kw in analysis.keywords
        if kw.keyword not in dropped_keyword_texts
        and (kw.requirement_ref is None or kw.requirement_ref not in dropped_requirement_ids)
    ]

    cleaned = analysis.model_copy(
        update={"requirements": kept_requirements, "keywords": kept_keywords}
    )
    return EeoScreenResult(analysis=cleaned, hits=tuple(hits))


__all__ = [
    "EeoScreenHit",
    "EeoScreenResult",
    "find_eeo_hits",
    "screen_eeo_red_flags",
]
