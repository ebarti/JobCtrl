"""Persistence port for pending learning recommendations."""

from __future__ import annotations

from typing import Protocol

from jobctrl.domain.operations.learning import (
    LearningRecommendation,
    RecommendationEvidenceRef,
)


class LearningRecommendationWriter(Protocol):
    """Append deterministic pending recommendations without activating policy."""

    def append_pending(
        self,
        recommendation: LearningRecommendation,
        *,
        contradicting_evidence: tuple[RecommendationEvidenceRef, ...] = (),
        derived_at: str,
    ) -> bool:
        """Persist one immutable recommendation, returning whether it was new."""
        ...


__all__ = ["LearningRecommendationWriter"]
