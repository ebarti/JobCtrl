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

from jobhunter.config import COVER_LETTER_DIR
from jobhunter.database import get_connection, get_jobs_by_stage
from jobhunter.domain.materials.services import ContentValidator
from jobhunter.domain.materials.use_cases import (
    CoverLetterOutcome,
    GenerateCoverLetterUseCase,
)
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.ports.llm import LlmPort
from jobhunter.domain.ports.materials import MaterialsRepository, PdfRendererPort
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.infrastructure.llm import get_llm_adapter
from jobhunter.infrastructure.materials import (
    PlaywrightHtmlPdfAdapter,
    SqliteMaterialsRepository,
)
from jobhunter.state import (
    ensure_job_stage_rows,
    record_job_event,
    set_stage_state,
    utc_now,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Use-case construction (DI seam)
# ---------------------------------------------------------------------------


def _build_use_case(
    *,
    repository: MaterialsRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
    validator: ContentValidator | None = None,
) -> GenerateCoverLetterUseCase:
    if repository is None:
        repository = SqliteMaterialsRepository(get_connection())
    if llm_port is None:
        llm_port = get_llm_adapter()
    if validator is None:
        validator = ContentValidator()
    return GenerateCoverLetterUseCase(
        repository=repository,
        llm=llm_port,
        validator=validator,
        publisher=publisher,
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


# ---------------------------------------------------------------------------
# Batch entry point
# ---------------------------------------------------------------------------


def run_cover_letters(
    min_score: int = 7,
    limit: int = 0,
    validation_mode: str = "normal",
    snapshot: ProfileSnapshot | None = None,
    *,
    repository: MaterialsRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
    pdf_renderer: PdfRendererPort | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
) -> dict:
    """Generate cover letters for jobs whose tailored resume is approved."""
    if snapshot is None:
        from jobhunter.infrastructure.profile import get_profile_repository
        snapshot = get_profile_repository().load_snapshot(tenant_id)

    conn = get_connection()
    if repository is None:
        repository = SqliteMaterialsRepository(conn)

    jobs = get_jobs_by_stage(
        conn=conn,
        stage="pending_cover",
        min_score=min_score,
        limit=limit,
    )

    if not jobs:
        log.info("No jobs needing cover letters (score >= %d).", min_score)
        return {"generated": 0, "errors": 0, "elapsed": 0.0}

    COVER_LETTER_DIR.mkdir(parents=True, exist_ok=True)
    log.info(
        "Generating cover letters for %d jobs (score >= %d)...",
        len(jobs), min_score,
    )
    t0 = time.time()
    completed = 0
    error_count = 0
    saved = 0
    use_case = _build_use_case(
        repository=repository,
        llm_port=llm_port,
        publisher=publisher,
    )
    if pdf_renderer is None:
        pdf_renderer = _build_pdf_renderer()

    for job in jobs:
        completed += 1
        url = job["url"]
        ensure_job_stage_rows(conn, url, discovered_at=job.get("discovered_at"))
        started_at = utc_now()
        set_stage_state(conn, url, "cover", "running", started_at=started_at)
        record_job_event(conn, url, "cover", "StageStarted", message="Cover letter generation started")

        try:
            outcome = use_case.execute(
                job=job,
                profile_snapshot=snapshot,
                cover_letter_dir=COVER_LETTER_DIR,
                validation_mode=validation_mode,
                tenant_id=tenant_id,
            )
        except Exception as exc:  # noqa: BLE001
            error_count += 1
            outcome = CoverLetterOutcome(
                materials=None,
                status="error",
                error=str(exc),
            )
            log.error("%d/%d [ERROR] %s -- %s", completed, len(jobs), str(job.get("title", ""))[:40], exc)

        finished_at = utc_now()
        if outcome.status == "ok":
            # Best-effort PDF render. Failure is non-fatal — the cover
            # letter text is the canonical artifact; the PDF is a sibling.
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
                url,
                "cover",
                "succeeded",
                attempt_count=1,
                started_at=started_at,
                finished_at=finished_at,
            )
            record_job_event(
                conn,
                url,
                "cover",
                "StageCompleted",
                message="Cover letter generated",
            )
            saved += 1
            elapsed = time.time() - t0
            rate = completed / elapsed if elapsed > 0 else 0
            log.info(
                "%d/%d [OK] | %.1f jobs/min | %s",
                completed, len(jobs), rate * 60, str(job.get("title", ""))[:40],
            )
        else:
            error_count += 1 if outcome.status == "error" else 0
            set_stage_state(
                conn,
                url,
                "cover",
                "failed",
                attempt_count=1,
                started_at=started_at,
                finished_at=finished_at,
                error_code="COVER_FAILED",
                error_message=outcome.error or f"Cover letter generation failed ({outcome.status})",
                retryable=True,
                next_action=f"jobhunter retry cover {url}",
            )
            record_job_event(
                conn,
                url,
                "cover",
                "StageFailed",
                level="error",
                message=outcome.error or f"Cover letter generation failed ({outcome.status})",
            )

    conn.commit()
    elapsed = time.time() - t0
    log.info(
        "Cover letters done in %.1fs: %d generated, %d errors", elapsed, saved, error_count
    )

    return {
        "generated": saved,
        "errors": error_count,
        "elapsed": elapsed,
    }


__all__ = [
    "_get_resume_text_for_job",
    "generate_cover_letter",
    "run_cover_letters",
]
