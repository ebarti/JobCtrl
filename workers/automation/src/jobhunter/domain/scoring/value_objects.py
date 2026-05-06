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

from dataclasses import dataclass
from typing import Any, Iterable

from jobhunter.domain.tenant import TenantId


# ---------------------------------------------------------------------------
# FitScore — int constrained to [1, 10]
# ---------------------------------------------------------------------------


_FIT_SCORE_MIN = 1
_FIT_SCORE_MAX = 10


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
# ScoreBreakdown — fixed-dimensional component scores + reasoning
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

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ScoreBreakdown":
        data = data or {}
        return cls(
            technical_fit=int(data.get("technical_fit", 0) or 0),
            experience_fit=int(data.get("experience_fit", 0) or 0),
            role_fit=int(data.get("role_fit", 0) or 0),
            reasoning=str(data.get("reasoning") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "technical_fit": self.technical_fit,
            "experience_fit": self.experience_fit,
            "role_fit": self.role_fit,
            "reasoning": self.reasoning,
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

    def __post_init__(self) -> None:
        if not isinstance(self.min_fit_score, int) or isinstance(self.min_fit_score, bool):
            raise ValueError("ScoringCriteria.min_fit_score must be an int")
        if self.min_fit_score < 0 or self.min_fit_score > 10:
            raise ValueError(
                f"ScoringCriteria.min_fit_score must be in [0, 10], got {self.min_fit_score}"
            )
        if not isinstance(self.criteria_text, str):
            raise ValueError("ScoringCriteria.criteria_text must be a string")
