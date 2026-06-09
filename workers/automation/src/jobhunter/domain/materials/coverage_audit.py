"""Final keyword-coverage audit against the rendered text (GROUND-06, Phase 3).

The honest coverage computation, run at generation time AFTER the voice pass so it
sees the exact text the renderers ship (Pitfall 4), and computed so that a keyword
counts as covered ONLY when it appears in a provenance-backed GROUNDED bullet
(success criterion 4 / Pitfall 10). This closes two anti-patterns at once:

  * **Never inferred from the JD** (Anti-Pattern 2 / CLAUDE.md auditability): the
    only text consulted is the provenance rows' ``generated_text`` — the byte-
    identical rendered line both the LaTeX and HTML renderers consume (the
    provenance builder already anchors ``generated_text`` to that line). The
    ``missing`` list is computed as ``analysis_keywords − covered``, never derived
    from the job description and never suppressed.
  * **Never keyword-stuffed / substring-faked** (Pitfall 10): a keyword is covered
    only when it appears (word-boundary, via :func:`_contains_term`, so ``java``
    does not match ``javascript``) in a bullet that is itself GROUNDED — i.e. the
    provenance row carries at least one evidence/requirement FK binding. A keyword
    crammed into an unsourced skills-dump line (no FK binding) is reported missing.

Pure data, no I/O, no LLM. The use case calls this once on the SELECTED, voiced
candidate's provenance rows and persists the result canonically on the
:class:`BulletProvenanceSet` so the read model serves generation-time truth.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from jobhunter.domain.materials.analysis import EmployerAnalysis, JobAnalysis
from jobhunter.domain.materials.quality import _contains_term, _normalize_phrase

if TYPE_CHECKING:  # pragma: no cover — type-only; avoids a provenance<->coverage cycle
    from jobhunter.domain.materials.provenance import BulletProvenance

# How the audit text was sourced — recorded on the result so the read model can
# prove coverage was computed against rendered text, not the JD (the audit label).
COMPUTED_AGAINST_RENDERED = "rendered_text"


def _is_grounded(row: BulletProvenance) -> bool:
    """A bullet is grounded when it carries a real evidence or requirement FK.

    Provenance bindings are validated against the canonical profile + analysis
    before a row is ever built (``provenance_builder``: a fabricated id is hard-
    rejected), so a non-empty ``evidence_ids``/``requirement_ids`` means the line
    is anchored to real profile evidence and/or a real job requirement. A line
    with neither — e.g. an ungrounded skills-dump — cannot legitimately
    "demonstrate" a keyword, so it does not count toward coverage.
    """
    return bool(row.evidence_ids) or bool(row.requirement_ids)


@dataclass(frozen=True)
class KeywordCoverage:
    """Generation-time keyword coverage computed against rendered, grounded text.

    ``covered`` / ``missing`` partition the analysis keywords. ``covered_by`` maps
    each covered keyword to the ``bullet_id`` of the grounded bullet it was found
    in, so coverage is inspectable (which bullet demonstrates which keyword), not
    a bare count (Pitfall 10 / UX: per-keyword, per-bullet coverage).
    """

    planned: tuple[str, ...]
    covered: tuple[str, ...]
    missing: tuple[str, ...]
    covered_by: dict[str, str]
    computed_against: str = COMPUTED_AGAINST_RENDERED

    @property
    def coverage_ratio(self) -> float:
        if not self.planned:
            return 0.0
        return len(self.covered) / len(self.planned)

    def to_read_model(self) -> dict[str, Any]:
        """The inspectable read shape (single owner; mirrored in the TS projection).

        Ordered as produced (analysis importance order) so the inspector renders
        keywords most-important-first.
        """
        return {
            "computed_against": self.computed_against,
            "planned": list(self.planned),
            "covered": list(self.covered),
            "missing": list(self.missing),
            "covered_by": dict(self.covered_by),
            "counts": {
                "planned": len(self.planned),
                "covered": len(self.covered),
                "missing": len(self.missing),
            },
        }

    @classmethod
    def from_read_model(cls, data: dict[str, Any] | None) -> KeywordCoverage | None:
        """Rehydrate a persisted coverage read shape (or None when absent)."""
        if not data:
            return None
        covered_by_raw = data.get("covered_by") or {}
        return cls(
            planned=tuple(str(item) for item in (data.get("planned") or ())),
            covered=tuple(str(item) for item in (data.get("covered") or ())),
            missing=tuple(str(item) for item in (data.get("missing") or ())),
            covered_by={str(key): str(value) for key, value in dict(covered_by_raw).items()},
            computed_against=str(data.get("computed_against") or COMPUTED_AGAINST_RENDERED),
        )


def _analysis_keywords(analysis: JobAnalysis) -> tuple[str, ...]:
    """The reasoned analysis keywords, normalised + deduplicated, in importance order."""
    ordered: list[str] = []
    seen: set[str] = set()
    for keyword in analysis.keywords:
        normalized = _normalize_phrase(keyword.keyword)
        if normalized and normalized not in seen:
            seen.add(normalized)
            ordered.append(normalized)
    return tuple(ordered)


def compute_keyword_coverage(
    analysis: EmployerAnalysis | JobAnalysis,
    provenance_rows: tuple[BulletProvenance, ...],
) -> KeywordCoverage:
    """Compute honest keyword coverage against the rendered, grounded bullet text.

    ``analysis`` may be the persisted :class:`EmployerAnalysis` aggregate or its
    canonical :class:`JobAnalysis` directly. Only GROUNDED provenance rows
    contribute, and a keyword is covered only when it appears (word-boundary) in
    one of those rows' rendered ``generated_text``.
    """
    canonical = analysis.canonical if isinstance(analysis, EmployerAnalysis) else analysis
    planned = _analysis_keywords(canonical)

    grounded_rows = [row for row in provenance_rows if _is_grounded(row)]
    grounded_texts = [(row.bullet_id, row.generated_text.lower()) for row in grounded_rows]

    covered: list[str] = []
    covered_by: dict[str, str] = {}
    for keyword in planned:
        for bullet_id, text in grounded_texts:
            if _contains_term(text, keyword):
                covered.append(keyword)
                covered_by[keyword] = bullet_id
                break

    covered_set = set(covered)
    missing = tuple(keyword for keyword in planned if keyword not in covered_set)
    return KeywordCoverage(
        planned=planned,
        covered=tuple(covered),
        missing=missing,
        covered_by=covered_by,
    )


__all__ = [
    "COMPUTED_AGAINST_RENDERED",
    "KeywordCoverage",
    "compute_keyword_coverage",
]
