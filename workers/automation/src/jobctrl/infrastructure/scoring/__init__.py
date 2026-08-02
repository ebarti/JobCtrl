"""Scoring adapters — drive the Phase-5 ``ScoreRepository`` port."""

from jobctrl.infrastructure.scoring.criteria_provider import LocalScoringCriteriaProvider
from jobctrl.infrastructure.scoring.feedback import (
    ScoringFeedbackSignal,
    collect_feedback_signals,
)
from jobctrl.infrastructure.scoring.sqlite_repository import (
    SqliteRequirementFitReportRepository,
    SqliteScoreRepository,
    SqliteScoreStalenessRepository,
    SqliteScoringPolicyRepository,
)

__all__ = [
    "LocalScoringCriteriaProvider",
    "ScoringFeedbackSignal",
    "SqliteRequirementFitReportRepository",
    "SqliteScoreRepository",
    "SqliteScoreStalenessRepository",
    "SqliteScoringPolicyRepository",
    "collect_feedback_signals",
]
