"""Requirement-led fit score resolution.

Pure domain functions for turning a requirement fit report into a deterministic
score summary. The scoring use case will wire this into the LLM/analysis flow in
a later slice; this module owns only the formula and derived compatibility
signals.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

from jobctl.domain.scoring.value_objects import (
    FitScore,
    RequirementFitAssessment,
    RequirementFitReport,
    RequirementFitStatus,
    RequirementFitSummary,
    RequirementScoreContribution,
    ScoreBreakdown,
    fit_band_for_score,
)

REQUIREMENT_FIT_FORMULA_VERSION = "requirement-fit-v1"
MUST_HAVE_TIER_MULTIPLIER = 1.25
NICE_TO_HAVE_TIER_MULTIPLIER = 1.0
TRANSFERABLE_FIT_VALUE = 0.6
MISSING_HIGH_WEIGHT_THRESHOLD = 0.75
BLOCKED_SCORE_CAP = 4


@dataclass(frozen=True)
class RequirementFitSignals:
    """Legacy score-signal buckets derived from requirement fit rows."""

    matched_signals: tuple[str, ...] = ()
    missing_signals: tuple[str, ...] = ()
    transferable_signals: tuple[str, ...] = ()


def resolve_requirement_fit_report(report: RequirementFitReport) -> RequirementFitReport:
    """Return ``report`` with deterministic contributions, summary, and score.

    The formula follows the plan's ``sum(weight * tier * fit) / sum(weight *
    tier)`` model. Hard blockers cap the final fit score after the weighted score
    has been recorded in the summary.
    """

    assessments = tuple(_assessment_with_contribution(item) for item in report.assessments)
    total_points = sum(item.contribution.max_points for item in assessments)
    awarded_points = sum(item.contribution.awarded_points for item in assessments)
    weighted_fit = 0.0 if total_points <= 0 else awarded_points / total_points

    must_haves = tuple(item for item in assessments if item.tier == "must_have")
    must_total = sum(item.contribution.max_points for item in must_haves)
    must_awarded = sum(item.contribution.awarded_points for item in must_haves)
    must_have_coverage = 0.0 if must_total <= 0 else must_awarded / must_total

    blocker_count = sum(1 for item in assessments if item.fit.kind == "blocked")
    missing_high_weight_count = sum(
        1
        for item in assessments
        if item.fit.kind in {"missing", "blocked"}
        and item.weight >= MISSING_HIGH_WEIGHT_THRESHOLD
    )
    summary = RequirementFitSummary(
        weighted_fit=round(weighted_fit, 4),
        must_have_coverage=round(must_have_coverage, 4),
        blocker_count=blocker_count,
        missing_high_weight_count=missing_high_weight_count,
    )
    resolved_score = _score_from_weighted_fit(weighted_fit, blocker_count=blocker_count)
    return replace(
        report,
        formula_version=REQUIREMENT_FIT_FORMULA_VERSION,
        resolved_fit_score=resolved_score,
        fit_band=fit_band_for_score(resolved_score.value) if resolved_score else report.fit_band,
        summary=summary,
        assessments=assessments,
    )


def derive_requirement_fit_signals(report: RequirementFitReport) -> RequirementFitSignals:
    """Derive compatibility matched/missing/transferable signals from rows."""

    matched: list[str] = []
    missing: list[str] = []
    transferable: list[str] = []
    for assessment in report.assessments:
        label = assessment.requirement_text
        if assessment.fit.kind == "matched":
            matched.append(label)
        elif assessment.fit.kind == "transferable":
            transferable.append(label)
        elif assessment.fit.kind in {"missing", "blocked"}:
            missing.append(label)
    return RequirementFitSignals(
        matched_signals=tuple(dict.fromkeys(matched)),
        missing_signals=tuple(dict.fromkeys(missing)),
        transferable_signals=tuple(dict.fromkeys(transferable)),
    )


def score_breakdown_from_requirement_fit(
    report: RequirementFitReport,
    *,
    reasoning: str = "",
) -> ScoreBreakdown:
    """Build a compatibility ``ScoreBreakdown`` from a requirement fit report."""

    signals = derive_requirement_fit_signals(report)
    return ScoreBreakdown(
        reasoning=reasoning,
        fit_band=report.fit_band,
        confidence=report.confidence,
        matched_signals=signals.matched_signals,
        missing_signals=signals.missing_signals,
        transferable_signals=signals.transferable_signals,
    )


def requirement_fit_value(status: RequirementFitStatus) -> float:
    """Return the numeric fit value for one requirement status."""

    if status.kind == "matched":
        return 1.0 if status.strength == "direct" else 0.85
    if status.kind == "transferable":
        return TRANSFERABLE_FIT_VALUE
    return 0.0


def _assessment_with_contribution(
    assessment: RequirementFitAssessment,
) -> RequirementFitAssessment:
    max_points = assessment.weight * _tier_multiplier(assessment.tier)
    fit_value = requirement_fit_value(assessment.fit)
    awarded_points = max_points * fit_value
    return replace(
        assessment,
        contribution=RequirementScoreContribution(
            max_points=round(max_points, 4),
            awarded_points=round(awarded_points, 4),
            weighted_impact=round(awarded_points, 4),
            rationale=_contribution_rationale(assessment, fit_value),
        ),
    )


def _score_from_weighted_fit(
    weighted_fit: float,
    *,
    blocker_count: int,
) -> FitScore | None:
    raw = 1 + math.floor((9 * weighted_fit) + 0.5)
    capped = max(1, min(10, int(raw)))
    if blocker_count:
        capped = min(capped, BLOCKED_SCORE_CAP)
    return FitScore.create(capped)


def _tier_multiplier(tier: str) -> float:
    return MUST_HAVE_TIER_MULTIPLIER if tier == "must_have" else NICE_TO_HAVE_TIER_MULTIPLIER


def _contribution_rationale(
    assessment: RequirementFitAssessment,
    fit_value: float,
) -> str:
    if assessment.fit.kind == "matched":
        return (
            f"{assessment.fit.strength or 'matched'} profile evidence covers "
            f"{assessment.requirement_id} at {fit_value:.2f} fit value."
        )
    if assessment.fit.kind == "transferable":
        return f"Transferable evidence partially covers {assessment.requirement_id}: {assessment.fit.bridge}"
    if assessment.fit.kind == "blocked":
        return f"Requirement {assessment.requirement_id} is blocked: {assessment.fit.blocker}"
    if assessment.fit.kind == "missing":
        return f"Requirement {assessment.requirement_id} is missing: {assessment.fit.reason}"
    return f"Requirement {assessment.requirement_id} was not assessed: {assessment.fit.reason}"


__all__ = [
    "BLOCKED_SCORE_CAP",
    "MISSING_HIGH_WEIGHT_THRESHOLD",
    "MUST_HAVE_TIER_MULTIPLIER",
    "NICE_TO_HAVE_TIER_MULTIPLIER",
    "REQUIREMENT_FIT_FORMULA_VERSION",
    "TRANSFERABLE_FIT_VALUE",
    "RequirementFitSignals",
    "derive_requirement_fit_signals",
    "requirement_fit_value",
    "resolve_requirement_fit_report",
    "score_breakdown_from_requirement_fit",
]
