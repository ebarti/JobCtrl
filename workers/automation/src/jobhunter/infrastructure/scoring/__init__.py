"""Scoring adapters — drive the Phase-5 ``ScoreRepository`` port."""

from jobhunter.infrastructure.scoring.criteria_provider import LocalScoringCriteriaProvider
from jobhunter.infrastructure.scoring.feedback import (
    FeedbackRankedJob,
    ScoringFeedbackSignal,
    collect_feedback_signals,
    rank_jobs_with_feedback,
)
from jobhunter.infrastructure.scoring.sqlite_repository import (
    SqliteScoreRepository,
    SqliteScoringPolicyRepository,
)

__all__ = [
    "FeedbackRankedJob",
    "LocalScoringCriteriaProvider",
    "ScoringFeedbackSignal",
    "SqliteScoreRepository",
    "SqliteScoringPolicyRepository",
    "collect_feedback_signals",
    "rank_jobs_with_feedback",
]
