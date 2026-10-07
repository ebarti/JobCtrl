"""Scoring bounded context — domain layer.

See ddd-target.md §4.4 (JobScore aggregate, value objects, lifecycle).

Public API barrel: aggregate root, value objects, domain services, and the
ports owned by the Scoring context. Adapters live under
``jobctrl.infrastructure.scoring``.
"""

from jobctrl.domain.scoring.value_objects import (
    EligibilityAssessment,
    FitScore,
    MatchedKeywords,
    RequirementArtifactCoverage,
    RequirementFitAssessment,
    RequirementFitReport,
    RequirementFitStatus,
    RequirementFitSummary,
    RequirementScoreContribution,
    RequirementTailoringDirective,
    ScoreBreakdown,
    ScoreCorrection,
    ScoreTrace,
    ScoringCriteria,
)
from jobctrl.domain.scoring.aggregate import JobScore, ScoreStaleMarker
from jobctrl.domain.scoring.policy import (
    CalibrationAnchor,
    CorrectionSignal,
    FitBandThreshold,
    ResolvedScore,
    ScoringPolicy,
    WeightedScoreDimension,
)
from jobctrl.domain.scoring.services import (
    EligibilityChecker,
    ScoreParser,
    ScoreParseResult,
)
from jobctrl.domain.scoring.retrieval import preselect_jobs_for_scoring

from jobctrl.domain.scoring.requirement_fit import (
    RequirementFitSignals,
    derive_requirement_fit_signals,
    requirement_fit_value,
    resolve_requirement_fit_report,
    score_breakdown_from_requirement_fit,
)

__all__ = [
    "EligibilityAssessment",
    "FitScore",
    "MatchedKeywords",
    "RequirementArtifactCoverage",
    "RequirementFitAssessment",
    "RequirementFitReport",
    "RequirementFitStatus",
    "RequirementFitSummary",
    "RequirementScoreContribution",
    "RequirementTailoringDirective",
    "ScoreBreakdown",
    "ScoreCorrection",
    "ScoreTrace",
    "ScoringCriteria",
    "JobScore",
    "ScoreStaleMarker",
    "CalibrationAnchor",
    "CorrectionSignal",
    "FitBandThreshold",
    "ResolvedScore",
    "ScoringPolicy",
    "WeightedScoreDimension",
    "EligibilityChecker",
    "ScoreParser",
    "ScoreParseResult",
    "preselect_jobs_for_scoring",
    "RequirementFitSignals",
    "derive_requirement_fit_signals",
    "requirement_fit_value",
    "resolve_requirement_fit_report",
    "score_breakdown_from_requirement_fit",
]
