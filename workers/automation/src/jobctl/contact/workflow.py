"""Temporal workflow for one supervised contact-research run.

Deterministic id ``contact-research-{task_id}``. Modelled on
``InterviewPrepWorkflow``: emit lifecycle, run the shared LLM spend preflight
(§5.4 — the existing ``check_spend_budget`` activity + ``dailyBudgetUsd``; no
second spend system), then the single research activity that fetches only
policy-permitted sources through the merged politeness gateway and proposes
candidates in ``needs_review`` (INV-4). Automation is off by default — this
workflow only runs when the user starts it.
"""

from __future__ import annotations

from dataclasses import dataclass

from temporalio import workflow
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

with workflow.unsafe.imports_passed_through():
    from jobctl.contact.activities import (
        RunContactResearchActivityInput,
        RunContactResearchActivityOutput,
        ResearchSourceInput,
        run_contact_research_activity,
    )
    from jobctl.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )
    from jobctl.llm import SpendBudgetInput, check_spend_budget
    from jobctl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
    from jobctl.pipeline.workflow import (
        _DEFAULT_HEARTBEAT_TIMEOUT,
        _DEFAULT_TIMEOUT,
        _TAILOR_RETRY,
    )


@dataclass(frozen=True)
class ContactResearchWorkflowInput:
    tenant_id: str
    task_id: str
    employer: str | None = None
    job_url: str | None = None
    sources: tuple[ResearchSourceInput, ...] = ()
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    expected_app_dir: str | None = None
    expected_db_path: str | None = None


@dataclass(frozen=True)
class ContactResearchWorkflowResult:
    task_id: str
    status: str
    candidate_count: int = 0
    attempt_count: int = 0
    failure: str | None = None
    error_code: str | None = None


def contact_research_workflow_id(task_id: str) -> str:
    return f"contact-research-{task_id}"


@workflow.defn(name="ContactResearchWorkflow")
class ContactResearchWorkflow:
    """Run one supervised contact-research task for a company/application."""

    @workflow.run
    async def run(
        self, payload: ContactResearchWorkflowInput
    ) -> ContactResearchWorkflowResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type="ContactResearchWorkflow",
            input_summary={
                "taskId": payload.task_id,
                "employer": payload.employer,
                "jobUrl": payload.job_url,
                "sourceCount": len(payload.sources),
            },
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
                run_contact_research_activity,
                RunContactResearchActivityInput(
                    tenant_id=payload.tenant_id,
                    task_id=payload.task_id,
                    employer=payload.employer,
                    job_url=payload.job_url,
                    sources=payload.sources,
                    llm_model=payload.llm_model,
                    expected_app_dir=payload.expected_app_dir,
                    expected_db_path=payload.expected_db_path,
                ),
                start_to_close_timeout=_DEFAULT_TIMEOUT,
                heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
                retry_policy=_TAILOR_RETRY,
            )
        except CancelledError:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="ContactResearchWorkflow",
                status="canceled",
                started_at=started_at,
                error_code="workflow_canceled",
                error_message="Workflow canceled by request.",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise
        except ActivityError as exc:
            result = ContactResearchWorkflowResult(
                task_id=payload.task_id,
                status="failed",
                failure=str(exc.cause if exc.cause else exc),
                error_code=_activity_error_code(exc) or "contact_research_activity_failed",
            )
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="ContactResearchWorkflow",
                status="failed",
                started_at=started_at,
                error_code=result.error_code,
                error_message=result.failure,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            return result
        except Exception as exc:  # noqa: BLE001
            result = ContactResearchWorkflowResult(
                task_id=payload.task_id,
                status="failed",
                failure=str(exc),
                error_code=_exception_error_code(exc) or "contact_research_workflow_failed",
            )
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="ContactResearchWorkflow",
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
            workflow_type="ContactResearchWorkflow",
            status="succeeded",
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        return result


def _output_to_result(
    output: RunContactResearchActivityOutput,
) -> ContactResearchWorkflowResult:
    return ContactResearchWorkflowResult(
        task_id=output.task_id,
        status=output.status,
        candidate_count=output.candidate_count,
        attempt_count=output.attempt_count,
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
    "ContactResearchWorkflow",
    "ContactResearchWorkflowInput",
    "ContactResearchWorkflowResult",
    "contact_research_workflow_id",
]
