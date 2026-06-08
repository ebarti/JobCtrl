"""Deterministic evidence-span grounding validator — the cardinal gate (D-15).

The single most important check in the employer-analysis pipeline: every
``evidence_span`` on every :class:`Requirement` and :class:`ReasonedKeyword`
MUST be a **literal substring** of the persisted JD snapshot. A span that is a
paraphrase, an over-inference, or text not found verbatim in the posting is the
fabricated-grounding failure (failure mode #1) and is rejected here — never
trusted from the model, and never expressible in JSON Schema.

This module is pure, deterministic code with NO LLM call (the validator, not
the prompt, is the real gate). Membership is decided by exact ``in`` after
normalising only insignificant whitespace (collapsing runs of spaces/newlines),
so trivial formatting differences in the model's quote do not produce false
rejections while real fabrications still fail.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from jobhunter.domain.materials.analysis import JobAnalysis

_WHITESPACE_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    """Collapse insignificant whitespace; preserve everything else verbatim.

    Only whitespace runs are normalised (and the result stripped). Case,
    punctuation, and word content are preserved so the check stays a genuine
    literal-substring test — an over-inferred or paraphrased span still fails.
    """
    return _WHITESPACE_RE.sub(" ", text).strip()


def is_grounded(span: str, jd_snapshot: str) -> bool:
    """Return True iff ``span`` is a literal substring of ``jd_snapshot``.

    An empty span is NOT grounded (an evidence claim must point at real text).
    """
    normalized_span = _normalize(span)
    if not normalized_span:
        return False
    return normalized_span in _normalize(jd_snapshot)


@dataclass(frozen=True)
class GroundingViolation:
    """One span that failed the literal-substring check."""

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
    audit trail can show exactly what was rejected.
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

    The hard gate used on every draft AND on the synthesized canonical record
    before persistence. Passes silently when every span is a literal JD
    substring.
    """
    violations = find_grounding_violations(analysis, jd_snapshot)
    if violations:
        raise GroundingError(violations)


__all__ = [
    "is_grounded",
    "GroundingViolation",
    "GroundingError",
    "find_grounding_violations",
    "validate_evidence_spans",
]
