"""Scheduling seam for two independent judgments of one frozen letter draft."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from jobctrl.domain.determinations import DeterminationEnvelope
from jobctrl.domain.ports.artifact_quality import ArtifactQuality
from jobctrl.domain.ports.claim_verification import ClaimVerification


@dataclass(frozen=True)
class LetterReviewResults:
    claims: tuple[ClaimVerification, DeterminationEnvelope]
    quality: tuple[ArtifactQuality, DeterminationEnvelope]


class LetterReviews(Protocol):
    def review(
        self, *, claim_request: dict[str, Any], quality_request: dict[str, Any],
        execution_guard: Callable[[], None] | None = None,
    ) -> LetterReviewResults: ...


class SequentialLetterReviews:
    """Custom domain dependencies retain their caller-thread execution."""

    def __init__(self, claim_verifier, quality_judge):
        self._claims, self._quality = claim_verifier, quality_judge

    def review(self, *, claim_request, quality_request, execution_guard=None):
        if execution_guard is not None:
            execution_guard()
        claims = self._claims.verify(**claim_request)
        if execution_guard is not None:
            execution_guard()
        quality = self._quality.judge(**quality_request)
        return LetterReviewResults(claims, quality)
