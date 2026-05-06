"""Scoring domain services — pure functions over the value objects.

See ddd-target.md §4.4. These services contain the parsing + eligibility
rules that used to live in ``scoring/scorer.py`` as private helpers; lifting
them into the domain layer means they can be unit-tested independently of
the LLM and used by both the canonical scorer and the manual application
flow in ``pipeline.py``.

Two services live here:

  ``ScoreParser``        — turns the LLM's free-text ``SCORE/KEYWORDS/REASONING``
                           response into the value objects required by
                           ``JobScore``. Failures are signalled via the
                           ``ok`` flag on the returned ``ScoreParseResult``
                           rather than exceptions, because the caller wants
                           to record an error event but keep going.
  ``EligibilityChecker`` — gates downstream tailoring per
                           ``ScoringCriteria.min_fit_score``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

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
    """Outcome of ``ScoreParser.parse``.

    When ``ok`` is True, ``fit_score``, ``breakdown``, and ``keywords`` are
    populated with the parsed values. When ``ok`` is False, ``fit_score``
    is ``None`` and ``error`` carries a human-readable reason; the
    breakdown still preserves the raw response so the caller can persist it
    as ``reasoning`` for forensic inspection.
    """

    ok: bool
    fit_score: FitScore | None
    breakdown: ScoreBreakdown
    keywords: MatchedKeywords
    error: str = ""


class ScoreParser:
    """Parses the canonical ``SCORE/KEYWORDS/REASONING`` LLM response."""

    # The legacy prompt format used in ``scoring/scorer.py``:
    #   SCORE: 8
    #   KEYWORDS: python, fastapi, postgres
    #   REASONING: ...
    #
    # The "between colon and content" whitespace is ``[ \t]*`` rather than
    # ``\s*`` so the regex doesn't greedily consume a trailing newline and
    # accidentally absorb the next line's content. Without this, an empty
    # ``KEYWORDS:`` line followed by ``REASONING: …`` would have the
    # parser capture "REASONING: …" as the keywords list.
    _SCORE_LINE = re.compile(r"^[ \t]*SCORE[ \t]*:[ \t]*(.*)$", re.IGNORECASE | re.MULTILINE)
    _KEYWORDS_LINE = re.compile(r"^[ \t]*KEYWORDS[ \t]*:[ \t]*(.*)$", re.IGNORECASE | re.MULTILINE)
    _REASONING_LINE = re.compile(
        r"^[ \t]*REASONING[ \t]*:[ \t]*(.*)$",
        re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    _DIGIT = re.compile(r"\d+")

    def parse(self, response: str) -> ScoreParseResult:
        """Parse a raw LLM response into ``FitScore``/``ScoreBreakdown``/``MatchedKeywords``.

        Returns ``ok=False`` when the score line is missing, the integer
        is out of range, or the LLM produced no keywords. In failure
        cases the breakdown still carries the raw response as
        ``reasoning`` so the caller can persist it for diagnosis.

        Component dimensions in ``ScoreBreakdown``
        (``technical_fit``/``experience_fit``/``role_fit``) are left at
        their default zero values: the legacy
        ``SCORE/KEYWORDS/REASONING`` prompt the worker still emits does
        not separate the score by dimension. The typed fields exist as a
        forward seam for the structured-output prompt cutover; once that
        lands, this parser will populate them and the keywords-required
        invariant tightens further. (Round-1 review M2.)
        """
        text = response or ""
        score_match = self._SCORE_LINE.search(text)
        keywords_match = self._KEYWORDS_LINE.search(text)
        reasoning_match = self._REASONING_LINE.search(text)

        reasoning = (
            reasoning_match.group(1).strip()
            if reasoning_match
            else text.strip()
        )
        # Empty / missing keywords need a sentinel because
        # ``MatchedKeywords`` enforces a non-empty invariant (round-1
        # review M1). On a successful SCORE we still flag the absence as
        # a parse failure below — the ``ok=False`` branch is what
        # callers use to decide whether to persist the score at all.
        keywords_csv = keywords_match.group(1).strip() if keywords_match else ""
        keywords = MatchedKeywords.from_csv(keywords_csv)
        keywords_present = bool(keywords_csv)

        if not score_match:
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning),
                keywords=keywords,
                error="LLM response missing SCORE: line",
            )

        digit_match = self._DIGIT.search(score_match.group(1))
        if not digit_match:
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning),
                keywords=keywords,
                error="LLM SCORE: line had no integer",
            )

        try:
            value = int(digit_match.group())
        except ValueError:
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning),
                keywords=keywords,
                error="LLM SCORE: integer parse failed",
            )

        # The legacy scorer clamped 0/11+ silently; we treat clamped values
        # as parse failures and return ok=False so the caller logs an
        # actual error rather than silently downgrading. Values inside
        # [1, 10] are accepted directly.
        fit_score = FitScore.from_optional(value)
        if fit_score is None:
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning),
                keywords=keywords,
                error=f"SCORE {value} outside [1, 10]",
            )

        # Round-1 review M1: a successful SCORE with no KEYWORDS line is
        # incomplete by §4.4 — a job's score must carry the ATS keywords
        # the LLM matched. The aggregate would still construct (the
        # keywords field falls back to the ``["legacy"]`` sentinel), but
        # that sentinel is reserved for backfilled rows; live scoring
        # MUST surface the failure so the operator sees the malformed
        # response.
        if not keywords_present:
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=reasoning),
                keywords=keywords,
                error="LLM response missing KEYWORDS: line",
            )

        breakdown = ScoreBreakdown(reasoning=reasoning)
        return ScoreParseResult(
            ok=True,
            fit_score=fit_score,
            breakdown=breakdown,
            keywords=keywords,
            error="",
        )


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
