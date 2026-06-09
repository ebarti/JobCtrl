"""Deterministic evidence-span grounding validator — the cardinal gate (D-15).

The single most important check in the employer-analysis pipeline: every
``evidence_span`` on every :class:`Requirement` and :class:`ReasonedKeyword`
MUST be locatable in the persisted JD snapshot. A span that is a paraphrase, an
over-inference, or text not present in the posting is the fabricated-grounding
failure (failure mode #1) and is rejected here — never trusted from the model,
and never expressible in JSON Schema.

This module is pure, deterministic code with NO LLM call (the validator, not
the prompt, is the real gate). Matching is **formatting-tolerant but
content-exact** via normalize → locate → snap-to-source:

  1. **Normalize** both sides for the membership decision: collapse every
     whitespace run (spaces, tabs, newlines) to a single space; fold the
     Unicode hyphen/dash family (‐ ‑ ‒ – — −) to ASCII ``-``; fold smart
     quotes (' ' to ``'``, “ ” to ``"``); case-insensitive. Every one of
     these is formatting-insignificant — none changes WHICH words are present,
     so none can let a fabrication through.
  2. **Locate** the span by building a tolerant regex from it (escape it, then
     relax escaped whitespace to ``\\s+`` and each hyphen/quote to a character
     class) and searching the ORIGINAL JD case-insensitively. A hit means the
     span is genuinely present, modulo formatting.
  3. **Snap-to-source**: the located match yields the JD's ACTUAL text at that
     position, so the stored ``evidence_span`` becomes verbatim-from-the-posting
     (satisfies D-15 and enables clean char-offset highlighting later).

A span whose WORDS are not in the JD (a paraphrase/synonym/hallucination like
``"99.9999% uptime"`` against a JD that says ``"high availability"``, or an
invented ``"Kubernetes"``) is NOT located and is still rejected — the
no-fabrication guarantee is unchanged, only formatting tolerance is added.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from jobhunter.domain.materials.analysis import (
    JobAnalysis,
    JobAnalysisDraft,
    ReasonedKeyword,
    Requirement,
)

_WHITESPACE_RE = re.compile(r"\s+")

# Unicode hyphen/dash variants that are formatting-equivalent to ASCII "-".
# Folding them changes punctuation rendering only, never which words are present:
#   U+2010 HYPHEN, U+2011 NON-BREAKING HYPHEN, U+2012 FIGURE DASH,
#   U+2013 EN DASH, U+2014 EM DASH, U+2212 MINUS SIGN.
_DASH_CHARS = "‐‑‒–—−"
_DASH_RE = re.compile(f"[{_DASH_CHARS}]")

# Smart single/double quotes folded to their ASCII counterparts:
#   U+2018 ‘, U+2019 ’  ->  '
#   U+201C “, U+201D ”  ->  "
_SINGLE_QUOTE_CHARS = "‘’"
_DOUBLE_QUOTE_CHARS = "“”"
_SINGLE_QUOTE_RE = re.compile(f"[{_SINGLE_QUOTE_CHARS}]")
_DOUBLE_QUOTE_RE = re.compile(f"[{_DOUBLE_QUOTE_CHARS}]")

# Character classes used to build the tolerant locator regex, so a span quoting
# any variant matches the JD's variant (and vice versa). The ASCII member is
# included alongside the Unicode variants in each class.
_HYPHEN_CLASS = f"[-{_DASH_CHARS}]"
_SINGLE_QUOTE_CLASS = f"['{_SINGLE_QUOTE_CHARS}]"
_DOUBLE_QUOTE_CLASS = f'["{_DOUBLE_QUOTE_CHARS}]'


def _normalize(text: str) -> str:
    """Fold formatting-insignificant variation for the membership decision.

    Collapses whitespace runs to one space (and strips), folds the Unicode
    dash/quote families to ASCII, and lowercases. Word content, digits, and all
    other punctuation are preserved, so the check stays a genuine
    content-membership test — an over-inferred or paraphrased span still fails.
    """
    folded = _DASH_RE.sub("-", text)
    folded = _SINGLE_QUOTE_RE.sub("'", folded)
    folded = _DOUBLE_QUOTE_RE.sub('"', folded)
    return _WHITESPACE_RE.sub(" ", folded).strip().lower()


def _tolerant_pattern(span: str) -> re.Pattern[str] | None:
    """Build a formatting-tolerant regex that locates ``span`` in the raw JD.

    The span is normalized (so its whitespace/dash/quote rendering is canonical),
    escaped, then relaxed: each space becomes ``\\s+`` (matches any whitespace
    run, including newlines), each ``-`` becomes the hyphen char-class, and each
    quote becomes the matching quote char-class. Searched case-insensitively
    against the ORIGINAL JD, so ``match.group()`` is the verbatim source slice.

    Returns ``None`` for an empty/whitespace-only span (no real text to locate).
    """
    normalized = _normalize(span)
    if not normalized:
        return None
    escaped = re.escape(normalized)
    # re.escape encodes a literal space as "\\ " and a hyphen as "\\-"; relax the
    # space to any whitespace run and the hyphen to the dash-variant char-class so
    # the JD's actual formatting (newlines, en/em dashes) still matches.
    pattern = escaped.replace("\\ ", r"\s+")
    pattern = pattern.replace("\\-", _HYPHEN_CLASS)
    # re.escape leaves ASCII quotes unescaped, so match them directly.
    pattern = pattern.replace("'", _SINGLE_QUOTE_CLASS)
    pattern = pattern.replace('"', _DOUBLE_QUOTE_CLASS)
    return re.compile(pattern, re.IGNORECASE)


def locate_grounded_span(span: str, jd_snapshot: str) -> str | None:
    """Return the JD's verbatim text matching ``span``, or ``None`` if absent.

    The single source of grounding truth: it both decides membership (a non-None
    result means grounded) and yields the snap-to-source slice. ``None`` means
    the span's content is not present in the JD (modulo formatting) — a genuine
    fabrication that must be rejected.
    """
    pattern = _tolerant_pattern(span)
    if pattern is None:
        return None
    match = pattern.search(jd_snapshot)
    return match.group() if match is not None else None


def is_grounded(span: str, jd_snapshot: str) -> bool:
    """Return True iff ``span``'s content is present in ``jd_snapshot``.

    Formatting-tolerant (whitespace/dash/quote/case) but content-exact. An empty
    span is NOT grounded (an evidence claim must point at real text).
    """
    return locate_grounded_span(span, jd_snapshot) is not None


@dataclass(frozen=True)
class GroundingViolation:
    """One span whose content could not be located in the JD snapshot."""

    kind: str  # "requirement" | "keyword"
    ref_id: str  # requirement id or keyword text
    span: str

    def describe(self) -> str:
        preview = self.span if len(self.span) <= 80 else self.span[:77] + "..."
        return f"{self.kind} {self.ref_id!r}: evidence span not found verbatim in JD: {preview!r}"


def find_grounding_violations(analysis: JobAnalysis, jd_snapshot: str) -> list[GroundingViolation]:
    """Return every fabricated/ungrounded evidence span in ``analysis``.

    An empty list means the analysis passes the grounding gate. Each violation
    names the requirement id (or keyword text) and the offending span so the
    audit trail can show exactly what was rejected. Membership is decided by the
    formatting-tolerant locator, so a violation is raised only for genuinely
    absent content — never for a hyphen/whitespace/quote/case difference.
    """
    violations: list[GroundingViolation] = []
    for requirement in analysis.requirements:
        if not is_grounded(requirement.evidence_span, jd_snapshot):
            violations.append(
                GroundingViolation(
                    kind="requirement",
                    ref_id=requirement.id,
                    span=requirement.evidence_span,
                )
            )
    for keyword in analysis.keywords:
        if not is_grounded(keyword.evidence_span, jd_snapshot):
            violations.append(
                GroundingViolation(
                    kind="keyword",
                    ref_id=keyword.keyword,
                    span=keyword.evidence_span,
                )
            )
    return violations


class GroundingError(ValueError):
    """Raised when an analysis carries one or more ungrounded evidence spans.

    Carries the structured violations so the use case can record them as the
    leg's failure reason and re-ask (Section 4b retry policy), or block
    persistence of a synthesized canonical that fabricated a span.
    """

    def __init__(self, violations: list[GroundingViolation]) -> None:
        self.violations = violations
        detail = "; ".join(v.describe() for v in violations)
        super().__init__(f"grounding validation failed ({len(violations)} span(s)): {detail}")


def validate_evidence_spans(analysis: JobAnalysis, jd_snapshot: str) -> None:
    """Raise :class:`GroundingError` if any evidence span is not grounded.

    The hard membership gate. Passes silently when every span's content is
    present in the JD (modulo formatting). Use :func:`ground_and_snap` instead
    when you also want the spans rewritten to the verbatim JD text.
    """
    violations = find_grounding_violations(analysis, jd_snapshot)
    if violations:
        raise GroundingError(violations)


def _snap_requirement(requirement: Requirement, jd_snapshot: str) -> Requirement | None:
    snapped = locate_grounded_span(requirement.evidence_span, jd_snapshot)
    if snapped is None:
        return None
    if snapped == requirement.evidence_span:
        return requirement  # already verbatim — no rebuild needed (idempotent)
    return requirement.model_copy(update={"evidence_span": snapped})


def _snap_keyword(keyword: ReasonedKeyword, jd_snapshot: str) -> ReasonedKeyword | None:
    snapped = locate_grounded_span(keyword.evidence_span, jd_snapshot)
    if snapped is None:
        return None
    if snapped == keyword.evidence_span:
        return keyword  # already verbatim — no rebuild needed (idempotent)
    return keyword.model_copy(update={"evidence_span": snapped})


def ground_and_snap(analysis: JobAnalysis, jd_snapshot: str) -> JobAnalysis:
    """Validate grounding AND return a copy with every span snapped to source.

    The hard gate used on every draft AND on the synthesized canonical before
    persistence. Each ``evidence_span`` is located in the JD (formatting-tolerant)
    and replaced with the JD's verbatim text at the match (snap-to-source), so the
    persisted/displayed evidence is always copy-paste-findable in the posting
    (D-15) and char-offset highlighting is exact. Any span whose content is not in
    the JD raises :class:`GroundingError` exactly as :func:`validate_evidence_spans`
    would — the no-fabrication guarantee is unchanged.

    Returns the SAME object unchanged when every span is already verbatim
    (idempotent); otherwise a ``model_copy`` carrying the snapped spans (the
    :class:`JobAnalysisDraft.model_id` tag is preserved). Never mutates the input.
    """
    violations: list[GroundingViolation] = []

    snapped_requirements: list[Requirement] = []
    requirements_changed = False
    for requirement in analysis.requirements:
        snapped = _snap_requirement(requirement, jd_snapshot)
        if snapped is None:
            violations.append(
                GroundingViolation(
                    kind="requirement",
                    ref_id=requirement.id,
                    span=requirement.evidence_span,
                )
            )
            snapped_requirements.append(requirement)
            continue
        requirements_changed = requirements_changed or snapped is not requirement
        snapped_requirements.append(snapped)

    snapped_keywords: list[ReasonedKeyword] = []
    keywords_changed = False
    for keyword in analysis.keywords:
        snapped = _snap_keyword(keyword, jd_snapshot)
        if snapped is None:
            violations.append(
                GroundingViolation(
                    kind="keyword",
                    ref_id=keyword.keyword,
                    span=keyword.evidence_span,
                )
            )
            snapped_keywords.append(keyword)
            continue
        keywords_changed = keywords_changed or snapped is not keyword
        snapped_keywords.append(snapped)

    if violations:
        raise GroundingError(violations)

    if not requirements_changed and not keywords_changed:
        return analysis  # every span already verbatim — idempotent no-op

    update = {"requirements": snapped_requirements, "keywords": snapped_keywords}
    if isinstance(analysis, JobAnalysisDraft):
        update["model_id"] = analysis.model_id  # preserve the leg tag
    return analysis.model_copy(update=update)


__all__ = [
    "is_grounded",
    "locate_grounded_span",
    "GroundingViolation",
    "GroundingError",
    "find_grounding_violations",
    "validate_evidence_spans",
    "ground_and_snap",
]
