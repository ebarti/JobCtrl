"""Scoring bounded context — domain layer.

See ddd-target.md §4.4 (JobScore aggregate, value objects, lifecycle).

Public API barrel: aggregate root, value objects, domain services, and the
ports owned by the Scoring context. Adapters live under
``jobhunter.infrastructure.scoring``.
"""

from jobhunter.domain.scoring.value_objects import (
    EligibilityAssessment,
    FitScore,
    MatchedKeywords,
    ScoreBreakdown,
    ScoreCorrection,
    ScoreTrace,
    ScoringCriteria,
)
from jobhunter.domain.scoring.aggregate import JobScore
from jobhunter.domain.scoring.policy import (
    CalibrationAnchor,
    FitBandThreshold,
    ResolvedScore,
    ScoringPolicy,
    WeightedScoreDimension,
)
from jobhunter.domain.scoring.services import (
    ConstraintChecker,
    EligibilityChecker,
    ScoreParser,
    ScoreParseResult,
)
from jobhunter.domain.scoring.retrieval import (
    DisabledEmbeddingIndex,
    HybridSearchIndex,
    PostingDocument,
    RetrievedJobCandidate,
    SearchQuery,
    normalize_text,
    preselect_jobs_for_scoring,
    tokenize_text,
)

__all__ = [
    "EligibilityAssessment",
    "FitScore",
    "MatchedKeywords",
    "ScoreBreakdown",
    "ScoreCorrection",
    "ScoreTrace",
    "ScoringCriteria",
    "JobScore",
    "CalibrationAnchor",
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
]
