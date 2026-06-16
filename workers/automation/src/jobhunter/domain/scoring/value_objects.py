"""Scoring value objects.

See ddd-target.md §4.4. Pure data, no I/O. All value objects are frozen
dataclasses; constructors enforce invariants up front so an instance carries
its validity. The aggregate root (``JobScore``) composes these into the
canonical scoring fact.

Invariants enforced here:

  ``FitScore``         — integer in the closed range [1, 10].
  ``ScoreBreakdown``   — every component score is in [0, 10]; ``reasoning``
                         is free text. Components are a fixed dimensional
                         schema (``technical_fit``, ``experience_fit``,
                         ``role_fit``) so consumers can compare across jobs.
  ``MatchedKeywords``  — frozen tuple of non-empty trimmed strings; rejects
                         duplicates (case-insensitive) so the order observed
                         is the order produced by the parser.
  ``ScoreCorrection``  — corrected ``FitScore`` + free-text rationale +
                         the ``TenantId`` who issued the correction +
                         ISO-8601 timestamp.
  ``ScoringCriteria``  — published threshold + free-text criteria the user
                         configured in settings; the eligibility checker
                         consults it to gate downstream tailoring.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable as IterableABC
from collections.abc import Mapping as MappingABC
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Iterable, Mapping

from jobhunter.domain.tenant import TenantId

if TYPE_CHECKING:
    from jobhunter.domain.profile.snapshot import ProfileSnapshot


# ---------------------------------------------------------------------------
# FitScore — int constrained to [1, 10]
# ---------------------------------------------------------------------------


_FIT_SCORE_MIN = 1
_FIT_SCORE_MAX = 10
FIT_BANDS = ("excellent", "strong", "plausible", "stretch", "poor")
CONFIDENCE_LEVELS = ("high", "medium", "low")
ELIGIBILITY_STATUSES = ("eligible", "warning", "blocked", "unknown")
REQUIREMENT_TIERS = ("must_have", "nice_to_have")
REQUIREMENT_FIT_KINDS = ("matched", "transferable", "missing", "blocked", "not_assessed")
REQUIREMENT_MATCH_STRENGTHS = ("direct", "strong")
REQUIREMENT_TAILORING_ACTIONS = ("double_down", "bridge_gap", "avoid_claim", "low_priority")
REQUIREMENT_ARTIFACT_COVERAGE_STATES = (
    "covered",
    "missing_from_resume",
    "missing_from_profile",
    "not_covered",
    "not_recorded",
)


def _clean_strings(values: Iterable[Any] | Any) -> tuple[str, ...]:
    if values is None or isinstance(values, (str, bytes)):
        values = [values] if values else []
    if not isinstance(values, IterableABC):
        return ()
    seen: set[str] = set()
    out: list[str] = []
    for raw in values:
        text = str(raw or "").strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return tuple(out)


def _clean_mapping(value: Mapping[str, Any] | dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(value, MappingABC):
        return {}
    # Round-trip through JSON-compatible values so snapshots stay stable
    # and do not retain caller-owned mutable containers.
    return json.loads(json.dumps(dict(value), sort_keys=True, default=str))


def _clean_mapping_tuple(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, IterableABC) or isinstance(value, (str, bytes, MappingABC)):
        return ()
    return tuple(_clean_mapping(item) for item in value if isinstance(item, MappingABC))


def _policy_object_tuple_to_dicts(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, IterableABC) or isinstance(value, (str, bytes, MappingABC)):
        return ()
    entries: list[dict[str, Any]] = []
    for item in value:
        if isinstance(item, MappingABC):
            entries.append(_clean_mapping(item))
        elif hasattr(item, "to_dict"):
            mapped = item.to_dict()
            if isinstance(mapped, MappingABC):
                entries.append(_clean_mapping(mapped))
    return tuple(entries)


def _int_or_default(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _float_or_default(value: Any, default: float) -> float:
    parsed = _float_or_none(value)
    return default if parsed is None else parsed


def fit_band_for_score(score: int) -> str:
    if score >= 9:
        return "excellent"
    if score >= 7:
        return "strong"
    if score >= 5:
        return "plausible"
    if score >= 3:
        return "stretch"
    return "poor"


@dataclass(frozen=True)
class FitScore:
    """A 1-to-10 candidate-fit grade.

    Construction enforces the range invariant: ``FitScore.create(0)`` and
    ``FitScore.create(11)`` both raise ``ValueError``. Use
    ``FitScore.from_optional`` when parsing untrusted input that may legally
    be ``None`` (e.g. the legacy ``jobs.fit_score`` column for unscored
    rows).
    """

    value: int

    def __post_init__(self) -> None:
        if not isinstance(self.value, int) or isinstance(self.value, bool):
            raise ValueError(f"FitScore.value must be an int, got {type(self.value).__name__}")
        if self.value < _FIT_SCORE_MIN or self.value > _FIT_SCORE_MAX:
            raise ValueError(
                f"FitScore.value must be in [{_FIT_SCORE_MIN}, {_FIT_SCORE_MAX}], got {self.value}"
            )

    @classmethod
    def create(cls, value: int) -> "FitScore":
        """Validating factory — raises on out-of-range values."""
        return cls(value=int(value))

    @classmethod
    def from_optional(cls, value: Any) -> "FitScore | None":
        """Parse a possibly-null value; returns ``None`` for null/missing."""
        if value is None:
            return None
        if isinstance(value, FitScore):
            return value
        try:
            ivalue = int(value)
        except (TypeError, ValueError):
            return None
        if ivalue < _FIT_SCORE_MIN or ivalue > _FIT_SCORE_MAX:
            return None
        return cls(value=ivalue)

    def __int__(self) -> int:
        return self.value


# ---------------------------------------------------------------------------
# EligibilityAssessment — hard-constraint evidence
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EligibilityAssessment:
    """Hard-constraint assessment kept separate from the display score."""

    status: str = "unknown"
    hard_blockers: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        status = str(self.status or "unknown").strip().lower()
        if status not in ELIGIBILITY_STATUSES:
            status = "unknown"
        object.__setattr__(self, "status", status)
        object.__setattr__(self, "hard_blockers", _clean_strings(self.hard_blockers))
        object.__setattr__(self, "warnings", _clean_strings(self.warnings))

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "EligibilityAssessment":
        data = data or {}
        blockers = data.get("hard_blockers", data.get("hardBlockers", data.get("blockers", ())))
        warnings = data.get("warnings", ())
        return cls(
            status=str(data.get("status") or "unknown"),
            hard_blockers=_clean_strings(blockers),
            warnings=_clean_strings(warnings),
        )

    def merge(self, other: "EligibilityAssessment") -> "EligibilityAssessment":
        status_rank = {"unknown": 0, "eligible": 1, "warning": 2, "blocked": 3}
        status = self.status if status_rank[self.status] >= status_rank[other.status] else other.status
        blockers = (*self.hard_blockers, *other.hard_blockers)
        warnings = (*self.warnings, *other.warnings)
        if blockers:
            status = "blocked"
        elif warnings and status == "eligible":
            status = "warning"
        return EligibilityAssessment(status=status, hard_blockers=blockers, warnings=warnings)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "hard_blockers": list(self.hard_blockers),
            "warnings": list(self.warnings),
        }


# ---------------------------------------------------------------------------
# ScoreBreakdown — fixed dimensions + fit-assessment evidence
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScoreBreakdown:
    """Structured rationale behind a ``FitScore``.

    The component dimensions are fixed so consumers can compare across jobs
    and so the parser is forced to make explicit zero/missing distinctions.
    Each component is a 0..10 integer; ``reasoning`` is the LLM's free-text
    summary preserved verbatim.
    """

    technical_fit: int = 0
    experience_fit: int = 0
    role_fit: int = 0
    reasoning: str = ""
    fit_band: str = "plausible"
    confidence: str = "medium"
    eligibility: EligibilityAssessment = field(default_factory=EligibilityAssessment)
    matched_signals: tuple[str, ...] = ()
    missing_signals: tuple[str, ...] = ()
    transferable_signals: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for name in ("technical_fit", "experience_fit", "role_fit"):
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool):
                raise ValueError(f"ScoreBreakdown.{name} must be an int, got {type(value).__name__}")
            if value < 0 or value > 10:
                raise ValueError(
                    f"ScoreBreakdown.{name} must be in [0, 10], got {value}"
                )
        if not isinstance(self.reasoning, str):
            raise ValueError("ScoreBreakdown.reasoning must be a string")
        fit_band = str(self.fit_band or "plausible").strip().lower()
        if fit_band not in FIT_BANDS:
            raise ValueError(f"ScoreBreakdown.fit_band must be one of {FIT_BANDS}")
        confidence = str(self.confidence or "medium").strip().lower()
        if confidence not in CONFIDENCE_LEVELS:
            raise ValueError(f"ScoreBreakdown.confidence must be one of {CONFIDENCE_LEVELS}")
        object.__setattr__(self, "fit_band", fit_band)
        object.__setattr__(self, "confidence", confidence)
        if not isinstance(self.eligibility, EligibilityAssessment):
            object.__setattr__(
                self,
                "eligibility",
                EligibilityAssessment.from_dict(self.eligibility if isinstance(self.eligibility, dict) else None),
            )
        object.__setattr__(self, "matched_signals", _clean_strings(self.matched_signals))
        object.__setattr__(self, "missing_signals", _clean_strings(self.missing_signals))
        object.__setattr__(self, "transferable_signals", _clean_strings(self.transferable_signals))

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ScoreBreakdown":
        data = data or {}
        return cls(
            technical_fit=int(data.get("technical_fit", data.get("technicalFit", 0)) or 0),
            experience_fit=int(data.get("experience_fit", data.get("experienceFit", 0)) or 0),
            role_fit=int(data.get("role_fit", data.get("roleFit", 0)) or 0),
            reasoning=str(data.get("reasoning") or ""),
            fit_band=str(data.get("fit_band", data.get("fitBand", "plausible")) or "plausible"),
            confidence=str(data.get("confidence") or "medium"),
            eligibility=EligibilityAssessment.from_dict(
                data.get("eligibility") if isinstance(data.get("eligibility"), dict) else None
            ),
            matched_signals=_clean_strings(data.get("matched_signals", data.get("matchedSignals", ()))),
            missing_signals=_clean_strings(data.get("missing_signals", data.get("missingSignals", ()))),
            transferable_signals=_clean_strings(
                data.get("transferable_signals", data.get("transferableSignals", ()))
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "technical_fit": self.technical_fit,
            "experience_fit": self.experience_fit,
            "role_fit": self.role_fit,
            "reasoning": self.reasoning,
            "fit_band": self.fit_band,
            "confidence": self.confidence,
            "eligibility": self.eligibility.to_dict(),
            "matched_signals": list(self.matched_signals),
            "missing_signals": list(self.missing_signals),
            "transferable_signals": list(self.transferable_signals),
        }


# ---------------------------------------------------------------------------
# Requirement fit report — canonical requirement-led score explanation
# ---------------------------------------------------------------------------


def _clean_enum(value: Any, allowed: tuple[str, ...], default: str) -> str:
    text = str(value or default).strip().lower()
    if text not in allowed:
        raise ValueError(f"value must be one of {allowed}, got {text!r}")
    return text


def _clean_non_empty_text(value: Any, *, field_name: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field_name} must be non-empty")
    return text


def _non_negative_float(value: Any, *, field_name: str) -> float:
    parsed = _float_or_default(value, 0.0)
    if parsed < 0:
        raise ValueError(f"{field_name} must be non-negative")
    return parsed


def _bounded_ratio(value: Any, *, field_name: str) -> float:
    parsed = _float_or_default(value, 0.0)
    if parsed < 0 or parsed > 1:
        raise ValueError(f"{field_name} must be in [0, 1]")
    return parsed


@dataclass(frozen=True)
class RequirementFitStatus:
    """Pre-tailoring candidate fit for one employer requirement."""

    kind: str
    evidence_ids: tuple[str, ...] = ()
    strength: str | None = None
    gap: str = ""
    bridge: str = ""
    reason: str = ""
    blocker: str = ""

    def __post_init__(self) -> None:
        kind = _clean_enum(self.kind, REQUIREMENT_FIT_KINDS, "not_assessed")
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "evidence_ids", _clean_strings(self.evidence_ids))
        object.__setattr__(self, "gap", str(self.gap or "").strip())
        object.__setattr__(self, "bridge", str(self.bridge or "").strip())
        object.__setattr__(self, "reason", str(self.reason or "").strip())
        object.__setattr__(self, "blocker", str(self.blocker or "").strip())
        if kind == "matched":
            if not self.evidence_ids:
                raise ValueError("matched requirement fit requires at least one evidence id")
            strength = _clean_enum(self.strength, REQUIREMENT_MATCH_STRENGTHS, "direct")
            object.__setattr__(self, "strength", strength)
            return
        object.__setattr__(self, "strength", None)
        if kind == "transferable":
            if not self.evidence_ids:
                raise ValueError("transferable requirement fit requires at least one evidence id")
            if not self.bridge:
                raise ValueError("transferable requirement fit requires a bridge")
        elif kind == "missing":
            if not self.reason:
                raise ValueError("missing requirement fit requires a reason")
        elif kind == "blocked":
            if not self.blocker:
                raise ValueError("blocked requirement fit requires a blocker")
        elif kind == "not_assessed" and not self.reason:
            raise ValueError("not_assessed requirement fit requires a reason")

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RequirementFitStatus":
        data = data or {}
        return cls(
            kind=str(data.get("kind") or "not_assessed"),
            evidence_ids=_clean_strings(data.get("evidence_ids", data.get("evidenceIds", ()))),
            strength=data.get("strength"),
            gap=str(data.get("gap") or ""),
            bridge=str(data.get("bridge") or ""),
            reason=str(data.get("reason") or ""),
            blocker=str(data.get("blocker") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"kind": self.kind}
        if self.evidence_ids:
            payload["evidence_ids"] = list(self.evidence_ids)
        if self.strength:
            payload["strength"] = self.strength
        if self.gap:
            payload["gap"] = self.gap
        if self.bridge:
            payload["bridge"] = self.bridge
        if self.reason:
            payload["reason"] = self.reason
        if self.blocker:
            payload["blocker"] = self.blocker
        return payload

    def to_read_model(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"kind": self.kind}
        if self.evidence_ids:
            payload["evidenceIds"] = list(self.evidence_ids)
        if self.strength:
            payload["strength"] = self.strength
        if self.gap:
            payload["gap"] = self.gap
        if self.bridge:
            payload["bridge"] = self.bridge
        if self.reason:
            payload["reason"] = self.reason
        if self.blocker:
            payload["blocker"] = self.blocker
        return payload


@dataclass(frozen=True)
class RequirementScoreContribution:
    """How one requirement contributes to the resolved fit score."""

    max_points: float
    awarded_points: float
    weighted_impact: float
    rationale: str = ""

    def __post_init__(self) -> None:
        max_points = _non_negative_float(self.max_points, field_name="RequirementScoreContribution.max_points")
        awarded_points = _non_negative_float(
            self.awarded_points,
            field_name="RequirementScoreContribution.awarded_points",
        )
        if awarded_points > max_points:
            raise ValueError("RequirementScoreContribution.awarded_points cannot exceed max_points")
        object.__setattr__(self, "max_points", max_points)
        object.__setattr__(self, "awarded_points", awarded_points)
        object.__setattr__(
            self,
            "weighted_impact",
            _non_negative_float(self.weighted_impact, field_name="RequirementScoreContribution.weighted_impact"),
        )
        object.__setattr__(self, "rationale", str(self.rationale or "").strip())

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RequirementScoreContribution":
        data = data or {}
        return cls(
            max_points=data.get("max_points", data.get("maxPoints", 0.0)),
            awarded_points=data.get("awarded_points", data.get("awardedPoints", 0.0)),
            weighted_impact=data.get("weighted_impact", data.get("weightedImpact", 0.0)),
            rationale=str(data.get("rationale") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_points": self.max_points,
            "awarded_points": self.awarded_points,
            "weighted_impact": self.weighted_impact,
            "rationale": self.rationale,
        }

    def to_read_model(self) -> dict[str, Any]:
        return {
            "maxPoints": self.max_points,
            "awardedPoints": self.awarded_points,
            "weightedImpact": self.weighted_impact,
            "rationale": self.rationale,
        }


@dataclass(frozen=True)
class RequirementTailoringDirective:
    """How the resume tailor should handle one assessed requirement."""

    action: str
    priority: float = 0.0
    allowed_evidence_ids: tuple[str, ...] = ()
    target_keywords: tuple[str, ...] = ()
    prohibited_claims: tuple[str, ...] = ()
    instruction: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "action",
            _clean_enum(self.action, REQUIREMENT_TAILORING_ACTIONS, "low_priority"),
        )
        object.__setattr__(self, "priority", _non_negative_float(self.priority, field_name="priority"))
        object.__setattr__(self, "allowed_evidence_ids", _clean_strings(self.allowed_evidence_ids))
        object.__setattr__(self, "target_keywords", _clean_strings(self.target_keywords))
        object.__setattr__(self, "prohibited_claims", _clean_strings(self.prohibited_claims))
        object.__setattr__(self, "instruction", str(self.instruction or "").strip())

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RequirementTailoringDirective":
        data = data or {}
        return cls(
            action=str(data.get("action") or "low_priority"),
            priority=data.get("priority", 0.0),
            allowed_evidence_ids=_clean_strings(
                data.get("allowed_evidence_ids", data.get("allowedEvidenceIds", ()))
            ),
            target_keywords=_clean_strings(data.get("target_keywords", data.get("targetKeywords", ()))),
            prohibited_claims=_clean_strings(
                data.get("prohibited_claims", data.get("prohibitedClaims", ()))
            ),
            instruction=str(data.get("instruction") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "priority": self.priority,
            "allowed_evidence_ids": list(self.allowed_evidence_ids),
            "target_keywords": list(self.target_keywords),
            "prohibited_claims": list(self.prohibited_claims),
            "instruction": self.instruction,
        }

    def to_read_model(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "priority": self.priority,
            "allowedEvidenceIds": list(self.allowed_evidence_ids),
            "targetKeywords": list(self.target_keywords),
            "prohibitedClaims": list(self.prohibited_claims),
            "instruction": self.instruction,
        }


@dataclass(frozen=True)
class RequirementArtifactCoverage:
    """Post-generation coverage for one requirement in the accepted artifact."""

    state: str = "not_recorded"
    source: str = "tailored_resume_bullet_provenance"
    bullet_count: int = 0
    examples: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "state",
            _clean_enum(self.state, REQUIREMENT_ARTIFACT_COVERAGE_STATES, "not_recorded"),
        )
        source = str(self.source or "tailored_resume_bullet_provenance").strip()
        if source != "tailored_resume_bullet_provenance":
            raise ValueError("RequirementArtifactCoverage.source must be tailored_resume_bullet_provenance")
        object.__setattr__(self, "source", source)
        count = _int_or_default(self.bullet_count, 0)
        if count < 0:
            raise ValueError("RequirementArtifactCoverage.bullet_count must be non-negative")
        object.__setattr__(self, "bullet_count", count)
        object.__setattr__(self, "examples", _clean_strings(self.examples))

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RequirementArtifactCoverage":
        data = data or {}
        return cls(
            state=str(data.get("state") or "not_recorded"),
            source=str(data.get("source") or "tailored_resume_bullet_provenance"),
            bullet_count=_int_or_default(data.get("bullet_count", data.get("bulletCount", 0)), 0),
            examples=_clean_strings(data.get("examples", ())),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "source": self.source,
            "bullet_count": self.bullet_count,
            "examples": list(self.examples),
        }

    def to_read_model(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "source": self.source,
            "bulletCount": self.bullet_count,
            "examples": list(self.examples),
        }


@dataclass(frozen=True)
class RequirementFitAssessment:
    """One requirement row in the canonical requirement-led score explanation."""

    requirement_id: str
    requirement_text: str
    tier: str
    weight: float
    job_evidence_span: str
    fit: RequirementFitStatus
    contribution: RequirementScoreContribution
    tailoring: RequirementTailoringDirective
    artifact_coverage: RequirementArtifactCoverage | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "requirement_id",
            _clean_non_empty_text(self.requirement_id, field_name="RequirementFitAssessment.requirement_id"),
        )
        object.__setattr__(
            self,
            "requirement_text",
            _clean_non_empty_text(self.requirement_text, field_name="RequirementFitAssessment.requirement_text"),
        )
        object.__setattr__(self, "tier", _clean_enum(self.tier, REQUIREMENT_TIERS, "nice_to_have"))
        object.__setattr__(self, "weight", _bounded_ratio(self.weight, field_name="RequirementFitAssessment.weight"))
        object.__setattr__(self, "job_evidence_span", str(self.job_evidence_span or "").strip())
        if not isinstance(self.fit, RequirementFitStatus):
            object.__setattr__(
                self,
                "fit",
                RequirementFitStatus.from_dict(self.fit if isinstance(self.fit, dict) else None),
            )
        if not isinstance(self.contribution, RequirementScoreContribution):
            object.__setattr__(
                self,
                "contribution",
                RequirementScoreContribution.from_dict(
                    self.contribution if isinstance(self.contribution, dict) else None
                ),
            )
        if not isinstance(self.tailoring, RequirementTailoringDirective):
            object.__setattr__(
                self,
                "tailoring",
                RequirementTailoringDirective.from_dict(
                    self.tailoring if isinstance(self.tailoring, dict) else None
                ),
            )
        if self.artifact_coverage is not None and not isinstance(
            self.artifact_coverage,
            RequirementArtifactCoverage,
        ):
            object.__setattr__(
                self,
                "artifact_coverage",
                RequirementArtifactCoverage.from_dict(
                    self.artifact_coverage if isinstance(self.artifact_coverage, dict) else None
                ),
            )

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RequirementFitAssessment":
        data = data or {}
        coverage = data.get("artifact_coverage", data.get("artifactCoverage"))
        return cls(
            requirement_id=str(data.get("requirement_id", data.get("requirementId", "")) or ""),
            requirement_text=str(data.get("requirement_text", data.get("requirementText", "")) or ""),
            tier=str(data.get("tier") or "nice_to_have"),
            weight=data.get("weight", 0.0),
            job_evidence_span=str(data.get("job_evidence_span", data.get("jobEvidenceSpan", "")) or ""),
            fit=RequirementFitStatus.from_dict(data.get("fit") if isinstance(data.get("fit"), dict) else None),
            contribution=RequirementScoreContribution.from_dict(
                data.get("contribution") if isinstance(data.get("contribution"), dict) else None
            ),
            tailoring=RequirementTailoringDirective.from_dict(
                data.get("tailoring") if isinstance(data.get("tailoring"), dict) else None
            ),
            artifact_coverage=(
                RequirementArtifactCoverage.from_dict(coverage)
                if isinstance(coverage, dict)
                else None
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "requirement_id": self.requirement_id,
            "requirement_text": self.requirement_text,
            "tier": self.tier,
            "weight": self.weight,
            "job_evidence_span": self.job_evidence_span,
            "fit": self.fit.to_dict(),
            "contribution": self.contribution.to_dict(),
            "tailoring": self.tailoring.to_dict(),
            "artifact_coverage": self.artifact_coverage.to_dict()
            if self.artifact_coverage is not None
            else None,
        }

    def to_read_model(self) -> dict[str, Any]:
        return {
            "requirementId": self.requirement_id,
            "requirementText": self.requirement_text,
            "tier": self.tier,
            "weight": self.weight,
            "jobEvidenceSpan": self.job_evidence_span,
            "fit": self.fit.to_read_model(),
            "contribution": self.contribution.to_read_model(),
            "tailoring": self.tailoring.to_read_model(),
            "artifactCoverage": self.artifact_coverage.to_read_model()
            if self.artifact_coverage is not None
            else None,
        }


@dataclass(frozen=True)
class RequirementFitSummary:
    weighted_fit: float = 0.0
    must_have_coverage: float = 0.0
    blocker_count: int = 0
    missing_high_weight_count: int = 0

    def __post_init__(self) -> None:
        object.__setattr__(self, "weighted_fit", _bounded_ratio(self.weighted_fit, field_name="weighted_fit"))
        object.__setattr__(
            self,
            "must_have_coverage",
            _bounded_ratio(self.must_have_coverage, field_name="must_have_coverage"),
        )
        for name in ("blocker_count", "missing_high_weight_count"):
            value = _int_or_default(getattr(self, name), 0)
            if value < 0:
                raise ValueError(f"RequirementFitSummary.{name} must be non-negative")
            object.__setattr__(self, name, value)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RequirementFitSummary":
        data = data or {}
        return cls(
            weighted_fit=data.get("weighted_fit", data.get("weightedFit", 0.0)),
            must_have_coverage=data.get("must_have_coverage", data.get("mustHaveCoverage", 0.0)),
            blocker_count=_int_or_default(data.get("blocker_count", data.get("blockerCount", 0)), 0),
            missing_high_weight_count=_int_or_default(
                data.get("missing_high_weight_count", data.get("missingHighWeightCount", 0)),
                0,
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "weighted_fit": self.weighted_fit,
            "must_have_coverage": self.must_have_coverage,
            "blocker_count": self.blocker_count,
            "missing_high_weight_count": self.missing_high_weight_count,
        }

    def to_read_model(self) -> dict[str, Any]:
        return {
            "weightedFit": self.weighted_fit,
            "mustHaveCoverage": self.must_have_coverage,
            "blockerCount": self.blocker_count,
            "missingHighWeightCount": self.missing_high_weight_count,
        }


@dataclass(frozen=True)
class RequirementFitReport:
    """Canonical requirement-led audit record for a score version."""

    job_id: str
    score_version: int
    employer_analysis_generation: int
    profile_snapshot_version: int
    scoring_policy_version: int
    formula_version: str
    fit_band: str
    confidence: str
    summary: RequirementFitSummary = field(default_factory=RequirementFitSummary)
    assessments: tuple[RequirementFitAssessment, ...] = ()
    resolved_fit_score: FitScore | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "job_id",
            _clean_non_empty_text(self.job_id, field_name="RequirementFitReport.job_id"),
        )
        for name in (
            "score_version",
            "employer_analysis_generation",
            "profile_snapshot_version",
            "scoring_policy_version",
        ):
            value = _int_or_default(getattr(self, name), 0)
            if value < 0:
                raise ValueError(f"RequirementFitReport.{name} must be non-negative")
            object.__setattr__(self, name, value)
        object.__setattr__(
            self,
            "formula_version",
            _clean_non_empty_text(self.formula_version, field_name="RequirementFitReport.formula_version"),
        )
        object.__setattr__(self, "fit_band", _clean_enum(self.fit_band, FIT_BANDS, "plausible"))
        object.__setattr__(self, "confidence", _clean_enum(self.confidence, CONFIDENCE_LEVELS, "medium"))
        if not isinstance(self.summary, RequirementFitSummary):
            object.__setattr__(
                self,
                "summary",
                RequirementFitSummary.from_dict(self.summary if isinstance(self.summary, dict) else None),
            )
        assessments = self.assessments
        if not isinstance(assessments, tuple):
            assessments = tuple(assessments) if isinstance(assessments, IterableABC) else ()
        object.__setattr__(
            self,
            "assessments",
            tuple(
                item if isinstance(item, RequirementFitAssessment) else RequirementFitAssessment.from_dict(item)
                for item in assessments
                if isinstance(item, (RequirementFitAssessment, MappingABC))
            ),
        )
        if self.resolved_fit_score is not None and not isinstance(self.resolved_fit_score, FitScore):
            object.__setattr__(self, "resolved_fit_score", FitScore.from_optional(self.resolved_fit_score))

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RequirementFitReport":
        data = data or {}
        return cls(
            job_id=str(data.get("job_id", data.get("jobKey", data.get("jobId", ""))) or ""),
            score_version=_int_or_default(data.get("score_version", data.get("scoreVersion", 0)), 0),
            employer_analysis_generation=_int_or_default(
                data.get("employer_analysis_generation", data.get("employerAnalysisGeneration", 0)),
                0,
            ),
            profile_snapshot_version=_int_or_default(
                data.get("profile_snapshot_version", data.get("profileSnapshotVersion", 0)),
                0,
            ),
            scoring_policy_version=_int_or_default(
                data.get("scoring_policy_version", data.get("scoringPolicyVersion", 0)),
                0,
            ),
            formula_version=str(data.get("formula_version", data.get("formulaVersion", "")) or ""),
            resolved_fit_score=FitScore.from_optional(
                data.get("resolved_fit_score", data.get("resolvedFitScore"))
            ),
            fit_band=str(data.get("fit_band", data.get("fitBand", "plausible")) or "plausible"),
            confidence=str(data.get("confidence") or "medium"),
            summary=RequirementFitSummary.from_dict(
                data.get("summary") if isinstance(data.get("summary"), dict) else None
            ),
            assessments=tuple(
                RequirementFitAssessment.from_dict(item)
                for item in data.get("assessments", ())
                if isinstance(item, MappingABC)
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "score_version": self.score_version,
            "employer_analysis_generation": self.employer_analysis_generation,
            "profile_snapshot_version": self.profile_snapshot_version,
            "scoring_policy_version": self.scoring_policy_version,
            "formula_version": self.formula_version,
            "resolved_fit_score": self.resolved_fit_score.value
            if self.resolved_fit_score is not None
            else None,
            "fit_band": self.fit_band,
            "confidence": self.confidence,
            "summary": self.summary.to_dict(),
            "assessments": [assessment.to_dict() for assessment in self.assessments],
        }

    def to_read_model(self) -> dict[str, Any]:
        """Serialise the API/detail DTO for requirement-led fit evidence."""

        return {
            "jobKey": self.job_id,
            "scoreVersion": self.score_version,
            "employerAnalysisGeneration": self.employer_analysis_generation,
            "profileSnapshotVersion": self.profile_snapshot_version,
            "scoringPolicyVersion": self.scoring_policy_version,
            "formulaVersion": self.formula_version,
            "resolvedFitScore": self.resolved_fit_score.value
            if self.resolved_fit_score is not None
            else None,
            "fitBand": self.fit_band,
            "confidence": self.confidence,
            "summary": self.summary.to_read_model(),
            "assessments": [assessment.to_read_model() for assessment in self.assessments],
        }


# ---------------------------------------------------------------------------
# MatchedKeywords — ordered, deduplicated, non-empty trimmed strings
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MatchedKeywords:
    """ATS keywords the LLM identified as overlapping with the candidate.

    Per ddd-target.md §4.4 + the round-1 review M1 directive: a valid
    score MUST carry at least one keyword. The legacy backfill writes the
    sentinel ``["legacy"]`` for migrated rows, so the empty-tuple state
    is never reachable through any sanctioned write path; tests
    constructing the value object directly should pass at least one
    entry. The constructor enforces the invariant up front so a buggy
    parser can't sneak an empty list past the aggregate.
    """

    values: tuple[str, ...] = ("legacy",)

    def __post_init__(self) -> None:
        if not isinstance(self.values, tuple):
            raise ValueError("MatchedKeywords.values must be a tuple")
        if not self.values:
            raise ValueError(
                "MatchedKeywords must contain at least one keyword "
                "(see ddd-target.md §4.4). Use the sentinel "
                "['legacy'] for backfilled / unknown-keyword rows."
            )
        for keyword in self.values:
            if not isinstance(keyword, str) or not keyword.strip():
                raise ValueError(
                    "MatchedKeywords entries must be non-empty trimmed strings"
                )

    @classmethod
    def from_iterable(cls, values: Iterable[Any] | None) -> "MatchedKeywords":
        if values is None:
            return cls(values=("legacy",))
        seen: set[str] = set()
        normalized: list[str] = []
        for raw in values:
            if raw is None:
                continue
            keyword = str(raw).strip()
            if not keyword:
                continue
            key = keyword.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(keyword)
        if not normalized:
            # Empty input collapses to the sentinel — keeps the invariant
            # for legacy/imported rows whose source had no keywords.
            return cls(values=("legacy",))
        return cls(values=tuple(normalized))

    @classmethod
    def from_csv(cls, csv: str | None) -> "MatchedKeywords":
        if not csv:
            return cls(values=("legacy",))
        return cls.from_iterable(part.strip() for part in csv.split(","))

    def to_list(self) -> list[str]:
        return list(self.values)

    def to_csv(self) -> str:
        return ", ".join(self.values)

    def __iter__(self):
        return iter(self.values)

    def __len__(self) -> int:
        return len(self.values)


# ---------------------------------------------------------------------------
# ScoreCorrection — user override metadata
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScoreCorrection:
    """Records that a user overrode the LLM's score.

    The corrected ``FitScore`` is the source of truth going forward; the
    original LLM score remains on the previous ``JobScore`` version for
    audit. ``corrected_by`` is the tenant who issued the correction (in
    local mode this is always ``LOCAL_TENANT``).
    """

    corrected_fit_score: FitScore
    rationale: str
    corrected_by: TenantId
    corrected_at: str

    def __post_init__(self) -> None:
        if not isinstance(self.corrected_fit_score, FitScore):
            raise ValueError("ScoreCorrection.corrected_fit_score must be a FitScore")
        if not isinstance(self.rationale, str) or not self.rationale.strip():
            raise ValueError("ScoreCorrection.rationale must be a non-empty string")
        if not isinstance(self.corrected_at, str) or not self.corrected_at.strip():
            raise ValueError("ScoreCorrection.corrected_at must be a non-empty ISO-8601 timestamp")

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ScoreCorrection | None":
        if not data:
            return None
        score = FitScore.from_optional(data.get("corrected_fit_score"))
        if score is None:
            return None
        rationale = str(data.get("rationale") or "").strip()
        corrected_by = TenantId(str(data.get("corrected_by") or "local"))
        corrected_at = str(data.get("corrected_at") or "").strip()
        if not rationale or not corrected_at:
            return None
        return cls(
            corrected_fit_score=score,
            rationale=rationale,
            corrected_by=corrected_by,
            corrected_at=corrected_at,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "corrected_fit_score": self.corrected_fit_score.value,
            "rationale": self.rationale,
            "corrected_by": str(self.corrected_by),
            "corrected_at": self.corrected_at,
        }


# ---------------------------------------------------------------------------
# ScoreTrace — non-sensitive observability and audit metadata
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScoreTrace:
    """Non-sensitive trace metadata for one score version."""

    prompt_version: str = "score-fit-assessment-v1"
    schema_version: str = "score-fit-assessment-v1"
    model: str = "llm-port-default"
    criteria_version: str = ""
    profile_snapshot_version: int = 0
    scoring_policy_id: str = ""
    scoring_policy_version: int = 0
    rubric_version: str = ""
    raw_weighted_score: float | None = None
    calibration_adjustment: float = 0.0
    anchor_ids: tuple[str, ...] = ()
    resolved_fit_band: str = ""
    resolution_reason: str = ""
    resolved_dimensions: tuple[dict[str, Any], ...] = ()
    fit_band_thresholds: tuple[dict[str, Any], ...] = ()
    policy_evidence: dict[str, Any] = field(default_factory=dict)
    parser_warnings: tuple[str, ...] = ()
    correction_history: tuple[dict[str, Any], ...] = ()

    def __post_init__(self) -> None:
        for name in (
            "prompt_version",
            "schema_version",
            "model",
            "criteria_version",
            "scoring_policy_id",
            "rubric_version",
            "resolved_fit_band",
            "resolution_reason",
        ):
            value = str(getattr(self, name) or "").strip()
            object.__setattr__(self, name, value)
        try:
            profile_version = int(self.profile_snapshot_version or 0)
        except (TypeError, ValueError):
            profile_version = 0
        object.__setattr__(self, "profile_snapshot_version", profile_version)
        object.__setattr__(
            self,
            "scoring_policy_version",
            _int_or_default(self.scoring_policy_version, 0),
        )
        object.__setattr__(self, "raw_weighted_score", _float_or_none(self.raw_weighted_score))
        object.__setattr__(
            self,
            "calibration_adjustment",
            _float_or_default(self.calibration_adjustment, 0.0),
        )
        object.__setattr__(self, "anchor_ids", _clean_strings(self.anchor_ids))
        object.__setattr__(
            self,
            "resolved_dimensions",
            _clean_mapping_tuple(self.resolved_dimensions),
        )
        object.__setattr__(
            self,
            "fit_band_thresholds",
            _clean_mapping_tuple(self.fit_band_thresholds),
        )
        object.__setattr__(self, "policy_evidence", _clean_mapping(self.policy_evidence))
        object.__setattr__(self, "parser_warnings", _clean_strings(self.parser_warnings))
        history = []
        for raw in self.correction_history:
            if isinstance(raw, MappingABC):
                history.append(_clean_mapping(raw))
        object.__setattr__(self, "correction_history", tuple(history))

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ScoreTrace":
        data = data or {}
        return cls(
            prompt_version=str(data.get("prompt_version", data.get("promptVersion", "score-fit-assessment-v1"))),
            schema_version=str(data.get("schema_version", data.get("schemaVersion", "score-fit-assessment-v1"))),
            model=str(data.get("model") or "llm-port-default"),
            criteria_version=str(data.get("criteria_version", data.get("criteriaVersion", ""))),
            profile_snapshot_version=_int_or_default(
                data.get("profile_snapshot_version", data.get("profileSnapshotVersion", 0)),
                0,
            ),
            scoring_policy_id=str(
                data.get(
                    "scoring_policy_id",
                    data.get("scoringPolicyId", data.get("policy_id", data.get("policyId", ""))),
                )
                or ""
            ),
            scoring_policy_version=_int_or_default(
                data.get(
                    "scoring_policy_version",
                    data.get("scoringPolicyVersion", data.get("policy_version", data.get("policyVersion", 0))),
                ),
                0,
            ),
            rubric_version=str(data.get("rubric_version", data.get("rubricVersion", ""))),
            raw_weighted_score=_float_or_none(
                data.get("raw_weighted_score", data.get("rawWeightedScore"))
            ),
            calibration_adjustment=_float_or_default(
                data.get("calibration_adjustment", data.get("calibrationAdjustment", 0.0)),
                0.0,
            ),
            anchor_ids=_clean_strings(data.get("anchor_ids", data.get("anchorIds", ()))),
            resolved_fit_band=str(
                data.get("resolved_fit_band", data.get("resolvedFitBand", "")) or ""
            ),
            resolution_reason=str(
                data.get("resolution_reason", data.get("resolutionReason", "")) or ""
            ),
            resolved_dimensions=_clean_mapping_tuple(
                data.get("resolved_dimensions", data.get("resolvedDimensions", ()))
            ),
            fit_band_thresholds=_clean_mapping_tuple(
                data.get("fit_band_thresholds", data.get("fitBandThresholds", ()))
            ),
            policy_evidence=_clean_mapping(
                data.get("policy_evidence", data.get("policyEvidence", {}))
            ),
            parser_warnings=_clean_strings(data.get("parser_warnings", data.get("parserWarnings", ()))),
            correction_history=tuple(
                item for item in data.get("correction_history", data.get("correctionHistory", ())) or ()
                if isinstance(item, MappingABC)
            ),
        )

    def with_parser_warnings(self, warnings: Iterable[Any]) -> "ScoreTrace":
        return replace(
            self,
            parser_warnings=(*self.parser_warnings, *_clean_strings(warnings)),
        )

    def with_policy_resolution(self, resolved_score: Any) -> "ScoreTrace":
        return replace(
            self,
            scoring_policy_id=str(getattr(resolved_score, "policy_id", "") or ""),
            scoring_policy_version=int(getattr(resolved_score, "policy_version", 0) or 0),
            rubric_version=str(getattr(resolved_score, "rubric_version", "") or ""),
            raw_weighted_score=_float_or_none(getattr(resolved_score, "raw_weighted_score", None)),
            calibration_adjustment=_float_or_default(
                getattr(resolved_score, "calibration_adjustment", 0.0),
                0.0,
            ),
            anchor_ids=_clean_strings(getattr(resolved_score, "anchor_ids", ())),
            resolved_fit_band=str(getattr(resolved_score, "fit_band", "") or ""),
            resolution_reason=str(getattr(resolved_score, "resolution_reason", "") or ""),
            resolved_dimensions=_policy_object_tuple_to_dicts(
                getattr(resolved_score, "dimensions", ())
            ),
            fit_band_thresholds=_policy_object_tuple_to_dicts(
                getattr(resolved_score, "fit_band_thresholds", ())
            ),
            policy_evidence=_clean_mapping(
                getattr(resolved_score, "evidence_summary", {})
            ),
        )

    def with_correction(
        self,
        *,
        original_score: int,
        correction: ScoreCorrection,
    ) -> "ScoreTrace":
        return replace(
            self,
            correction_history=(
                *self.correction_history,
                {
                    "original_score": original_score,
                    "corrected_score": correction.corrected_fit_score.value,
                    "rationale": correction.rationale,
                    "corrected_by": str(correction.corrected_by),
                    "corrected_at": correction.corrected_at,
                },
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "prompt_version": self.prompt_version,
            "schema_version": self.schema_version,
            "model": self.model,
            "criteria_version": self.criteria_version,
            "profile_snapshot_version": self.profile_snapshot_version,
            "scoring_policy_id": self.scoring_policy_id,
            "scoring_policy_version": self.scoring_policy_version,
            "rubric_version": self.rubric_version,
            "raw_weighted_score": self.raw_weighted_score,
            "calibration_adjustment": self.calibration_adjustment,
            "anchor_ids": list(self.anchor_ids),
            "resolved_fit_band": self.resolved_fit_band,
            "resolution_reason": self.resolution_reason,
            "resolved_dimensions": list(self.resolved_dimensions),
            "fit_band_thresholds": list(self.fit_band_thresholds),
            "policy_evidence": self.policy_evidence,
            "parser_warnings": list(self.parser_warnings),
            "correction_history": list(self.correction_history),
        }


# ---------------------------------------------------------------------------
# ScoringCriteria — published rule-of-thumb threshold + free-text criteria
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScoringCriteria:
    """Tenant-configured scoring rules used by ``EligibilityChecker``.

    ``min_fit_score`` is the cutoff: only jobs with ``FitScore >= min_fit_score``
    are eligible for tailoring. ``criteria_text`` is the user's free-text
    description of what makes a "good" job (e.g. "remote, US-based, Python
    or Go") — passed through to the LLM prompt as additional guidance.
    """

    min_fit_score: int = 7
    criteria_text: str = ""
    target_criteria: str = ""
    profile_preferences: dict[str, Any] = field(default_factory=dict)
    criteria_version: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.min_fit_score, int) or isinstance(self.min_fit_score, bool):
            raise ValueError("ScoringCriteria.min_fit_score must be an int")
        if self.min_fit_score < 0 or self.min_fit_score > 10:
            raise ValueError(
                f"ScoringCriteria.min_fit_score must be in [0, 10], got {self.min_fit_score}"
            )
        if not isinstance(self.criteria_text, str):
            raise ValueError("ScoringCriteria.criteria_text must be a string")
        if not isinstance(self.target_criteria, str):
            raise ValueError("ScoringCriteria.target_criteria must be a string")
        prefs = _clean_mapping(self.profile_preferences)
        object.__setattr__(self, "profile_preferences", prefs)
        version = str(self.criteria_version or "").strip()
        if not version:
            version = self._derive_version(
                self.min_fit_score,
                self.criteria_text,
                self.target_criteria,
                prefs,
            )
        object.__setattr__(self, "criteria_version", version)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ScoringCriteria":
        data = data or {}
        return cls(
            min_fit_score=_int_or_default(data.get("min_fit_score", data.get("minFitScore", 7)), 7),
            criteria_text=str(data.get("criteria_text", data.get("criteriaText", "")) or ""),
            target_criteria=str(data.get("target_criteria", data.get("targetCriteria", "")) or ""),
            profile_preferences=_clean_mapping(
                data.get("profile_preferences", data.get("profilePreferences", {}))
            ),
            criteria_version=str(data.get("criteria_version", data.get("criteriaVersion", "")) or ""),
        )

    @classmethod
    def from_profile_snapshot(
        cls,
        profile_snapshot: "ProfileSnapshot",
        *,
        min_fit_score: int = 7,
        criteria_text: str = "",
        target_criteria: str = "",
    ) -> "ScoringCriteria":
        profile = profile_snapshot.as_dict()
        experience = profile.get("experience") if isinstance(profile.get("experience"), MappingABC) else {}
        preferences = {
            "profile_snapshot_version": profile_snapshot.version,
            "work_authorization": profile.get("work_authorization", {}),
            "compensation": profile.get("compensation", {}),
            "availability": profile.get("availability", {}),
            "target_role": experience.get("target_role", ""),
            "target_locations": experience.get("target_locations", ""),
            "target_work_models": experience.get("target_work_models", ""),
        }
        return cls(
            min_fit_score=min_fit_score,
            criteria_text=criteria_text,
            target_criteria=target_criteria,
            profile_preferences=preferences,
        )

    @staticmethod
    def _derive_version(
        min_fit_score: int,
        criteria_text: str,
        target_criteria: str,
        profile_preferences: dict[str, Any],
    ) -> str:
        payload = json.dumps(
            {
                "min_fit_score": min_fit_score,
                "criteria_text": criteria_text,
                "target_criteria": target_criteria,
                "profile_preferences": profile_preferences,
            },
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]

    def to_dict(self) -> dict[str, Any]:
        return {
            "min_fit_score": self.min_fit_score,
            "criteria_text": self.criteria_text,
            "target_criteria": self.target_criteria,
            "profile_preferences": self.profile_preferences,
            "criteria_version": self.criteria_version,
        }
