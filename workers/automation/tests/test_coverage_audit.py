"""Final keyword-coverage audit against rendered text (GROUND-06, Phase 3).

Coverage is computed at generation time against the ACTUAL rendered resume text
both renderers consume — never inferred from the job description (Anti-Pattern 2)
— and a keyword counts as covered ONLY when it appears in a provenance-backed
grounded bullet (success criterion 4 / Pitfall 10): an unsourced skills-dump line
or a substring false positive does NOT count.

These tests pin the audit's two cardinal invariants directly over
``compute_keyword_coverage`` with hand-built provenance rows:

  * covered ⇒ the keyword appears in a bullet that is itself grounded (has an
    evidence/requirement FK binding);
  * a keyword present only in an UNGROUNDED line is reported missing, not covered;
  * a substring collision ("java" inside "javascript") does not count as covered.
"""

from __future__ import annotations

from jobhunter.domain.materials.analysis import (
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
)
from jobhunter.domain.materials.coverage_audit import compute_keyword_coverage
from jobhunter.domain.materials.provenance import BulletProvenance
from jobhunter.domain.materials.value_objects import ControlRule, TransformType


def _analysis(*keywords: str) -> JobAnalysis:
    return JobAnalysis(
        role_framing="Backend.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A backend owner.",
        requirements=[
            Requirement(
                id="req1",
                text="own backend services",
                tier="must_have",
                weight=0.9,
                evidence_span="own backend services",
            ),
        ],
        keywords=[
            ReasonedKeyword(keyword=kw, evidence_span=kw, requirement_ref="req1")
            for kw in keywords
        ],
    )


def _grounded_bullet(text: str, *, bullet_id: str = "experience:e#0") -> BulletProvenance:
    """A bullet WITH an FK binding (a real evidence id) => grounded."""
    return BulletProvenance(
        bullet_id=bullet_id,
        section="experience",
        source_id="e",
        evidence_ids=("ev1",),
        requirement_ids=("req1",),
        matched_keywords=(),
        transform_type=TransformType.REPHRASE,
        control=ControlRule.REPHRASE_ALLOWED,
        rationale="",
        generated_text=text,
    )


def _ungrounded_skill_line(text: str, *, bullet_id: str = "skills:s#0") -> BulletProvenance:
    """A skills line with NO evidence and NO requirement binding => not grounded."""
    return BulletProvenance(
        bullet_id=bullet_id,
        section="skills",
        source_id="s",
        evidence_ids=(),
        requirement_ids=(),
        matched_keywords=(),
        transform_type=TransformType.VERBATIM,
        control=ControlRule.REPHRASE_ALLOWED,
        rationale="",
        generated_text=text,
    )


def test_keyword_in_grounded_bullet_counts_as_covered() -> None:
    analysis = _analysis("kubernetes")
    rows = (_grounded_bullet("Ran services on Kubernetes across three clusters."),)
    coverage = compute_keyword_coverage(analysis, rows)
    assert "kubernetes" in coverage.covered
    assert "kubernetes" not in coverage.missing
    assert coverage.computed_against == "rendered_text"


def test_keyword_only_in_ungrounded_skills_dump_is_missing_not_covered() -> None:
    """Success criterion 4 / Pitfall 10: keyword-stuffing a skills line that has no
    provenance grounding must NOT make the keyword count as covered."""
    analysis = _analysis("kubernetes")
    # The ONLY place "kubernetes" appears is an ungrounded skills-dump line.
    rows = (
        _grounded_bullet("Owned the billing service end to end."),
        _ungrounded_skill_line("Skills: Kubernetes, Terraform, Helm"),
    )
    coverage = compute_keyword_coverage(analysis, rows)
    assert "kubernetes" not in coverage.covered
    assert "kubernetes" in coverage.missing


def test_substring_false_positive_does_not_count() -> None:
    """'java' must not be 'covered' just because 'javascript' appears (Pitfall 10)."""
    analysis = _analysis("java")
    rows = (_grounded_bullet("Shipped a JavaScript SPA for the dashboard."),)
    coverage = compute_keyword_coverage(analysis, rows)
    assert "java" not in coverage.covered
    assert "java" in coverage.missing


def test_covered_records_the_grounded_bullet_it_was_found_in() -> None:
    """Coverage is inspectable: each covered keyword records WHERE it was covered."""
    analysis = _analysis("python")
    rows = (_grounded_bullet("Built Python services.", bullet_id="experience:acme#0"),)
    coverage = compute_keyword_coverage(analysis, rows)
    assert coverage.covered_by["python"] == "experience:acme#0"


def test_missing_list_is_never_empty_when_a_keyword_is_absent() -> None:
    """The missing list is computed (analysis_keywords - covered), never suppressed."""
    analysis = _analysis("python", "rust", "kafka")
    rows = (_grounded_bullet("Built Python services."),)
    coverage = compute_keyword_coverage(analysis, rows)
    assert coverage.covered == ("python",)
    assert set(coverage.missing) == {"rust", "kafka"}


def test_empty_analysis_keywords_is_neutral() -> None:
    analysis = _analysis()
    rows = (_grounded_bullet("Built Python services."),)
    coverage = compute_keyword_coverage(analysis, rows)
    assert coverage.covered == ()
    assert coverage.missing == ()
    assert coverage.coverage_ratio == 0.0


def test_coverage_to_read_model_is_serialisable_and_complete() -> None:
    analysis = _analysis("python", "rust")
    rows = (_grounded_bullet("Built Python services."),)
    read = compute_keyword_coverage(analysis, rows).to_read_model()
    assert read["covered"] == ["python"]
    assert read["missing"] == ["rust"]
    assert read["computed_against"] == "rendered_text"
    assert read["covered_by"] == {"python": "experience:e#0"}
    assert read["counts"] == {"planned": 2, "covered": 1, "missing": 1}
