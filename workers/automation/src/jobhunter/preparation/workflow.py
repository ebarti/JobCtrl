"""Per-job Temporal workflow for preparation steps."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from temporalio import workflow
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

with workflow.unsafe.imports_passed_through():
    from jobhunter.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )
    from jobhunter.materials.activities import (
        CoverLetterActivityInput,
        RenderPdfActivityInput,
        TailorJobActivityInput,
        cover_letter_activity,
        render_pdf_activity,
        tailor_job_activity,
    )
    from jobhunter.pipeline.workflow import (
        _COVER_RETRY,
        _DEFAULT_HEARTBEAT_TIMEOUT,
        _DEFAULT_TIMEOUT,
        _SCORE_RETRY,
        _TAILOR_RETRY,
    )
    from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
    from jobhunter.scoring.activities import ScoreJobActivityInput, score_job_activity


PREPARATION_STEP_ORDER: tuple[str, ...] = ("score", "tailor", "cover", "pdf")


@dataclass(frozen=True)
class JobPreparationInput:
    tenant_id: str
    job_url: str
    steps: list[str]
    target_version: str
    idempotency_key: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    min_score: int = 7
    workers: int = 1
    validation_mode: str = "normal"
    rescore: bool = False
    retailor: bool = False
    suppress_existing_artifacts: bool = False
    allow_low_fit_override: bool = False
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float | None = None
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class JobPreparationResult:
    steps_completed: list[str] = field(default_factory=list)
    steps_failed: list[str] = field(default_factory=list)
    failure: str | None = None
    error_code: str | None = None


def preparation_workflow_id(idempotency_key: str) -> str:
    return f"prep-{idempotency_key}"


@workflow.defn(name="JobPreparationWorkflow")
class JobPreparationWorkflow:
    """Run score, tailor, cover, and PDF preparation for one job."""

    @workflow.run
    async def run(self, payload: JobPreparationInput) -> JobPreparationResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type="JobPreparationWorkflow",
            input_summary=_input_summary(payload),
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        try:
            result = await self._execute_steps(payload)
        except CancelledError:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="JobPreparationWorkflow",
                status="canceled",
                started_at=started_at,
                error_code="workflow_canceled",
                error_message="Workflow canceled by request.",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise
        except Exception as exc:  # noqa: BLE001
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="JobPreparationWorkflow",
                status="failed",
                started_at=started_at,
                error_code=_exception_error_code(exc) or "workflow_error",
                error_message=str(exc),
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise

        if result.failure:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="JobPreparationWorkflow",
                status="failed",
                started_at=started_at,
                error_code=result.error_code or "preparation_step_failed",
                error_message=result.failure,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
        else:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="JobPreparationWorkflow",
                status="succeeded",
                started_at=started_at,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
        return result

    async def _execute_steps(self, payload: JobPreparationInput) -> JobPreparationResult:
        completed: list[str] = []
        failed: list[str] = []
        failure: str | None = None
        error_code: str | None = None
        for step in _ordered_steps(payload.steps):
            try:
                await _execute_step(step, payload)
            except ActivityError as exc:
                if _activity_error_was_cancelled(exc):
                    raise CancelledError("Workflow canceled by request.") from exc
                failed.append(step)
                error_code = _activity_error_code(exc)
                failure = f"{step}: {exc.cause if exc.cause else exc}"
                break
            completed.append(step)
        return JobPreparationResult(
            steps_completed=completed,
            steps_failed=failed,
            failure=failure,
            error_code=error_code,
        )


async def _execute_step(step: str, payload: JobPreparationInput) -> Any:
    if step == "score":
        return await workflow.execute_activity(
            score_job_activity,
            ScoreJobActivityInput(
                tenant_id=payload.tenant_id,
                job_url=payload.job_url,
                rescore=payload.rescore,
                llm_model=payload.llm_model,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_SCORE_RETRY,
        )
    if step == "tailor":
        return await workflow.execute_activity(
            tailor_job_activity,
            TailorJobActivityInput(
                tenant_id=payload.tenant_id,
                job_url=payload.job_url,
                min_score=payload.min_score,
                workers=payload.workers,
                validation_mode=payload.validation_mode,
                retailor=payload.retailor,
                suppress_existing_artifacts=payload.suppress_existing_artifacts,
                allow_low_fit_override=payload.allow_low_fit_override,
                tailor_models=payload.tailor_models,
                tailor_judge_model=payload.tailor_judge_model,
                tailor_judge_min_score=payload.tailor_judge_min_score,
                llm_model=payload.llm_model,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_TAILOR_RETRY,
        )
    if step == "cover":
        return await workflow.execute_activity(
            cover_letter_activity,
            CoverLetterActivityInput(
                tenant_id=payload.tenant_id,
                job_url=payload.job_url,
                min_score=payload.min_score,
                validation_mode=payload.validation_mode,
                llm_model=payload.llm_model,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_COVER_RETRY,
        )
    if step == "pdf":
        return await workflow.execute_activity(
            render_pdf_activity,
            RenderPdfActivityInput(tenant_id=payload.tenant_id, job_url=payload.job_url),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_COVER_RETRY,
        )
    raise ApplicationError(f"Unknown preparation step: {step}", non_retryable=True)


def _ordered_steps(steps: list[str]) -> list[str]:
    requested = {str(step) for step in steps}
    invalid = requested.difference(PREPARATION_STEP_ORDER)
    if invalid:
        raise ApplicationError(
            f"Unknown preparation step(s): {', '.join(sorted(invalid))}",
            non_retryable=True,
        )
    return [step for step in PREPARATION_STEP_ORDER if step in requested]


def _input_summary(payload: JobPreparationInput) -> dict[str, Any]:
    return {
        "jobUrl": payload.job_url,
        "steps": list(payload.steps),
        "targetVersion": payload.target_version,
        "idempotencyKey": payload.idempotency_key,
    }


def _activity_error_code(exc: ActivityError) -> str | None:
    cause = exc.cause
    if isinstance(cause, ApplicationError):
        return cause.type or None
    return None


def _exception_error_code(exc: Exception) -> str | None:
    if isinstance(exc, ActivityError):
        return _activity_error_code(exc)
    if isinstance(exc, ApplicationError):
        return exc.type or None
    return None


def _activity_error_was_cancelled(exc: ActivityError) -> bool:
    cause: BaseException | None = exc
    seen: set[int] = set()
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        if isinstance(cause, CancelledError):
            return True
        nested = getattr(cause, "cause", None) or getattr(cause, "__cause__", None)
        cause = nested if isinstance(nested, BaseException) else None
    return False
