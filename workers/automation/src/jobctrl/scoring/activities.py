"""Temporal activity for the scoring stage."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, replace
import threading
import time
from typing import Any

from temporalio import activity

from jobctrl.domain.errors import JobCtrlError, LlmTransientError, to_application_error
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class ScoreActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    limit: int = 0
    workers: int = 1
    dry_run: bool = False
    rescore: bool = False
    job_ids: tuple[JobId, ...] = ()
    current_policy_only: bool = False
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    workflow_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_ids", _canonical_job_ids(self.job_ids))


@dataclass(frozen=True)
class ScoreActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class ScoreJobActivityInput:
    tenant_id: str
    job_id: JobId
    rescore: bool = False
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))


@dataclass(frozen=True)
class ScoreJobActivityOutput:
    status: str
    score_version: int | None = None
    error: str = ""


@activity.defn(name="score")
async def score_activity(payload: ScoreActivityInput) -> ScoreActivityOutput:
    """Run the scoring stage."""
    from jobctrl.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobctrl.pipeline.runner import _run_score, _run_stage_observed

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    if activity.info().attempt > 1 and payload.workflow_id:
        from jobctrl.database import get_connection
        from jobctrl.infrastructure.preparation_recovery import (
            RecoverPreparationStateInput,
            recover_preparation_state_rows,
        )

        recover_preparation_state_rows(
            get_connection(),
            RecoverPreparationStateInput(
                tenant_id=payload.tenant_id,
                workflow_id=payload.workflow_id,
                stage="score",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            ),
        )

    cancel_event = threading.Event()
    try:
        if payload.current_policy_only:
            result = await run_blocking_with_heartbeat(
                lambda: _run_current_policy_scores(payload, cancel_event=cancel_event),
                starting_message="current-policy score starting",
                progress_message="current-policy score still running",
                on_cancel=cancel_event.set,
                activity_name="score",
            )
            _raise_on_failure("score", result, LlmTransientError)
            return ScoreActivityOutput(
                status=str(result["status"]),
                elapsed=float(result["elapsed"]),
                errors=dict(result["errors"]),
                stages=list(result["stages"]),
            )

        if payload.job_ids:
            result = await run_blocking_with_heartbeat(
                lambda: _run_selected_scores(payload, cancel_event=cancel_event),
                starting_message="selected score starting",
                progress_message="selected score still running",
                on_cancel=cancel_event.set,
                activity_name="score",
            )
            _raise_on_failure("score", result, LlmTransientError)
            return ScoreActivityOutput(
                status=str(result["status"]),
                elapsed=float(result["elapsed"]),
                errors=dict(result["errors"]),
                stages=list(result["stages"]),
            )

        if payload.dry_run:
            return ScoreActivityOutput(
                status="ok",
                elapsed=0.0,
                errors={},
                stages=[
                    {
                        "stage": "score",
                        "status": "ok",
                        "elapsed": 0.0,
                        "dry_run": True,
                    }
                ],
            )

        result = await run_blocking_with_heartbeat(
            lambda: _run_stage_observed(
                "score",
                _run_score,
                {
                    "workers": payload.workers,
                    "limit": payload.limit,
                    "rescore": payload.rescore,
                    "llm_model": payload.llm_model,
                    "cancel_event": cancel_event,
                    "workflow_id": payload.workflow_id,
                },
                mode="workflow",
                pass_number=1,
            ),
            starting_message="score starting",
            progress_message="score still running",
            on_cancel=cancel_event.set,
            activity_name="score",
        )
        stage_result, elapsed, status = result
        errors: dict[str, str] = {}
        if status not in _SUCCESS_STATUSES:
            errors["score"] = str(stage_result.get("error") or stage_result.get("error_message") or status)
        stages = [{"stage": "score", "status": status, "elapsed": elapsed, **stage_result}]
        activity_result = {
            "status": status,
            "elapsed": float(elapsed),
            "errors": errors,
            "stages": stages,
        }
        _raise_on_failure("score", activity_result, LlmTransientError)
        return ScoreActivityOutput(
            status=status,
            elapsed=float(elapsed),
            errors=errors,
            stages=stages,
        )
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


def _run_current_policy_scores(
    payload: ScoreActivityInput,
    *,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    from jobctrl.database import get_connection
    from jobctrl.pipeline.current_policy_selectors import scoring_current_policy_job_ids

    job_ids = scoring_current_policy_job_ids(
        get_connection(),
        tenant_id=payload.tenant_id,
        limit=payload.limit,
        job_ids=payload.job_ids,
    )
    return _run_selected_scores(replace(payload, job_ids=job_ids, limit=0), cancel_event=cancel_event)


def _run_selected_scores(
    payload: ScoreActivityInput,
    *,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    from jobctrl.domain.tenant import TenantId
    from jobctrl.scoring.scorer import score_job_by_id

    job_ids = _limited_job_ids(payload.job_ids, payload.limit)
    if payload.dry_run:
        return {
            "status": "ok",
            "elapsed": 0.0,
            "errors": {},
            "stages": [
                {
                    "stage": "score",
                    "status": "ok",
                    "elapsed": 0.0,
                    "selected": len(job_ids),
                    "dry_run": True,
                }
            ],
        }

    t0 = time.time()
    errors: dict[str, str] = {}
    scored = 0

    def score_one(job_id: JobId):
        if cancel_event is not None and cancel_event.is_set():
            raise LlmTransientError("score activity canceled")
        return job_id, score_job_by_id(
            job_id,
            tenant_id=TenantId(payload.tenant_id),
            rescore=payload.rescore,
            llm_model=payload.llm_model,
            workflow_id=payload.workflow_id,
        )

    worker_count = max(1, int(payload.workers or 1))
    if worker_count == 1 or len(job_ids) <= 1:
        results = [score_one(job_id) for job_id in job_ids]
    else:
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = [executor.submit(score_one, job_id) for job_id in job_ids]
            results = [future.result() for future in as_completed(futures)]

    for job_id, outcome in results:
        if cancel_event is not None and cancel_event.is_set():
            raise LlmTransientError("score activity canceled")
        if outcome.ok:
            scored += 1
        else:
            errors[str(job_id)] = outcome.error or "Scoring failed"

    elapsed = time.time() - t0
    status = "failed" if errors else "ok"
    return {
        "status": status,
        "elapsed": elapsed,
        "errors": errors,
        "stages": [
            {
                "stage": "score",
                "status": status,
                "elapsed": elapsed,
                "selected": len(job_ids),
                "scored": scored,
            }
        ],
    }


def _limited_job_ids(job_ids: tuple[JobId, ...], limit: int) -> tuple[JobId, ...]:
    unique = tuple(dict.fromkeys(job_ids))
    if limit > 0:
        return unique[:limit]
    return unique


def _canonical_job_ids(job_ids: tuple[JobId, ...]) -> tuple[JobId, ...]:
    return tuple(dict.fromkeys(canonical_job_id(str(job_id)) for job_id in job_ids))


_SUCCESS_STATUSES = {"ok", "partial", "skipped", "already_done"}


def _raise_on_failure(stage: str, result: dict[str, Any], error_type: type[JobCtrlError]) -> None:
    errors = result.get("errors") or {}
    status = str(result.get("status") or "ok").lower()
    if errors or status not in _SUCCESS_STATUSES:
        detail = errors or result.get("error") or result.get("status") or "stage failed"
        raise error_type(f"{stage} failed: {detail}")


@activity.defn(name="score_job")
async def score_job_activity(payload: ScoreJobActivityInput) -> ScoreJobActivityOutput:
    """Score one canonical JobId for ``JobPreparationWorkflow``."""
    from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat

    workflow_id = str(activity.info().workflow_run_id or activity.info().workflow_id)
    if activity.info().attempt > 1:
        from jobctrl.database import get_connection
        from jobctrl.infrastructure.preparation_recovery import (
            RecoverPreparationStateInput,
            recover_preparation_state_rows,
        )

        recover_preparation_state_rows(
            get_connection(),
            RecoverPreparationStateInput(
                tenant_id=payload.tenant_id,
                workflow_id=workflow_id,
                stage="score",
            ),
        )
    try:
        result = await run_blocking_with_heartbeat(
            lambda: _score_one_job(payload, workflow_id=workflow_id),
            starting_message="score-job starting",
            progress_message="score-job still running",
            activity_name="score_job",
        )
        status = str(result.get("status") or "ok")
        if status != "ok":
            raise LlmTransientError(str(result.get("error") or "scoring failed"))
        return ScoreJobActivityOutput(
            status=status,
            score_version=result.get("score_version"),
            error=str(result.get("error") or ""),
        )
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


def _score_one_job(
    payload: ScoreJobActivityInput,
    *,
    workflow_id: str | None = None,
) -> dict[str, Any]:
    from jobctrl.domain.errors import MissingInputError
    from jobctrl.domain.tenant import TenantId
    from jobctrl.scoring.scorer import score_job_by_id

    outcome = score_job_by_id(
        payload.job_id,
        tenant_id=TenantId(payload.tenant_id),
        rescore=payload.rescore,
        llm_model=payload.llm_model,
        workflow_id=workflow_id,
    )
    if outcome.ok:
        return {
            "status": "ok",
            "score_version": outcome.score.version if outcome.score is not None else None,
        }
    error = outcome.error or "scoring failed"
    if "not found" in error.lower() or "not enriched" in error.lower():
        raise MissingInputError(error)
    return {"status": "failed", "error": error}
