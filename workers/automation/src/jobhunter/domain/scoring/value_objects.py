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
    scoring_policy_version: int = 0
    rubric_version: str = ""
    raw_weighted_score: float | None = None
    calibration_adjustment: float = 0.0
    anchor_ids: tuple[str, ...] = ()
    parser_warnings: tuple[str, ...] = ()
    correction_history: tuple[dict[str, Any], ...] = ()

    def __post_init__(self) -> None:
        for name in ("prompt_version", "schema_version", "model", "criteria_version", "rubric_version"):
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
            scoring_policy_version=int(getattr(resolved_score, "policy_version", 0) or 0),
            rubric_version=str(getattr(resolved_score, "rubric_version", "") or ""),
            raw_weighted_score=_float_or_none(getattr(resolved_score, "raw_weighted_score", None)),
            calibration_adjustment=_float_or_default(
                getattr(resolved_score, "calibration_adjustment", 0.0),
                0.0,
            ),
            anchor_ids=_clean_strings(getattr(resolved_score, "anchor_ids", ())),
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
            "scoring_policy_version": self.scoring_policy_version,
            "rubric_version": self.rubric_version,
            "raw_weighted_score": self.raw_weighted_score,
            "calibration_adjustment": self.calibration_adjustment,
            "anchor_ids": list(self.anchor_ids),
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
