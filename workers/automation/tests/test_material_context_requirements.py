"""Canonical context remains available without forcing it into new prose."""

from dataclasses import replace

import pytest

from jobctrl.domain.materials.claim_grounding import ground_claim_mappings
from jobctrl.domain.materials.requirement_coverage import (
    score_generated_resume_against_target,
    validate_mandatory_covered_achievements,
)
from jobctrl.domain.materials.resume_document import build_resume_document
from jobctrl.domain.scoring import RequirementFitStatus
from tests.test_materials_quality import (
    _profile,
    _requirement_analysis,
    _requirement_fit_report,
    _senior_job,
    build_tailoring_plan,
)


@pytest.mark.parametrize(
    "evidence_id",
    [
        "experience:acme_swe:date_range",
        "experience:acme_swe:location",
        "experience:acme_swe:title",
        "experience:acme_swe:company",
        "education:edu_state",
        "skills:languages",
        "executive_profile:baseline",
    ],
)
def test_context_edge_does_not_require_a_generated_claim(evidence_id):
    profile = _profile()
    report = _requirement_fit_report()
    first = report.assessments[0]
    report = replace(report, assessments=(replace(
        first,
        fit=RequirementFitStatus(
            kind="transferable", evidence_ids=(evidence_id,),
            strength="moderate", bridge="Synthetic model-selected context",
        ),
        tailoring=replace(first.tailoring, allowed_evidence_ids=(evidence_id,)),
    ), *report.assessments[1:]))
    plan = build_tailoring_plan(
        profile, _senior_job(), employer_analysis=_requirement_analysis(),
        requirement_fit_report=report,
    )
    graph = plan.coverage_graph
    assert graph is not None
    assert evidence_id in plan.evidence_by_id and evidence_id in graph.achievement_ids
    assert any(edge.achievement_evidence_id == evidence_id for edge in graph.coverage_edges)
    assert validate_mandatory_covered_achievements(graph, ()) == ()
    # Omitting a context claim never grants generated coverage automatically.
    score = score_generated_resume_against_target(
        target_profile=plan.target_profile, mappings=(), grounding=ground_claim_mappings((), ()),
    )
    assert score.covered_requirement_ids == () and score.must_have_coverage == 0
    assert build_resume_document({}, profile)["experience"][0]["date_range"] == "2020-Present"


def test_selected_achievement_still_requires_a_generated_claim():
    plan = build_tailoring_plan(
        _profile(), _senior_job(), employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    assert validate_mandatory_covered_achievements(plan.coverage_graph, ()) == ("ev_latency",)


def test_explicit_user_pin_keeps_a_context_source_required():
    from jobctrl.domain.materials.requirement_coverage import AchievementNode, CoverageEdge, CoverageGraph

    graph = CoverageGraph(
        achievements=(AchievementNode(
            "opaque-source", "opaque-owner", "Authored context", pinned=True,
            requires_generated_claim=False,
        ),),
        coverage_edges=(CoverageEdge(
            "opaque-edge", "requirement", "opaque-source", "direct", "direct", "verified_only",
        ),),
    )
    assert validate_mandatory_covered_achievements(graph, ()) == ("opaque-source",)
