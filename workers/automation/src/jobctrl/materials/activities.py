"""Temporal activities for the materials-generation stages (tailor / cover)."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import threading
import time
from typing import Any

from temporalio import activity

from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.errors import JobCtrlError, LlmTransientError, to_application_error
from jobctrl.infrastructure.temporal.pipeline_step_lifecycle import (
    PipelineStepScope,
    begin_pipeline_step_attempt,
    pdf_pipeline_step_item_key,
)
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


# ---------------------------------------------------------------------------
# Tailor
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TailorActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    min_score: int = 7
    limit: int = 0
    workers: int = 1
    validation_mode: str = "normal"
    dry_run: bool = False
    retailor: bool = False
    job_urls: tuple[str, ...] = ()
    current_policy_only: bool = False
    suppress_existing_artifacts: bool = False
    allow_low_fit_override: bool = False
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float | None = None
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    workflow_id: str | None = None


@dataclass(frozen=True)
class TailorActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class TailorJobActivityInput:
    tenant_id: str
    job_url: str
    min_score: int = 7
    workers: int = 1
    validation_mode: str = "normal"
    retailor: bool = False
    suppress_existing_artifacts: bool = False
    allow_low_fit_override: bool = False
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float | None = None
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class TailorJobActivityOutput:
    status: str
    materials_generation: int | None = None
    reason: str = ""
    error: str = ""


@activity.defn(name="tailor")
async def tailor_activity(payload: TailorActivityInput) -> TailorActivityOutput:
    """Run the tailor stage."""
    from jobctrl.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobctrl.pipeline.runner import _run_stage_observed, _run_tailor

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    cancel_event = threading.Event()
    try:
        if payload.current_policy_only:
            result = await run_blocking_with_heartbeat(
                lambda: _run_current_policy_tailoring(payload, cancel_event=cancel_event),
                starting_message="current-policy tailor starting",
                progress_message="current-policy tailor still running",
                on_cancel=cancel_event.set,
                activity_name="tailor",
            )
            _raise_on_failure("tailor", result, LlmTransientError)
            return TailorActivityOutput(
                status=str(result["status"]),
                elapsed=float(result["elapsed"]),
                errors=dict(result["errors"]),
                stages=list(result["stages"]),
            )

        if payload.job_urls:
            result = await run_blocking_with_heartbeat(
                lambda: _run_selected_tailoring(payload, cancel_event=cancel_event),
                starting_message="selected tailor starting",
                progress_message="selected tailor still running",
                on_cancel=cancel_event.set,
                activity_name="tailor",
            )
            _raise_on_failure("tailor", result, LlmTransientError)
            return TailorActivityOutput(
                status=str(result["status"]),
                elapsed=float(result["elapsed"]),
                errors=dict(result["errors"]),
                stages=list(result["stages"]),
            )

        if payload.dry_run:
            return TailorActivityOutput(
                status="ok",
                elapsed=0.0,
                errors={},
                stages=[
                    {
                        "stage": "tailor",
                        "status": "ok",
                        "elapsed": 0.0,
                        "dry_run": True,
                        "selectedJobUrls": [],
                        "approvedJobUrls": [],
                    }
                ],
            )

        result = await run_blocking_with_heartbeat(
            lambda: _run_stage_observed(
                "tailor",
                _run_tailor,
                {
                    "min_score": payload.min_score,
                    "workers": payload.workers,
                    "validation_mode": payload.validation_mode,
                    "limit": payload.limit,
                    "retailor": payload.retailor,
                    "tailor_models": payload.tailor_models,
                    "tailor_judge_model": payload.tailor_judge_model,
                    "tailor_judge_min_score": payload.tailor_judge_min_score,
                    "llm_model": payload.llm_model,
                    "cancel_event": cancel_event,
                },
                mode="workflow",
                pass_number=1,
            ),
            starting_message="tailor starting",
            progress_message="tailor still running",
            on_cancel=cancel_event.set,
            activity_name="tailor",
        )
        stage_result, elapsed, status = result
        errors: dict[str, str] = {}
        if status not in _SUCCESS_STATUSES:
            errors["tailor"] = str(
                stage_result.get("error")
                or stage_result.get("error_message")
                or status
            )
        stages = [{"stage": "tailor", "status": status, "elapsed": elapsed, **stage_result}]
        activity_result = {
            "status": status,
            "elapsed": float(elapsed),
            "errors": errors,
            "stages": stages,
        }
        _raise_on_failure("tailor", activity_result, LlmTransientError)
        return TailorActivityOutput(
            status=status,
            elapsed=float(elapsed),
            errors=errors,
            stages=stages,
        )
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


def _run_current_policy_tailoring(
    payload: TailorActivityInput,
    *,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    from jobctrl.database import get_connection
    from jobctrl.pipeline.current_policy_selectors import tailoring_current_policy_job_urls

    urls = tailoring_current_policy_job_urls(
        get_connection(),
        tenant_id=payload.tenant_id,
        min_score=payload.min_score,
        limit=payload.limit,
        job_urls=payload.job_urls,
    )
    return _run_selected_tailoring(replace(payload, job_urls=urls, limit=0), cancel_event=cancel_event)


def _run_selected_tailoring(
    payload: TailorActivityInput,
    *,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    from jobctrl.domain.tenant import TenantId
    from jobctrl.scoring.tailor import tailor_job_by_url

    urls = _limited_job_urls(payload.job_urls, payload.limit)
    if payload.dry_run:
        return {
            "status": "ok",
            "elapsed": 0.0,
            "errors": {},
            "stages": [
                {
                    "stage": "tailor",
                    "status": "ok",
                    "elapsed": 0.0,
                    "selected": len(urls),
                    "dry_run": True,
                    "selectedJobUrls": list(urls),
                    "approvedJobUrls": [],
                }
            ],
        }

    t0 = time.time()
    approved = 0
    approved_urls: list[str] = []
    skipped = 0
    failed = 0
    errors: dict[str, str] = {}
    for url in urls:
        if cancel_event is not None and cancel_event.is_set():
            raise LlmTransientError("tailor activity canceled")
        result = tailor_job_by_url(
            url,
            min_score=payload.min_score,
            validation_mode=payload.validation_mode,
            workers=payload.workers,
            retailor=payload.retailor,
            tenant_id=TenantId(payload.tenant_id),
            llm_model=payload.llm_model,
            suppress_existing_artifacts=payload.suppress_existing_artifacts,
            allow_low_fit_override=payload.allow_low_fit_override,
            tailor_models=payload.tailor_models,
            tailor_judge_model=payload.tailor_judge_model,
            tailor_judge_min_score=payload.tailor_judge_min_score,
        )
        status = str(result.get("status") or "error")
        if status == "approved":
            approved += 1
            approved_urls.append(url)
        elif status in {"skipped", "not_eligible"}:
            skipped += 1
        else:
            failed += 1
            errors[url] = str(result.get("error") or f"Tailoring ended with status {status}")

    elapsed = time.time() - t0
    status = "failed" if errors else "ok"
    return {
        "status": status,
        "elapsed": elapsed,
        "errors": errors,
        "stages": [
            {
                "stage": "tailor",
                "status": status,
                "elapsed": elapsed,
                "selected": len(urls),
                "approved": approved,
                "selectedJobUrls": list(urls),
                "approvedJobUrls": approved_urls,
                "skipped": skipped,
                "failed": failed,
            }
        ],
    }


def _limited_job_urls(job_urls: tuple[str, ...], limit: int) -> tuple[str, ...]:
    unique = tuple(dict.fromkeys(url for url in job_urls if url))
    if limit > 0:
        return unique[:limit]
    return unique


@activity.defn(name="tailor_job")
async def tailor_job_activity(payload: TailorJobActivityInput) -> TailorJobActivityOutput:
    """Tailor one job by URL for ``JobPreparationWorkflow``."""
    from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat

    try:
        result = await run_blocking_with_heartbeat(
            lambda: _tailor_one_job(payload),
            starting_message="tailor-job starting",
            progress_message="tailor-job still running",
            activity_name="tailor_job",
        )
        status = str(result.get("status") or "error")
        if status not in {"approved", "skipped", "not_eligible", "already_done"}:
            raise LlmTransientError(str(result.get("error") or f"Tailoring ended with status {status}"))
        materials = result.get("materials")
        generation = getattr(materials, "generation", None)
        return TailorJobActivityOutput(
            status=status,
            materials_generation=generation,
            reason=str(result.get("reason") or ""),
            error=str(result.get("error") or ""),
        )
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


def _tailor_one_job(payload: TailorJobActivityInput) -> dict[str, Any]:
    from jobctrl.domain.tenant import TenantId
    from jobctrl.scoring.tailor import tailor_job_by_url

    return tailor_job_by_url(
        payload.job_url,
        min_score=payload.min_score,
        validation_mode=payload.validation_mode,
        workers=payload.workers,
        retailor=payload.retailor,
        tenant_id=TenantId(payload.tenant_id),
        llm_model=payload.llm_model,
        suppress_existing_artifacts=payload.suppress_existing_artifacts,
        allow_low_fit_override=payload.allow_low_fit_override,
        tailor_models=payload.tailor_models,
        tailor_judge_model=payload.tailor_judge_model,
        tailor_judge_min_score=payload.tailor_judge_min_score,
    )


# ---------------------------------------------------------------------------
# Cover letter
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CoverActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    min_score: int = 7
    limit: int = 0
    validation_mode: str = "normal"
    dry_run: bool = False
    job_urls: tuple[str, ...] = ()
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    workflow_id: str | None = None


@dataclass(frozen=True)
class CoverActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class CoverLetterActivityInput:
    tenant_id: str
    job_url: str
    min_score: int = 7
    validation_mode: str = "normal"
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class CoverLetterActivityOutput:
    status: str
    materials_generation: int | None = None
    reason: str = ""
    error: str = ""


@dataclass(frozen=True)
class RenderPdfActivityInput:
    tenant_id: str
    job_url: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    discovery_execution: DiscoveryExecutionRef | None = None
    pipeline_step_idempotency_key: str | None = None

    def __post_init__(self) -> None:
        if (self.discovery_execution is None) != (
            self.pipeline_step_idempotency_key is None
        ):
            raise ValueError(
                "discovery_execution and pipeline_step_idempotency_key must be supplied together"
            )
        if (
            self.discovery_execution is not None
            and self.discovery_execution.tenant_id != self.tenant_id
        ):
            raise ValueError("PDF tenant does not match discovery execution")
        if (
            self.pipeline_step_idempotency_key is not None
            and not self.pipeline_step_idempotency_key.strip()
        ):
            raise ValueError("PDF pipeline-step idempotency key must be non-empty")


@dataclass(frozen=True)
class RenderPdfActivityOutput:
    status: str
    rendered: tuple[str, ...] = ()
    error: str = ""


@activity.defn(name="cover")
async def cover_activity(payload: CoverActivityInput) -> CoverActivityOutput:
    """Run the cover-letter stage."""
    from jobctrl.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobctrl.pipeline.runner import _run_cover, _run_stage_observed

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    cancel_event = threading.Event()
    try:
        if payload.job_urls:
            result = await run_blocking_with_heartbeat(
                lambda: _run_selected_cover(payload, cancel_event=cancel_event),
                starting_message="selected cover starting",
                progress_message="selected cover still running",
                on_cancel=cancel_event.set,
                activity_name="cover",
            )
            _raise_on_failure("cover", result, LlmTransientError)
            return CoverActivityOutput(
                status=str(result["status"]),
                elapsed=float(result["elapsed"]),
                errors=dict(result["errors"]),
                stages=list(result["stages"]),
            )

        if payload.dry_run:
            return CoverActivityOutput(
                status="ok",
                elapsed=0.0,
                errors={},
                stages=[
                    {
                        "stage": "cover",
                        "status": "ok",
                        "elapsed": 0.0,
                        "dry_run": True,
                    }
                ],
            )

        result = await run_blocking_with_heartbeat(
            lambda: _run_stage_observed(
                "cover",
                _run_cover,
                {
                    "min_score": payload.min_score,
                    "validation_mode": payload.validation_mode,
                    "limit": payload.limit,
                    "llm_model": payload.llm_model,
                    "cancel_event": cancel_event,
                },
                mode="workflow",
                pass_number=1,
            ),
            starting_message="cover starting",
            progress_message="cover still running",
            on_cancel=cancel_event.set,
            activity_name="cover",
        )
        stage_result, elapsed, status = result
        errors: dict[str, str] = {}
        if status not in _SUCCESS_STATUSES:
            errors["cover"] = str(
                stage_result.get("error")
                or stage_result.get("error_message")
                or status
            )
        stages = [{"stage": "cover", "status": status, "elapsed": elapsed, **stage_result}]
        activity_result = {
            "status": status,
            "elapsed": float(elapsed),
            "errors": errors,
            "stages": stages,
        }
        _raise_on_failure("cover", activity_result, LlmTransientError)
        return CoverActivityOutput(
            status=status,
            elapsed=float(elapsed),
            errors=errors,
            stages=stages,
        )
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


def _run_selected_cover(
    payload: CoverActivityInput,
    *,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    from jobctrl.domain.tenant import TenantId
    from jobctrl.scoring.cover_letter import cover_letter_by_url

    urls = _limited_job_urls(payload.job_urls, payload.limit)
    if payload.dry_run:
        return {
            "status": "ok",
            "elapsed": 0.0,
            "errors": {},
            "stages": [
                {
                    "stage": "cover",
                    "status": "ok",
                    "elapsed": 0.0,
                    "selected": len(urls),
                    "dry_run": True,
                }
            ],
    }

    t0 = time.time()
    generated = 0
    skipped = 0
    failed = 0
    errors: dict[str, str] = {}
    results: list[dict[str, Any]] = []
    for url in urls:
        if cancel_event is not None and cancel_event.is_set():
            raise LlmTransientError("cover activity canceled")
        result = cover_letter_by_url(
            url,
            min_score=payload.min_score,
            validation_mode=payload.validation_mode,
            llm_model=payload.llm_model,
            tenant_id=TenantId(payload.tenant_id),
        )
        results.append(result)
        result_status = str(result.get("status") or "error")
        if result_status in {"ok", "already_done"}:
            generated += int(result.get("generated") or 0)
        elif result_status in {"skipped", "not_eligible"}:
            skipped += 1
        else:
            failed += 1
            errors[url] = str(result.get("error") or f"Cover ended with status {result_status}")
    elapsed = time.time() - t0
    status = "failed" if errors else "ok"
    return {
        "status": status,
        "elapsed": elapsed,
        "errors": errors,
        "stages": [
            {
                "stage": "cover",
                "status": status,
                "elapsed": elapsed,
                "selected": len(urls),
                "generated": generated,
                "skipped": skipped,
                "failed": failed,
                "results": results,
            }
        ],
    }


_SUCCESS_STATUSES = {"ok", "partial", "skipped", "already_done"}


def _raise_on_failure(stage: str, result: dict[str, Any], error_type: type[JobCtrlError]) -> None:
    errors = result.get("errors") or {}
    status = str(result.get("status") or "ok").lower()
    if errors or status not in _SUCCESS_STATUSES:
        detail = errors or result.get("error") or result.get("status") or "stage failed"
        raise error_type(f"{stage} failed: {detail}")


@activity.defn(name="cover_letter")
async def cover_letter_activity(payload: CoverLetterActivityInput) -> CoverLetterActivityOutput:
    """Generate one cover letter by URL for ``JobPreparationWorkflow``."""
    from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat

    try:
        result = await run_blocking_with_heartbeat(
            lambda: _cover_one_job(payload),
            starting_message="cover-letter starting",
            progress_message="cover-letter still running",
            activity_name="cover_letter",
        )
        status = str(result.get("status") or "error")
        if status not in {"ok", "skipped", "already_done"}:
            raise LlmTransientError(str(result.get("error") or f"Cover ended with status {status}"))
        return CoverLetterActivityOutput(
            status=status,
            materials_generation=result.get("materialsGeneration"),
            reason=str(result.get("reason") or ""),
            error=str(result.get("error") or ""),
        )
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


def _cover_one_job(payload: CoverLetterActivityInput) -> dict[str, Any]:
    from jobctrl.domain.tenant import TenantId
    from jobctrl.scoring.cover_letter import cover_letter_by_url

    return cover_letter_by_url(
        payload.job_url,
        min_score=payload.min_score,
        validation_mode=payload.validation_mode,
        llm_model=payload.llm_model,
        tenant_id=TenantId(payload.tenant_id),
    )


@activity.defn(name="render_pdf")
async def render_pdf_activity(payload: RenderPdfActivityInput) -> RenderPdfActivityOutput:
    """Render missing PDFs for one job's current approved materials."""
    from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat

    lifecycle = None
    if payload.discovery_execution is not None:
        idempotency_key = payload.pipeline_step_idempotency_key
        if idempotency_key is None:
            raise RuntimeError("PDF pipeline-step scope is incomplete")
        lifecycle = begin_pipeline_step_attempt(
            PipelineStepScope(
                execution=payload.discovery_execution,
                step_kind="pdf_render",
                item_key=pdf_pipeline_step_item_key(idempotency_key),
                detail_code="pdf_render",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
        )
    try:
        result = await run_blocking_with_heartbeat(
            lambda: _render_pdf_for_job(payload),
            starting_message="render-pdf starting",
            progress_message="render-pdf still running",
            activity_name="render_pdf",
        )
        output = RenderPdfActivityOutput(
            status=str(result.get("status") or "ok"),
            rendered=tuple(str(item) for item in result.get("rendered", ())),
            error=str(result.get("error") or ""),
        )
    except JobCtrlError as exc:
        app_error = to_application_error(exc)
        if lifecycle is not None:
            lifecycle.failed_from_exception(
                app_error,
                fallback_error_code="pdf_render_failed",
            )
        raise app_error from exc
    except Exception as exc:
        app_error = to_application_error(exc)
        if lifecycle is not None:
            lifecycle.failed_from_exception(
                app_error,
                fallback_error_code="pdf_render_failed",
            )
        raise app_error from exc
    if lifecycle is not None:
        if output.status == "error":
            lifecycle.failed(
                error_code="pdf_render_failed",
                retryable=False,
                item_count=0,
            )
        else:
            lifecycle.completed(item_count=len(output.rendered))
    return output


def _render_pdf_for_job(payload: RenderPdfActivityInput) -> dict[str, Any]:
    from jobctrl.database import get_connection
    from jobctrl.domain.identifiers import JobId
    from jobctrl.domain.materials.use_cases import RenderPdfUseCase
    from jobctrl.domain.tenant import TenantId
    from jobctrl.infrastructure.materials import (
        HtmlResumePdfAdapter,
        PlaywrightHtmlPdfAdapter,
        SqliteMaterialsRepository,
    )
    from jobctrl.infrastructure.profile import get_profile_repository

    tenant_id = TenantId(payload.tenant_id)
    repository = SqliteMaterialsRepository(get_connection())
    profile = get_profile_repository().load_snapshot(tenant_id)
    outcome = RenderPdfUseCase(
        repository=repository,
        resume_renderer=HtmlResumePdfAdapter(),
        cover_letter_renderer=PlaywrightHtmlPdfAdapter(),
    ).execute(
        job_id=JobId(payload.job_url),
        profile_dict=profile.as_dict(),
        tenant_id=tenant_id,
    )
    return {
        "status": outcome.status,
        "rendered": tuple(item.value for item in outcome.rendered),
        "error": outcome.error,
    }
