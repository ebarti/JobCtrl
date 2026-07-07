"""Versioned scoring policy model.

The policy turns structured scoring evidence into the persisted
``FitScore``. The LLM may still propose an overall score, but that score is
input evidence only; deterministic policy resolution owns the final grade.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping as MappingABC
from dataclasses import dataclass, field
from typing import Any

from jobctl.domain.scoring.value_objects import (
    ELIGIBILITY_STATUSES,
    FIT_BANDS,
    FitScore,
    ScoreBreakdown,
)
from jobctl.domain.tenant import LOCAL_TENANT, TenantId

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
class CorrectionSignal:
    """Use-case input signal derived from a user score correction.

    The signal may carry raw audit fields from the corrected score. Persisted
    policy anchors must derive non-sensitive learning features from it.
    """

    tenant_id: TenantId
    job_id: str
    original_score: FitScore
    corrected_score: FitScore
    rationale: str
    corrected_at: str
    source_policy_id: str = ""
    source_policy_version: int = 0
    score_dimensions: tuple[dict[str, Any], ...] = ()
    evidence_summary: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "tenant_id", TenantId(str(self.tenant_id)))
        job_id = str(self.job_id or "").strip()
        if not job_id:
            raise ValueError("CorrectionSignal.job_id must be non-empty")
        object.__setattr__(self, "job_id", job_id)
        original_score = _coerce_fit_score(self.original_score, "original_score")
        corrected_score = _coerce_fit_score(self.corrected_score, "corrected_score")
        object.__setattr__(self, "original_score", original_score)
        object.__setattr__(self, "corrected_score", corrected_score)
        rationale = " ".join(str(self.rationale or "").split())
        if not rationale:
            raise ValueError("CorrectionSignal.rationale must be non-empty")
        object.__setattr__(self, "rationale", rationale[:500])
        corrected_at = str(self.corrected_at or "").strip()
        if not corrected_at:
            raise ValueError("CorrectionSignal.corrected_at must be non-empty")
        object.__setattr__(self, "corrected_at", corrected_at)
        object.__setattr__(
            self,
            "source_policy_id",
            str(self.source_policy_id or "").strip(),
        )
        object.__setattr__(
            self,
            "source_policy_version",
            max(_int_or_default(self.source_policy_version, 0), 0),
        )
        object.__setattr__(
            self,
            "score_dimensions",
            _clean_mapping_tuple(self.score_dimensions),
        )
        object.__setattr__(
            self,
            "evidence_summary",
            _clean_mapping(self.evidence_summary),
        )

    @property
    def anchor_id(self) -> str:
        payload = {
            "tenant_id": str(self.tenant_id),
            "job_id": self.job_id,
            "original_score": self.original_score.value,
            "corrected_score": self.corrected_score.value,
            "corrected_at": self.corrected_at,
            "source_policy_version": self.source_policy_version,
        }
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return f"correction-anchor-{digest[:12]}"

    def to_dict(self) -> dict[str, Any]:
        correction_delta = self.corrected_score.value - self.original_score.value
        return {
            "anchor_id": self.anchor_id,
            "tenant_id": str(self.tenant_id),
            "job_ref_hash": _stable_job_ref_hash(
                tenant_id=self.tenant_id,
                job_id=self.job_id,
            ),
            "original_score": self.original_score.value,
            "corrected_score": self.corrected_score.value,
            "correction_delta": correction_delta,
            "correction_direction": _correction_direction(correction_delta),
            "corrected_at": self.corrected_at,
            "source_policy_id": self.source_policy_id,
            "source_policy_version": self.source_policy_version,
            "score_dimensions": list(self.score_dimensions),
            "evidence_summary": self.evidence_summary,
        }


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

    Anchors are correction-derived calibration evidence. PR3 deliberately
    traces them without changing weights or thresholds so one correction
    cannot overfit the policy.
    """

    anchor_id: str
    job_id: str = ""
    job_ref_hash: str = ""
    fit_score: FitScore | None = None
    original_fit_score: FitScore | None = None
    corrected_fit_score: FitScore | None = None
    rationale: str = ""
    correction_delta: int | None = None
    correction_direction: str = ""
    dimensions: tuple[str, ...] = ()
    dimension_scores: tuple[dict[str, Any], ...] = ()
    evidence_summary: dict[str, Any] = field(default_factory=dict)
    source_policy_id: str = ""
    source_policy_version: int = 0
    created_at: str = ""

    def __post_init__(self) -> None:
        anchor_id = str(self.anchor_id or "").strip()
        if not anchor_id:
            raise ValueError("CalibrationAnchor.anchor_id must be non-empty")
        object.__setattr__(self, "anchor_id", anchor_id)
        job_id = str(self.job_id or "").strip()
        object.__setattr__(self, "job_id", job_id)
        job_ref_hash = str(self.job_ref_hash or "").strip()
        if not job_ref_hash and job_id:
            job_ref_hash = _stable_job_ref_hash(job_id=job_id)
        object.__setattr__(self, "job_ref_hash", job_ref_hash)
        fit_score = _coerce_optional_fit_score(
            self.fit_score
        ) or _coerce_optional_fit_score(self.corrected_fit_score)
        corrected_fit_score = _coerce_optional_fit_score(
            self.corrected_fit_score
        ) or fit_score
        object.__setattr__(self, "fit_score", fit_score)
        object.__setattr__(
            self,
            "original_fit_score",
            _coerce_optional_fit_score(self.original_fit_score),
        )
        object.__setattr__(
            self,
            "corrected_fit_score",
            _coerce_optional_fit_score(corrected_fit_score),
        )
        object.__setattr__(self, "rationale", str(self.rationale or "").strip())
        delta = self.correction_delta
        if delta is None:
            delta = _correction_delta(
                self.original_fit_score,
                self.corrected_fit_score or self.fit_score,
            )
        object.__setattr__(self, "correction_delta", int(delta or 0))
        direction = str(self.correction_direction or "").strip() or _correction_direction(
            int(delta or 0)
        )
        object.__setattr__(self, "correction_direction", direction)
        object.__setattr__(
            self,
            "dimensions",
            tuple(str(value).strip() for value in self.dimensions if str(value).strip()),
        )
        object.__setattr__(
            self,
            "dimension_scores",
            _clean_anchor_dimension_scores(self.dimension_scores),
        )
        object.__setattr__(
            self,
            "evidence_summary",
            _clean_anchor_evidence_summary(self.evidence_summary),
        )
        object.__setattr__(
            self,
            "source_policy_id",
            str(self.source_policy_id or "").strip(),
        )
        object.__setattr__(
            self,
            "source_policy_version",
            max(_int_or_default(self.source_policy_version, 0), 0),
        )
        object.__setattr__(self, "created_at", str(self.created_at or "").strip())

    @classmethod
    def from_dict(cls, data: MappingABC[str, Any]) -> "CalibrationAnchor":
        score = FitScore.from_optional(data.get("fit_score", data.get("fitScore")))
        original_score = FitScore.from_optional(
            data.get(
                "original_fit_score",
                data.get("originalFitScore", data.get("original_score")),
            )
        )
        corrected_score = FitScore.from_optional(
            data.get(
                "corrected_fit_score",
                data.get("correctedFitScore", data.get("corrected_score")),
            )
        )
        raw_dimensions = data.get("dimensions", ())
        dimensions: tuple[str, ...]
        if isinstance(raw_dimensions, list):
            dimensions = tuple(str(item) for item in raw_dimensions)
        else:
            raw_dimension_scores = data.get(
                "dimension_scores",
                data.get("dimensionScores", ()),
            )
            dimension_scores = _clean_mapping_tuple(raw_dimension_scores)
            dimensions = tuple(
                str(item.get("name", "")).strip()
                for item in dimension_scores
                if str(item.get("name", "")).strip()
            )
        return cls(
            anchor_id=str(data.get("anchor_id", data.get("anchorId", ""))),
            job_id=str(data.get("job_id", data.get("jobId", "")) or ""),
            job_ref_hash=str(data.get("job_ref_hash", data.get("jobRefHash", "")) or ""),
            fit_score=score,
            original_fit_score=original_score,
            corrected_fit_score=corrected_score,
            rationale=str(data.get("rationale") or ""),
            correction_delta=data.get(
                "correction_delta",
                data.get("correctionDelta"),
            ),
            correction_direction=str(
                data.get("correction_direction", data.get("correctionDirection", ""))
                or ""
            ),
            dimensions=dimensions,
            dimension_scores=_clean_mapping_tuple(
                data.get("dimension_scores", data.get("dimensionScores", ()))
            ),
            evidence_summary=_clean_mapping(
                data.get("evidence_summary", data.get("evidenceSummary", {}))
            ),
            source_policy_id=str(
                data.get("source_policy_id", data.get("sourcePolicyId", "")) or ""
            ),
            source_policy_version=_int_or_default(
                data.get("source_policy_version", data.get("sourcePolicyVersion", 0)),
                0,
            ),
            created_at=str(data.get("created_at", data.get("createdAt", "")) or ""),
        )

    @classmethod
    def from_signal(cls, signal: CorrectionSignal) -> "CalibrationAnchor":
        dimensions = tuple(
            str(item.get("name", "")).strip()
            for item in signal.score_dimensions
            if str(item.get("name", "")).strip()
        )
        return cls(
            anchor_id=signal.anchor_id,
            job_ref_hash=_stable_job_ref_hash(
                tenant_id=signal.tenant_id,
                job_id=signal.job_id,
            ),
            fit_score=signal.corrected_score,
            original_fit_score=signal.original_score,
            corrected_fit_score=signal.corrected_score,
            correction_delta=signal.corrected_score.value - signal.original_score.value,
            correction_direction=_correction_direction(
                signal.corrected_score.value - signal.original_score.value
            ),
            dimensions=dimensions,
            dimension_scores=signal.score_dimensions,
            evidence_summary=signal.evidence_summary,
            source_policy_id=signal.source_policy_id,
            source_policy_version=signal.source_policy_version,
            created_at=signal.corrected_at,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "anchor_id": self.anchor_id,
            "job_ref_hash": self.job_ref_hash,
            "fit_score": self.fit_score.value if self.fit_score else None,
            "original_fit_score": (
                self.original_fit_score.value if self.original_fit_score else None
            ),
            "corrected_fit_score": (
                self.corrected_fit_score.value if self.corrected_fit_score else None
            ),
            "correction_delta": self.correction_delta,
            "correction_direction": self.correction_direction,
            "dimensions": list(self.dimensions),
            "dimension_scores": list(self.dimension_scores),
            "evidence_summary": self.evidence_summary,
            "source_policy_id": self.source_policy_id,
            "source_policy_version": self.source_policy_version,
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
            anchor_ids=tuple(anchor.anchor_id for anchor in self.anchors),
            dimensions=dimensions,
            fit_band_thresholds=self.fit_band_thresholds,
            resolution_reason=_resolution_reason(breakdown),
            evidence_summary=_evidence_summary(breakdown),
        )

    def with_correction_signal(self, signal: CorrectionSignal) -> "ScoringPolicy":
        """Return the next policy version with a correction-derived anchor.

        PR3 keeps the deterministic rubric stable. The correction is
        recorded as calibration evidence and surfaced through trace metadata
        on subsequent scores; later policy versions can learn adjustments
        from the accumulated anchors.
        """
        if signal.tenant_id != self.tenant_id:
            raise ValueError("CorrectionSignal tenant must match ScoringPolicy tenant")
        anchor = CalibrationAnchor.from_signal(signal)
        anchors: list[CalibrationAnchor] = []
        replaced = False
        for existing in self.anchors:
            if existing.anchor_id == anchor.anchor_id:
                anchors.append(anchor)
                replaced = True
            else:
                anchors.append(existing)
        if not replaced:
            anchors.append(anchor)
        return ScoringPolicy(
            tenant_id=self.tenant_id,
            version=self.version + 1,
            rubric_version=self.rubric_version,
            dimensions=self.dimensions,
            fit_band_thresholds=self.fit_band_thresholds,
            anchors=tuple(anchors),
            created_at=signal.corrected_at,
            created_from_event_id=None,
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


def _coerce_fit_score(value: FitScore | int, field_name: str) -> FitScore:
    score = _coerce_optional_fit_score(value)
    if score is None:
        raise ValueError(f"CorrectionSignal.{field_name} must be a FitScore")
    return score


def _coerce_optional_fit_score(value: Any) -> FitScore | None:
    if value is None:
        return None
    if isinstance(value, FitScore):
        return value
    return FitScore.from_optional(value)


def _int_or_default(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _clean_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, MappingABC):
        return {}
    return json.loads(json.dumps(dict(value), sort_keys=True, default=str))


def _clean_mapping_tuple(value: Any) -> tuple[dict[str, Any], ...]:
    if isinstance(value, (str, bytes, MappingABC)) or value is None:
        return ()
    try:
        iterator = iter(value)
    except TypeError:
        return ()
    return tuple(_clean_mapping(item) for item in iterator if isinstance(item, MappingABC))


def _stable_job_ref_hash(
    *,
    job_id: str,
    tenant_id: TenantId | str | None = None,
) -> str:
    payload = {
        "tenant_id": str(tenant_id or ""),
        "job_id": str(job_id or "").strip(),
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"sha256:{digest}"


def _correction_delta(
    original_score: FitScore | None,
    corrected_score: FitScore | None,
) -> int:
    if original_score is None or corrected_score is None:
        return 0
    return corrected_score.value - original_score.value


def _correction_direction(delta: int) -> str:
    if delta > 0:
        return "increased"
    if delta < 0:
        return "decreased"
    return "unchanged"


def _clean_anchor_dimension_scores(value: Any) -> tuple[dict[str, Any], ...]:
    sanitized: list[dict[str, Any]] = []
    for item in _clean_mapping_tuple(value):
        name = str(item.get("name") or "").strip()
        cleaned: dict[str, Any] = {}
        if name:
            cleaned["name"] = name
        for key in ("value", "weight", "weighted_value"):
            number = _number_or_none(item.get(key))
            if number is not None:
                cleaned[key] = number
        if cleaned:
            sanitized.append(cleaned)
    return tuple(sanitized)


def _clean_anchor_evidence_summary(value: Any) -> dict[str, Any]:
    raw = _clean_mapping(value)
    cleaned: dict[str, Any] = {}
    confidence = str(raw.get("confidence") or "").strip().lower()
    if confidence in {"low", "medium", "high"}:
        cleaned["confidence"] = confidence
    eligibility_status = str(raw.get("eligibility_status") or "").strip().lower()
    if eligibility_status in ELIGIBILITY_STATUSES:
        cleaned["eligibility_status"] = eligibility_status
    for key in (
        "hard_blocker_count",
        "warning_count",
        "matched_signal_count",
        "missing_signal_count",
        "transferable_signal_count",
    ):
        if key in raw:
            cleaned[key] = max(_int_or_default(raw.get(key), 0), 0)
    return cleaned


def _number_or_none(value: Any) -> int | float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not (-1_000_000 <= number <= 1_000_000):
        return None
    if number.is_integer():
        return int(number)
    return number


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
    threshold_by_band = {threshold.band: threshold for threshold in threshold_values}
    canonical_values = tuple(threshold_by_band[band] for band in FIT_BANDS)
    minimums = [threshold.minimum_score for threshold in canonical_values]
    if len(minimums) != len(set(minimums)):
        raise ValueError("ScoringPolicy fit band thresholds must have unique minimum scores")
    if canonical_values[-1].minimum_score != 1:
        raise ValueError("ScoringPolicy fit band thresholds must include a floor of 1")
    if any(
        higher.minimum_score <= lower.minimum_score
        for higher, lower in zip(canonical_values, canonical_values[1:])
    ):
        raise ValueError(
            "ScoringPolicy fit band thresholds must follow "
            "excellent > strong > plausible > stretch > poor == 1"
        )
    return canonical_values


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
    "CorrectionSignal",
    "DEFAULT_FIT_BAND_THRESHOLDS",
    "DEFAULT_RUBRIC_VERSION",
    "DEFAULT_SCORING_POLICY_VERSION",
    "FitBandThreshold",
    "ResolvedDimensionScore",
    "ResolvedScore",
    "ScoringPolicy",
    "WeightedScoreDimension",
]
