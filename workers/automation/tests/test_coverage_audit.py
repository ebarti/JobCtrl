"""Coverage arithmetic follows recorded requirement IDs, independent of words."""

from types import SimpleNamespace

from jobctrl.domain.materials.analysis import JobAnalysis, ReasonedKeyword, Requirement
from jobctrl.domain.materials.coverage_audit import KeywordCoverage, compute_keyword_coverage
from jobctrl.domain.materials.provenance import BulletProvenance
from jobctrl.domain.materials.value_objects import ControlRule, TransformType


def analysis():
    return SimpleNamespace(
        canonical=JobAnalysis(
            role_framing="Synthetic role",
            inferred_seniority="unknown",
            ideal_candidate_narrative="Synthetic narrative",
            requirements=[
                Requirement(id="req", text="Synthetic requirement", tier="must_have", weight=1, evidence_span="Source")
            ],
            keywords=[ReasonedKeyword(keyword="Synthetic label", evidence_span="Source", requirement_ref="req")],
        )
    )


def row(*, requirements=(), section="experience"):
    return BulletProvenance(
        bullet_id="line:1",
        section=section,
        source_id="entry",
        evidence_ids=("fact",),
        requirement_ids=requirements,
        matched_keywords=(),
        transform_type=TransformType.REPHRASE,
        control=ControlRule.CLAIM_VERIFICATION,
        rationale="Model anchor",
        generated_text="Identical synthetic output",
    )


def test_only_recorded_requirement_id_creates_coverage():
    bound = compute_keyword_coverage(analysis(), [row(requirements=("req",))])
    unbound = compute_keyword_coverage(analysis(), [row()])
    assert bound.covered == ("Synthetic label",)
    assert bound.covered_by == {"Synthetic label": "line:1"}
    assert bound.coverage_ratio == 1
    assert unbound.covered == () and unbound.missing == ("Synthetic label",)


def test_declared_and_demonstrated_partition_uses_recorded_section():
    declared = compute_keyword_coverage(analysis(), [row(requirements=("req",), section="skills")])
    assert declared.declared == ("Synthetic label",) and declared.coverage_ratio == 0
    combined = compute_keyword_coverage(
        analysis(), [row(requirements=("req",), section="skills"), row(requirements=("req",))]
    )
    assert combined.covered == ("Synthetic label",) and combined.declared == ()


def test_coverage_read_shape_round_trip_does_not_infer_missing_metadata():
    coverage = compute_keyword_coverage(analysis(), [row(requirements=("req",))])
    assert KeywordCoverage.from_read_model(coverage.to_read_model()) == coverage
    assert KeywordCoverage.from_read_model(None) is None
