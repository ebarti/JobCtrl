"""Scoring domain services — pure functions over the value objects.

See ddd-target.md §4.4. These services contain the parsing + eligibility
rules that used to live in ``scoring/scorer.py`` as private helpers; lifting
them into the domain layer means they can be unit-tested independently of
the LLM and used by both the canonical scorer and the manual application
flow in ``pipeline.py``.

Two services live here:

  ``ScoreParser``        — turns the LLM's structured-output JSON payload
                           into the value objects required by ``JobScore``.
                           The LLM is invoked with a JSON schema (see
                           ``SCORE_SCHEMA`` in ``use_cases``); the parser
                           validates the dict shape and clamps invariants
                           the LLM violated. Failures are signalled via
                           the ``ok`` flag on the returned
                           ``ScoreParseResult`` rather than exceptions —
                           the caller wants to record an error event but
                           keep going.
  ``EligibilityChecker`` — gates downstream tailoring per
                           ``ScoringCriteria.min_fit_score`` plus hard
                           eligibility blockers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from jobhunter.domain.scoring.value_objects import (
    EligibilityAssessment,
    FitScore,
    MatchedKeywords,
    ScoreBreakdown,
    ScoreTrace,
    ScoringCriteria,
    fit_band_for_score,
)


# ---------------------------------------------------------------------------
# ScoreParser
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScoreParseResult:
    """Outcome of ``ScoreParser.parse_json``.

    When ``ok`` is True, ``fit_score``, ``breakdown``, and ``keywords`` are
    populated with the parsed values. When ``ok`` is False, ``fit_score``
    is ``None`` and ``error`` carries a human-readable reason; the
    breakdown still preserves whatever rationale arrived (or a stringified
    payload) so the caller can persist it for forensic inspection.
    """

    ok: bool
    fit_score: FitScore | None
    breakdown: ScoreBreakdown
    keywords: MatchedKeywords
    criteria: ScoringCriteria = field(default_factory=ScoringCriteria)
    trace: ScoreTrace = field(default_factory=ScoreTrace)
    error: str = ""


class ScoreParser:
    """Parses a structured-output JSON payload from ``LlmPort.chat_json``.

    The schema landed by the structured-outputs cutover (see
    ``use_cases.SCORE_SCHEMA``) is::

        {
          "score":          int 1..10,
          "technical_fit":  int 0..10,
          "experience_fit": int 0..10,
          "role_fit":       int 0..10,
          "fit_band":       "excellent" | "strong" | "plausible" | "stretch" | "poor",
          "confidence":     "high" | "medium" | "low",
          "eligibility":    {"status": str, "hard_blockers": [str], "warnings": [str]},
          "matched_signals": [str, ...],
          "missing_signals": [str, ...],
          "transferable_signals": [str, ...],
          "keywords":       [str, ...]   (≥1 entry),
          "reasoning":      str
        }

    Invariants the parser still enforces (because providers occasionally
    drift on ``response_format=json_schema``):

      * ``score`` is an int in [1, 10] — anything else flips ``ok=False``.
      * Component dimensions clamp into [0, 10] silently; out-of-range
        values are recorded as parse-error reasoning rather than persisted.
      * ``keywords`` must contain at least one non-empty entry; the
        legacy ``["legacy"]`` sentinel is reserved for backfilled rows
        and is never produced by the structured-output path.
    """

    def parse_json(
        self,
        payload: Any,
        *,
        criteria: ScoringCriteria | None = None,
        trace: ScoreTrace | None = None,
    ) -> ScoreParseResult:
        """Parse the structured-output payload into the scoring value objects."""
        criteria = criteria or ScoringCriteria()
        trace = trace or ScoreTrace()
        if not isinstance(payload, dict):
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=str(payload)[:2000]),
                keywords=MatchedKeywords(),
                criteria=criteria,
                trace=trace,
                error=f"LLM payload was {type(payload).__name__}, expected dict",
            )

        reasoning = str(payload.get("reasoning") or "").strip()
        keywords_raw = payload.get("keywords", [])
        keywords = MatchedKeywords.from_iterable(
            keywords_raw if isinstance(keywords_raw, list) else None
        )
        parser_warnings: list[str] = []

        score_raw = payload.get("score")
        fit_score = FitScore.from_optional(score_raw)
        if fit_score is None:
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning or str(payload)[:2000]),
                keywords=keywords,
                criteria=criteria,
                trace=trace,
                error=f"score {score_raw!r} missing or outside [1, 10]",
            )

        if "keywords" not in payload:
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning or str(payload)[:2000]),
                keywords=keywords,
                criteria=criteria,
                trace=trace,
                error="LLM payload missing 'keywords' (required by schema)",
            )
        if not isinstance(keywords_raw, list):
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning or str(payload)[:2000]),
                keywords=keywords,
                criteria=criteria,
                trace=trace,
                error="LLM payload 'keywords' must be an array",
            )
        if not _has_non_blank_keyword(keywords_raw):
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning or str(payload)[:2000]),
                keywords=keywords,
                criteria=criteria,
                trace=trace,
                error="LLM payload 'keywords' must contain at least one non-blank entry",
            )

        if "eligibility" not in payload:
            parser_warnings.append("missing_eligibility")
        if "confidence" not in payload:
            parser_warnings.append("missing_confidence")
        if "fit_band" not in payload:
            parser_warnings.append("missing_fit_band")

        fit_band = _choice_or_default(
            payload.get("fit_band"),
            allowed={"excellent", "strong", "plausible", "stretch", "poor"},
            default=fit_band_for_score(fit_score.value),
            warning_name="invalid_fit_band",
            warnings=parser_warnings,
        )
        confidence = _choice_or_default(
            payload.get("confidence"),
            allowed={"high", "medium", "low"},
            default="medium",
            warning_name="invalid_confidence",
            warnings=parser_warnings,
        )

        eligibility_raw = payload.get("eligibility")
        eligibility = EligibilityAssessment.from_dict(
            eligibility_raw if isinstance(eligibility_raw, dict) else None
        )

        breakdown = ScoreBreakdown(
            technical_fit=_clamp_dim(payload.get("technical_fit")),
            experience_fit=_clamp_dim(payload.get("experience_fit")),
            role_fit=_clamp_dim(payload.get("role_fit")),
            reasoning=reasoning,
            fit_band=fit_band,
            confidence=confidence,
            eligibility=eligibility,
            matched_signals=_strings_or_empty(payload.get("matched_signals")) or tuple(keywords),
            missing_signals=_strings_or_empty(payload.get("missing_signals")),
            transferable_signals=_strings_or_empty(payload.get("transferable_signals")),
        )
        return ScoreParseResult(
            ok=True,
            fit_score=fit_score,
            breakdown=breakdown,
            keywords=keywords,
            criteria=criteria,
            trace=trace.with_parser_warnings(parser_warnings),
            error="",
        )


def _clamp_dim(value: Any) -> int:
    """Clamp a single component dimension into ``[0, 10]``.

    Out-of-range / non-integer values become 0 rather than raising — the
    overall ``ScoreParseResult.ok`` flag is owned by the score field, and
    we'd rather persist a partially-typed breakdown than reject the row
    over a single bad dimension.
    """
    try:
        ivalue = int(value) if value is not None else 0
    except (TypeError, ValueError):
        return 0
    if ivalue < 0:
        return 0
    if ivalue > 10:
        return 10
    return ivalue


def _has_non_blank_keyword(values: list[Any]) -> bool:
    return any(raw is not None and str(raw).strip() for raw in values)


def _strings_or_empty(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    seen: set[str] = set()
    out: list[str] = []
    for raw in value:
        text = str(raw or "").strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return tuple(out)


def _choice_or_default(
    value: Any,
    *,
    allowed: set[str],
    default: str,
    warning_name: str,
    warnings: list[str],
) -> str:
    candidate = str(value or "").strip().lower()
    if candidate in allowed:
        return candidate
    if value not in (None, ""):
        warnings.append(warning_name)
    return default


# ---------------------------------------------------------------------------
# ConstraintChecker
# ---------------------------------------------------------------------------


class ConstraintChecker:
    """Deterministic eligibility checks over local criteria and job text."""

    _ONSITE_TERMS = ("on-site", "onsite", "office-based", "office based")
    _REMOTE_TERMS = ("remote", "work from home", "distributed")
    _NO_SPONSORSHIP_TERMS = (
        "no sponsorship",
        "not sponsor",
        "without sponsorship",
        "must be authorized",
        "must already be authorized",
    )

    def evaluate(self, *, job: dict[str, Any], criteria: ScoringCriteria) -> EligibilityAssessment:
        text = _job_text(job)
        prefs = criteria.profile_preferences
        blockers: list[str] = []
        warnings: list[str] = []

        work_auth = prefs.get("work_authorization", {})
        if isinstance(work_auth, dict):
            needs_sponsorship = _truthy_text(work_auth.get("require_sponsorship"))
            if needs_sponsorship and any(term in text for term in self._NO_SPONSORSHIP_TERMS):
                blockers.append("candidate requires sponsorship but posting says sponsorship is unavailable")

        target_work_models = _split_preferences(prefs.get("target_work_models"))
        if "remote" in target_work_models and any(term in text for term in self._ONSITE_TERMS):
            if not any(term in text for term in self._REMOTE_TERMS):
                blockers.append("target work model is remote but posting appears onsite-only")

        target_locations = _split_preferences(prefs.get("target_locations"))
        location = str(job.get("location") or "").strip().lower()
        if target_locations and location:
            if not any(loc in location or location in loc for loc in target_locations):
                warnings.append("posting location does not match target locations")

        compensation = prefs.get("compensation", {})
        if isinstance(compensation, dict):
            desired_min = _first_number(compensation.get("salary_range_min")) or _first_number(
                compensation.get("salary_expectation")
            )
            posted_max = _salary_max(job)
            if desired_min and posted_max and posted_max < desired_min:
                blockers.append("posted compensation appears below profile minimum")

        excluded = _explicit_exclusions(criteria.criteria_text, criteria.target_criteria)
        for phrase in excluded:
            if phrase and phrase in text:
                blockers.append(f"posting matches excluded criterion: {phrase}")

        status = "blocked" if blockers else ("warning" if warnings else "eligible")
        return EligibilityAssessment(status=status, hard_blockers=blockers, warnings=warnings)

    def apply(self, *, parse: ScoreParseResult, job: dict[str, Any]) -> ScoreParseResult:
        deterministic = self.evaluate(job=job, criteria=parse.criteria)
        merged = parse.breakdown.eligibility.merge(deterministic)
        if merged == parse.breakdown.eligibility:
            return parse
        breakdown = ScoreBreakdown(
            technical_fit=parse.breakdown.technical_fit,
            experience_fit=parse.breakdown.experience_fit,
            role_fit=parse.breakdown.role_fit,
            reasoning=parse.breakdown.reasoning,
            fit_band=parse.breakdown.fit_band,
            confidence=parse.breakdown.confidence,
            eligibility=merged,
            matched_signals=parse.breakdown.matched_signals,
            missing_signals=parse.breakdown.missing_signals,
            transferable_signals=parse.breakdown.transferable_signals,
        )
        return ScoreParseResult(
            ok=parse.ok,
            fit_score=parse.fit_score,
            breakdown=breakdown,
            keywords=parse.keywords,
            criteria=parse.criteria,
            trace=parse.trace,
            error=parse.error,
        )


# ---------------------------------------------------------------------------
# EligibilityChecker
# ---------------------------------------------------------------------------


class EligibilityChecker:
    """Gate that decides whether a ``JobScore`` clears downstream selection.

    Decoupled from ``ScoringCriteria`` so the same checker instance can be
    reused across tenants — the criteria object is passed at call time.
    Hard blockers remain separate from the display score, but downstream
    automation must not treat a high blocked score as actionable.
    """

    def is_eligible(
        self,
        fit_score: FitScore,
        criteria: ScoringCriteria,
        eligibility: EligibilityAssessment | None = None,
    ) -> bool:
        """True iff the candidate clears score and hard-blocker gates."""
        if eligibility is not None and (
            eligibility.status == "blocked" or eligibility.hard_blockers
        ):
            return False
        return fit_score.value >= criteria.min_fit_score


def _job_text(job: dict[str, Any]) -> str:
    return " ".join(
        str(job.get(key) or "")
        for key in ("title", "site", "company", "location", "salary", "description", "full_description")
    ).lower()


def _truthy_text(value: Any) -> bool:
    return str(value or "").strip().lower() in {"yes", "true", "1", "y", "required", "requires sponsorship"}


def _split_preferences(value: Any) -> set[str]:
    return {
        part.strip().lower()
        for part in re.split(r"[,;/|]", str(value or ""))
        if part.strip()
    }


def _first_number(value: Any) -> int | None:
    match = re.search(r"(\d[\d,]*)", str(value or ""))
    if not match:
        return None
    return int(match.group(1).replace(",", ""))


def _salary_max(job: dict[str, Any]) -> int | None:
    text = " ".join(str(job.get(key) or "") for key in ("salary", "description", "full_description"))
    numbers = [int(match.replace(",", "")) for match in re.findall(r"\d[\d,]*", text)]
    if not numbers:
        return None
    # Normalize common shorthand such as "120k".
    normalized = [n * 1000 if n < 1000 else n for n in numbers]
    return max(normalized)


def _explicit_exclusions(*texts: str) -> tuple[str, ...]:
    exclusions: list[str] = []
    for text in texts:
        for match in re.findall(r"(?:avoid|exclude|no)\s+([^.;\n]+)", text.lower()):
            exclusions.append(match.strip())
    return tuple(exclusions)
