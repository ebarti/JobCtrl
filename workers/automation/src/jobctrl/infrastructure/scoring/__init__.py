"""Scoring adapters — drive the Phase-5 ``ScoreRepository`` port."""

from jobctrl.infrastructure.scoring.criteria_provider import LocalScoringCriteriaProvider
from jobctrl.infrastructure.scoring.sqlite_repository import (
    SqliteRequirementFitReportRepository,
    SqliteScoreRepository,
    SqliteScoreStalenessRepository,
    SqliteScoringPolicyRepository,
)

__all__ = [
    "LocalScoringCriteriaProvider",
    "SqliteRequirementFitReportRepository",
    "SqliteScoreRepository",
    "SqliteScoreStalenessRepository",
    "SqliteScoringPolicyRepository",
]
