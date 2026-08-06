"""Resume tailoring runner — wires the Materials use case into the worker.

See ddd-target.md §3.5 / §4.5 / §5.5. After Phase 6 the tailor module is
a thin adapter around :class:`TailorResumeUseCase`
(``domain/materials/use_cases.py``):

  * Domain logic (prompt assembly, validation, judge, MaterialsSet
    composition) lives in the use case + ``ContentValidator`` /
    ``ResumeAssembler`` / ``MaterialsSet``.
  * Persistence goes through :class:`MaterialsRepository` — the legacy
    ``UPDATE jobs SET tailored_resume_path = …`` writes are GONE per the
    no-strangler directive. Readers fall back to
    ``jobs.tailored_resume_path`` only for historical rows that were
    never re-tailored after the backfill.
  * The LLM call is mediated by :class:`LlmPort` so the cloud LLM gateway
    swap-out (Phase 9) is a constructor-only change.

The module preserves the public surface (``run_tailoring``,
``tailor_resume``, ``_tailor_one_job``, ``_build_master_tailor_prompt``)
so existing callers (``pipeline.py``, ``pipeline.apply_jobs``) continue
to work; their internals now run on top of the new use case.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from jobctrl import database as db_module
from jobctrl import config
from jobctrl.config import TAILORED_DIR
from jobctrl.database import get_connection, get_jobs_by_stage
from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.services import ContentValidator, ResumeAssembler
from jobctrl.domain.materials.use_cases import (
    TailorOutcome,
    TailoringLlmPolicy,
    TailorResumeUseCase,
    build_master_tailor_prompt,
)
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.ports.llm import LlmPort
from jobctrl.domain.ports.materials import (
    BulletProvenanceRepository,
    MaterialsRepository,
    PdfRendererPort,
    TailoringPolicyRepository,
)
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.scoring.eligibility import (
    eligibility_blocks_downstream,
    normalize_eligibility_for_downstream,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.llm import get_llm_adapter
from jobctrl.infrastructure.discovery import SqliteJobIdentityResolver
from jobctrl.infrastructure.materials import (
    HtmlResumePdfAdapter,
    SqliteBulletProvenanceRepository,
    SqliteMaterialsRepository,
    SqliteTailoringPolicyRepository,
    SqliteUnitOfWork,
)
from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader
from jobctrl.infrastructure.preparation_recovery import (
    assert_material_activity_commit_allowed,
    stage_completed_by_activity_owner,
)
from jobctrl.infrastructure.scoring import (
    SqliteRequirementFitReportRepository,
    SqliteScoreRepository,
)
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctrl.scoring.employer_analysis import build_analyze_use_case
from jobctrl.state import (
    ensure_job_stage_rows,
    reconcile_score_eligibility_blockers,
    record_job_event,
    set_stage_state,
    utc_now,
)

log = logging.getLogger(__name__)

MAX_ATTEMPTS = config.DEFAULTS["max_tailor_attempts"]  # durable executions


def _split_model_specs(value: str | None) -> tuple[str, ...]:
    return tuple(part.strip() for part in (value or "").split(",") if part.strip())


def _build_llm_policy(
    *,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
) -> TailoringLlmPolicy:
    configured_models = config.get_tailoring_generator_models()
    configured_judge_model = config.get_tailoring_judge_model()
    judge_min_score = (
        config.get_tailoring_judge_min_score() if tailor_judge_min_score is None else tailor_judge_min_score
    )
    return TailoringLlmPolicy(
        candidate_models=tailor_models or configured_models or ((llm_model,) if llm_model else ()),
        judge_model=tailor_judge_model or configured_judge_model or llm_model,
        judge_min_score=judge_min_score,
    )


def _build_analyze_use_case(
    *,
    conn,
    publisher: EventPublisher | None = None,
):
    """Construct the :class:`AnalyzeJobUseCase` for the tailor sub-step (D-20).

    Wires the 3-SDK ensemble (Claude + Codex + Antigravity/Gemini draft
    adapters + Claude synthesizer, D-03/D-07) behind the hexagonal ports. The
    publisher defaults to ``record_employer_analyzed_event`` so a successful
    analysis lands an ``EmployerAnalyzed`` row in ``job_events`` (read-side
    projection + SSE). A missing Gemini key degrades the Antigravity leg to a
    recorded per-leg failure (failure mode #2), never a hard fail.
    """
    return build_analyze_use_case(conn=conn, publisher=publisher, event_stage="tailor")


def _build_voice_port():
    """Construct the optional Claude voice pass only when provider auth is ready.

    Mirrors ``_build_analyze_use_case``'s SDK wiring: the voice pass is a NEW AI
    transform, so it runs through the Claude Agent SDK behind the ``VoicePort``
    seam, not the legacy httpx client (the all-new-AI-via-SDK directive).
    """
    from jobctrl.infrastructure.setup_probes import probe_claude_auth

    if not probe_claude_auth().ok:
        return None

    from jobctrl.infrastructure.materials.voice_adapter import ClaudeVoiceAdapter

    return ClaudeVoiceAdapter()


def _build_use_case(
    *,
    repository: MaterialsRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
    validator: ContentValidator | None = None,
    assembler: ResumeAssembler | None = None,
    llm_policy: TailoringLlmPolicy | None = None,
    policy_repository: TailoringPolicyRepository | None = None,
    provenance_repository: BulletProvenanceRepository | None = None,
    requirement_fit_repository=None,
    analyze_use_case=None,
    voice=None,
    pdf_renderer: PdfRendererPort | None = None,
) -> TailorResumeUseCase:
    """Construct a :class:`TailorResumeUseCase` using local-mode defaults."""
    conn = get_connection()
    # The generation flip (supersede + save + provenance) must commit atomically
    # (A9). The default materials + provenance repositories share this connection
    # and this unit of work, so the flip is one transaction. We only hand the unit
    # of work to the use case when BOTH those repositories are the shared-connection
    # defaults; an injected repository may not share the connection, so gating it
    # would give a false atomicity guarantee — such callers keep per-call commits.
    unit_of_work = SqliteUnitOfWork(conn)
    default_flip_repositories = repository is None and provenance_repository is None
    if repository is None:
        repository = SqliteMaterialsRepository(conn, unit_of_work=unit_of_work)
    if policy_repository is None:
        policy_repository = SqliteTailoringPolicyRepository(
            conn,
            unit_of_work=unit_of_work,
        )
    if provenance_repository is None:
        provenance_repository = SqliteBulletProvenanceRepository(conn, unit_of_work=unit_of_work)
    if requirement_fit_repository is None:
        requirement_fit_repository = SqliteRequirementFitReportRepository(conn)
    if llm_port is None:
        llm_port = get_llm_adapter()
    if validator is None:
        validator = ContentValidator()
    if assembler is None:
        assembler = ResumeAssembler()
    if llm_policy is None:
        llm_policy = _build_llm_policy()
    if analyze_use_case is None:
        analyze_use_case = _build_analyze_use_case(conn=conn, publisher=publisher)
    if voice is None:
        voice = _build_voice_port()
    if pdf_renderer is None:
        pdf_renderer = _build_pdf_renderer()
    return TailorResumeUseCase(
        repository=repository,
        llm=llm_port,
        validator=validator,
        assembler=assembler,
        publisher=publisher,
        llm_policy=llm_policy,
        policy_repository=policy_repository,
        provenance_repository=provenance_repository,
        requirement_fit_repository=requirement_fit_repository,
        analyze_use_case=analyze_use_case,
        voice=voice,
        pdf_renderer=pdf_renderer,
        unit_of_work=unit_of_work if default_flip_repositories else None,
    )


def _build_pdf_renderer() -> PdfRendererPort:
    return HtmlResumePdfAdapter()


def _load_requirement_fit_report_for_job(*, tenant_id: TenantId, job: dict):
    job_id = job.get("job_id")
    if not job_id:
        return None
    return SqliteRequirementFitReportRepository(get_connection()).load(
        tenant_id,
        canonical_job_id(str(job_id)),
    )


# ---------------------------------------------------------------------------
# Prompt builder (kept for backward compatibility — re-exports the use case helper)
# ---------------------------------------------------------------------------


def _build_master_tailor_prompt(snapshot: ProfileSnapshot) -> str:
    """Backward-compatible wrapper for the canonical use-case prompt builder."""
    return build_master_tailor_prompt(snapshot)


def _mark_cover_pending_after_tailor_success(
    conn: sqlite3.Connection,
    job_url: str,
    *,
    reason: str,
) -> None:
    """Legacy batch-runner cover reset.

    ``run_tailoring`` remains outside the canonical JobId cutover in this
    slice. Its URL-shaped selector is kept untouched until its own bounded
    migration; the per-job preparation entry point uses the exact helper
    below.
    """
    now = utc_now()
    metadata = json.dumps(
        {"invalidated_at": now, "reason": reason},
        sort_keys=True,
    )
    conn.execute(
        "UPDATE jobs SET cover_letter_path = NULL, cover_letter_at = NULL, cover_attempts = 0 WHERE url = ?",
        (job_url,),
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'pending',
            attempt_count = 0,
            max_attempts = 5,
            started_at = NULL,
            updated_at = ?,
            finished_at = NULL,
            duration_ms = NULL,
            error_code = NULL,
            error_message = NULL,
            retryable = 1,
            blocked_by_json = '[]',
            next_action = NULL,
            metadata_json = ?
        WHERE job_url = ? AND stage = 'cover'
        """,
        (now, metadata, job_url),
    )
    record_job_event(
        conn,
        job_url,
        "cover",
        "StageReset",
        message="Cover stage reset after tailored resume generation",
        payload={"reason": reason},
    )


def _mark_cover_pending_after_tailor_success_by_id(
    conn: sqlite3.Connection,
    job_id: JobId,
    *,
    tenant_id: TenantId,
    reason: str,
) -> None:
    """Invalidate downstream cover readiness after a new resume generation.

    A stale ``cover=succeeded`` row is unsafe after re-tailoring because it can
    refer to a superseded cover letter from an older material generation. The
    cover stage must become visibly pending so the next pipeline step generates
    cover artifacts for the current approved resume.
    """
    now = utc_now()
    metadata = json.dumps(
        {"invalidated_at": now, "reason": reason},
        sort_keys=True,
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'pending',
            attempt_count = 0,
            max_attempts = 5,
            started_at = NULL,
            updated_at = ?,
            finished_at = NULL,
            duration_ms = NULL,
            error_code = NULL,
            error_message = NULL,
            retryable = 1,
            blocked_by_json = '[]',
            next_action = NULL,
            metadata_json = ?
        WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
        """,
        (now, metadata, str(tenant_id), str(canonical_job_id(str(job_id)))),
    )
    record_job_event(
        conn,
        job_id,
        "cover",
        "StageReset",
        tenant_id=tenant_id,
        message="Cover stage reset after tailored resume generation",
        payload={"reason": reason},
    )


# ---------------------------------------------------------------------------
# Single-job tailoring entry point
# ---------------------------------------------------------------------------


def _tailor_one_job(
    job: dict,
    resume_text: str,
    snapshot: ProfileSnapshot,
    validation_mode: str,
    *,
    use_case: TailorResumeUseCase | None = None,
    pdf_renderer: PdfRendererPort | None = None,
    retailor: bool = False,
    suppress_existing_artifacts: bool = False,
    tenant_id: TenantId = LOCAL_TENANT,
    llm_policy: TailoringLlmPolicy | None = None,
    commit_guard=None,
    audit_execution_id: str | None = None,
    durable_attempt: int | None = None,
) -> dict:
    """Tailor one job and return the legacy-shaped result dict.

    The ``resume_text`` parameter is preserved for backward
    compatibility — the use case doesn't read it (it builds prompts
    from the snapshot). New callers should pass empty.
    """
    _ = resume_text  # legacy parameter — ignored
    if use_case is None:
        use_case = _build_use_case(llm_policy=llm_policy, pdf_renderer=pdf_renderer)
        requirement_fit_report = _load_requirement_fit_report_for_job(
            tenant_id=tenant_id,
            job=job,
        )
    else:
        requirement_fit_report = None

    # The use case owns PDF rendering (it renders the approved resume BEFORE
    # superseding the prior generation so a render failure cannot strip the job
    # of its last accepted resume — architecture.md §5.5 / CLAUDE.md). The runner
    # only surfaces the resulting outcome.
    outcome = use_case.execute(
        job=job,
        job_id=canonical_job_id(str(job["job_id"])),
        profile_snapshot=snapshot,
        tailored_dir=TAILORED_DIR,
        validation_mode=validation_mode,
        tenant_id=tenant_id,
        retailor=retailor,
        suppress_existing_artifacts=suppress_existing_artifacts,
        requirement_fit_report=requirement_fit_report,
        commit_guard=commit_guard,
        audit_execution_id=audit_execution_id,
        durable_attempt=durable_attempt,
    )

    return {
        "job_id": str(canonical_job_id(str(job["job_id"]))),
        "url": job["url"],
        "path": outcome.text_path,
        "pdf_path": outcome.pdf_path,
        "title": job["title"],
        "site": job.get("site"),
        "status": outcome.status,
        "attempts": outcome.attempts,
        "report": getattr(outcome, "report", {}),
        "materials": outcome.materials,
        "error": outcome.error,
    }


# ---------------------------------------------------------------------------
# Legacy thin wrapper — preserved so single-job callers keep working
# ---------------------------------------------------------------------------


def tailor_resume(
    resume_text: str,
    job: dict,
    snapshot: ProfileSnapshot,
    max_retries: int = 3,
    validation_mode: str = "normal",
) -> tuple[str, dict]:
    """Generate a tailored resume — kept for callers that want raw text out.

    This wrapper exists so legacy callers (notably the manual ``apply_jobs``
    flow) can still get back a ``(text, report)`` tuple. New callers should
    construct :class:`TailorResumeUseCase` directly and persist via the
    repository.
    """
    _ = resume_text  # unused — use case reads from the snapshot
    use_case = _build_use_case()
    use_case._max_retries = max_retries  # noqa: SLF001 — DI seam
    outcome = use_case.execute(
        job=job,
        profile_snapshot=snapshot,
        tailored_dir=TAILORED_DIR,
        validation_mode=validation_mode,
        requirement_fit_report=_load_requirement_fit_report_for_job(
            tenant_id=LOCAL_TENANT,
            job=job,
        ),
    )
    text = ""
    if outcome.text_path:
        try:
            text = Path(outcome.text_path).read_text(encoding="utf-8")
        except OSError:
            text = ""
    return text, outcome.report


# ---------------------------------------------------------------------------
# Batch entry point
# ---------------------------------------------------------------------------


def run_tailoring(
    min_score: int = 7,
    limit: int = 0,
    validation_mode: str = "normal",
    workers: int = 1,
    retailor: bool = False,
    snapshot: ProfileSnapshot | None = None,
    *,
    repository: MaterialsRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
    pdf_renderer: PdfRendererPort | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    workflow_id: str | None = None,
) -> dict:
    """Generate tailored resumes for high-scoring jobs.

    Each job is processed inside a :class:`ThreadPoolExecutor` task; the
    use case (LLM call + materials persistence) runs in the worker thread.
    SQLite connections are not safe to share across threads, so each
    worker builds its own use case (and therefore its own thread-local
    connection via ``get_connection()``). The main thread keeps a separate
    connection only for the per-job stage-state writes around the worker
    pool's lifetime.
    """
    if snapshot is None:
        from jobctrl.infrastructure.profile import get_profile_repository

        snapshot = get_profile_repository().load_snapshot(tenant_id)

    conn = get_connection()
    # ``repository`` is accepted for test injection but MUST NOT be passed
    # into worker-thread tasks — sqlite connections are thread-bound.
    if repository is None:
        repository = SqliteMaterialsRepository(conn)
    min_score = db_module.effective_tailoring_min_score(min_score)

    jobs = get_jobs_by_stage(
        conn=conn,
        stage="pending_tailor",
        min_score=min_score,
        limit=limit,
        retailor=retailor,
    )
    jobs = [
        job
        for job in jobs
        if str(job.get("tenant_id") or tenant_id) == str(tenant_id)
    ]
    if workflow_id:
        jobs = [
            job
            for job in jobs
            if not stage_completed_by_activity_owner(
                conn,
                tenant_id=str(tenant_id),
                job_id=str(canonical_job_id(str(job["job_id"]))),
                stage="tailor",
                workflow_id=workflow_id,
            )
        ]

    if not jobs:
        if retailor:
            log.info("No jobs eligible for tailoring or re-tailoring with score >= %d.", min_score)
        else:
            log.info("No untailored jobs with score >= %d.", min_score)
        return {"approved": 0, "failed": 0, "errors": 0, "elapsed": 0.0}

    TAILORED_DIR.mkdir(parents=True, exist_ok=True)
    worker_count = max(1, workers)
    log.info(
        "Tailoring resumes for %d jobs (score >= %d) with %d worker(s)%s...",
        len(jobs),
        min_score,
        worker_count,
        " [re-tailor enabled]" if retailor else "",
    )
    t0 = time.time()
    results: list[dict] = []
    stats: dict[str, int] = {"approved": 0, "failed_validation": 0, "failed_judge": 0, "error": 0}

    # ``use_case`` is built lazily per-worker inside _tailor_one_job so the
    # repository connection lives in the worker thread that uses it. The
    # main-thread ``repository`` constructed above is intentionally
    # ignored by the workers (sqlite connections are thread-bound).
    if pdf_renderer is None:
        pdf_renderer = _build_pdf_renderer()
    llm_policy = _build_llm_policy(
        tailor_models=tailor_models,
        tailor_judge_model=tailor_judge_model,
        tailor_judge_min_score=tailor_judge_min_score,
        llm_model=llm_model,
    )

    started_ats: dict[str, str] = {}
    stage_attempts: dict[str, int] = {}
    activity_metadata: dict[str, dict[str, object]] = {}
    for job in jobs:
        stable_job_id = canonical_job_id(str(job["job_id"]))
        stage_key = str(stable_job_id)
        ensure_job_stage_rows(
            conn,
            stable_job_id,
            tenant_id=tenant_id,
            discovered_at=job.get("discovered_at"),
        )
        started_at = utc_now()
        started_ats[stage_key] = started_at
        prior_attempts = _tailor_attempt_count(
            conn,
            tenant_id=tenant_id,
            job_id=stable_job_id,
        )
        current_attempt = prior_attempts + 1
        stage_attempts[stage_key] = current_attempt
        # The runner owns the restart policy: a job that failed last time is
        # eligible for retailoring per ``get_jobs_by_stage``, so the
        # transition Failed -> Running needs to be permitted even though
        # the canonical state machine table only allows Failed -> Pending
        # (via Reset). Skip validation here; the writer is the runner.
        metadata = _tailor_activity_metadata(
            repository,
            tenant_id=tenant_id,
            job_id=stable_job_id,
            workflow_id=workflow_id,
            retailor=retailor,
        )
        activity_metadata[stage_key] = metadata or {}
        set_stage_state(
            conn,
            stable_job_id,
            "tailor",
            "running",
            tenant_id=tenant_id,
            # Running exposes the completed durable count. Normal completion
            # or owner recovery advances this execution exactly once.
            attempt_count=prior_attempts,
            started_at=started_at,
            metadata=metadata,
            validate_transition=False,
        )
        record_job_event(
            conn,
            stable_job_id,
            "tailor",
            "StageStarted",
            tenant_id=tenant_id,
            message="Tailoring started",
        )

    future_to_job: dict = {}
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        for job in jobs:
            future = executor.submit(
                _tailor_one_job,
                job,
                "",  # legacy resume_text param — unused
                snapshot,
                validation_mode,
                # use_case=None: worker builds its own with a thread-local
                # SQLite connection. Passing the main-thread use case would
                # crash with "SQLite objects created in a thread can only
                # be used in that same thread".
                use_case=None,
                pdf_renderer=pdf_renderer,
                retailor=retailor,
                tenant_id=tenant_id,
                llm_policy=llm_policy,
                audit_execution_id=workflow_id,
                durable_attempt=stage_attempts[
                    str(canonical_job_id(str(job["job_id"])))
                ],
            )
            future_to_job[future] = job

        for completed, future in enumerate(as_completed(future_to_job), start=1):
            job = future_to_job[future]
            try:
                result = future.result()
            except Exception as e:
                result = {
                    "job_id": str(canonical_job_id(str(job["job_id"]))),
                    "url": job["url"],
                    "title": job["title"],
                    "site": job.get("site"),
                    "status": "error",
                    "attempts": 0,
                    "path": None,
                    "pdf_path": None,
                    "materials": None,
                }
                log.error("%d/%d [ERROR] %s -- %s", completed, len(jobs), job["title"][:40], e)

            result.setdefault("job_id", str(canonical_job_id(str(job["job_id"]))))
            results.append(result)
            stats[result.get("status", "error")] = stats.get(result.get("status", "error"), 0) + 1

            elapsed = time.time() - t0
            rate = completed / elapsed if elapsed > 0 else 0
            log.info(
                "%d/%d [%s] attempts=%s | %.1f jobs/min | %s",
                completed,
                len(jobs),
                str(result.get("status", "error")).upper(),
                result.get("attempts", "?"),
                rate * 60,
                str(result.get("title", "?"))[:40],
            )

    # Stage state writes — Phase 6 keeps state.set_stage_state() the
    # canonical way to advance the pipeline state machine. The legacy
    # ``UPDATE jobs SET tailored_resume_path / tailored_at /
    # tailor_attempts`` writes are GONE per the no-strangler directive —
    # those columns are read-only fallbacks now.
    finished_at = utc_now()
    _success_statuses = {"approved"}
    durable_exhausted = 0
    for r in results:
        stable_job_id = canonical_job_id(str(r["job_id"]))
        stage_key = str(stable_job_id)
        url = r["url"]
        current_attempt = stage_attempts[stage_key]
        generation_attempts = r.get("attempts") or 1
        if r.get("status") in _success_statuses:
            set_stage_state(
                conn,
                stable_job_id,
                "tailor",
                "succeeded",
                tenant_id=tenant_id,
                attempt_count=current_attempt,
                started_at=started_ats.get(stage_key),
                finished_at=finished_at,
                metadata=activity_metadata.get(stage_key) or None,
            )
            record_job_event(
                conn,
                stable_job_id,
                "tailor",
                "StageCompleted",
                tenant_id=tenant_id,
                message=f"Tailoring {r.get('status')}",
                payload={
                    "attempts": current_attempt,
                    "generationAttempts": generation_attempts,
                },
            )
            _mark_cover_pending_after_tailor_success_by_id(
                conn,
                stable_job_id,
                tenant_id=tenant_id,
                reason="tailor_stage_completed",
            )
        else:
            exhausted = current_attempt >= MAX_ATTEMPTS
            durable_exhausted += int(exhausted)
            set_stage_state(
                conn,
                stable_job_id,
                "tailor",
                "exhausted" if exhausted else "failed",
                tenant_id=tenant_id,
                attempt_count=current_attempt,
                max_attempts=MAX_ATTEMPTS,
                started_at=started_ats.get(stage_key),
                finished_at=finished_at,
                error_code=str(r.get("status", "error")).upper(),
                error_message=f"Tailoring ended with status {r.get('status', 'error')}",
                retryable=not exhausted,
                next_action=(
                    f"jobctrl retry tailor {url} --reset-attempts" if exhausted else f"jobctrl retry tailor {url}"
                ),
                validate_transition=False,
            )
            record_job_event(
                conn,
                stable_job_id,
                "tailor",
                "StageExhausted" if exhausted else "StageFailed",
                tenant_id=tenant_id,
                level="error",
                message=f"Tailoring ended with status {r.get('status', 'error')}",
                payload={
                    "attempts": current_attempt,
                    "generationAttempts": generation_attempts,
                    "generationStatus": str(r.get("status") or "error"),
                    "retryable": not exhausted,
                },
            )
    conn.commit()

    elapsed = time.time() - t0
    log.info(
        "Tailoring done in %.1fs: %d approved, %d failed_validation, %d failed_judge, %d errors",
        elapsed,
        stats.get("approved", 0),
        stats.get("failed_validation", 0),
        stats.get("failed_judge", 0),
        stats.get("error", 0),
    )

    errors = stats.get("error", 0)
    failed = sum(
        count
        for status, count in stats.items()
        if status not in {"approved", "error"}
    )
    return {
        "approved": stats.get("approved", 0),
        "failed": failed,
        "errors": errors,
        "exhausted": durable_exhausted,
        "elapsed": elapsed,
    }


def tailor_job_by_url(
    job_url: str,
    *,
    min_score: int = 7,
    validation_mode: str = "normal",
    workers: int = 1,
    retailor: bool = False,
    snapshot: ProfileSnapshot | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    pdf_renderer: PdfRendererPort | None = None,
    suppress_existing_artifacts: bool = False,
    allow_low_fit_override: bool = False,
    workflow_id: str | None = None,
) -> dict:
    """Resolve an active external posting locator, then tailor its JobId."""
    conn = get_connection()
    identity = SqliteJobIdentityResolver(conn).resolve_current_by_posting_url(
        tenant_id,
        PostingUrl(value=job_url),
    )
    if identity is None:
        return {"url": job_url, "status": "skipped", "reason": "not_found"}
    return tailor_job_by_id(
        identity.job_id,
        min_score=min_score,
        validation_mode=validation_mode,
        workers=workers,
        retailor=retailor,
        snapshot=snapshot,
        tenant_id=tenant_id,
        llm_model=llm_model,
        tailor_models=tailor_models,
        tailor_judge_model=tailor_judge_model,
        tailor_judge_min_score=tailor_judge_min_score,
        pdf_renderer=pdf_renderer,
        suppress_existing_artifacts=suppress_existing_artifacts,
        allow_low_fit_override=allow_low_fit_override,
        workflow_id=workflow_id,
    )


def tailor_job_by_id(
    job_id: JobId,
    *,
    min_score: int = 7,
    validation_mode: str = "normal",
    workers: int = 1,
    retailor: bool = False,
    snapshot: ProfileSnapshot | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    pdf_renderer: PdfRendererPort | None = None,
    suppress_existing_artifacts: bool = False,
    allow_low_fit_override: bool = False,
    workflow_id: str | None = None,
    cancel_event: threading.Event | None = None,
) -> dict:
    """Tailor one active, eligible JobId for its tenant-scoped preparation step.

    This is the canonical single-job entry point. It deliberately does not use
    the batch selector or URL-shaped primary keys: a preparation workflow owns
    one JobId, and all target, score, materials, state, and event access stays
    scoped to that identity.
    """
    stable_job_id = canonical_job_id(str(job_id))
    conn = get_connection()
    target_reader = SqlitePreparationTargetReader(conn)
    target = target_reader.load(tenant_id, stable_job_id)
    if target is None:
        return {
            "job_id": str(stable_job_id),
            "status": "skipped",
            "reason": "not_found",
        }

    # Reconcile score-derived state before the stage-state gate. Historical
    # salary-only scores may still carry SCORE_ELIGIBILITY_BLOCKED rows from
    # the old policy; clearing them after selection would skip this invocation
    # and strand the preparation workflow until another external trigger.
    if _reconcile_score_eligibility_skip(
        conn,
        job_id=stable_job_id,
        tenant_id=tenant_id,
    ):
        conn.commit()
        return {
            "url": target["url"],
            "job_id": str(stable_job_id),
            "status": "skipped",
            "reason": "score_eligibility_blocked",
        }

    existing_materials = _reconcile_existing_approved_resume(
        conn,
        tenant_id=tenant_id,
        job_id=stable_job_id,
        retailor=retailor,
        workflow_id=workflow_id,
    )
    if existing_materials is not None:
        return {
            "url": target["url"],
            "job_id": str(stable_job_id),
            "status": "already_done",
            "reason": "approved_resume_already_committed",
            "materials": existing_materials,
        }

    if _tailor_attempt_budget_exhausted(
        conn,
        tenant_id=tenant_id,
        job_id=stable_job_id,
    ):
        return {
            "url": target["url"],
            "job_id": str(stable_job_id),
            "status": "exhausted",
            "reason": "durable_attempt_budget_exhausted",
            "error": "Tailor durable attempt budget exhausted.",
        }

    job = _load_tailor_eligible_job_by_id(
        conn,
        tenant_id=tenant_id,
        job_id=stable_job_id,
        job=target,
        min_score=min_score,
        retailor=retailor,
        allow_low_fit_override=allow_low_fit_override,
    )
    if job is None:
        if _record_tailor_enrichment_block(
            conn,
            job_id=stable_job_id,
            tenant_id=tenant_id,
            discovered_at=target.get("discovered_at"),
        ):
            conn.commit()
            return {
                "url": target["url"],
                "job_id": str(stable_job_id),
                "status": "skipped",
                "reason": "enrichment_quarantined",
            }
        _record_tailor_skip(
            conn,
            job_id=stable_job_id,
            tenant_id=tenant_id,
            discovered_at=target.get("discovered_at"),
            reason="not_eligible",
            message="Tailoring skipped because the job is not currently eligible.",
        )
        conn.commit()
        return {
            "url": target["url"],
            "job_id": str(stable_job_id),
            "status": "skipped",
            "reason": "not_eligible",
        }

    if snapshot is None:
        from jobctrl.infrastructure.profile import get_profile_repository

        snapshot = get_profile_repository().load_snapshot(tenant_id)

    worker_count = max(1, workers)
    _ = worker_count  # same validation surface as batch runner; single work item runs one job.
    TAILORED_DIR.mkdir(parents=True, exist_ok=True)
    if pdf_renderer is None:
        pdf_renderer = _build_pdf_renderer()
    llm_policy = _build_llm_policy(
        tailor_models=tailor_models,
        tailor_judge_model=tailor_judge_model,
        tailor_judge_min_score=tailor_judge_min_score,
        llm_model=llm_model,
    )

    ensure_job_stage_rows(
        conn,
        stable_job_id,
        tenant_id=tenant_id,
        discovered_at=job.get("discovered_at"),
    )
    started_at = utc_now()
    prior_attempts = _tailor_attempt_count(
        conn,
        tenant_id=tenant_id,
        job_id=stable_job_id,
    )
    current_attempt = prior_attempts + 1
    metadata = _tailor_activity_metadata(
        SqliteMaterialsRepository(conn),
        tenant_id=tenant_id,
        job_id=stable_job_id,
        workflow_id=workflow_id,
        retailor=retailor,
    )
    set_stage_state(
        conn,
        stable_job_id,
        "tailor",
        "running",
        tenant_id=tenant_id,
        # Owner recovery increments an interrupted running row, so the start
        # write must preserve the completed count instead of pre-incrementing.
        attempt_count=prior_attempts,
        started_at=started_at,
        metadata=metadata,
        validate_transition=False,
    )
    record_job_event(
        conn,
        stable_job_id,
        "tailor",
        "StageStarted",
        tenant_id=tenant_id,
        message="Tailoring started",
    )
    conn.commit()

    def commit_guard() -> None:
        assert_material_activity_commit_allowed(
            conn,
            tenant_id=str(tenant_id),
            job_id=str(stable_job_id),
            stage="tailor",
            workflow_id=workflow_id,
            cancel_event=cancel_event,
        )

    try:
        result = _tailor_one_job(
            job,
            "",
            snapshot,
            validation_mode,
            use_case=None,
            pdf_renderer=pdf_renderer,
            retailor=retailor,
            suppress_existing_artifacts=suppress_existing_artifacts,
            tenant_id=tenant_id,
            llm_policy=llm_policy,
            commit_guard=commit_guard,
            audit_execution_id=workflow_id,
            durable_attempt=current_attempt,
        )
        commit_guard()
    except Exception as exc:  # noqa: BLE001 - one item must terminalize its stage
        # A cancellation/successor fence must escape this item runner. Turning
        # it into an ordinary generation failure would let this stale owner
        # overwrite the durable canceled/successor-owned row below.
        commit_guard()
        committed = _reconcile_existing_approved_resume(
            conn,
            tenant_id=tenant_id,
            job_id=stable_job_id,
            retailor=retailor,
            workflow_id=workflow_id,
            commit_guard=commit_guard,
        )
        if committed is not None:
            return {
                "url": target["url"],
                "job_id": str(stable_job_id),
                "status": "already_done",
                "reason": "approved_resume_committed_before_exception",
                "materials": committed,
            }
        result = {
            "url": target["url"],
            "job_id": str(stable_job_id),
            "status": "error",
            "attempts": 1,
            "error": str(exc),
        }
    finished_at = utc_now()
    generation_attempts = result.get("attempts") or 1
    # The final owner check and stage transition share SQLite's write-lock
    # boundary, so cancellation or a successor cannot slip between them.
    durable_exhausted = False
    with SqliteUnitOfWork(conn):
        commit_guard()
        if result.get("status") == "approved":
            set_stage_state(
                conn,
                stable_job_id,
                "tailor",
                "succeeded",
                tenant_id=tenant_id,
                attempt_count=current_attempt,
                started_at=started_at,
                finished_at=finished_at,
                metadata=metadata,
            )
            record_job_event(
                conn,
                stable_job_id,
                "tailor",
                "StageCompleted",
                tenant_id=tenant_id,
                message="Tailoring approved",
                payload={
                    "attempts": current_attempt,
                    "generationAttempts": generation_attempts,
                },
            )
            _mark_cover_pending_after_tailor_success_by_id(
                conn,
                stable_job_id,
                tenant_id=tenant_id,
                reason="tailor_stage_completed",
            )
        else:
            exhausted = current_attempt >= MAX_ATTEMPTS
            durable_exhausted = exhausted
            set_stage_state(
                conn,
                stable_job_id,
                "tailor",
                "exhausted" if exhausted else "failed",
                tenant_id=tenant_id,
                attempt_count=current_attempt,
                max_attempts=MAX_ATTEMPTS,
                started_at=started_at,
                finished_at=finished_at,
                error_code=str(result.get("status", "error")).upper(),
                error_message=f"Tailoring ended with status {result.get('status', 'error')}",
                retryable=not exhausted,
                next_action=(
                    f"jobctrl retry tailor {job['url']} --reset-attempts"
                    if exhausted
                    else f"jobctrl retry tailor {job['url']}"
                ),
                validate_transition=False,
            )
            record_job_event(
                conn,
                stable_job_id,
                "tailor",
                "StageExhausted" if exhausted else "StageFailed",
                tenant_id=tenant_id,
                level="error",
                message=f"Tailoring ended with status {result.get('status', 'error')}",
                payload={
                    "attempts": current_attempt,
                    "generationAttempts": generation_attempts,
                    "generationStatus": str(result.get("status") or "error"),
                    "retryable": not exhausted,
                },
            )
    if durable_exhausted:
        return {
            **result,
            "status": "exhausted",
            "reason": "durable_attempt_budget_exhausted",
            "inner_status": str(result.get("status") or "error"),
        }
    return result


def _tailor_attempt_count(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> int:
    """Return durable Tailor executions, separate from inner LLM attempts."""
    row = conn.execute(
        """
        SELECT attempt_count
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchone()
    if row is None:
        return 0
    return int(row["attempt_count"] if hasattr(row, "keys") else row[0] or 0)


def _tailor_attempt_budget_exhausted(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> bool:
    row = conn.execute(
        """
        SELECT state, attempt_count, max_attempts
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchone()
    if row is None:
        return False
    max_attempts = int(row["max_attempts"] or MAX_ATTEMPTS)
    return str(row["state"]) == "exhausted" or int(row["attempt_count"] or 0) >= max_attempts


def _tailor_activity_metadata(
    repository: MaterialsRepository,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    workflow_id: str | None,
    retailor: bool,
) -> dict[str, object] | None:
    if not workflow_id:
        return None
    current = repository.load_current_approved(tenant_id, job_id)
    return {
        "activityOwner": workflow_id,
        "attemptCountBasis": "completed",
        "retailor": retailor,
        "priorApprovedGeneration": int(current.generation) if current is not None else 0,
    }


def _reconcile_existing_approved_resume(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    retailor: bool,
    workflow_id: str | None,
    commit_guard=None,
):
    """Treat the committed resume as authoritative after activity replay."""
    materials = SqliteMaterialsRepository(conn).load_current_approved(
        tenant_id,
        job_id,
    )
    if materials is None or not materials.is_resume_approved:
        return None
    row = conn.execute(
        """
        SELECT state, metadata_json
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    metadata = {}
    if row is not None:
        try:
            parsed = json.loads(str(row["metadata_json"] or "{}"))
            metadata = parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError, json.JSONDecodeError):
            metadata = {}
    completed_by_owner = bool(
        workflow_id
        and metadata.get("activityOwner") == workflow_id
        and str(row["state"] if row is not None else "") == "succeeded"
    )
    committed_retailor = bool(
        retailor
        and workflow_id
        and metadata.get("activityOwner") == workflow_id
        and int(materials.generation) > int(metadata.get("priorApprovedGeneration") or 0)
    )
    if retailor and not (completed_by_owner or committed_retailor):
        return None
    if row is None or str(row["state"]) != "succeeded":
        with SqliteUnitOfWork(conn):
            if commit_guard is not None:
                commit_guard()
            set_stage_state(
                conn,
                job_id,
                "tailor",
                "succeeded",
                tenant_id=tenant_id,
                finished_at=utc_now(),
                metadata={"activityOwner": workflow_id} if workflow_id else None,
                validate_transition=False,
            )
            record_job_event(
                conn,
                job_id,
                "tailor",
                "StageCompleted",
                tenant_id=tenant_id,
                message="Tailoring recovered from the committed approved resume.",
                payload={"recoveredAfterActivityReplay": True},
            )
    return materials


def _reconcile_score_eligibility_skip(
    conn: sqlite3.Connection,
    *,
    job_id: JobId,
    tenant_id: TenantId,
) -> bool:
    stable_job_id = canonical_job_id(str(job_id))
    score = SqliteScoreRepository(conn).load(tenant_id, stable_job_id)
    if score is None:
        return False
    eligibility = normalize_eligibility_for_downstream(score.breakdown.eligibility)
    if not eligibility_blocks_downstream(eligibility):
        reconcile_score_eligibility_blockers(
            conn,
            tenant_id=tenant_id,
            job_id=score.job_id,
            eligibility_status=eligibility.status,
            hard_blockers=list(eligibility.hard_blockers),
        )
        return False
    row = conn.execute(
        "SELECT discovered_at FROM jobs WHERE tenant_id = ? AND job_id = ?",
        (str(tenant_id), str(score.job_id)),
    ).fetchone()
    discovered_at = row["discovered_at"] if row is not None else None
    ensure_job_stage_rows(
        conn,
        score.job_id,
        tenant_id=tenant_id,
        discovered_at=discovered_at,
    )
    reconcile_score_eligibility_blockers(
        conn,
        tenant_id=tenant_id,
        job_id=score.job_id,
        eligibility_status=eligibility.status,
        hard_blockers=list(eligibility.hard_blockers),
    )
    return True


def _record_tailor_enrichment_block(
    conn: sqlite3.Connection,
    *,
    job_id: JobId,
    tenant_id: TenantId,
    discovered_at: str | None,
) -> bool:
    row = conn.execute(
        """
        SELECT latest_confidence, latest_quarantine_reason
        FROM posting_snapshot_sets
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if row is None:
        return False
    confidence = str(row["latest_confidence"] or "").lower()
    quarantine_reason = str(row["latest_quarantine_reason"] or "").lower()
    if confidence != "low" or quarantine_reason in {"", "none"}:
        return False
    ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=tenant_id,
        discovered_at=discovered_at,
    )
    set_stage_state(
        conn,
        job_id,
        "tailor",
        "blocked",
        tenant_id=tenant_id,
        error_code="ENRICHMENT_QUARANTINED",
        error_message="Tailoring is waiting for a trustworthy posting snapshot.",
        retryable=True,
        blocked_by=["enrich"],
        next_action="Retry enrichment after the posting-confidence condition is resolved.",
        metadata={"condition": quarantine_reason},
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_id,
        "tailor",
        "StageBlocked",
        tenant_id=tenant_id,
        level="warning",
        message="Tailoring is waiting for a trustworthy posting snapshot.",
        payload={"reason": "enrichment_quarantined", "condition": quarantine_reason},
    )
    return True


def _record_tailor_skip(
    conn: sqlite3.Connection,
    *,
    job_id: JobId,
    tenant_id: TenantId,
    discovered_at: str | None,
    reason: str,
    message: str,
) -> None:
    stable_job_id = canonical_job_id(str(job_id))
    ensure_job_stage_rows(
        conn,
        stable_job_id,
        tenant_id=tenant_id,
        discovered_at=discovered_at,
    )
    record_job_event(
        conn,
        stable_job_id,
        "tailor",
        "StageSkipped",
        tenant_id=tenant_id,
        level="warning",
        message=message,
        payload={"reason": reason},
    )


def _load_tailor_eligible_job_by_id(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    job: dict,
    min_score: int,
    retailor: bool,
    allow_low_fit_override: bool = False,
) -> dict | None:
    stable_job_id = canonical_job_id(str(job_id))
    if not str(job.get("full_description") or "").strip():
        return None
    score_stage = conn.execute(
        """
        SELECT state
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'score'
        """,
        (str(tenant_id), str(stable_job_id)),
    ).fetchone()
    if score_stage is not None and str(score_stage["state"]) != "succeeded":
        return None
    if conn.execute(
        """
        SELECT 1
        FROM job_score_staleness
        WHERE tenant_id = ? AND job_id = ? AND resolved = 0
        LIMIT 1
        """,
        (str(tenant_id), str(stable_job_id)),
    ).fetchone() is not None:
        return None
    posting_state = conn.execute(
        """
        SELECT latest_active_state, latest_confidence, latest_quarantine_reason
        FROM posting_snapshot_sets
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(tenant_id), str(stable_job_id)),
    ).fetchone()
    if posting_state is not None:
        active_state = str(posting_state["latest_active_state"] or "").lower()
        if active_state in {
            "closed",
            "expired",
            "removed",
            "location_incompatible",
        }:
            return None
        confidence = str(posting_state["latest_confidence"] or "").lower()
        quarantine_reason = str(
            posting_state["latest_quarantine_reason"] or ""
        ).lower()
        if confidence == "low" and quarantine_reason not in {"", "none"}:
            return None
    tailor_stage = conn.execute(
        """
        SELECT state, attempt_count
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(tenant_id), str(stable_job_id)),
    ).fetchone()
    if tailor_stage is not None:
        tailor_state = str(tailor_stage["state"])
        attempt_count = int(tailor_stage["attempt_count"] or 0)
        if tailor_state == "exhausted" or attempt_count >= MAX_ATTEMPTS:
            return None
        if not retailor and tailor_state not in {
            "pending",
            "running",
            "failed",
            "stale",
        }:
            return None
    score = SqliteScoreRepository(conn).load(tenant_id, stable_job_id)
    if score is None:
        return None
    if eligibility_blocks_downstream(score.breakdown.eligibility):
        return None
    effective_min_score = 0 if allow_low_fit_override else db_module.effective_tailoring_min_score(min_score)
    if score.fit_score.value < effective_min_score:
        return None
    if not retailor and SqliteMaterialsRepository(conn).load_current_approved(tenant_id, stable_job_id) is not None:
        return None
    return job


__all__ = [
    "MAX_ATTEMPTS",
    "TailorOutcome",
    "_build_master_tailor_prompt",
    "_tailor_one_job",
    "run_tailoring",
    "tailor_resume",
    "tailor_job_by_id",
    "tailor_job_by_url",
]
