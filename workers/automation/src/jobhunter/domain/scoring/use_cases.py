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
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from jobhunter.domain.events import (
    JobScoredPayload,
    ScoreCorrectedPayload,
    create_job_scored,
    create_score_corrected,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.ports.llm import LlmMessage
from jobhunter.domain.ports.scoring import LlmPort, ScoreRepository
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.scoring.aggregate import JobScore
from jobhunter.domain.scoring.services import ScoreParseResult, ScoreParser
from jobhunter.domain.scoring.value_objects import (
    FitScore,
    MatchedKeywords,
    ScoreBreakdown,
    ScoreCorrection,
    ScoringCriteria,
)
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


SCORE_PROMPT = """You are a job fit evaluator. Given a candidate's resume and a job description, score how well the candidate fits the role.

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

KEYWORDS: list ATS keywords from the job description that match or could match the candidate. At least one keyword is required.

REASONING: 2-3 sentence justification.

Respond as a JSON object conforming to the provided schema. Do not wrap the JSON in markdown fences and do not include any prose outside the JSON object."""


SCORE_SCHEMA: dict = {
    "title": "JobFitScore",
    "type": "object",
    "properties": {
        "score": {
            "type": "integer",
            "minimum": 1,
            "maximum": 10,
            "description": "Overall fit score 1..10",
        },
        "technical_fit": {
            "type": "integer",
            "minimum": 0,
            "maximum": 10,
            "description": "Technical skill / tooling alignment 0..10",
        },
        "experience_fit": {
            "type": "integer",
            "minimum": 0,
            "maximum": 10,
            "description": "Years / seniority / domain depth alignment 0..10",
        },
        "role_fit": {
            "type": "integer",
            "minimum": 0,
            "maximum": 10,
            "description": "Role responsibility alignment 0..10",
        },
        "keywords": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 1,
            "description": "ATS keywords from the job that overlap with the candidate",
        },
        "reasoning": {
            "type": "string",
            "description": "2-3 sentence justification",
        },
    },
    "required": ["score", "technical_fit", "experience_fit", "role_fit", "keywords", "reasoning"],
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_job_blob(job: dict[str, Any]) -> str:
    return (
        f"TITLE: {job.get('title', '')}\n"
        f"COMPANY: {job.get('site', '')}\n"
        f"LOCATION: {job.get('location') or 'N/A'}\n\n"
        f"DESCRIPTION:\n{(job.get('full_description') or '')[:6000]}"
    )


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
        prompt: str = SCORE_PROMPT,
    ) -> None:
        self._repository = repository
        self._llm = llm
        self._publisher = publisher
        self._parser = parser or ScoreParser()
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
        parse_result = self.compute(
            job=job,
            profile_snapshot=profile_snapshot,
            resume_text=resume_text,
        )
        return self.persist_outcome(job=job, parse=parse_result, tenant_id=tenant_id)

    def compute(
        self,
        *,
        job: dict[str, Any],
        profile_snapshot: ProfileSnapshot,
        resume_text: str | None = None,
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
        text = resume_text or profile_snapshot.as_dict().get("resume", {}).get(
            "executive_profile", {}
        ).get("baseline_text", "")
        return self._call_llm(job=job, resume_text=text)

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

        scored_at = _utc_now()
        new_score = self._build_aggregate(
            tenant_id=tenant_id,
            job=job,
            parse=parse,
            scored_at=scored_at,
        )
        self._repository.save(new_score)
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
    ) -> ScoreJobOutcome:
        return self.score(
            job=job,
            profile_snapshot=profile_snapshot,
            tenant_id=tenant_id,
            resume_text=resume_text,
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _call_llm(self, *, job: dict[str, Any], resume_text: str) -> ScoreParseResult:
        messages = [
            LlmMessage(role="system", content=self._prompt),
            LlmMessage(
                role="user",
                content=(
                    f"RESUME:\n{resume_text}\n\n---\n\nJOB POSTING:\n{_build_job_blob(job)}"
                ),
            ),
        ]
        # Structured outputs: the LLM gateway returns a JSON object that
        # already conforms to SCORE_SCHEMA. max_tokens is generous because
        # Gemini 3.x preview models spend invisible tokens on internal
        # reasoning before emitting the schema fill.
        try:
            payload = self._llm.chat_json(
                messages,
                response_schema=SCORE_SCHEMA,
                max_tokens=4096,
                temperature=0.2,
            )
        except Exception as exc:  # noqa: BLE001 — surface as a parse failure to the caller
            log.error("LLM error scoring job %r: %s", job.get("title", "?"), exc)
            # Sentinel keyword keeps the ``MatchedKeywords`` non-empty
            # invariant intact for the failure-path ``ScoreParseResult``;
            # ``ok=False`` means nothing is persisted anyway.
            return ScoreParseResult(
                ok=False,
                fit_score=None,
                breakdown=ScoreBreakdown(reasoning=f"LLM error: {exc}"),
                keywords=MatchedKeywords(),
                error=f"LLM error: {exc}",
            )

        return self._parser.parse_json(payload)

    def _build_aggregate(
        self,
        *,
        tenant_id: TenantId,
        job: dict[str, Any],
        parse: ScoreParseResult,
        scored_at: str,
    ) -> JobScore:
        job_id = JobId(str(job["url"]))
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
            )
        return previous.next_version(
            fit_score=parse.fit_score,
            breakdown=parse.breakdown,
            matched_keywords=parse.keywords,
            scored_at=scored_at,
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
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001 — event publication never blocks save
            log.exception("Failed to publish JobScored event for %s", score.job_id)


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
    ) -> None:
        self._repository = repository
        self._publisher = publisher

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
        self._publish_corrected(previous=previous, new=new_score)
        return new_score

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


__all__ = [
    "ScoreJobOutcome",
    "ScoreJobUseCase",
    "CorrectScoreUseCase",
    "ScoringCriteria",
    "SCORE_PROMPT",
]
