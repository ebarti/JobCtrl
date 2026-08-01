"""Infrastructure adapters for privacy-safe learning recommendations."""

from jobctrl.infrastructure.learning.sqlite_repository import (
    LearningRecommendationConflict,
    SqliteLearningRecommendationRepository,
)

__all__ = [
    "LearningRecommendationConflict",
    "SqliteLearningRecommendationRepository",
]
