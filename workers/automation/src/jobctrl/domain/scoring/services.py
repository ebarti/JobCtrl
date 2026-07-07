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

from jobctrl.domain.compensation import PostedCompensationFact, parse_posted_compensation
from jobctrl.domain.scoring.value_objects import (
    EligibilityAssessment,
    FitScore,
    MatchedKeywords,
    RequirementFitAssessment,
    RequirementFitStatus,
    RequirementScoreContribution,
    RequirementTailoringDirective,
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
    requirement_assessments: tuple[RequirementFitAssessment, ...] = ()
    employer_analysis_generation: int = 0
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
        requirement_assessments = _parse_requirement_assessments(
            payload.get("requirement_assessments", payload.get("requirementAssessments")),
            parser_warnings,
        )

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
            requirement_assessments=requirement_assessments,
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


def _parse_requirement_assessments(
    value: Any,
    warnings: list[str],
) -> tuple[RequirementFitAssessment, ...]:
    if value in (None, ""):
        return ()
    if not isinstance(value, list):
        warnings.append("invalid_requirement_assessments")
        return ()

    assessments: list[RequirementFitAssessment] = []
    seen: set[str] = set()
    for index, raw in enumerate(value, start=1):
        row_id = f"row_{index}"
        if isinstance(raw, dict):
            row_id = _text_field(raw, "requirement_id", "requirementId") or row_id
        if not isinstance(raw, dict):
            warnings.append(f"invalid_requirement_assessment:{row_id}")
            continue
        try:
            assessment = _parse_requirement_assessment(raw, row_id, warnings)
        except ValueError:
            warnings.append(f"invalid_requirement_assessment:{row_id}")
            continue
        key = assessment.requirement_id.lower()
        if key in seen:
            warnings.append(f"duplicate_requirement_assessment:{assessment.requirement_id}")
            continue
        seen.add(key)
        assessments.append(assessment)
    return tuple(assessments)


def _parse_requirement_assessment(
    raw: dict[str, Any],
    row_id: str,
    warnings: list[str],
) -> RequirementFitAssessment:
    requirement_id = _text_field(raw, "requirement_id", "requirementId") or row_id
    requirement_text = _text_field(raw, "requirement_text", "requirementText", "text")
    if not requirement_text:
        raise ValueError("requirement assessment requires text")

    fit = _parse_requirement_fit(raw, requirement_id, warnings)
    contribution = _parse_requirement_contribution(raw, requirement_id, warnings)
    tailoring = _parse_requirement_tailoring(raw, fit, requirement_text, requirement_id, warnings)
    return RequirementFitAssessment(
        requirement_id=requirement_id,
        requirement_text=requirement_text,
        tier=_text_field(raw, "tier") or "nice_to_have",
        weight=_number_field(raw, "weight"),
        job_evidence_span=_text_field(raw, "job_evidence_span", "jobEvidenceSpan", "evidence_span", "evidenceSpan"),
        fit=fit,
        contribution=contribution,
        tailoring=tailoring,
    )


def _parse_requirement_fit(
    raw: dict[str, Any],
    requirement_id: str,
    warnings: list[str],
) -> RequirementFitStatus:
    fit_raw = raw.get("fit") if isinstance(raw.get("fit"), dict) else {}
    assert isinstance(fit_raw, dict)
    kind = _text_field(fit_raw, "kind") or _text_field(raw, "fit_kind", "fitKind") or "not_assessed"
    kind = kind.strip().lower()
    evidence_ids = _strings_or_empty(
        fit_raw.get(
            "evidence_ids",
            fit_raw.get("evidenceIds", raw.get("evidence_ids", raw.get("evidenceIds", ()))),
        )
    )

    if kind == "matched" and not evidence_ids:
        warnings.append(f"requirement_fit_matched_without_evidence:{requirement_id}")
        kind = "not_assessed"
    if kind == "transferable" and not evidence_ids:
        warnings.append(f"requirement_fit_transferable_without_evidence:{requirement_id}")
        kind = "missing"

    if kind == "matched":
        return RequirementFitStatus(
            kind="matched",
            evidence_ids=evidence_ids,
            strength=_text_field(fit_raw, "strength") or "direct",
        )
    if kind == "transferable":
        return RequirementFitStatus(
            kind="transferable",
            evidence_ids=evidence_ids,
            gap=_text_field(fit_raw, "gap"),
            bridge=_text_field(fit_raw, "bridge")
            or "Candidate has adjacent evidence but no direct match.",
        )
    if kind == "missing":
        return RequirementFitStatus(
            kind="missing",
            reason=_text_field(fit_raw, "reason") or "No grounded profile evidence was found.",
        )
    if kind == "blocked":
        return RequirementFitStatus(
            kind="blocked",
            blocker=_text_field(fit_raw, "blocker") or "Requirement appears to be a hard blocker.",
        )
    return RequirementFitStatus(
        kind="not_assessed",
        reason=_text_field(fit_raw, "reason") or "Requirement fit was not assessed.",
    )


def _parse_requirement_contribution(
    raw: dict[str, Any],
    requirement_id: str,
    warnings: list[str],
) -> RequirementScoreContribution:
    contribution = raw.get("contribution")
    if not isinstance(contribution, dict):
        return RequirementScoreContribution(
            max_points=0.0,
            awarded_points=0.0,
            weighted_impact=0.0,
            rationale="Pending deterministic requirement-fit resolution.",
        )
    try:
        return RequirementScoreContribution.from_dict(contribution)
    except ValueError:
        warnings.append(f"invalid_requirement_contribution:{requirement_id}")
        return RequirementScoreContribution(
            max_points=0.0,
            awarded_points=0.0,
            weighted_impact=0.0,
            rationale="Invalid provider contribution ignored before deterministic resolution.",
        )


def _parse_requirement_tailoring(
    raw: dict[str, Any],
    fit: RequirementFitStatus,
    requirement_text: str,
    requirement_id: str,
    warnings: list[str],
) -> RequirementTailoringDirective:
    tailoring = raw.get("tailoring")
    if isinstance(tailoring, dict):
        try:
            return RequirementTailoringDirective.from_dict(tailoring)
        except ValueError:
            warnings.append(f"invalid_requirement_tailoring:{requirement_id}")

    priority = _number_field(raw, "weight")
    if fit.kind == "matched":
        return RequirementTailoringDirective(
            action="double_down",
            priority=priority,
            allowed_evidence_ids=fit.evidence_ids,
            target_keywords=_strings_or_empty(raw.get("target_keywords", raw.get("targetKeywords", ()))),
            instruction="Emphasize the cited profile evidence for this requirement.",
        )
    if fit.kind == "transferable":
        return RequirementTailoringDirective(
            action="bridge_gap",
            priority=priority,
            allowed_evidence_ids=fit.evidence_ids,
            target_keywords=_strings_or_empty(raw.get("target_keywords", raw.get("targetKeywords", ()))),
            instruction="Bridge from adjacent profile evidence without overstating direct experience.",
        )
    if fit.kind in {"missing", "blocked"}:
        return RequirementTailoringDirective(
            action="avoid_claim",
            priority=priority,
            prohibited_claims=(requirement_text,),
            instruction="Do not fabricate this requirement in generated materials.",
        )
    return RequirementTailoringDirective(
        action="low_priority",
        priority=priority,
        instruction="Leave unassessed requirements out unless later evidence supports them.",
    )


def _text_field(data: dict[str, Any], *keys: str) -> str:
    for key in keys:
        if key in data:
            return str(data.get(key) or "").strip()
    return ""


def _number_field(data: dict[str, Any], *keys: str) -> float:
    for key in keys:
        if key not in data:
            continue
        try:
            value = float(data.get(key) or 0.0)
        except (TypeError, ValueError):
            return 0.0
        if value < 0.0:
            return 0.0
        if value > 1.0:
            return 1.0
        return value
    return 0.0


# ---------------------------------------------------------------------------
# ConstraintChecker
# ---------------------------------------------------------------------------


class ConstraintChecker:
    """Deterministic eligibility checks over local criteria and job text."""

    _COMPENSATION_CONTEXT = re.compile(
        r"\b(?:salary|compensation|base\s+pay|base\s+salary|pay\s+range|"
        r"remuneration|wage|ote|on-target\s+earnings|annual\s+package)\b",
        re.IGNORECASE,
    )
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
        if "remote" in target_work_models and not any(term in text for term in self._REMOTE_TERMS):
            matched_onsite = next((term for term in self._ONSITE_TERMS if term in text), "")
            if matched_onsite:
                warnings.append(
                    "target work model is remote but posting appears onsite-only "
                    f"(matched '{matched_onsite}' in job text with no remote signal)"
                )

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
            if desired_min:
                signal = _posted_compensation_signal(job)
                if signal is not None and signal.annual_ceiling < desired_min:
                    reason = _compensation_reason(signal, desired_min)
                    if signal.reliable_annual:
                        blockers.append(reason)
                    else:
                        warnings.append(reason)

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
            requirement_assessments=parse.requirement_assessments,
            employer_analysis_generation=parse.employer_analysis_generation,
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


_ANNUAL_SALARY_FLOOR = 12_000
_WORK_WEEKS_PER_YEAR = 52
_WORK_DAYS_PER_YEAR = 260
_WEEKLY_MARKER = re.compile(r"/\s*wk\b|/\s*week\b|\bper\s+week\b|\bweekly\b", re.IGNORECASE)
_DAILY_MARKER = re.compile(r"/\s*day\b|\bper\s+day\b|\bday\s*rate\b|\bper\s+diem\b|\bdaily\b", re.IGNORECASE)


@dataclass(frozen=True)
class _PostedCompensationSignal:
    """A single posted-compensation reading distilled for the eligibility gate.

    ``reliable_annual`` is the only thing that can turn a below-minimum
    reading into a hard blocker: it is true only for a genuinely annual
    figure taken from the structured salary field. Hourly/monthly figures
    (annualized via a fixed-hours assumption) and description-derived
    figures stay warnings so a truthful, high-fit job is never dropped from
    the funnel on a brittle guess.
    """

    annual_ceiling: int
    source_field: str
    period: str
    assumption: str
    reliable_annual: bool


def _posted_compensation_signal(job: dict[str, Any]) -> _PostedCompensationSignal | None:
    salary = str(job.get("salary") or "").strip()
    if salary:
        signal = _signal_from_fact(
            parse_posted_compensation(salary, source_field="jobs.salary"),
            salary_field=True,
        )
        if signal is not None:
            return signal

    description = "\n".join(str(job.get(key) or "") for key in ("description", "full_description"))
    best: _PostedCompensationSignal | None = None
    for window in _compensation_windows(description):
        signal = _signal_from_fact(
            parse_posted_compensation(window, source_field="jobs.description"),
            salary_field=False,
        )
        if signal is None:
            continue
        if best is None or signal.annual_ceiling > best.annual_ceiling:
            best = signal
    return best


def _signal_from_fact(
    fact: PostedCompensationFact,
    *,
    salary_field: bool,
) -> _PostedCompensationSignal | None:
    if fact.parse_state != "parsed_range":
        return None
    if fact.period in ("year", "month", "hour"):
        ceiling = fact.annualized_maximum_amount
        if ceiling is None:
            return None
        return _PostedCompensationSignal(
            annual_ceiling=ceiling,
            source_field=fact.source_field,
            period=fact.period,
            assumption=fact.annualization_assumption or "",
            reliable_annual=salary_field and fact.period == "year",
        )
    ceiling = fact.maximum_amount
    if ceiling is None:
        return None
    subannual = _subannual_from_text(fact.source_text)
    if subannual is not None:
        period, factor, assumption = subannual
        return _PostedCompensationSignal(
            annual_ceiling=ceiling * factor,
            source_field=fact.source_field,
            period=period,
            assumption=assumption,
            reliable_annual=False,
        )
    if ceiling < _ANNUAL_SALARY_FLOOR:
        return None
    return _PostedCompensationSignal(
        annual_ceiling=ceiling,
        source_field=fact.source_field,
        period="unknown",
        assumption="amount without an explicit pay period; read as annual",
        reliable_annual=salary_field,
    )


def _subannual_from_text(source_text: str | None) -> tuple[str, int, str] | None:
    """Detect a week/day pay marker the posted-comp parser leaves as unknown.

    The shared parser only classifies hour/month/year; a salary-field figure
    like "$15,000/week" would otherwise be read as a raw annual amount and
    could fabricate a below-minimum hard blocker on a ~$780k/yr role. Weekly
    and daily rates are annualized here and always kept as warnings, never
    hard blockers, because they rely on a fixed-schedule assumption.
    """
    text = source_text or ""
    if _DAILY_MARKER.search(text):
        return ("day", _WORK_DAYS_PER_YEAR, "daily rate annualized by multiplying by 260 working days")
    if _WEEKLY_MARKER.search(text):
        return ("week", _WORK_WEEKS_PER_YEAR, "weekly rate annualized by multiplying by 52 weeks")
    return None


def _compensation_reason(signal: _PostedCompensationSignal, desired_min: int) -> str:
    provenance = f"source {signal.source_field}, period {signal.period}"
    if signal.assumption:
        provenance = f"{provenance}, {signal.assumption}"
    return (
        "posted compensation appears below profile minimum: "
        f"${signal.annual_ceiling:,} vs profile minimum ${desired_min:,} ({provenance})"
    )


def _compensation_windows(text: str) -> list[str]:
    windows: list[str] = []
    for segment in re.split(r"[\n.;]", text):
        if ConstraintChecker._COMPENSATION_CONTEXT.search(segment):
            windows.append(segment)
    return windows


def _explicit_exclusions(*texts: str) -> tuple[str, ...]:
    exclusions: list[str] = []
    for text in texts:
        for match in re.findall(r"(?:avoid|exclude|no)\s+([^.;\n]+)", text.lower()):
            exclusions.append(match.strip())
    return tuple(exclusions)
