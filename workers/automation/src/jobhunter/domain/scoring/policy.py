"""Versioned scoring policy model.

The policy turns structured scoring evidence into the persisted
``FitScore``. The LLM may still propose an overall score, but that score is
input evidence only; deterministic policy resolution owns the final grade.
"""

from __future__ import annotations

from collections.abc import Mapping as MappingABC
from dataclasses import dataclass
from typing import Any

from jobhunter.domain.scoring.value_objects import FIT_BANDS, FitScore, ScoreBreakdown
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId

DEFAULT_SCORING_POLICY_VERSION = 1
DEFAULT_RUBRIC_VERSION = "default-scoring-rubric-v1"
DEFAULT_DIMENSION_WEIGHTS: tuple[tuple[str, float], ...] = (
    ("technical_fit", 0.45),
    ("experience_fit", 0.30),
    ("role_fit", 0.25),
)
DEFAULT_FIT_BAND_THRESHOLDS: tuple[tuple[str, int], ...] = (
    ("excellent", 9),
    ("strong", 7),
    ("plausible", 5),
    ("stretch", 3),
    ("poor", 1),
)


@dataclass(frozen=True)
class WeightedScoreDimension:
    """One deterministic scoring input and its policy weight."""

    name: str
    weight: float

    def __post_init__(self) -> None:
        name = str(self.name or "").strip()
        if not name:
            raise ValueError("WeightedScoreDimension.name must be non-empty")
        try:
            weight = float(self.weight)
        except (TypeError, ValueError) as exc:
            raise ValueError("WeightedScoreDimension.weight must be numeric") from exc
        if weight <= 0:
            raise ValueError("WeightedScoreDimension.weight must be positive")
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "weight", weight)

    @classmethod
    def from_dict(cls, data: MappingABC[str, Any]) -> "WeightedScoreDimension":
        return cls(name=str(data.get("name") or ""), weight=float(data.get("weight") or 0))

    def value_from(self, breakdown: ScoreBreakdown) -> int:
        value = getattr(breakdown, self.name, None)
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError(f"ScoreBreakdown has no integer dimension {self.name!r}")
        if value < 0 or value > 10:
            raise ValueError(f"ScoreBreakdown.{self.name} must be in [0, 10], got {value}")
        return value

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "weight": self.weight}


@dataclass(frozen=True)
class CalibrationAnchor:
    """Persisted calibration reference.

    This first policy PR stores anchors but does not learn from correction
    signals yet. Future stacked PRs can populate this value object without
    changing the policy persistence table.
    """

    anchor_id: str
    job_id: str = ""
    fit_score: FitScore | None = None
    rationale: str = ""
    dimensions: tuple[str, ...] = ()
    created_at: str = ""

    def __post_init__(self) -> None:
        anchor_id = str(self.anchor_id or "").strip()
        if not anchor_id:
            raise ValueError("CalibrationAnchor.anchor_id must be non-empty")
        object.__setattr__(self, "anchor_id", anchor_id)
        object.__setattr__(self, "job_id", str(self.job_id or "").strip())
        object.__setattr__(self, "rationale", str(self.rationale or "").strip())
        object.__setattr__(
            self,
            "dimensions",
            tuple(str(value).strip() for value in self.dimensions if str(value).strip()),
        )
        object.__setattr__(self, "created_at", str(self.created_at or "").strip())

    @classmethod
    def from_dict(cls, data: MappingABC[str, Any]) -> "CalibrationAnchor":
        score = FitScore.from_optional(data.get("fit_score", data.get("fitScore")))
        raw_dimensions = data.get("dimensions", ())
        dimensions = raw_dimensions if isinstance(raw_dimensions, list) else ()
        return cls(
            anchor_id=str(data.get("anchor_id", data.get("anchorId", ""))),
            job_id=str(data.get("job_id", data.get("jobId", "")) or ""),
            fit_score=score,
            rationale=str(data.get("rationale") or ""),
            dimensions=tuple(dimensions),
            created_at=str(data.get("created_at", data.get("createdAt", "")) or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "anchor_id": self.anchor_id,
            "job_id": self.job_id,
            "fit_score": self.fit_score.value if self.fit_score else None,
            "rationale": self.rationale,
            "dimensions": list(self.dimensions),
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class FitBandThreshold:
    """Policy-owned lower bound for one resolved fit band."""

    band: str
    minimum_score: int

    def __post_init__(self) -> None:
        band = str(self.band or "").strip().lower()
        if band not in FIT_BANDS:
            raise ValueError(f"FitBandThreshold.band must be one of {FIT_BANDS}")
        try:
            minimum_score = int(self.minimum_score)
        except (TypeError, ValueError) as exc:
            raise ValueError("FitBandThreshold.minimum_score must be an integer") from exc
        if minimum_score < 1 or minimum_score > 10:
            raise ValueError("FitBandThreshold.minimum_score must be in [1, 10]")
        object.__setattr__(self, "band", band)
        object.__setattr__(self, "minimum_score", minimum_score)

    @classmethod
    def from_dict(cls, data: MappingABC[str, Any]) -> "FitBandThreshold":
        return cls(
            band=str(data.get("band") or ""),
            minimum_score=int(
                data.get("minimum_score", data.get("minimumScore", 0)) or 0
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {"band": self.band, "minimum_score": self.minimum_score}


@dataclass(frozen=True)
class ResolvedDimensionScore:
    """Dimension contribution used to produce one resolved score."""

    name: str
    value: int
    weight: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "value": self.value,
            "weight": self.weight,
            "weighted_value": round(self.value * self.weight, 4),
        }


@dataclass(frozen=True)
class ResolvedScore:
    """Deterministic policy result attached to the score trace."""

    fit_score: FitScore
    fit_band: str
    policy_id: str
    policy_version: int
    rubric_version: str
    raw_weighted_score: float
    calibration_adjustment: float
    anchor_ids: tuple[str, ...]
    dimensions: tuple[ResolvedDimensionScore, ...]
    fit_band_thresholds: tuple[FitBandThreshold, ...]
    resolution_reason: str
    evidence_summary: dict[str, Any]

    def dimension_values(self) -> dict[str, int]:
        return {dimension.name: dimension.value for dimension in self.dimensions}


@dataclass(frozen=True)
class ScoringPolicy:
    """Versioned rule set that resolves final ``FitScore`` values."""

    tenant_id: TenantId = LOCAL_TENANT
    version: int = DEFAULT_SCORING_POLICY_VERSION
    rubric_version: str = DEFAULT_RUBRIC_VERSION
    dimensions: tuple[WeightedScoreDimension, ...] = ()
    fit_band_thresholds: tuple[FitBandThreshold, ...] = ()
    anchors: tuple[CalibrationAnchor, ...] = ()
    created_at: str = ""
    created_from_event_id: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "tenant_id", TenantId(str(self.tenant_id)))
        try:
            version = int(self.version)
        except (TypeError, ValueError) as exc:
            raise ValueError("ScoringPolicy.version must be an integer") from exc
        if version < 1:
            raise ValueError("ScoringPolicy.version must be >= 1")
        object.__setattr__(self, "version", version)
        rubric_version = str(self.rubric_version or "").strip() or DEFAULT_RUBRIC_VERSION
        object.__setattr__(self, "rubric_version", rubric_version)
        dimensions = self.dimensions or _default_dimensions()
        if not dimensions:
            raise ValueError("ScoringPolicy.dimensions must be non-empty")
        names = [dimension.name for dimension in dimensions]
        if len(names) != len(set(names)):
            raise ValueError("ScoringPolicy dimensions must be unique by name")
        object.__setattr__(self, "dimensions", tuple(dimensions))
        object.__setattr__(
            self,
            "fit_band_thresholds",
            _validated_fit_band_thresholds(self.fit_band_thresholds),
        )
        object.__setattr__(self, "anchors", tuple(self.anchors))
        object.__setattr__(self, "created_at", str(self.created_at or "").strip())
        if self.created_from_event_id is not None:
            object.__setattr__(self, "created_from_event_id", int(self.created_from_event_id))

    @property
    def policy_id(self) -> str:
        return f"{self.tenant_id}:scoring-policy-v{self.version}"

    @classmethod
    def default(
        cls,
        tenant_id: TenantId = LOCAL_TENANT,
        *,
        created_at: str = "",
    ) -> "ScoringPolicy":
        return cls(
            tenant_id=tenant_id,
            version=DEFAULT_SCORING_POLICY_VERSION,
            rubric_version=DEFAULT_RUBRIC_VERSION,
            dimensions=_default_dimensions(),
            fit_band_thresholds=_default_fit_band_thresholds(),
            anchors=(),
            created_at=created_at,
            created_from_event_id=None,
        )

    @classmethod
    def from_persistence(
        cls,
        *,
        tenant_id: TenantId,
        version: int,
        rubric: MappingABC[str, Any] | None,
        anchors: list[Any] | None,
        created_at: str,
        created_from_event_id: int | None,
    ) -> "ScoringPolicy":
        rubric = rubric or {}
        raw_dimensions = rubric.get("dimensions", ())
        dimensions = (
            tuple(
                WeightedScoreDimension.from_dict(item)
                for item in raw_dimensions
                if isinstance(item, MappingABC)
            )
            if isinstance(raw_dimensions, list)
            else ()
        )
        raw_thresholds = rubric.get("fit_band_thresholds", rubric.get("fitBandThresholds", ()))
        fit_band_thresholds = (
            tuple(
                FitBandThreshold.from_dict(item)
                for item in raw_thresholds
                if isinstance(item, MappingABC)
            )
            if isinstance(raw_thresholds, list)
            else ()
        )
        anchor_values = tuple(
            CalibrationAnchor.from_dict(item)
            for item in anchors or []
            if isinstance(item, MappingABC)
        )
        return cls(
            tenant_id=tenant_id,
            version=version,
            rubric_version=str(rubric.get("rubric_version", rubric.get("rubricVersion", DEFAULT_RUBRIC_VERSION))),
            dimensions=dimensions,
            fit_band_thresholds=fit_band_thresholds,
            anchors=anchor_values,
            created_at=created_at,
            created_from_event_id=created_from_event_id,
        )

    def resolve(self, breakdown: ScoreBreakdown) -> ResolvedScore:
        """Resolve final score from validated structured evidence."""
        dimensions = tuple(
            ResolvedDimensionScore(
                name=dimension.name,
                value=dimension.value_from(breakdown),
                weight=dimension.weight,
            )
            for dimension in self.dimensions
        )
        total_weight = sum(dimension.weight for dimension in dimensions)
        if total_weight <= 0:
            raise ValueError("ScoringPolicy dimensions must have a positive total weight")

        raw_weighted_score = sum(
            dimension.value * dimension.weight for dimension in dimensions
        ) / total_weight
        calibration_adjustment = 0.0
        resolved_value = _fit_score_from_raw(raw_weighted_score + calibration_adjustment)
        fit_score = FitScore.create(resolved_value)
        return ResolvedScore(
            fit_score=fit_score,
            fit_band=self.fit_band_for_score(fit_score),
            policy_id=self.policy_id,
            policy_version=self.version,
            rubric_version=self.rubric_version,
            raw_weighted_score=round(raw_weighted_score, 4),
            calibration_adjustment=calibration_adjustment,
            anchor_ids=(),
            dimensions=dimensions,
            fit_band_thresholds=self.fit_band_thresholds,
            resolution_reason=_resolution_reason(breakdown),
            evidence_summary=_evidence_summary(breakdown),
        )

    def fit_band_for_score(self, score: FitScore | int) -> str:
        value = score.value if isinstance(score, FitScore) else int(score)
        for threshold in self.fit_band_thresholds:
            if value >= threshold.minimum_score:
                return threshold.band
        return "poor"

    def to_rubric_dict(self) -> dict[str, Any]:
        return {
            "rubric_version": self.rubric_version,
            "dimensions": [dimension.to_dict() for dimension in self.dimensions],
            "fit_band_thresholds": [
                threshold.to_dict() for threshold in self.fit_band_thresholds
            ],
            "rounding": "nearest_integer_half_up",
            "fit_score_range": [1, 10],
            "confidence_handling": "trace_only",
            "eligibility_handling": "trace_only",
        }

    def to_anchors_list(self) -> list[dict[str, Any]]:
        return [anchor.to_dict() for anchor in self.anchors]


def _default_dimensions() -> tuple[WeightedScoreDimension, ...]:
    return tuple(
        WeightedScoreDimension(name=name, weight=weight)
        for name, weight in DEFAULT_DIMENSION_WEIGHTS
    )


def _default_fit_band_thresholds() -> tuple[FitBandThreshold, ...]:
    return tuple(
        FitBandThreshold(band=band, minimum_score=minimum_score)
        for band, minimum_score in DEFAULT_FIT_BAND_THRESHOLDS
    )


def _validated_fit_band_thresholds(
    thresholds: tuple[FitBandThreshold, ...],
) -> tuple[FitBandThreshold, ...]:
    threshold_values = tuple(thresholds or _default_fit_band_thresholds())
    bands = [threshold.band for threshold in threshold_values]
    if set(bands) != set(FIT_BANDS) or len(bands) != len(FIT_BANDS):
        raise ValueError(f"ScoringPolicy fit band thresholds must cover {FIT_BANDS}")
    sorted_values = tuple(
        sorted(threshold_values, key=lambda threshold: threshold.minimum_score, reverse=True)
    )
    minimums = [threshold.minimum_score for threshold in sorted_values]
    if len(minimums) != len(set(minimums)):
        raise ValueError("ScoringPolicy fit band thresholds must have unique minimum scores")
    if sorted_values[-1].minimum_score != 1:
        raise ValueError("ScoringPolicy fit band thresholds must include a floor of 1")
    return sorted_values


def _resolution_reason(breakdown: ScoreBreakdown) -> str:
    reasons = ["weighted_dimensions"]
    if breakdown.eligibility.hard_blockers or breakdown.eligibility.status == "blocked":
        reasons.append("eligibility_blockers_traced")
    if breakdown.confidence == "low":
        reasons.append("low_confidence_traced")
    if breakdown.missing_signals:
        reasons.append("missing_signals_traced")
    return "+".join(reasons)


def _evidence_summary(breakdown: ScoreBreakdown) -> dict[str, Any]:
    return {
        "confidence": breakdown.confidence,
        "eligibility_status": breakdown.eligibility.status,
        "hard_blocker_count": len(breakdown.eligibility.hard_blockers),
        "warning_count": len(breakdown.eligibility.warnings),
        "matched_signal_count": len(breakdown.matched_signals),
        "missing_signal_count": len(breakdown.missing_signals),
        "transferable_signal_count": len(breakdown.transferable_signals),
    }


def _fit_score_from_raw(value: float) -> int:
    rounded = int(value + 0.5)
    if rounded < 1:
        return 1
    if rounded > 10:
        return 10
    return rounded


__all__ = [
    "CalibrationAnchor",
    "DEFAULT_FIT_BAND_THRESHOLDS",
    "DEFAULT_RUBRIC_VERSION",
    "DEFAULT_SCORING_POLICY_VERSION",
    "FitBandThreshold",
    "ResolvedDimensionScore",
    "ResolvedScore",
    "ScoringPolicy",
    "WeightedScoreDimension",
]
