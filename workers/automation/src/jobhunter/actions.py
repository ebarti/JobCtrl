"""Structured local action entrypoints for JobHunter automation.

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

from jobhunter import config
from jobhunter.database import get_connection, init_db
from jobhunter.infrastructure.profile import get_profile_repository
from jobhunter.pipeline import STAGE_ORDER, run_pipeline
from jobhunter.state import record_job_event, utc_now

ACTION_STAGES: tuple[str, ...] = (*STAGE_ORDER, "apply", "profile_import")


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
    model: str = "haiku"
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

        if request.dry_run:
            return _finish_action(
                request,
                action_id,
                started_at,
                start,
                ok=True,
                status="dry_run",
                result={"planned": _describe_action(request)},
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
        )
    )


def _bootstrap_runtime() -> None:
    config.load_env()
    config.ensure_dirs()
    init_db()


def _execute_action(request: LocalActionRequest) -> dict[str, Any]:
    if request.stage in STAGE_ORDER:
        return run_pipeline(
            stages=[request.stage],
            min_score=request.min_score,
            dry_run=False,
            workers=request.workers,
            validation_mode=request.validation_mode,
            limit=request.limit,
            rescore=request.rescore,
            retailor=request.retailor,
        )
    if request.stage == "apply":
        from jobhunter.apply.launcher import main as apply_main

        applied, failed = apply_main(
            limit=_effective_apply_limit(request),
            target_url=request.job_url,
            min_score=request.min_score,
            headless=request.headless,
            model=request.model,
            dry_run=False,
            continuous=request.continuous,
            workers=request.workers,
        )
        return {"status": "ok" if failed == 0 else "failed", "applied": applied, "failed": failed}
    if request.stage == "profile_import":
        if not request.pdf_path:
            raise ValueError("profile_import requires pdf_path.")
        from jobhunter.domain.profile.use_cases import ImportProfileUseCase

        pdf_path = Path(request.pdf_path).expanduser()
        use_case = ImportProfileUseCase(repository=get_profile_repository())
        result = use_case(pdf_path.read_bytes(), filename=pdf_path.name)
        draft: dict[str, Any] = {"source": result.source}
        if request.import_profile:
            draft["profile"] = result.profile
        if request.import_style:
            draft["style"] = result.style
        return {"status": "ok", "draft": draft}
    raise ValueError(f"Unknown action stage: {request.stage}")


def _action_succeeded(result: dict[str, Any]) -> bool:
    if result.get("errors"):
        return False
    if int(result.get("failed") or 0) > 0:
        return False
    status = str(result.get("status") or "ok").lower()
    return not status.startswith("error") and status not in {"failed", "failure"}


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


def _describe_action(request: LocalActionRequest) -> dict[str, Any]:
    planned = asdict(request)
    if request.stage == "apply":
        planned["effective_limit"] = _effective_apply_limit(request)
    return planned
