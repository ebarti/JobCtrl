"""Structured local action entrypoints for JobCtl automation.

These wrappers give API/UI callers one local surface for invoking existing
Python automation without pasting shell commands. They intentionally delegate to
the current stage implementations; later phases can replace the internals with
queue-backed workers without changing the caller contract.
"""

from __future__ import annotations

import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Any
from uuid import uuid4

from jobctl import config
from jobctl.database import get_connection, init_db
from jobctl.operational_metrics import record_operational_attempt_metric
from jobctl.pipeline import SUPPORTED_STAGE_ORDER
from jobctl.state import record_job_event, utc_now
from jobctl.workflow_specs import (
    build_apply_workflow_spec,
    build_profile_import_workflow_spec,
    build_run_stage_workflow_spec,
    start_workflow_spec_and_wait_sync,
    workflow_result_to_dict,
)

INTERNAL_PIPELINE_ACTION_STAGES: tuple[str, ...] = (*SUPPORTED_STAGE_ORDER, "enrich")
ACTION_STAGES: tuple[str, ...] = (*INTERNAL_PIPELINE_ACTION_STAGES, "apply", "profile_import")


@dataclass(frozen=True)
class LocalActionRequest:
    """Input for a local automation action."""

    stage: str
    job_url: str | None = None
    limit: int = 0
    workers: int = 1
    min_score: int = 7
    validation_mode: str = "normal"
    dry_run: bool = False
    rescore: bool = False
    retailor: bool = False
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float | None = None
    model: str = "default"
    headless: bool = False
    continuous: bool = False
    pdf_path: str | None = None
    import_profile: bool = True
    import_style: bool = True


@dataclass(frozen=True)
class LocalActionResult:
    """Structured result returned by every local action wrapper."""

    ok: bool
    action_id: str
    stage: str
    status: str
    started_at: str
    finished_at: str
    duration_ms: int
    job_url: str | None = None
    dry_run: bool = False
    result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    traceback: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def run_local_action(request: LocalActionRequest) -> LocalActionResult:
    """Run one structured local action and record start/finish events."""
    action_id = f"act-{uuid4().hex}"
    started_at = utc_now()
    start = perf_counter()

    if request.stage not in ACTION_STAGES:
        return LocalActionResult(
            ok=False,
            action_id=action_id,
            stage=request.stage,
            status="failed",
            started_at=started_at,
            finished_at=utc_now(),
            duration_ms=int((perf_counter() - start) * 1000),
            job_url=request.job_url,
            dry_run=request.dry_run,
            error=f"Unknown action stage: {request.stage}",
        )

    try:
        _bootstrap_runtime()
        _record_action_event(
            request,
            "ActionStarted",
            "info",
            f"{request.stage} action started",
            {"action_id": action_id, "dry_run": request.dry_run},
        )

        if request.stage == "profile_import" and request.dry_run:
            result = {"planned": _describe_action(request)}
            return _finish_action(
                request,
                action_id,
                started_at,
                start,
                ok=True,
                status="dry_run",
                result=result,
            )

        result = _execute_action(request)
        ok = _action_succeeded(result)
        status = "succeeded" if ok else "failed"
        return _finish_action(request, action_id, started_at, start, ok=ok, status=status, result=result)
    except Exception as exc:  # noqa: BLE001 - action API must return structured failure
        return _finish_action(
            request,
            action_id,
            started_at,
            start,
            ok=False,
            status="failed",
            result={},
            error=str(exc),
            traceback_text=traceback.format_exc(),
        )


def run_stage_action(
    stage: str,
    *,
    job_url: str | None = None,
    limit: int = 0,
    workers: int = 1,
    min_score: int = 7,
    validation_mode: str = "normal",
    dry_run: bool = False,
    rescore: bool = False,
    retailor: bool = False,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
) -> LocalActionResult:
    """Convenience entrypoint for a pipeline stage action."""
    return run_local_action(
        LocalActionRequest(
            stage=stage,
            job_url=job_url,
            limit=limit,
            workers=workers,
            min_score=min_score,
            validation_mode=validation_mode,
            dry_run=dry_run,
            rescore=rescore,
            retailor=retailor,
            tailor_models=tailor_models,
            tailor_judge_model=tailor_judge_model,
            tailor_judge_min_score=tailor_judge_min_score,
        )
    )


def _bootstrap_runtime() -> None:
    config.load_env()
    config.ensure_dirs()
    init_db()


def _execute_action(request: LocalActionRequest) -> dict[str, Any]:
    if request.stage in INTERNAL_PIPELINE_ACTION_STAGES:
        return _start_and_wait(
            build_run_stage_workflow_spec(
                {
                    "tenantId": "local",
                    "stage": request.stage,
                    "minScore": request.min_score,
                    "dryRun": request.dry_run,
                    "workers": request.workers,
                    "validationMode": request.validation_mode,
                    "limit": request.limit,
                    "rescore": request.rescore,
                    "retailor": request.retailor,
                    "tailorModels": request.tailor_models,
                    "tailorJudgeModel": request.tailor_judge_model,
                    "tailorJudgeMinScore": request.tailor_judge_min_score,
                }
            )
        )
    if request.stage == "apply":
        return _start_and_wait(
            build_apply_workflow_spec(
                {
                    "tenantId": "local",
                    "jobUrl": request.job_url,
                    "limit": _effective_apply_limit(request),
                    "minScore": request.min_score,
                    "headless": request.headless,
                    "model": request.model,
                    "dryRun": request.dry_run,
                    "continuous": request.continuous,
                    "workers": request.workers,
                }
            )
        )
    if request.stage == "profile_import":
        if not request.pdf_path:
            raise ValueError("profile_import requires pdf_path.")
        return _start_and_wait(
            build_profile_import_workflow_spec(
                {
                    "tenantId": "local",
                    "pdfPath": str(Path(request.pdf_path).expanduser()),
                    "importProfile": request.import_profile,
                    "importStyle": request.import_style,
                }
            )
        )
    raise ValueError(f"Unknown action stage: {request.stage}")


def _start_and_wait(spec) -> dict[str, Any]:
    started = start_workflow_spec_and_wait_sync(spec)
    result = workflow_result_to_dict(started.result)
    return {
        "status": _workflow_status(result),
        "runId": started.run_id,
        "workflowId": started.workflow_id,
        "firstExecutionRunId": started.first_execution_run_id,
        **(result if isinstance(result, dict) else {"result": result}),
    }


def _action_succeeded(result: dict[str, Any]) -> bool:
    if result.get("errors"):
        return False
    if int(result.get("failed") or 0) > 0:
        return False
    if result.get("failure") or result.get("error"):
        return False
    if result.get("ok") is False:
        return False
    status = str(result.get("status") or "ok").lower()
    return not status.startswith("error") and status not in {"failed", "failure"}


def _workflow_status(result: Any) -> str:
    if isinstance(result, dict):
        if result.get("failure") or result.get("error") or result.get("ok") is False:
            return "failed"
        return str(result.get("status") or "succeeded")
    return "succeeded"


def _effective_apply_limit(request: LocalActionRequest) -> int:
    return 0 if request.continuous else max(1, request.limit)


def _finish_action(
    request: LocalActionRequest,
    action_id: str,
    started_at: str,
    start: float,
    *,
    ok: bool,
    status: str,
    result: dict[str, Any],
    error: str | None = None,
    traceback_text: str | None = None,
) -> LocalActionResult:
    finished_at = utc_now()
    duration_ms = int((perf_counter() - start) * 1000)
    try:
        _record_action_event(
            request,
            "ActionSucceeded" if ok else "ActionFailed",
            "info" if ok else "error",
            f"{request.stage} action {status}",
            {
                "action_id": action_id,
                "duration_ms": duration_ms,
                "error": error,
            },
        )
        if request.dry_run:
            _record_dry_run_metric(request, action_id, duration_ms)
    except Exception:  # noqa: BLE001 - action results must stay JSON-safe when event logging fails
        pass
    return LocalActionResult(
        ok=ok,
        action_id=action_id,
        stage=request.stage,
        status=status,
        started_at=started_at,
        finished_at=finished_at,
        duration_ms=duration_ms,
        job_url=request.job_url,
        dry_run=request.dry_run,
        result=result,
        error=error,
        traceback=traceback_text,
    )


def _record_action_event(
    request: LocalActionRequest,
    event_type: str,
    level: str,
    message: str,
    payload: dict[str, Any],
) -> None:
    conn = get_connection()
    record_job_event(
        conn,
        request.job_url,
        request.stage,
        event_type,
        level=level,
        message=message,
        payload=payload,
    )
    conn.commit()


def _record_dry_run_metric(request: LocalActionRequest, action_id: str, duration_ms: int) -> None:
    conn = get_connection()
    record_operational_attempt_metric(
        conn,
        stage=request.stage,
        attempt_kind="local_action",
        outcome="dry_run",
        adapter="api",
        run_id=action_id,
        job_url=request.job_url,
        duration_ms=duration_ms,
        metadata={
            "workers": request.workers,
            "limit": request.limit,
            "rescore": request.rescore,
            "retailor": request.retailor,
            "tailor_models": list(request.tailor_models),
            "tailor_judge_model": request.tailor_judge_model,
            "tailor_judge_min_score": request.tailor_judge_min_score,
        },
    )
    conn.commit()


def _describe_action(request: LocalActionRequest) -> dict[str, Any]:
    planned = asdict(request)
    if request.stage == "apply":
        planned["effective_limit"] = _effective_apply_limit(request)
    return planned
