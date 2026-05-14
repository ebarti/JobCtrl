"""JobScore aggregate root.

See ddd-target.md §4.4. ``JobScore`` is the canonical fact about a job's
fit; identity is ``(TenantId, JobId, version)`` so each rescore (LLM or
human override) produces a NEW aggregate rather than mutating the previous
one. The repository (``ScoreRepository`` in
``jobhunter.domain.scoring.ports``) owns persistence and version
allocation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.scoring.value_objects import (
    FitScore,
    MatchedKeywords,
    ScoreBreakdown,
    ScoreCorrection,
    ScoreTrace,
    ScoringCriteria,
)
from jobhunter.domain.tenant import TenantId


@dataclass(frozen=True)
class JobScore:
    """Aggregate root capturing one scoring of one job at one point in time.

    Identity is the triple ``(tenant_id, job_id, version)``. ``version`` is
    monotonically increasing per ``(tenant_id, job_id)`` and is allocated by
    the repository on save. The aggregate is immutable — to issue a new
    score (rescore or correction), call ``next_version`` on the existing
    instance to derive a fresh aggregate with the version bumped, or use
    the dedicated ``with_correction`` helper.
    """

    tenant_id: TenantId
    job_id: JobId
    version: int
    fit_score: FitScore
    breakdown: ScoreBreakdown
    matched_keywords: MatchedKeywords
    scored_at: str
    criteria: ScoringCriteria = field(default_factory=ScoringCriteria)
    trace: ScoreTrace = field(default_factory=ScoreTrace)
    correction: ScoreCorrection | None = None

    # ------------------------------------------------------------------
    # Invariants
    # ------------------------------------------------------------------

    def __post_init__(self) -> None:
        if not isinstance(self.fit_score, FitScore):
            raise ValueError("JobScore.fit_score must be a FitScore")
        if not isinstance(self.breakdown, ScoreBreakdown):
            raise ValueError("JobScore.breakdown must be a ScoreBreakdown")
        if not isinstance(self.matched_keywords, MatchedKeywords):
            raise ValueError("JobScore.matched_keywords must be a MatchedKeywords")
        if not isinstance(self.criteria, ScoringCriteria):
            raise ValueError("JobScore.criteria must be a ScoringCriteria")
        if not isinstance(self.trace, ScoreTrace):
            raise ValueError("JobScore.trace must be a ScoreTrace")
        if not isinstance(self.version, int) or self.version < 1:
            raise ValueError(f"JobScore.version must be >= 1, got {self.version!r}")
        if not isinstance(self.scored_at, str) or not self.scored_at.strip():
            raise ValueError("JobScore.scored_at must be a non-empty ISO-8601 timestamp")
        if self.correction is not None and not isinstance(self.correction, ScoreCorrection):
            raise ValueError("JobScore.correction must be a ScoreCorrection or None")

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------

    @classmethod
    def initial(
        cls,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        fit_score: FitScore,
        breakdown: ScoreBreakdown,
        matched_keywords: MatchedKeywords,
        scored_at: str,
        criteria: ScoringCriteria | None = None,
        trace: ScoreTrace | None = None,
    ) -> "JobScore":
        """Create the first version (version=1) of a JobScore."""
        return cls(
            tenant_id=tenant_id,
            job_id=job_id,
            version=1,
            fit_score=fit_score,
            breakdown=breakdown,
            matched_keywords=matched_keywords,
            scored_at=scored_at,
            criteria=criteria or ScoringCriteria(),
            trace=trace or ScoreTrace(),
            correction=None,
        )

    def next_version(
        self,
        *,
        fit_score: FitScore,
        breakdown: ScoreBreakdown,
        matched_keywords: MatchedKeywords,
        scored_at: str,
        criteria: ScoringCriteria | None = None,
        trace: ScoreTrace | None = None,
        correction: ScoreCorrection | None = None,
    ) -> "JobScore":
        """Return a new ``JobScore`` with ``version + 1`` and replaced fields.

        Use this when rescoring — never mutate an existing ``JobScore``.
        """
        return JobScore(
            tenant_id=self.tenant_id,
            job_id=self.job_id,
            version=self.version + 1,
            fit_score=fit_score,
            breakdown=breakdown,
            matched_keywords=matched_keywords,
            scored_at=scored_at,
            criteria=criteria or self.criteria,
            trace=trace or self.trace,
            correction=correction,
        )

    def with_correction(self, correction: ScoreCorrection) -> "JobScore":
        """Apply a user override and return a new version.

        The returned aggregate's ``fit_score`` reflects the corrected value
        (single source of truth post-correction); the original score remains
        on the previous version's record for audit. ``scored_at`` is
        replaced with the correction's timestamp so consumers see the
        actual moment the score changed.
        """
        return self.next_version(
            fit_score=correction.corrected_fit_score,
            breakdown=self.breakdown,
            matched_keywords=self.matched_keywords,
            scored_at=correction.corrected_at,
            criteria=self.criteria,
            trace=self.trace.with_correction(
                original_score=self.fit_score.value,
                correction=correction,
            ),
            correction=correction,
        )

    # ------------------------------------------------------------------
    # Serialization (used by the repository adapter)
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "tenant_id": str(self.tenant_id),
            "job_id": str(self.job_id),
            "version": self.version,
            "fit_score": self.fit_score.value,
            "breakdown": self.breakdown.to_dict(),
            "matched_keywords": self.matched_keywords.to_list(),
            "scored_at": self.scored_at,
            "criteria": self.criteria.to_dict(),
            "trace": self.trace.to_dict(),
            "correction": self.correction.to_dict() if self.correction else None,
        }
