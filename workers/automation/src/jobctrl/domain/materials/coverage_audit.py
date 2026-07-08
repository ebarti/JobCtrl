"""Final keyword-coverage audit against the rendered text (GROUND-06, Phase 3).

The honest coverage computation, run at generation time AFTER the voice pass so it
sees the exact text the renderers ship (Pitfall 4), and computed so that a keyword
counts as covered ONLY when it appears in a bullet backed by real profile evidence
(success criterion 4 / Pitfall 10). This closes two anti-patterns at once:

  * **Never inferred from the JD** (Anti-Pattern 2 / CLAUDE.md auditability): the
    only text consulted is the provenance rows' ``generated_text`` — the byte-
    identical rendered line the HTML renderer consumes (the provenance builder
    already anchors ``generated_text`` to that line). The
    ``missing`` list is computed as ``analysis_keywords − covered − declared``,
    never derived from the job description and never suppressed.
  * **Never keyword-stuffed / substring-faked** (Pitfall 10): a keyword is covered
    only when it appears (word-boundary, via :func:`_contains_term`, so ``java``
    does not match ``javascript``) in a bullet backed by real profile EVIDENCE —
    the bullet carries a canonical evidence FK (``evidence_ids``), or the keyword
    itself traces to the profile evidence corpus. A requirement FK does NOT count:
    the provenance builder binds a requirement whenever one of its keywords appears
    in the line (``provenance_builder._served_requirements``), so crediting coverage
    off that binding is circular — the keyword would ground itself, and the guard
    would reward the very stuffing it exists to catch.

Coverage partitions the analysis keywords into THREE honestly-labeled buckets:

  * ``covered`` — demonstrated: rendered in an evidence-backed bullet (above).
  * ``declared`` — rendered word-boundary in a SKILLS-SECTION provenance row but NOT
    demonstrated in experience/evidence. The skills rows render the LLM's
    ``tailored_skill_items`` (with ``allow_skill_reordering`` — default True — those
    are reordered/trimmed profile skills, not raw ``get_skill_categories`` output),
    so a *surfaced* declared keyword is profile-grounded NOT by the row's
    construction but by the approval-gated surfacing chain: coverage is read only
    from the persisted ``coverage_audit_json``, which ``use_cases`` records only when
    the resume is approved (``is_resume_approved``); approval requires
    ``validation.passed``; and the ``ContentValidator`` "Fabricated skill" check
    (``services``) fails validation for any skills item absent from the profile's
    declared category. So every skills item in an approved generation is a genuine
    profile declaration — reporting one ``missing`` (as if absent) was a lying audit
    surface, and the prose fabrication gate already treats declared skills as backed.
    ``declared`` is NOT ``covered``: it records what the resume declares, not what
    its experience demonstrates. (Edge: a terminal ``failed_validation`` generation
    may still class a fabricated skill ``declared`` inside the internal
    ``keyword_coverage_v2`` report metadata, which the read model never surfaces.)
  * ``missing`` — planned but rendered in no shipped bullet (or only in an
    ungrounded non-skills line): absent from the artifact the employer receives.

Pure data, no I/O, no LLM. The use case calls this once on the SELECTED, voiced
candidate's provenance rows and persists the result canonically on the
:class:`BulletProvenanceSet` so the read model serves generation-time truth.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from jobctrl.domain.materials.analysis import EmployerAnalysis, JobAnalysis
from jobctrl.domain.materials.quality import _contains_term, _normalize_phrase

if TYPE_CHECKING:  # pragma: no cover — type-only; avoids a provenance<->coverage cycle
    from jobctrl.domain.materials.fabrication_detector import EvidenceCorpus
    from jobctrl.domain.materials.provenance import BulletProvenance

# How the audit text was sourced — recorded on the result so the read model can
# prove coverage was computed against rendered text, not the JD (the audit label).
COMPUTED_AGAINST_RENDERED = "rendered_text"

# Skills-section provenance rows carry this ``bullet_id`` prefix / ``section``. A
# keyword rendered only here (not evidence-backed) is ``declared`` rather than
# ``missing``: its profile grounding rests on the approval-gated surfacing chain
# (validation's "Fabricated skill" gate + approval-only persistence of
# ``coverage_audit_json``), not on the row's construction — see the module docstring.
_SKILLS_SECTION = "skills"


@dataclass(frozen=True)
class KeywordCoverage:
    """Generation-time keyword coverage computed against rendered, evidence-backed text.

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

        ``declared`` / ``declared_by`` default to empty so a pre-A6b persisted row
        (two-bucket covered/missing) rehydrates cleanly — a backward-compatible read.
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
    corpus: EvidenceCorpus,
) -> KeywordCoverage:
    """Compute honest keyword coverage against the rendered, evidence-backed text.

    ``analysis`` may be the persisted :class:`EmployerAnalysis` aggregate or its
    canonical :class:`JobAnalysis` directly. Each planned keyword is classified into
    exactly one bucket, checked in precedence order:

      * ``covered`` (demonstrated) — it appears (word-boundary) in a rendered bullet
        backed by real profile evidence: the bullet carries a canonical evidence FK
        (``evidence_ids``), or the keyword itself traces (word-boundary) to the
        profile ``corpus``. A requirement FK is deliberately NOT sufficient — the
        provenance builder binds a requirement whenever one of its keywords appears
        in the line, so crediting coverage off that binding would let a keyword
        ground itself and reward the stuffing this audit exists to catch.
      * ``declared`` — otherwise, it appears (word-boundary) in a SKILLS-SECTION row
        (``section == "skills"``). A *surfaced* skills item is a genuine profile
        declaration not by construction (the row renders the LLM's reordered
        ``tailored_skill_items``) but because coverage is persisted only for an
        approved resume and approval requires validation, whose "Fabricated skill"
        gate rejects any skills item outside the profile's declared category (see the
        module docstring). Reporting such a keyword ``missing`` contradicted the
        artifact; the prose fabrication gate already treats declared skills as backed.
        Declared is honestly distinct from covered: rendered from a declaration, not
        demonstrated by experience/evidence.
      * ``missing`` — planned − covered − declared: rendered in no shipped bullet, or
        only in an ungrounded non-skills line the employer never legitimately reads.
    """
    canonical = analysis.canonical if isinstance(analysis, EmployerAnalysis) else analysis
    planned = _analysis_keywords(canonical)

    rows_with_text = [(row, row.generated_text.lower()) for row in provenance_rows]

    covered: list[str] = []
    covered_by: dict[str, str] = {}
    declared: list[str] = []
    declared_by: dict[str, str] = {}
    for keyword in planned:
        keyword_in_evidence = _contains_term(corpus.text, keyword)
        demonstrated_bullet: str | None = None
        declared_bullet: str | None = None
        for row, text in rows_with_text:
            if not _contains_term(text, keyword):
                continue
            if row.evidence_ids or keyword_in_evidence:
                demonstrated_bullet = row.bullet_id
                break
            if declared_bullet is None and row.section == _SKILLS_SECTION:
                declared_bullet = row.bullet_id
        if demonstrated_bullet is not None:
            covered.append(keyword)
            covered_by[keyword] = demonstrated_bullet
        elif declared_bullet is not None:
            declared.append(keyword)
            declared_by[keyword] = declared_bullet

    accounted = set(covered) | set(declared)
    missing = tuple(keyword for keyword in planned if keyword not in accounted)
    return KeywordCoverage(
        planned=planned,
        covered=tuple(covered),
        declared=tuple(declared),
        missing=missing,
        covered_by=covered_by,
        declared_by=declared_by,
    )


__all__ = [
    "COMPUTED_AGAINST_RENDERED",
    "KeywordCoverage",
    "compute_keyword_coverage",
]
