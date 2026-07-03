"""Temporal activities for the materials-generation stages (tailor / cover)."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import threading
import time
from typing import Any

from temporalio import activity

from jobhunter.domain.errors import JobHunterError, LlmTransientError, to_application_error
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


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


@activity.defn(name="tailor")
async def tailor_activity(payload: TailorActivityInput) -> TailorActivityOutput:
    """Run the tailor stage via ``run_pipeline``."""
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.pipeline import run_pipeline

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

        def _do() -> dict[str, Any]:
            return run_pipeline(
                stages=["tailor"],
                min_score=payload.min_score,
                workers=payload.workers,
                validation_mode=payload.validation_mode,
                limit=payload.limit,
                dry_run=payload.dry_run,
                retailor=payload.retailor,
                tailor_models=payload.tailor_models,
                tailor_judge_model=payload.tailor_judge_model,
                tailor_judge_min_score=payload.tailor_judge_min_score,
                llm_model=payload.llm_model,
                workflow_id=payload.workflow_id,
                cancel_event=cancel_event,
            )

        result = await run_blocking_with_heartbeat(
            _do,
            starting_message="tailor starting",
            progress_message="tailor still running",
            on_cancel=cancel_event.set,
            activity_name="tailor",
        )
        stages = list(result.get("stages") or [])
        errors = dict(result.get("errors") or {})
        status = stages[0]["status"] if stages else ("failed" if errors else "ok")
        activity_result = {
            "status": status,
            "elapsed": float(result.get("elapsed") or 0.0),
            "errors": errors,
            "stages": stages,
        }
        _raise_on_failure("tailor", activity_result, LlmTransientError)
        return TailorActivityOutput(
            status=status,
            elapsed=float(result.get("elapsed") or 0.0),
            errors=errors,
            stages=stages,
        )
    except JobHunterError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


def _run_current_policy_tailoring(
    payload: TailorActivityInput,
    *,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    from jobhunter.database import get_connection
    from jobhunter.pipeline.current_policy_selectors import tailoring_current_policy_job_urls

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
    from jobhunter.domain.tenant import TenantId
    from jobhunter.scoring.tailor import tailor_job_by_url

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


@activity.defn(name="cover")
async def cover_activity(payload: CoverActivityInput) -> CoverActivityOutput:
    """Run the cover-letter stage via ``run_pipeline``."""
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.pipeline import run_pipeline

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

        def _do() -> dict[str, Any]:
            return run_pipeline(
                stages=["cover"],
                min_score=payload.min_score,
                validation_mode=payload.validation_mode,
                limit=payload.limit,
                dry_run=payload.dry_run,
                llm_model=payload.llm_model,
                workflow_id=payload.workflow_id,
                cancel_event=cancel_event,
            )

        result = await run_blocking_with_heartbeat(
            _do,
            starting_message="cover starting",
            progress_message="cover still running",
            on_cancel=cancel_event.set,
            activity_name="cover",
        )
        stages = list(result.get("stages") or [])
        errors = dict(result.get("errors") or {})
        status = stages[0]["status"] if stages else ("failed" if errors else "ok")
        activity_result = {
            "status": status,
            "elapsed": float(result.get("elapsed") or 0.0),
            "errors": errors,
            "stages": stages,
        }
        _raise_on_failure("cover", activity_result, LlmTransientError)
        return CoverActivityOutput(
            status=status,
            elapsed=float(result.get("elapsed") or 0.0),
            errors=errors,
            stages=stages,
        )
    except JobHunterError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


def _run_selected_cover(
    payload: CoverActivityInput,
    *,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    from jobhunter.scoring.cover_letter import run_cover_letters

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
    if cancel_event is not None and cancel_event.is_set():
        raise LlmTransientError("cover activity canceled")
    result = run_cover_letters(
        min_score=payload.min_score,
        limit=payload.limit,
        validation_mode=payload.validation_mode,
        llm_model=payload.llm_model,
        job_urls=urls,
    )
    elapsed = float(result.get("elapsed") or (time.time() - t0))
    error_count = int(result.get("errors") or 0)
    errors = {"cover": f"{error_count} cover letter error(s)"} if error_count > 0 else {}
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
                **result,
            }
        ],
    }


_SUCCESS_STATUSES = {"ok", "partial", "skipped", "already_done"}


def _raise_on_failure(stage: str, result: dict[str, Any], error_type: type[JobHunterError]) -> None:
    errors = result.get("errors") or {}
    status = str(result.get("status") or "ok").lower()
    if errors or status not in _SUCCESS_STATUSES:
        detail = errors or result.get("error") or result.get("status") or "stage failed"
        raise error_type(f"{stage} failed: {detail}")
