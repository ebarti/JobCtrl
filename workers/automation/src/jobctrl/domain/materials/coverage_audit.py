"""Coverage is a join over verifier-declared requirement IDs on final line anchors.

Code performs ID membership and arithmetic only. Words appearing in a line or
an available evidence pool do not create coverage. The historical keyword read
shape labels requirements through their analysis-provided keyword references.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:  # pragma: no cover — type-only; avoids a provenance<->coverage cycle
    pass

# How the audit text was sourced — recorded on the result so the read model can
# prove coverage was computed against rendered text, not the JD (the audit label).
COMPUTED_AGAINST_RENDERED = "rendered_text"


@dataclass(frozen=True)
class KeywordCoverage:
    """Generation-time coverage over explicitly recorded requirement bindings.

    ``covered`` / ``declared`` / ``missing`` partition the analysis keywords.
    ``covered_by`` maps each covered keyword to the ``bullet_id`` of the
    evidence-backed bullet that DEMONSTRATES it; ``declared_by`` maps each declared
    keyword to the ``bullet_id`` of the skills line that DECLARES it. Both keep
    coverage inspectable (which bullet backs which keyword, and how) rather than a
    bare count (Pitfall 10 / UX: per-keyword, per-bullet coverage).
    """

    planned: tuple[str, ...]
    covered: tuple[str, ...]
    declared: tuple[str, ...]
    missing: tuple[str, ...]
    covered_by: dict[str, str]
    declared_by: dict[str, str]
    computed_against: str = COMPUTED_AGAINST_RENDERED

    @property
    def coverage_ratio(self) -> float:
        """Demonstrated ratio: covered / planned.

        Deliberately excludes ``declared`` — the ratio measures demonstrated
        coverage, and inflating it with declared-but-undemonstrated skills would be
        the same lie in the other direction. The read model exposes counts for all
        three buckets separately.
        """
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
            "declared": list(self.declared),
            "missing": list(self.missing),
            "covered_by": dict(self.covered_by),
            "declared_by": dict(self.declared_by),
            "counts": {
                "planned": len(self.planned),
                "covered": len(self.covered),
                "declared": len(self.declared),
                "missing": len(self.missing),
            },
        }

    @classmethod
    def from_read_model(cls, data: dict[str, Any] | None) -> KeywordCoverage | None:
        """Rehydrate a persisted coverage read shape (or None when absent).

        Absent records remain absent; reading never infers a source or coverage.
        """
        if not data:
            return None
        covered_by_raw = data.get("covered_by") or {}
        declared_by_raw = data.get("declared_by") or {}
        return cls(
            planned=tuple(str(item) for item in (data.get("planned") or ())),
            covered=tuple(str(item) for item in (data.get("covered") or ())),
            declared=tuple(str(item) for item in (data.get("declared") or ())),
            missing=tuple(str(item) for item in (data.get("missing") or ())),
            covered_by={str(key): str(value) for key, value in dict(covered_by_raw).items()},
            declared_by={str(key): str(value) for key, value in dict(declared_by_raw).items()},
            computed_against=str(data.get("computed_against") or COMPUTED_AGAINST_RENDERED),
        )


def compute_keyword_coverage(analysis, rows):
    # Coverage is a join over the model's explicit requirement bindings, never
    # token overlap or an occurrence of a word in a generated line.
    planned = tuple(dict.fromkeys(keyword.keyword for keyword in analysis.canonical.keywords))
    covered_by, declared_by = {}, {}
    for keyword in analysis.canonical.keywords:
        for row in rows:
            if ({keyword.requirement_ref} if keyword.requirement_ref else set()) & set(row.requirement_ids):
                (declared_by if row.section == "skills" else covered_by).setdefault(keyword.keyword, row.bullet_id)
    covered = tuple(item for item in planned if item in covered_by)
    declared = tuple(item for item in planned if item not in covered_by and item in declared_by)
    missing = tuple(item for item in planned if item not in covered_by and item not in declared_by)
    return KeywordCoverage(planned, covered, declared, missing, covered_by, declared_by)
