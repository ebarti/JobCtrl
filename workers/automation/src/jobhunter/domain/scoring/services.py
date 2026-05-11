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
                           ``ScoringCriteria.min_fit_score``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from jobhunter.domain.scoring.value_objects import (
    FitScore,
    MatchedKeywords,
    ScoreBreakdown,
    ScoringCriteria,
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

    def parse_json(self, payload: Any) -> ScoreParseResult:
        """Parse the structured-output payload into the scoring value objects."""
        if not isinstance(payload, dict):
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=str(payload)[:2000]),
                keywords=MatchedKeywords(),
                error=f"LLM payload was {type(payload).__name__}, expected dict",
            )

        reasoning = str(payload.get("reasoning") or "").strip()
        keywords_raw = payload.get("keywords", [])
        keywords = MatchedKeywords.from_iterable(
            keywords_raw if isinstance(keywords_raw, list) else None
        )

        score_raw = payload.get("score")
        fit_score = FitScore.from_optional(score_raw)
        if fit_score is None:
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning or str(payload)[:2000]),
                keywords=keywords,
                error=f"score {score_raw!r} missing or outside [1, 10]",
            )

        if "keywords" not in payload:
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning or str(payload)[:2000]),
                keywords=keywords,
                error="LLM payload missing 'keywords' (required by schema)",
            )
        if not isinstance(keywords_raw, list):
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning or str(payload)[:2000]),
                keywords=keywords,
                error="LLM payload 'keywords' must be an array",
            )
        if not _has_non_blank_keyword(keywords_raw):
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning or str(payload)[:2000]),
                keywords=keywords,
                error="LLM payload 'keywords' must contain at least one non-blank entry",
            )

        breakdown = ScoreBreakdown(
            technical_fit=_clamp_dim(payload.get("technical_fit")),
            experience_fit=_clamp_dim(payload.get("experience_fit")),
            role_fit=_clamp_dim(payload.get("role_fit")),
            reasoning=reasoning,
        )
        return ScoreParseResult(
            ok=True,
            fit_score=fit_score,
            breakdown=breakdown,
            keywords=keywords,
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


# ---------------------------------------------------------------------------
# EligibilityChecker
# ---------------------------------------------------------------------------


class EligibilityChecker:
    """Gate that decides whether a ``JobScore`` clears the tailoring threshold.

    Decoupled from ``ScoringCriteria`` so the same checker instance can be
    reused across tenants — the criteria object is passed at call time. The
    checker is intentionally tiny: a single boolean predicate. Other gates
    (e.g. work-authorization compatibility) live in their own services so
    we never mix concerns inside one service.
    """

    def is_eligible(self, fit_score: FitScore, criteria: ScoringCriteria) -> bool:
        """True iff the candidate clears the configured ``min_fit_score`` cut."""
        return fit_score.value >= criteria.min_fit_score
