"""Scoring use cases — application-layer orchestration.

See ddd-target.md §3.4 (use cases own transaction boundaries) and §4.4.

Two use cases live here:

  ``ScoreJobUseCase``     — given a profile snapshot + job description,
                            calls the ``LlmPort`` for a 1..10 fit score,
                            parses the response into the ``JobScore``
                            aggregate, persists via ``ScoreRepository``,
                            and publishes ``JobScored``.
  ``CorrectScoreUseCase`` — applies a user override; saves a new
                            ``JobScore`` version with the
                            ``ScoreCorrection`` attached and publishes
                            ``ScoreCorrected``.

Both use cases accept their dependencies as constructor arguments so
tests can swap fakes without monkey-patching.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any

from opentelemetry import trace as otel_trace
from opentelemetry.trace import Status, StatusCode

from jobctrl.domain.events import (
    JobScoredPayload,
    ScoreCorrectedPayload,
    create_job_scored,
    create_score_corrected,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.analysis import EmployerAnalysis
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.llm_lanes import lane_bound
from jobctrl.domain.ports.scoring import (
    LlmPort,
    RequirementFitReportRepository,
    ScoreRepository,
    ScoreStalenessRepository,
    ScoringPolicyRepository,
)
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.scoring.aggregate import JobScore
from jobctrl.domain.scoring.policy import CorrectionSignal, ScoringPolicy
from jobctrl.domain.scoring.requirement_fit import (
    REQUIREMENT_FIT_FORMULA_VERSION,
    derive_requirement_fit_signals,
    resolve_requirement_fit_report,
)
from jobctrl.domain.scoring.services import ScoreParseResult, ScoreParser
from jobctrl.domain.scoring.determination import ScoringDecision
from jobctrl.domain.determinations import Source, DeterminationFailure, determine
from jobctrl.domain.profile.canonical_sources import profile_sources
from jobctrl.domain.job_snapshot import build_jd_snapshot
from jobctrl.domain.scoring.value_objects import (
    FitScore,
    MatchedKeywords,
    RequirementFitReport,
    ScoreBreakdown,
    ScoreCorrection,
    ScoreTrace,
    ScoringCriteria,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


SCORE_PROMPT_VERSION = "score-fit-assessment-v9-canonical-evidence"
SCORE_SCHEMA_VERSION = "score-fit-assessment-v5-determinations"
SCORE_THINKING_BUDGET = 0


SCORE_PROMPT = """You are a job fit evaluator for an applicant-side local tool. Given a candidate profile, saved scoring criteria, and a job description, produce an explainable fit assessment.

SCORING CRITERIA (overall `score`, 1..10):
- 9-10: Perfect match. Candidate has direct experience in nearly all required skills and qualifications.
- 7-8: Strong match. Candidate has most required skills, minor gaps easily bridged.
- 5-6: Moderate match. Candidate has some relevant skills but missing key requirements.
- 3-4: Weak match. Significant skill gaps, would need substantial ramp-up.
- 1-2: Poor match. Completely different field or experience level.

DIMENSION SCORES (0..10 each — be strict, do not anchor on the overall score):
- `technical_fit`: alignment of programming languages, frameworks, tools, and platforms.
- `experience_fit`: alignment of years / seniority level / domain depth.
- `role_fit`: alignment of role responsibilities and the candidate's recent role focus.

ELIGIBILITY: keep hard constraints separate from the numeric score. Use `blocked` when work authorization, application language, seniority floor, or an explicit exclusion is a non-negotiable mismatch. For every blocker return a typed category, reason and citations. Compensation range and location/work-model preferences are always `warning` signals and must never appear in `hard_blockers`; Return preference mismatches as typed warnings. Use `warning` for likely mismatches that need review. Use `eligible` only when no hard blocker or warning is visible.

EVIDENCE: name matched signals, missing signals, and transferable signals. Do not invent candidate experience to close a gap.

REQUIREMENT ASSESSMENTS: when the input includes explicit employer requirement IDs and profile evidence IDs, include `requirement_assessments`. Each row must classify the candidate's pre-tailoring fit for one requirement. Use `matched` or `transferable` only when citing provided profile evidence IDs. If explicit IDs are absent, omit `requirement_assessments`; do not invent requirement IDs or evidence IDs.

CONFIDENCE: use `low` when the posting is thin, the profile is incomplete, evidence conflicts, or the score needs manual review.

KEYWORDS: list ATS keywords from the job description that match or could match the candidate. At least one keyword is required.

REASONING: 2-3 sentence justification.

Respond as a JSON object conforming to the provided schema. Do not wrap the JSON in markdown fences and do not include any prose outside the JSON object."""


SCORE_SCHEMA = ScoringDecision.model_json_schema()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _job_id(job: dict[str, Any]) -> JobId:
    """Return the canonical aggregate identity carried by a scoring input."""
    return canonical_job_id(str(job["job_id"]))


def _job_tenant_id(job: dict[str, Any]) -> TenantId:
    """Return the explicit tenant boundary carried by a scoring input."""
    return TenantId(str(job["tenant_id"]))


def _matching_employer_analysis(
    job: dict[str, Any],
    employer_analysis: EmployerAnalysis | None,
) -> EmployerAnalysis | None:
    if employer_analysis is None:
        return None
    job_id = _job_id(job)
    tenant_id = _job_tenant_id(job)
    if employer_analysis.job_id == job_id and employer_analysis.tenant_id == tenant_id:
        return employer_analysis
    log.warning(
        "Ignoring employer analysis for tenant=%s job=%s while scoring tenant=%s job=%s",
        employer_analysis.tenant_id,
        employer_analysis.job_id,
        tenant_id,
        job_id,
    )
    return None


def _build_job_blob(job: dict[str, Any]) -> str:
    return (
        f"TITLE: {job.get('title', '')}\n"
        f"COMPANY: {job.get('company') or job.get('site', '')}\n"
        f"LOCATION: {job.get('location') or 'N/A'}\n\n"
        f"DESCRIPTION:\n{(job.get('full_description') or '')[:6000]}"
    )


def _build_requirement_fit_inputs_blob(
    *,
    job: dict[str, Any],
    profile_snapshot: ProfileSnapshot,
    employer_analysis: EmployerAnalysis | None,
) -> str:
    if employer_analysis is None:
        return ""

    requirements = [
        {
            "id": requirement.id,
            "text": requirement.text,
            "tier": requirement.tier,
            "weight": requirement.weight,
            "evidence_span": requirement.evidence_span,
        }
        for requirement in employer_analysis.canonical.requirements
        if requirement.id and requirement.text
    ]
    if not requirements:
        return ""

    payload = {
        "employer_analysis_generation": employer_analysis.generation,
        "requirements": requirements,
        "profile_evidence": _profile_evidence_prompt_items(profile_snapshot),
    }
    return "REQUIREMENT FIT INPUTS:\n" + json_dumps(payload)


def _profile_evidence_prompt_items(profile_snapshot: ProfileSnapshot) -> list[dict[str, Any]]:
    # Advertised evidence is the same inventory and verbatim text validated
    # after the model call. Unconfirmed suggestions never become evidence.
    return [
        {"id": source.source_id, "source_text": source.text}
        for source in profile_sources(profile_snapshot.as_dict())
    ]


def _optional_prompt_section(text: str) -> str:
    if not text:
        return ""
    return f"---\n\n{text}\n\n"


def _has_requirement_fit(parse: ScoreParseResult) -> bool:
    return bool(parse.requirement_assessments) and parse.employer_analysis_generation > 0


def json_dumps(value: Any) -> str:
    import json

    return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)


# ---------------------------------------------------------------------------
# ScoreJobUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScoreJobOutcome:
    """Result of a single ``ScoreJobUseCase.execute`` call.

    ``ok=True`` and ``score`` populated when the LLM returned a parseable
    fit score. ``ok=False`` and ``error`` populated otherwise — in that
    case nothing was persisted and no event was published. The job dict
    handed to ``execute`` is left untouched in either case.
    """

    ok: bool
    score: JobScore | None
    error: str = ""


class ScoreJobUseCase:
    """Score one job and persist the result through ``ScoreRepository``.

    The use case owns the transaction boundary: it reads the previous
    ``JobScore`` (if any), constructs the next version, persists it, then
    publishes ``JobScored``. The repository commits eagerly; the event
    publisher is called after the commit so subscribers see the new row.
    """

    def __init__(
        self,
        *,
        repository: ScoreRepository,
        llm: LlmPort,
        publisher: EventPublisher | None = None,
        parser: ScoreParser | None = None,
        determination_dependencies,
        job_interpretation_reader,
        confirmed_preferences_reader,
        policy_repository: ScoringPolicyRepository | None = None,
        requirement_fit_repository: RequirementFitReportRepository | None = None,
        policy: ScoringPolicy | None = None,
        prompt: str = SCORE_PROMPT,
    ) -> None:
        self._repository = repository
        self._llm = llm
        self._publisher = publisher
        self._parser = parser or ScoreParser()
        self._determination_dependencies = determination_dependencies
        self._job_interpretation_reader = job_interpretation_reader
        self._confirmed_preferences_reader = confirmed_preferences_reader
        self._policy_repository = policy_repository
        self._requirement_fit_repository = requirement_fit_repository
        self._policy = policy
        self._prompt = prompt

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def score(
        self,
        *,
        job: dict[str, Any],
        profile_snapshot: ProfileSnapshot,
        tenant_id: TenantId = LOCAL_TENANT,
        resume_text: str | None = None,
        criteria: ScoringCriteria | None = None,
        employer_analysis: EmployerAnalysis | None = None,
    ) -> ScoreJobOutcome:
        """**Preferred entry point** for single-threaded callers.

        Runs one scoring round end-to-end (LLM ⇒ persist ⇒ publish).
        Use this from the manual ``apply_jobs`` flow, the CLI dry run,
        or any other context that doesn't need to detach the LLM call
        from the SQLite connection thread. For batch / multi-threaded
        callers see :meth:`compute` + :meth:`persist_outcome`.

        ``resume_text`` is accepted as an explicit fallback for callers
        that still hand the raw resume file in (the legacy scorer reads
        the on-disk file). If omitted, the snapshot's resume baseline is
        used. Either way the LLM only sees the resume text — the snapshot
        carries the published candidate language.
        """
        if _job_tenant_id(job) != tenant_id:
            raise ValueError("Scoring input tenant_id does not match the requested tenant")
        parse_result = self.compute(
            job=job,
            profile_snapshot=profile_snapshot,
            tenant_id=tenant_id,
            resume_text=resume_text,
            criteria=criteria,
            employer_analysis=employer_analysis,
        )
        return self.persist_outcome(job=job, parse=parse_result, tenant_id=tenant_id)

    def compute(
        self,
        *,
        job: dict[str, Any],
        profile_snapshot: ProfileSnapshot,
        tenant_id: TenantId = LOCAL_TENANT,
        resume_text: str | None = None,
        criteria: ScoringCriteria | None = None,
        employer_analysis: EmployerAnalysis | None = None,
    ) -> ScoreParseResult:
        """LLM call + parse only — does NOT touch the repository.

        **Use only when you need to detach the LLM I/O from the connection
        thread.** Single-threaded callers should prefer :meth:`score`,
        which handles the full LLM ⇒ persist ⇒ publish flow.

        This split exists because SQLite connections are single-threaded;
        the batch ``run_scoring`` runner submits LLM work to a
        ``ThreadPoolExecutor`` and joins on the main thread to persist
        each parse via :meth:`persist_outcome`.
        """
        _job_id(job)
        if _job_tenant_id(job) != tenant_id:
            raise ValueError("Scoring input tenant_id does not match the requested tenant")
        text = resume_text or profile_snapshot.as_dict().get("resume", {}).get("executive_profile", {}).get(
            "baseline_text", ""
        )
        scoring_criteria = criteria or ScoringCriteria.from_profile_snapshot(profile_snapshot)
        return self._call_llm(
            job=job,
            resume_text=text,
            profile_snapshot=profile_snapshot,
            criteria=scoring_criteria,
            employer_analysis=employer_analysis,
        )

    def persist_outcome(
        self,
        *,
        job: dict[str, Any],
        parse: ScoreParseResult,
        tenant_id: TenantId = LOCAL_TENANT,
    ) -> ScoreJobOutcome:
        """Persist a parsed score and emit ``JobScored``.

        **Pair with :meth:`compute` when LLM I/O ran on a worker thread.**
        Single-threaded callers should use :meth:`score` instead of
        invoking this directly.

        Returns ``ok=False`` (and writes nothing) when the parse failed.
        Errors from the repository propagate — they indicate either a
        version conflict or a real persistence failure and the caller
        wants both surfaced.
        """
        if not parse.ok or parse.fit_score is None:
            return ScoreJobOutcome(
                ok=False,
                score=None,
                error=parse.error or "Unknown parse error",
            )

        if _job_tenant_id(job) != tenant_id:
            raise ValueError("Scoring input tenant_id does not match the requested tenant")
        job_id = _job_id(job)
        resolved_parse = (
            self._resolve_with_requirement_fit(
                parse=parse,
                tenant_id=tenant_id,
                job_id=job_id,
            )
            if _has_requirement_fit(parse)
            else self._resolve_with_policy(parse=parse, tenant_id=tenant_id)
        )
        scored_at = _utc_now()
        new_score = self._build_aggregate(
            tenant_id=tenant_id,
            job=job,
            parse=resolved_parse,
            scored_at=scored_at,
        )
        self._repository.save(new_score)
        self._determination_dependencies["repository"].bind(
            tenant_id=str(tenant_id),
            entity_kind="score",
            entity_id=str(job_id),
            entity_version=str(new_score.version),
            determination_kind="scoring",
            determination_id=resolved_parse.trace.determination_id,
        )
        self._persist_requirement_fit_report(
            tenant_id=tenant_id,
            score=new_score,
            parse=resolved_parse,
        )
        self._publish_scored(new_score)
        return ScoreJobOutcome(ok=True, score=new_score)

    # Convenience legacy-shape entry point — preserved so the manual
    # ``pipeline.apply_jobs`` flow can keep its single-call ergonomics.
    def execute(
        self,
        *,
        profile_snapshot: ProfileSnapshot,
        job: dict[str, Any],
        tenant_id: TenantId = LOCAL_TENANT,
        resume_text: str | None = None,
        criteria: ScoringCriteria | None = None,
        employer_analysis: EmployerAnalysis | None = None,
    ) -> ScoreJobOutcome:
        return self.score(
            job=job,
            profile_snapshot=profile_snapshot,
            tenant_id=tenant_id,
            resume_text=resume_text,
            criteria=criteria,
            employer_analysis=employer_analysis,
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @lane_bound("scoring")
    def _call_llm(
        self,
        *,
        job: dict[str, Any],
        resume_text: str,
        profile_snapshot: ProfileSnapshot,
        criteria: ScoringCriteria,
        employer_analysis: EmployerAnalysis | None = None,
    ) -> ScoreParseResult:
        matched_employer_analysis = _matching_employer_analysis(job, employer_analysis)
        trace = ScoreTrace(
            prompt_version=SCORE_PROMPT_VERSION,
            schema_version=SCORE_SCHEMA_VERSION,
            model=str(getattr(self._llm, "model", "llm-port-default")),
            criteria_version=criteria.criteria_version,
            profile_snapshot_version=profile_snapshot.version,
        )
        requirement_fit_inputs = _build_requirement_fit_inputs_blob(
            job=job,
            profile_snapshot=profile_snapshot,
            employer_analysis=matched_employer_analysis,
        )
        with otel_trace.get_tracer("jobctrl.scoring").start_as_current_span("scoring.score_job") as span:
            span.set_attribute("langfuse.observation.type", "span")
            span.set_attribute("jobctrl.scoring.prompt_version", SCORE_PROMPT_VERSION)
            span.set_attribute("jobctrl.scoring.schema_version", SCORE_SCHEMA_VERSION)
            span.set_attribute("jobctrl.scoring.criteria_version", criteria.criteria_version)
            span.set_attribute("jobctrl.scoring.profile_snapshot_version", profile_snapshot.version)
            span.set_attribute("jobctrl.scoring.min_fit_score", criteria.min_fit_score)
            try:
                authored = profile_sources(profile_snapshot.as_dict())
                interpretation = self._job_interpretation_reader(job)
                if interpretation is None:
                    raise DeterminationFailure("job_interpretation_unavailable")
                requirements = (
                    {row.id: row.evidence_span for row in matched_employer_analysis.canonical.requirements}
                    if matched_employer_analysis
                    else {}
                )
                confirmed_preferences = self._confirmed_preferences_reader(profile_snapshot, criteria)
                sources = [
                    Source(source_id="posting", text=build_jd_snapshot(job)),
                    *authored,
                    *confirmed_preferences,
                    Source(
                        source_id="authored_conditions",
                        text=json_dumps(
                            {
                                key: criteria.profile_preferences.get(key)
                                for key in ("work_authorization", "compensation", "availability")
                            }
                        ),
                    ),
                    Source(source_id="job-interpretation", text=interpretation.model_dump_json()),
                    *[Source(source_id=ident, text=text) for ident, text in requirements.items()],
                ]
                result, envelope = determine(
                    kind="scoring",
                    schema=ScoringDecision,
                    schema_version=SCORE_SCHEMA_VERSION,
                    prompt_version=SCORE_PROMPT_VERSION,
                    instruction=self._prompt
                    + " Each eligibility blocker must carry a closed category, rationale and verbatim citations. Compensation, work-model and location preferences belong in warnings, never blockers. Use the supplied job interpretation and saved search preferences; selected settings are authoritative. Compare shared codes directly and assess the posting against authored criteria through cited verdicts. Never replace saved preferences or invent a constraint. Every requirement ID must have one cited assessment. RequirementFit.evidence_ids must use only candidate_evidence_ids; copy quotes from the corresponding canonical sources, without reconstructing or joining fields. Decide discovery_feedback independently: propose_exact_title_exclusion only when the role itself is unsuitable for the confirmed target and avoiding that literal title would help. Otherwise use none. Give verbatim citations and a reason; do not use a score threshold to decide this. Cite supplied evidence IDs only.",
                    sources=sources,
                    context={
                        "profile_version": profile_snapshot.version,
                        "criteria_version": criteria.criteria_version,
                        "requirement_ids": sorted(requirements),
                        "candidate_evidence_ids": [item.source_id for item in authored],
                        "requirement_fit_inputs": requirement_fit_inputs,
                    },
                    entity_id=str(job["job_id"]),
                    validate=lambda row: row.validate_inventory(
                        requirements=requirements, evidence_ids={item.source_id for item in authored}
                    ),
                    **{**self._determination_dependencies, "tenant_id": str(profile_snapshot.tenant_id)},
                )
                payload = result.score_payload()
            except DeterminationFailure as failure:
                return ScoreParseResult(
                    ok=False,
                    fit_score=None,
                    breakdown=ScoreBreakdown(),
                    keywords=MatchedKeywords(),
                    criteria=criteria,
                    trace=trace,
                    error=str(failure),
                )

            trace = replace(trace, determination_id=envelope.determination_id)
            parsed = self._parser.parse_json(payload, criteria=criteria, trace=trace)
            if parsed.ok:
                if matched_employer_analysis is not None:
                    parsed = replace(
                        parsed,
                        employer_analysis_generation=matched_employer_analysis.generation,
                    )
            span.set_attribute("jobctrl.scoring.parse.ok", parsed.ok)
            span.set_attribute("jobctrl.scoring.parser_warning_count", len(parsed.trace.parser_warnings))
            span.set_attribute("jobctrl.scoring.eligibility", parsed.breakdown.eligibility.status)
            span.set_attribute("jobctrl.scoring.hard_blocker_count", len(parsed.breakdown.eligibility.hard_blockers))
            span.set_attribute("jobctrl.scoring.fit_band", parsed.breakdown.fit_band)
            span.set_attribute("jobctrl.scoring.confidence", parsed.breakdown.confidence)
            if parsed.fit_score is not None:
                span.set_attribute("jobctrl.scoring.fit_score", parsed.fit_score.value)
            if not parsed.ok:
                span.set_status(Status(StatusCode.ERROR, parsed.error))
            return parsed

    def _build_aggregate(
        self,
        *,
        tenant_id: TenantId,
        job: dict[str, Any],
        parse: ScoreParseResult,
        scored_at: str,
    ) -> JobScore:
        job_id = _job_id(job)
        previous = self._repository.load(tenant_id, job_id)
        # Type guard: parse.ok is True at this point (caller checks).
        assert parse.fit_score is not None
        if previous is None:
            return JobScore.initial(
                tenant_id=tenant_id,
                job_id=job_id,
                fit_score=parse.fit_score,
                breakdown=parse.breakdown,
                matched_keywords=parse.keywords,
                scored_at=scored_at,
                criteria=parse.criteria,
                trace=parse.trace,
            )
        return previous.next_version(
            fit_score=parse.fit_score,
            breakdown=parse.breakdown,
            matched_keywords=parse.keywords,
            scored_at=scored_at,
            criteria=parse.criteria,
            trace=parse.trace,
        )

    def _resolve_with_policy(
        self,
        *,
        parse: ScoreParseResult,
        tenant_id: TenantId,
    ) -> ScoreParseResult:
        policy = (
            self._policy_repository.get_current(tenant_id)
            if self._policy_repository is not None
            else self._policy or ScoringPolicy.default(tenant_id)
        )
        resolved = policy.resolve(parse.breakdown)
        breakdown = ScoreBreakdown(
            technical_fit=parse.breakdown.technical_fit,
            experience_fit=parse.breakdown.experience_fit,
            role_fit=parse.breakdown.role_fit,
            reasoning=parse.breakdown.reasoning,
            fit_band=resolved.fit_band,
            confidence=parse.breakdown.confidence,
            eligibility=parse.breakdown.eligibility,
            matched_signals=parse.breakdown.matched_signals,
            missing_signals=parse.breakdown.missing_signals,
            transferable_signals=parse.breakdown.transferable_signals,
        )
        return replace(
            parse,
            fit_score=resolved.fit_score,
            breakdown=breakdown,
            trace=parse.trace.with_policy_resolution(resolved),
        )

    def _resolve_with_requirement_fit(
        self,
        *,
        parse: ScoreParseResult,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> ScoreParseResult:
        policy = (
            self._policy_repository.get_current(tenant_id)
            if self._policy_repository is not None
            else self._policy or ScoringPolicy.default(tenant_id)
        )
        report = self._build_requirement_fit_report(
            parse=parse,
            job_id=job_id,
            score_version=0,
        )
        assert report is not None
        signals = derive_requirement_fit_signals(report)
        resolved_score = report.resolved_fit_score or parse.fit_score
        assert resolved_score is not None
        breakdown = ScoreBreakdown(
            technical_fit=parse.breakdown.technical_fit,
            experience_fit=parse.breakdown.experience_fit,
            role_fit=parse.breakdown.role_fit,
            reasoning=parse.breakdown.reasoning,
            fit_band=report.fit_band,
            confidence=parse.breakdown.confidence,
            eligibility=parse.breakdown.eligibility,
            matched_signals=signals.matched_signals,
            missing_signals=signals.missing_signals,
            transferable_signals=signals.transferable_signals,
        )
        trace = replace(
            parse.trace,
            scoring_policy_id=policy.policy_id,
            scoring_policy_version=policy.version,
            rubric_version=policy.rubric_version,
            raw_weighted_score=round(1 + (9 * report.summary.weighted_fit), 4),
            calibration_adjustment=0.0,
            anchor_ids=tuple(anchor.anchor_id for anchor in policy.anchors),
            resolved_fit_band=report.fit_band,
            resolution_reason="requirement_fit_report",
            resolved_dimensions=(
                {
                    "name": "requirement_fit",
                    "value": report.summary.weighted_fit,
                    "weight": 1.0,
                    "weighted_value": report.summary.weighted_fit,
                },
            ),
            fit_band_thresholds=tuple(threshold.to_dict() for threshold in policy.fit_band_thresholds),
            policy_evidence={
                "formula_version": report.formula_version,
                "employer_analysis_generation": report.employer_analysis_generation,
                "summary": report.summary.to_dict(),
            },
        )
        return replace(
            parse,
            fit_score=resolved_score,
            breakdown=breakdown,
            requirement_assessments=report.assessments,
            trace=trace,
        )

    def _publish_scored(self, score: JobScore) -> None:
        if self._publisher is None:
            return
        try:
            event = create_job_scored(
                score.tenant_id,
                JobScoredPayload(
                    job_id=str(score.job_id),
                    fit_score=score.fit_score.value,
                    breakdown=score.breakdown.to_dict(),
                    keywords=tuple(score.matched_keywords),
                    version=score.version,
                    scored_at=score.scored_at,
                    fit_band=score.breakdown.fit_band,
                    confidence=score.breakdown.confidence,
                    eligibility=score.breakdown.eligibility.to_dict(),
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001 — event publication never blocks save
            log.exception("Failed to publish JobScored event for %s", score.job_id)

    def _persist_requirement_fit_report(
        self,
        *,
        tenant_id: TenantId,
        score: JobScore,
        parse: ScoreParseResult,
    ) -> None:
        if self._requirement_fit_repository is None:
            return
        report = self._build_requirement_fit_report(
            parse=parse,
            job_id=score.job_id,
            score_version=score.version,
        )
        if report is None:
            return
        self._requirement_fit_repository.save(tenant_id, report)

    def _build_requirement_fit_report(
        self,
        *,
        parse: ScoreParseResult,
        job_id: JobId,
        score_version: int,
    ) -> RequirementFitReport | None:
        if not _has_requirement_fit(parse):
            return None
        return resolve_requirement_fit_report(
            RequirementFitReport(
                job_id=str(job_id),
                score_version=score_version,
                employer_analysis_generation=parse.employer_analysis_generation,
                profile_snapshot_version=parse.trace.profile_snapshot_version,
                scoring_policy_version=parse.trace.scoring_policy_version,
                formula_version=REQUIREMENT_FIT_FORMULA_VERSION,
                fit_band=parse.breakdown.fit_band,
                confidence=parse.breakdown.confidence,
                assessments=parse.requirement_assessments,
            )
        )


# ---------------------------------------------------------------------------
# CorrectScoreUseCase
# ---------------------------------------------------------------------------


class CorrectScoreUseCase:
    """Apply a user-supplied score correction.

    The use case loads the latest ``JobScore``, derives the next version
    via ``with_correction``, persists it, and publishes ``ScoreCorrected``.
    Loading is required: corrections only make sense relative to an
    existing score. Calling without a prior score raises ``LookupError``.
    """

    def __init__(
        self,
        *,
        repository: ScoreRepository,
        publisher: EventPublisher | None = None,
        policy_repository: ScoringPolicyRepository | None = None,
        staleness_repository: ScoreStalenessRepository | None = None,
    ) -> None:
        self._repository = repository
        self._publisher = publisher
        self._policy_repository = policy_repository
        self._staleness_repository = staleness_repository

    def execute(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        corrected_fit_score: FitScore,
        rationale: str,
        corrected_at: str | None = None,
    ) -> JobScore:
        previous = self._repository.load(tenant_id, job_id)
        if previous is None:
            raise LookupError(
                f"Cannot correct score for tenant={tenant_id!r} job_id={job_id!r}: "
                "no existing JobScore. Run ScoreJobUseCase first."
            )

        correction = ScoreCorrection(
            corrected_fit_score=corrected_fit_score,
            rationale=rationale,
            corrected_by=tenant_id,
            corrected_at=corrected_at or _utc_now(),
        )
        new_score = previous.with_correction(correction)
        self._repository.save(new_score)
        new_policy = self._persist_policy_correction_signal(
            previous=previous,
            correction=correction,
        )
        self._mark_stale_scores(previous=previous, new_policy=new_policy, marked_at=correction.corrected_at)
        self._publish_corrected(previous=previous, new=new_score)
        return new_score

    def _persist_policy_correction_signal(
        self,
        *,
        previous: JobScore,
        correction: ScoreCorrection,
    ) -> ScoringPolicy | None:
        if self._policy_repository is None:
            return None
        signal = CorrectionSignal(
            tenant_id=previous.tenant_id,
            job_id=str(previous.job_id),
            original_score=previous.fit_score,
            corrected_score=correction.corrected_fit_score,
            rationale=correction.rationale,
            corrected_at=correction.corrected_at,
            source_policy_id=previous.trace.scoring_policy_id,
            source_policy_version=previous.trace.scoring_policy_version,
            score_dimensions=_dimension_signal_from_score(previous),
            evidence_summary=_policy_evidence_from_score(previous),
        )
        save_correction_signal = getattr(
            self._policy_repository,
            "save_correction_signal",
            None,
        )
        if callable(save_correction_signal):
            return save_correction_signal(signal)
        current = self._policy_repository.get_current(previous.tenant_id)
        next_policy = current.with_correction_signal(signal)
        self._policy_repository.save(next_policy)
        return next_policy

    def _mark_stale_scores(
        self,
        *,
        previous: JobScore,
        new_policy: ScoringPolicy | None,
        marked_at: str,
    ) -> None:
        if self._staleness_repository is None or new_policy is None:
            return
        self._staleness_repository.mark_comparable_scores_stale(
            tenant_id=previous.tenant_id,
            stale_reason="scoring_policy_changed",
            new_policy_id=new_policy.policy_id,
            new_policy_version=new_policy.version,
            marked_at=marked_at,
        )

    def _publish_corrected(self, *, previous: JobScore, new: JobScore) -> None:
        if self._publisher is None or new.correction is None:
            return
        try:
            event = create_score_corrected(
                new.tenant_id,
                ScoreCorrectedPayload(
                    job_id=str(new.job_id),
                    original_score=previous.fit_score.value,
                    corrected_score=new.fit_score.value,
                    reason=new.correction.rationale,
                    corrected_at=new.correction.corrected_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish ScoreCorrected event for %s", new.job_id)


def _dimension_signal_from_score(score: JobScore) -> tuple[dict[str, Any], ...]:
    if score.trace.resolved_dimensions:
        return score.trace.resolved_dimensions
    return (
        {"name": "technical_fit", "value": score.breakdown.technical_fit},
        {"name": "experience_fit", "value": score.breakdown.experience_fit},
        {"name": "role_fit", "value": score.breakdown.role_fit},
    )


def _policy_evidence_from_score(score: JobScore) -> dict[str, Any]:
    if score.trace.policy_evidence:
        return score.trace.policy_evidence
    return {
        "confidence": score.breakdown.confidence,
        "eligibility_status": score.breakdown.eligibility.status,
        "hard_blocker_count": len(score.breakdown.eligibility.hard_blockers),
        "warning_count": len(score.breakdown.eligibility.warnings),
        "matched_signal_count": len(score.breakdown.matched_signals),
        "missing_signal_count": len(score.breakdown.missing_signals),
        "transferable_signal_count": len(score.breakdown.transferable_signals),
    }


__all__ = [
    "ScoreJobOutcome",
    "ScoreJobUseCase",
    "CorrectScoreUseCase",
    "ScoringCriteria",
    "SCORE_PROMPT",
]
