"""Cover letter generation runner — wires the Materials use case into the worker.

See ddd-target.md §3.5 / §4.5 / §5.5. After Phase 6 the cover-letter
module is a thin adapter around :class:`GenerateCoverLetterUseCase`
(``domain/materials/use_cases.py``):

  * Domain logic (prompt assembly, validation, MaterialsSet composition)
    lives in the use case + ``ContentValidator`` / ``MaterialsSet``.
  * Persistence goes through :class:`MaterialsRepository` — the legacy
    ``UPDATE jobs SET cover_letter_path = …`` writes are GONE per the
    no-strangler directive. Readers fall back to
    ``jobs.cover_letter_path`` only for historical rows.
  * The LLM call is mediated by :class:`LlmPort`; the cloud LLM gateway
    swap-out is a constructor-only change.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from jobctrl.config import COVER_LETTER_DIR
from jobctrl.database import effective_tailoring_min_score, get_connection
from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.services import ContentValidator
from jobctrl.domain.materials.use_cases import (
    CoverLetterOutcome,
    GenerateCoverLetterUseCase,
)
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.ports.llm import LlmPort
from jobctrl.domain.ports.materials import (
    EmployerAnalysisRepository,
    MaterialsRepository,
    PdfRendererPort,
)
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.domain.materials.value_objects import ArtifactStatus
from jobctrl.infrastructure.discovery.sqlite_identity_resolver import SqliteJobIdentityResolver
from jobctrl.infrastructure.llm import LlmAdapter, get_llm_adapter
from jobctrl.infrastructure.materials import (
    PlaywrightHtmlPdfAdapter,
    SqliteEmployerAnalysisRepository,
    SqliteMaterialsRepository,
)
from jobctrl.infrastructure.preparation.sqlite_repository import SqlitePreparationTargetReader
from jobctrl.infrastructure.scoring import SqliteScoreRepository
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctrl.state import (
    MAX_ATTEMPTS,
    ensure_job_stage_rows,
    record_job_event,
    set_stage_state,
    utc_now,
)

log = logging.getLogger(__name__)

_COVER_MAX_ATTEMPTS = int(MAX_ATTEMPTS["cover"] or 5)


# ---------------------------------------------------------------------------
# Use-case construction (DI seam)
# ---------------------------------------------------------------------------


def _build_use_case(
    *,
    repository: MaterialsRepository | None = None,
    llm_port: LlmPort | None = None,
    llm_model: str | None = None,
    publisher: EventPublisher | None = None,
    validator: ContentValidator | None = None,
    analysis_repository: EmployerAnalysisRepository | None = None,
) -> GenerateCoverLetterUseCase:
    if repository is None:
        repository = SqliteMaterialsRepository(get_connection())
    if llm_port is None:
        llm_port = (
            LlmAdapter(default_model=llm_model)
            if llm_model
            else get_llm_adapter()
        )
    if validator is None:
        validator = ContentValidator()
    if analysis_repository is None:
        analysis_repository = SqliteEmployerAnalysisRepository(get_connection())
    return GenerateCoverLetterUseCase(
        repository=repository,
        llm=llm_port,
        validator=validator,
        publisher=publisher,
        analysis_repository=analysis_repository,
    )


def _build_pdf_renderer() -> PdfRendererPort:
    return PlaywrightHtmlPdfAdapter()


# ---------------------------------------------------------------------------
# Backward-compatible helpers — preserved so callers / tests keep working
# ---------------------------------------------------------------------------


def _get_resume_text_for_job(job: dict, base_resume_text: str) -> str:
    """Read the tailored resume required for cover generation.

    Kept for backward compatibility (a regression test asserts the
    behaviour). ``base_resume_text`` is unused and retained for the
    legacy signature.
    """
    _ = base_resume_text
    tailored_path = job.get("tailored_resume_path")
    if not tailored_path:
        raise FileNotFoundError("Cover letter generation requires a tailored resume.")

    path = Path(tailored_path)
    if not path.exists():
        raise FileNotFoundError(f"Tailored resume missing on disk: {path}")

    try:
        return path.read_text(encoding="utf-8")
    except OSError as e:
        raise FileNotFoundError(f"Could not read tailored resume {path}: {e}") from e


def generate_cover_letter(
    resume_text: str,
    job: dict,
    snapshot: ProfileSnapshot,
    max_retries: int = 3,
    validation_mode: str = "normal",
) -> str:
    """Generate a cover letter — kept for callers that want raw text out.

    Single-job entry point preserved so the manual ``apply_jobs`` flow
    keeps its single-call ergonomics. New callers should construct
    :class:`GenerateCoverLetterUseCase` directly.
    """
    _ = resume_text  # use case reads the tailored resume from the repo
    use_case = _build_use_case()
    use_case._max_retries = max_retries  # noqa: SLF001 — DI seam
    outcome = use_case.execute(
        job=job,
        job_id=canonical_job_id(str(job["job_id"])),
        profile_snapshot=snapshot,
        cover_letter_dir=COVER_LETTER_DIR,
        validation_mode=validation_mode,
    )
    if outcome.text_path:
        try:
            return Path(outcome.text_path).read_text(encoding="utf-8")
        except OSError:
            pass
    return ""


def cover_letter_by_id(
    job_id: JobId,
    *,
    min_score: int = 7,
    validation_mode: str = "normal",
    snapshot: ProfileSnapshot | None = None,
    repository: MaterialsRepository | None = None,
    llm_port: LlmPort | None = None,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    publisher: EventPublisher | None = None,
    pdf_renderer: PdfRendererPort | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
) -> dict:
    """Generate exactly one eligible cover letter by tenant-scoped JobId."""
    stable_job_id = canonical_job_id(str(job_id))
    conn = get_connection()
    job = SqlitePreparationTargetReader(conn).load(tenant_id, stable_job_id)
    if job is None:
        return _skipped_result(stable_job_id, reason="job_not_found")

    if repository is None:
        repository = SqliteMaterialsRepository(conn)
    min_score = effective_tailoring_min_score(min_score)

    eligibility_reason = _cover_eligibility_reason(
        conn,
        tenant_id=tenant_id,
        job_id=stable_job_id,
        job=job,
        min_score=min_score,
    )
    if eligibility_reason is not None:
        return _skipped_result(
            stable_job_id,
            reason=eligibility_reason,
            url=str(job.get("url") or ""),
        )

    materials = repository.load_current_approved(tenant_id, stable_job_id)
    if materials is None or not materials.is_resume_approved:
        return _skipped_result(stable_job_id, reason="missing_approved_resume", url=str(job.get("url") or ""))
    if materials.resume_pdf is None or materials.resume_pdf.status is not ArtifactStatus.APPROVED:
        return _skipped_result(stable_job_id, reason="missing_approved_resume_pdf", url=str(job.get("url") or ""))
    if materials.cover_letter is not None and materials.cover_letter.status is ArtifactStatus.APPROVED:
        return _skipped_result(stable_job_id, reason="already_done", url=str(job.get("url") or ""), status="already_done")
    if _cover_stage_succeeded(conn, tenant_id=tenant_id, job_id=stable_job_id):
        return _skipped_result(stable_job_id, reason="already_done", url=str(job.get("url") or ""), status="already_done")

    if snapshot is None:
        from jobctrl.infrastructure.profile import get_profile_repository

        snapshot = get_profile_repository().load_snapshot(tenant_id)

    COVER_LETTER_DIR.mkdir(parents=True, exist_ok=True)
    log.info("Generating cover letter for %s (score >= %d)...", stable_job_id, min_score)
    t0 = time.time()
    use_case = _build_use_case(
        repository=repository,
        llm_port=llm_port,
        llm_model=llm_model,
        publisher=publisher,
    )
    if pdf_renderer is None:
        pdf_renderer = _build_pdf_renderer()

    url = str(job.get("url") or "")
    ensure_job_stage_rows(
        conn,
        stable_job_id,
        tenant_id=tenant_id,
        discovered_at=job.get("discovered_at"),
    )
    started_at = utc_now()
    prior_attempts = _cover_attempt_count(
        conn,
        tenant_id=tenant_id,
        job_id=stable_job_id,
    )
    current_attempt = prior_attempts + 1
    set_stage_state(
        conn,
        stable_job_id,
        "cover",
        "running",
        tenant_id=tenant_id,
        attempt_count=current_attempt,
        started_at=started_at,
        validate_transition=False,
    )
    record_job_event(
        conn,
        stable_job_id,
        "cover",
        "StageStarted",
        tenant_id=tenant_id,
        message="Cover letter generation started",
    )
    conn.commit()

    try:
        outcome = use_case.execute(
            job=job,
            profile_snapshot=snapshot,
            cover_letter_dir=COVER_LETTER_DIR,
            validation_mode=validation_mode,
            tenant_id=tenant_id,
            job_id=stable_job_id,
        )
    except Exception as exc:  # noqa: BLE001
        outcome = CoverLetterOutcome(
            materials=None,
            status="error",
            error=str(exc),
        )
        log.error("[ERROR] %s -- %s", str(job.get("title", ""))[:40], exc)

    finished_at = utc_now()
    elapsed = time.time() - t0
    if outcome.status == "ok":
        # Best-effort PDF render. Failure is non-fatal: the cover letter text
        # is the canonical artifact and the PDF is an optional sibling.
        if outcome.text_path and outcome.materials is not None:
            try:
                text_path = Path(outcome.text_path)
                pdf_path = text_path.with_suffix(".pdf")
                pdf_artifact = pdf_renderer.render_cover_letter_to_pdf(
                    cover_letter_text=text_path.read_text(encoding="utf-8"),
                    output_path=str(pdf_path),
                    created_at=utc_now(),
                )
                materials = outcome.materials.with_cover_letter_pdf(
                    pdf_artifact, updated_at=utc_now()
                )
                repository.save(materials)
            except Exception:
                log.debug("PDF generation failed for cover letter", exc_info=True)

        set_stage_state(
            conn,
            stable_job_id,
            "cover",
            "succeeded",
            tenant_id=tenant_id,
            attempt_count=current_attempt,
            started_at=started_at,
            finished_at=finished_at,
        )
        record_job_event(
            conn,
            stable_job_id,
            "cover",
            "StageCompleted",
            tenant_id=tenant_id,
            message="Cover letter generated",
        )
        conn.commit()
        log.info("Cover letter done in %.1fs: generated for %s", elapsed, url)
        return {
            "jobId": str(stable_job_id),
            "url": url,
            "status": "ok",
            "generated": 1,
            "errors": 0,
            "elapsed": elapsed,
            "materialsGeneration": getattr(outcome.materials, "generation", None),
        }

    failed_attempts = current_attempt
    exhausted = failed_attempts >= _COVER_MAX_ATTEMPTS
    set_stage_state(
        conn,
        stable_job_id,
        "cover",
        "exhausted" if exhausted else "failed",
        tenant_id=tenant_id,
        attempt_count=failed_attempts,
        max_attempts=_COVER_MAX_ATTEMPTS,
        started_at=started_at,
        finished_at=finished_at,
        error_code="COVER_FAILED",
        error_message=outcome.error or f"Cover letter generation failed ({outcome.status})",
        retryable=not exhausted,
        next_action=(
            f"jobctrl retry cover {url or stable_job_id} --reset-attempts"
            if exhausted
            else f"jobctrl retry cover {url or stable_job_id}"
        ),
        validate_transition=False,
    )
    record_job_event(
        conn,
        stable_job_id,
        "cover",
        "StageFailed",
        tenant_id=tenant_id,
        level="error",
        message=outcome.error or f"Cover letter generation failed ({outcome.status})",
    )
    conn.commit()
    return {
        "jobId": str(stable_job_id),
        "url": url,
        "status": outcome.status,
        "generated": 0,
        "errors": 1 if outcome.status == "error" else 0,
        "elapsed": elapsed,
        "error": outcome.error,
    }


def cover_letter_by_url(
    job_url: str,
    **kwargs,
) -> dict:
    """Resolve one current posting locator before using the JobId runtime path."""
    tenant_id = kwargs.get("tenant_id", LOCAL_TENANT)
    conn = get_connection()
    resolved = SqliteJobIdentityResolver(conn).resolve_current_by_posting_url(
        tenant_id,
        PostingUrl(str(job_url)),
    )
    if resolved is None:
        return _skipped_result(None, reason="job_not_found", url=str(job_url))
    return cover_letter_by_id(resolved.job_id, **kwargs)


def _skipped_result(
    job_id: JobId | None,
    *,
    reason: str,
    url: str = "",
    status: str = "skipped",
) -> dict:
    return {
        "jobId": str(job_id) if job_id is not None else None,
        "url": url,
        "status": status,
        "reason": reason,
        "generated": 0,
        "errors": 0,
        "elapsed": 0.0,
    }


def _cover_stage_succeeded(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> bool:
    row = conn.execute(
        "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'",
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchone()
    if row is None:
        return False
    return str(row["state"] if hasattr(row, "keys") else row[0]) == "succeeded"


def _cover_eligibility_reason(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    job: dict,
    min_score: int,
) -> str | None:
    """Return the durable admission reason that prevents cover generation."""
    if not str(job.get("full_description") or "").strip():
        return "missing_description"

    score_stage = conn.execute(
        """
        SELECT state
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'score'
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if score_stage is not None and str(score_stage["state"]) != "succeeded":
        return "score_not_current"
    if conn.execute(
        """
        SELECT 1
        FROM job_score_staleness
        WHERE tenant_id = ? AND job_id = ? AND resolved = 0
        LIMIT 1
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone() is not None:
        return "score_stale"

    posting_state = conn.execute(
        """
        SELECT latest_active_state, latest_confidence, latest_quarantine_reason
        FROM posting_snapshot_sets
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if posting_state is not None:
        active_state = str(posting_state["latest_active_state"] or "").lower()
        if active_state in {"closed", "expired", "removed", "location_incompatible"}:
            return "posting_inactive"
        confidence = str(posting_state["latest_confidence"] or "").lower()
        quarantine_reason = str(
            posting_state["latest_quarantine_reason"] or ""
        ).lower()
        if confidence == "low" and quarantine_reason not in {"", "none"}:
            return "posting_quarantined"

    cover_stage = conn.execute(
        """
        SELECT state, attempt_count
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if cover_stage is not None:
        cover_state = str(cover_stage["state"])
        attempt_count = int(cover_stage["attempt_count"] or 0)
        if cover_state == "succeeded":
            return None
        if cover_state == "exhausted" or attempt_count >= _COVER_MAX_ATTEMPTS:
            return "cover_exhausted"
        if cover_state not in {"pending", "running", "failed", "stale"}:
            return "cover_not_retryable"

    score = SqliteScoreRepository(conn).load(tenant_id, job_id)
    if score is None:
        return "missing_score"
    if score.fit_score.value < min_score:
        return "below_min_score"
    eligibility = score.breakdown.eligibility
    if eligibility.status == "blocked" or eligibility.hard_blockers:
        return "score_ineligible"
    return None


def _cover_attempt_count(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> int:
    row = conn.execute(
        """
        SELECT attempt_count
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if row is None:
        return 0
    return int(row["attempt_count"] if hasattr(row, "keys") else row[0] or 0)


__all__ = [
    "_get_resume_text_for_job",
    "cover_letter_by_id",
    "cover_letter_by_url",
    "generate_cover_letter",
]
