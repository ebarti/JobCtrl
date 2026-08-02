"""Temporal workflow for one-shot Interview Preparation generation."""

from __future__ import annotations

from dataclasses import dataclass, field

from temporalio import workflow
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

from jobctrl.domain.identifiers import JobId, canonical_job_id

with workflow.unsafe.imports_passed_through():
    from jobctrl.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )
    from jobctrl.interview.activities import (
        GenerateInterviewPrepActivityInput,
        GenerateInterviewPrepActivityOutput,
        generate_interview_prep_activity,
    )
    from jobctrl.llm import SpendBudgetInput, check_spend_budget
    from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
    from jobctrl.pipeline.workflow import (
        _DEFAULT_HEARTBEAT_TIMEOUT,
        _DEFAULT_TIMEOUT,
        _TAILOR_RETRY,
    )


@dataclass(frozen=True)
class InterviewPrepWorkflowInput:
    tenant_id: str
    job_id: JobId
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))


@dataclass(frozen=True)
class InterviewPrepWorkflowResult:
    status: str
    job_id: JobId
    generation: int = 0
    item_count: int = 0
    errors: list[str] = field(default_factory=list)
    failure: str | None = None
    error_code: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))


@workflow.defn(name="InterviewPrepWorkflow")
class InterviewPrepWorkflow:
    """Run user-triggered interview prep generation for one job."""

    @workflow.run
    async def run(self, payload: InterviewPrepWorkflowInput) -> InterviewPrepWorkflowResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type="InterviewPrepWorkflow",
            input_summary={"jobId": str(payload.job_id)},
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        try:
            await workflow.execute_activity(
                check_spend_budget,
                SpendBudgetInput(tenant_id=payload.tenant_id),
                start_to_close_timeout=_DEFAULT_TIMEOUT,
                heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
                retry_policy=_TAILOR_RETRY,
            )
            output = await workflow.execute_activity(
                generate_interview_prep_activity,
                GenerateInterviewPrepActivityInput(
                    tenant_id=payload.tenant_id,
                    job_id=payload.job_id,
                    llm_model=payload.llm_model,
                ),
                start_to_close_timeout=_DEFAULT_TIMEOUT,
                heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
                retry_policy=_TAILOR_RETRY,
            )
        except CancelledError:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="InterviewPrepWorkflow",
                status="canceled",
                started_at=started_at,
                error_code="workflow_canceled",
                error_message="Workflow canceled by request.",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise
        except ActivityError as exc:
            result = InterviewPrepWorkflowResult(
                status="failed",
                job_id=payload.job_id,
                failure=str(exc.cause if exc.cause else exc),
                error_code=_activity_error_code(exc) or "interview_prep_activity_failed",
            )
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="InterviewPrepWorkflow",
                status="failed",
                started_at=started_at,
                error_code=result.error_code,
                error_message=result.failure,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            return result
        except Exception as exc:  # noqa: BLE001
            result = InterviewPrepWorkflowResult(
                status="failed",
                job_id=payload.job_id,
                failure=str(exc),
                error_code=_exception_error_code(exc) or "interview_prep_workflow_failed",
            )
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="InterviewPrepWorkflow",
                status="failed",
                started_at=started_at,
                error_code=result.error_code,
                error_message=result.failure,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            return result

        result = _output_to_result(output)
        await emit_workflow_outcome(
            tenant_id=payload.tenant_id,
            workflow_type="InterviewPrepWorkflow",
            status="succeeded" if result.status == "accepted" else "failed",
            started_at=started_at,
            error_code=None if result.status == "accepted" else "interview_prep_rejected",
            error_message=None if result.status == "accepted" else "; ".join(result.errors),
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        return result


def _output_to_result(output: GenerateInterviewPrepActivityOutput) -> InterviewPrepWorkflowResult:
    return InterviewPrepWorkflowResult(
        status=output.status,
        job_id=output.job_id,
        generation=output.generation,
        item_count=output.item_count,
        errors=list(output.errors),
    )


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


__all__ = [
    "InterviewPrepWorkflow",
    "InterviewPrepWorkflowInput",
    "InterviewPrepWorkflowResult",
]
