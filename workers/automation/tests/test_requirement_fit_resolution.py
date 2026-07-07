"""Requirement-fit scoring formula tests."""

from __future__ import annotations

from jobctrl.domain.scoring import (
    FitScore,
    RequirementFitAssessment,
    RequirementFitReport,
    RequirementFitStatus,
    RequirementFitSummary,
    RequirementScoreContribution,
    RequirementTailoringDirective,
    derive_requirement_fit_signals,
    requirement_fit_value,
    resolve_requirement_fit_report,
    score_breakdown_from_requirement_fit,
)


def _assessment(
    requirement_id: str,
    *,
    tier: str = "must_have",
    weight: float = 0.8,
    status: RequirementFitStatus,
) -> RequirementFitAssessment:
    return RequirementFitAssessment(
        requirement_id=requirement_id,
        requirement_text=f"Requirement {requirement_id}",
        tier=tier,
        weight=weight,
        job_evidence_span=f"Requirement {requirement_id}",
        fit=status,
        contribution=RequirementScoreContribution(
            max_points=0,
            awarded_points=0,
            weighted_impact=0,
            rationale="unresolved",
        ),
        tailoring=RequirementTailoringDirective(
            action="double_down",
            priority=weight,
            allowed_evidence_ids=status.evidence_ids,
            target_keywords=(f"keyword-{requirement_id}",),
            instruction="Use supported evidence.",
        ),
    )


def _report(
    *assessments: RequirementFitAssessment,
    confidence: str = "high",
) -> RequirementFitReport:
    return RequirementFitReport(
        job_id="https://example.com/job/1",
        score_version=1,
        employer_analysis_generation=1,
        profile_snapshot_version=1,
        scoring_policy_version=1,
        formula_version="unresolved",
        resolved_fit_score=None,
        fit_band="plausible",
        confidence=confidence,
        summary=RequirementFitSummary(),
        assessments=assessments,
    )


def test_requirement_fit_value_maps_statuses() -> None:
    assert requirement_fit_value(
        RequirementFitStatus(kind="matched", evidence_ids=("ev-1",), strength="direct")
    ) == 1.0
    assert requirement_fit_value(
        RequirementFitStatus(kind="matched", evidence_ids=("ev-1",), strength="strong")
    ) == 0.85
    assert requirement_fit_value(
        RequirementFitStatus(
            kind="transferable",
            evidence_ids=("ev-2",),
            bridge="Adjacent experience",
        )
    ) == 0.6
    assert requirement_fit_value(RequirementFitStatus(kind="missing", reason="No evidence")) == 0.0


def test_resolve_requirement_fit_report_scores_weighted_requirements() -> None:
    report = _report(
        _assessment(
            "r1",
            tier="must_have",
            weight=0.8,
            status=RequirementFitStatus(
                kind="matched",
                evidence_ids=("ev-r1",),
                strength="direct",
            ),
        ),
        _assessment(
            "r2",
            tier="nice_to_have",
            weight=0.5,
            status=RequirementFitStatus(
                kind="transferable",
                evidence_ids=("ev-r2",),
                bridge="Adjacent incident leadership evidence",
            ),
        ),
        _assessment(
            "r3",
            tier="must_have",
            weight=0.7,
            status=RequirementFitStatus(kind="missing", reason="No profile evidence"),
        ),
    )

    resolved = resolve_requirement_fit_report(report)

    assert resolved.formula_version == "requirement-fit-v1"
    assert resolved.resolved_fit_score == FitScore.create(6)
    assert resolved.fit_band == "plausible"
    assert resolved.summary.weighted_fit == 0.5474
    assert resolved.summary.must_have_coverage == 0.5333
    assert resolved.summary.missing_high_weight_count == 0
    assert resolved.assessments[0].contribution.max_points == 1.0
    assert resolved.assessments[0].contribution.awarded_points == 1.0
    assert resolved.assessments[1].contribution.awarded_points == 0.3
    assert resolved.assessments[2].contribution.awarded_points == 0.0


def test_resolve_requirement_fit_report_caps_blocked_scores() -> None:
    report = _report(
        _assessment(
            "r1",
            tier="must_have",
            weight=0.95,
            status=RequirementFitStatus(
                kind="matched",
                evidence_ids=("ev-r1",),
                strength="direct",
            ),
        ),
        _assessment(
            "r2",
            tier="nice_to_have",
            weight=0.05,
            status=RequirementFitStatus(kind="blocked", blocker="Requires local work authorization"),
        ),
    )

    resolved = resolve_requirement_fit_report(report)

    assert resolved.summary.blocker_count == 1
    assert resolved.resolved_fit_score == FitScore.create(4)
    assert resolved.fit_band == "stretch"


def test_derive_requirement_fit_signals_groups_by_status() -> None:
    resolved = resolve_requirement_fit_report(
        _report(
            _assessment(
                "r1",
                status=RequirementFitStatus(
                    kind="matched",
                    evidence_ids=("ev-r1",),
                    strength="direct",
                ),
            ),
            _assessment(
                "r2",
                status=RequirementFitStatus(
                    kind="transferable",
                    evidence_ids=("ev-r2",),
                    bridge="Adjacent evidence",
                ),
            ),
            _assessment(
                "r3",
                status=RequirementFitStatus(kind="missing", reason="No profile evidence"),
            ),
        )
    )

    signals = derive_requirement_fit_signals(resolved)
    breakdown = score_breakdown_from_requirement_fit(resolved, reasoning="Requirement-led score")

    assert signals.matched_signals == ("Requirement r1",)
    assert signals.transferable_signals == ("Requirement r2",)
    assert signals.missing_signals == ("Requirement r3",)
    assert breakdown.reasoning == "Requirement-led score"
    assert breakdown.matched_signals == signals.matched_signals
    assert breakdown.transferable_signals == signals.transferable_signals
    assert breakdown.missing_signals == signals.missing_signals
