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

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from jobhunter import config
from jobhunter.config import TAILORED_DIR
from jobhunter.database import get_connection, get_jobs_by_stage
from jobhunter.domain.materials import ValidationResult
from jobhunter.domain.materials.services import ContentValidator, ResumeAssembler
from jobhunter.domain.materials.use_cases import (
    TailorOutcome,
    TailoringLlmPolicy,
    TailorResumeUseCase,
    build_master_tailor_prompt,
)
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.ports.llm import LlmPort
from jobhunter.domain.ports.materials import (
    MaterialsRepository,
    PdfRendererPort,
    TailoringPolicyRepository,
)
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.infrastructure.llm import get_llm_adapter
from jobhunter.infrastructure.materials import (
    LatexPdfAdapter,
    SqliteMaterialsRepository,
    SqliteTailoringPolicyRepository,
)
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobhunter.state import (
    ensure_job_stage_rows,
    record_job_event,
    set_stage_state,
    utc_now,
)

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 5  # max cross-run retries before giving up


def _split_model_specs(value: str | None) -> tuple[str, ...]:
    return tuple(part.strip() for part in (value or "").split(",") if part.strip())


def _build_llm_policy(
    *,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
) -> TailoringLlmPolicy:
    env_models = _split_model_specs(
        os.environ.get("TAILORING_GENERATOR_MODELS")
        or os.environ.get("TAILORING_GENERATOR_MODEL")
        or os.environ.get("TAILOR_LLM_MODELS")
    )
    env_judge_model = (
        os.environ.get("TAILORING_JUDGE_MODEL")
        or os.environ.get("TAILOR_JUDGE_MODEL")
        or ""
    ).strip() or None
    judge_min_score = 0.82 if tailor_judge_min_score is None else tailor_judge_min_score
    env_min_score = os.environ.get("TAILORING_JUDGE_MIN_SCORE") or os.environ.get(
        "TAILOR_JUDGE_MIN_SCORE"
    )
    if tailor_judge_min_score is None and env_min_score:
        try:
            judge_min_score = float(env_min_score)
        except ValueError:
            log.warning(
                "Invalid tailoring judge min score %r; using %.2f",
                env_min_score,
                judge_min_score,
            )
    return TailoringLlmPolicy(
        candidate_models=tailor_models or env_models or ((llm_model,) if llm_model else ()),
        judge_model=tailor_judge_model or env_judge_model or llm_model,
        judge_min_score=judge_min_score,
    )


# ---------------------------------------------------------------------------
# Use-case construction (DI seam)
# ---------------------------------------------------------------------------


def _build_use_case(
    *,
    repository: MaterialsRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
    validator: ContentValidator | None = None,
    assembler: ResumeAssembler | None = None,
    llm_policy: TailoringLlmPolicy | None = None,
    policy_repository: TailoringPolicyRepository | None = None,
) -> TailorResumeUseCase:
    """Construct a :class:`TailorResumeUseCase` using local-mode defaults."""
    conn = get_connection()
    if repository is None:
        repository = SqliteMaterialsRepository(conn)
    if policy_repository is None:
        policy_repository = SqliteTailoringPolicyRepository(conn)
    if llm_port is None:
        llm_port = get_llm_adapter()
    if validator is None:
        validator = ContentValidator()
    if assembler is None:
        assembler = ResumeAssembler()
    if llm_policy is None:
        llm_policy = _build_llm_policy()
    return TailorResumeUseCase(
        repository=repository,
        llm=llm_port,
        validator=validator,
        assembler=assembler,
        publisher=publisher,
        llm_policy=llm_policy,
        policy_repository=policy_repository,
    )


def _build_pdf_renderer() -> PdfRendererPort:
    return LatexPdfAdapter()


def _selected_candidate_payload(report: dict) -> dict | None:
    """Return the selected tailored JSON payload from a quality-gated report."""
    selected_candidate_id = str(report.get("selected_candidate") or "")
    attempts = report.get("attempt_history") or []
    for attempt in reversed(attempts):
        if not isinstance(attempt, dict):
            continue
        candidates = attempt.get("candidates") or []
        if not isinstance(candidates, list):
            continue
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            if candidate.get("candidate_id") != selected_candidate_id:
                continue
            payload = candidate.get("parsed_json")
            if isinstance(payload, dict):
                return payload
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            if candidate.get("status") != "approved":
                continue
            payload = candidate.get("parsed_json")
            if isinstance(payload, dict):
                return payload
    return None


# ---------------------------------------------------------------------------
# Prompt builder (kept for backward compatibility — re-exports the use case helper)
# ---------------------------------------------------------------------------


def _build_master_tailor_prompt(snapshot: ProfileSnapshot) -> str:
    """Backward-compatible wrapper for the canonical use-case prompt builder."""
    return build_master_tailor_prompt(snapshot)


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
    tenant_id: TenantId = LOCAL_TENANT,
    llm_policy: TailoringLlmPolicy | None = None,
) -> dict:
    """Tailor one job and return the legacy-shaped result dict.

    The ``resume_text`` parameter is preserved for backward
    compatibility — the use case doesn't read it (it builds prompts
    from the snapshot). New callers should pass empty.
    """
    _ = resume_text  # legacy parameter — ignored
    if use_case is None:
        use_case = _build_use_case(llm_policy=llm_policy)
    if pdf_renderer is None:
        pdf_renderer = _build_pdf_renderer()

    outcome = use_case.execute(
        job=job,
        profile_snapshot=snapshot,
        tailored_dir=TAILORED_DIR,
        validation_mode=validation_mode,
        tenant_id=tenant_id,
        retailor=retailor,
    )

    pdf_path: str | None = None
    if outcome.materials is not None and outcome.materials.is_resume_approved:
        # Render the resume PDF inline so the legacy result shape carries
        # ``pdf_path`` (downstream callers and the apply launcher
        # immediately pick it up via the joined ``jm_resume_pdf_path`` /
        # legacy fallback).
        parsed_payload = _selected_candidate_payload(outcome.report)
        if parsed_payload and outcome.materials.tailored_resume is not None:
            try:
                text_path = Path(outcome.materials.tailored_resume.path)
                pdf_out = text_path.with_suffix(".pdf")
                pdf_artifact = pdf_renderer.render_resume_to_pdf(
                    tailored_payload=parsed_payload,
                    profile_dict=snapshot.as_dict(),
                    output_path=str(pdf_out),
                    created_at=utc_now(),
                )
                # Append the PDF onto the existing aggregate so the
                # repository persists it under the same generation.
                outcome_materials = outcome.materials.with_resume_pdf(
                    pdf_artifact, updated_at=utc_now()
                )
                # Re-save through the same repository the use case used.
                use_case._repository.save(outcome_materials)  # noqa: SLF001 — DI seam
                pdf_path = str(pdf_out)
            except Exception as exc:
                log.error("LaTeX PDF generation failed for %s", outcome.text_path, exc_info=True)
                pdf_error = f"PDF render failed: {exc}"
                failed_materials = outcome.materials.with_resume_attempt(
                    outcome.materials.tailored_resume,
                    validation=ValidationResult.failure((pdf_error,)),
                    verdict=outcome.materials.last_verdict,
                    updated_at=utc_now(),
                )
                use_case._repository.save(failed_materials)  # noqa: SLF001 — DI seam
                return {
                    "url": job["url"],
                    "path": outcome.text_path,
                    "pdf_path": None,
                    "title": job["title"],
                    "site": job.get("site"),
                    "status": "error",
                    "attempts": outcome.attempts,
                    "materials": failed_materials,
                    "error": pdf_error,
                }

    return {
        "url": job["url"],
        "path": outcome.text_path,
        "pdf_path": pdf_path,
        "title": job["title"],
        "site": job.get("site"),
        "status": outcome.status,
        "attempts": outcome.attempts,
        "materials": outcome.materials,
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
        from jobhunter.infrastructure.profile import get_profile_repository
        snapshot = get_profile_repository().load_snapshot(tenant_id)

    conn = get_connection()
    # ``repository`` is accepted for test injection but MUST NOT be passed
    # into worker-thread tasks — sqlite connections are thread-bound.
    if repository is None:
        repository = SqliteMaterialsRepository(conn)

    jobs = get_jobs_by_stage(
        conn=conn,
        stage="pending_tailor",
        min_score=min_score,
        limit=limit,
        retailor=retailor,
    )

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
    for job in jobs:
        ensure_job_stage_rows(conn, job["url"], discovered_at=job.get("discovered_at"))
        started_at = utc_now()
        started_ats[job["url"]] = started_at
        # The runner owns the restart policy: a job that failed last time is
        # eligible for retailoring per ``get_jobs_by_stage``, so the
        # transition Failed -> Running needs to be permitted even though
        # the canonical state machine table only allows Failed -> Pending
        # (via Reset). Skip validation here; the writer is the runner.
        set_stage_state(
            conn,
            job["url"],
            "tailor",
            "running",
            started_at=started_at,
            validate_transition=False,
        )
        record_job_event(conn, job["url"], "tailor", "StageStarted", message="Tailoring started")

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
            )
            future_to_job[future] = job

        for completed, future in enumerate(as_completed(future_to_job), start=1):
            job = future_to_job[future]
            try:
                result = future.result()
            except Exception as e:
                result = {
                    "url": job["url"], "title": job["title"], "site": job.get("site"),
                    "status": "error", "attempts": 0, "path": None, "pdf_path": None,
                    "materials": None,
                }
                log.error("%d/%d [ERROR] %s -- %s", completed, len(jobs), job["title"][:40], e)

            results.append(result)
            stats[result.get("status", "error")] = stats.get(result.get("status", "error"), 0) + 1

            elapsed = time.time() - t0
            rate = completed / elapsed if elapsed > 0 else 0
            log.info(
                "%d/%d [%s] attempts=%s | %.1f jobs/min | %s",
                completed, len(jobs),
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
    for r in results:
        url = r["url"]
        attempts = r.get("attempts") or 1
        if r.get("status") in _success_statuses:
            set_stage_state(
                conn,
                url,
                "tailor",
                "succeeded",
                attempt_count=attempts,
                started_at=started_ats.get(url),
                finished_at=finished_at,
            )
            record_job_event(
                conn,
                url,
                "tailor",
                "StageCompleted",
                message=f"Tailoring {r.get('status')}",
                payload={"attempts": attempts},
            )
        else:
            exhausted = (
                attempts >= config.DEFAULTS["max_tailor_attempts"]
                or r.get("status") == "exhausted_retries"
            )
            set_stage_state(
                conn,
                url,
                "tailor",
                "exhausted" if exhausted else "failed",
                attempt_count=attempts,
                max_attempts=config.DEFAULTS["max_tailor_attempts"],
                started_at=started_ats.get(url),
                finished_at=finished_at,
                error_code=str(r.get("status", "error")).upper(),
                error_message=f"Tailoring ended with status {r.get('status', 'error')}",
                retryable=True,
                next_action=(
                    f"jobhunter retry tailor {url} --reset-attempts"
                    if exhausted
                    else f"jobhunter retry tailor {url}"
                ),
            )
            record_job_event(
                conn,
                url,
                "tailor",
                "StageFailed",
                level="error",
                message=f"Tailoring ended with status {r.get('status', 'error')}",
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

    return {
        "approved": stats.get("approved", 0),
        "failed": stats.get("failed_validation", 0) + stats.get("failed_judge", 0),
        "errors": stats.get("error", 0),
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
) -> dict:
    """Tailor exactly one eligible job by URL.

    Durable Discovery-preparation items are job-scoped. This helper keeps the
    existing Materials use case and stage-state behavior while avoiding the
    batch ``pending_tailor`` selector from choosing a different job.
    """
    if snapshot is None:
        from jobhunter.infrastructure.profile import get_profile_repository

        snapshot = get_profile_repository().load_snapshot(tenant_id)

    conn = get_connection()
    eligible_jobs = get_jobs_by_stage(
        conn=conn,
        stage="pending_tailor",
        min_score=min_score,
        limit=0,
        retailor=retailor,
    )
    job = next((candidate for candidate in eligible_jobs if candidate.get("url") == job_url), None)
    if job is None:
        return {"url": job_url, "status": "skipped", "reason": "not_eligible"}

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

    ensure_job_stage_rows(conn, job_url, discovered_at=job.get("discovered_at"))
    started_at = utc_now()
    set_stage_state(
        conn,
        job_url,
        "tailor",
        "running",
        started_at=started_at,
        validate_transition=False,
    )
    record_job_event(conn, job_url, "tailor", "StageStarted", message="Tailoring started")
    conn.commit()

    result = _tailor_one_job(
        job,
        "",
        snapshot,
        validation_mode,
        use_case=None,
        pdf_renderer=pdf_renderer,
        retailor=retailor,
        tenant_id=tenant_id,
        llm_policy=llm_policy,
    )
    finished_at = utc_now()
    attempts = result.get("attempts") or 1
    if result.get("status") == "approved":
        set_stage_state(
            conn,
            job_url,
            "tailor",
            "succeeded",
            attempt_count=attempts,
            started_at=started_at,
            finished_at=finished_at,
        )
        record_job_event(
            conn,
            job_url,
            "tailor",
            "StageCompleted",
            message="Tailoring approved",
            payload={"attempts": attempts},
        )
    else:
        exhausted = (
            attempts >= config.DEFAULTS["max_tailor_attempts"]
            or result.get("status") == "exhausted_retries"
        )
        set_stage_state(
            conn,
            job_url,
            "tailor",
            "exhausted" if exhausted else "failed",
            attempt_count=attempts,
            max_attempts=config.DEFAULTS["max_tailor_attempts"],
            started_at=started_at,
            finished_at=finished_at,
            error_code=str(result.get("status", "error")).upper(),
            error_message=f"Tailoring ended with status {result.get('status', 'error')}",
            retryable=True,
            next_action=(
                f"jobhunter retry tailor {job_url} --reset-attempts"
                if exhausted
                else f"jobhunter retry tailor {job_url}"
            ),
            validate_transition=False,
        )
        record_job_event(
            conn,
            job_url,
            "tailor",
            "StageFailed",
            level="error",
            message=f"Tailoring ended with status {result.get('status', 'error')}",
        )
    conn.commit()
    return result


__all__ = [
    "MAX_ATTEMPTS",
    "TailorOutcome",
    "_build_master_tailor_prompt",
    "_tailor_one_job",
    "run_tailoring",
    "tailor_resume",
    "tailor_job_by_url",
]
