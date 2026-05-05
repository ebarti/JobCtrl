"""Scoring bounded context — domain layer.

See ddd-target.md §4.4 (JobScore aggregate, value objects, lifecycle).

Public API barrel: aggregate root, value objects, domain services, and the
ports owned by the Scoring context. Adapters live under
``jobhunter.infrastructure.scoring``.
"""

from jobhunter.domain.scoring.value_objects import (
    FitScore,
    MatchedKeywords,
    ScoreBreakdown,
    ScoreCorrection,
    ScoringCriteria,
)
from jobhunter.domain.scoring.aggregate import JobScore
from jobhunter.domain.scoring.services import (
    EligibilityChecker,
    ScoreParser,
    ScoreParseResult,
)

__all__ = [
    "FitScore",
    "MatchedKeywords",
    "ScoreBreakdown",
    "ScoreCorrection",
    "ScoringCriteria",
    "JobScore",
    "EligibilityChecker",
    "ScoreParser",
    "ScoreParseResult",
]
