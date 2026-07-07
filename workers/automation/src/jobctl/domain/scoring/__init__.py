"""Scoring bounded context — domain layer.

See ddd-target.md §4.4 (JobScore aggregate, value objects, lifecycle).

Public API barrel: aggregate root, value objects, domain services, and the
ports owned by the Scoring context. Adapters live under
``jobctl.infrastructure.scoring``.
"""

from jobctl.domain.scoring.value_objects import (
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
from jobctl.domain.scoring.aggregate import JobScore, ScoreStaleMarker
from jobctl.domain.scoring.policy import (
    CalibrationAnchor,
    CorrectionSignal,
    FitBandThreshold,
    ResolvedScore,
    ScoringPolicy,
    WeightedScoreDimension,
)
from jobctl.domain.scoring.services import (
    ConstraintChecker,
    EligibilityChecker,
    ScoreParser,
    ScoreParseResult,
)
from jobctl.domain.scoring.retrieval import (
    DisabledEmbeddingIndex,
    HybridSearchIndex,
    PostingDocument,
    RetrievedJobCandidate,
    SearchQuery,
    normalize_text,
    preselect_jobs_for_scoring,
    tokenize_text,
)
from jobctl.domain.scoring.requirement_fit import (
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
    "ConstraintChecker",
    "EligibilityChecker",
    "ScoreParser",
    "ScoreParseResult",
    "DisabledEmbeddingIndex",
    "HybridSearchIndex",
    "PostingDocument",
    "RetrievedJobCandidate",
    "SearchQuery",
    "normalize_text",
    "preselect_jobs_for_scoring",
    "tokenize_text",
    "RequirementFitSignals",
    "derive_requirement_fit_signals",
    "requirement_fit_value",
    "resolve_requirement_fit_report",
    "score_breakdown_from_requirement_fit",
]
