"""Temporal workflow for compensation refresh."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

with workflow.unsafe.imports_passed_through():
    from jobctrl.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )
    from jobctrl.llm import SpendBudgetInput, check_spend_budget


@dataclass(frozen=True)
class CompensationRefreshWorkflowInput:
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    job_url: str | None = None
    limit: int = 0
    observations_json_path: str | None = None
    include_euro_top_tech: bool = True
    euro_top_tech_max_pages: int = 10


@dataclass(frozen=True)
class CompensationRefreshWorkflowResult:
    status: str
    result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    error_code: str | None = None


_COMPENSATION_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=5),
    maximum_interval=timedelta(minutes=1),
    maximum_attempts=2,
    non_retryable_error_types=["configuration", "authentication", "missing_input", "budget_exceeded"],
)
_DEFAULT_TIMEOUT = timedelta(minutes=20)


@activity.defn(name="refresh_compensation")
async def refresh_compensation_activity(
    payload: CompensationRefreshWorkflowInput,
) -> dict[str, Any]:
    from jobctrl.domain.errors import JobCtrlError, MissingInputError, to_application_error
    from jobctrl.infrastructure.compensation.refresh import refresh_compensation_facts
    from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )
    try:
        return await run_blocking_with_heartbeat(
            lambda: refresh_compensation_facts(
                tenant_id=payload.tenant_id,
                job_url=payload.job_url,
                limit=payload.limit,
                observations_json_path=payload.observations_json_path,
                include_euro_top_tech=payload.include_euro_top_tech,
                euro_top_tech_max_pages=payload.euro_top_tech_max_pages,
            ),
            starting_message="refresh-compensation starting",
            progress_message="refresh-compensation still running",
            activity_name="refresh_compensation",
        )
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except ValueError as exc:
        raise to_application_error(MissingInputError(str(exc))) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


@workflow.defn(name="CompensationRefreshWorkflow")
class CompensationRefreshWorkflow:
    """Refresh compensation facts and estimates through Temporal."""

    @workflow.run
    async def run(
        self, payload: CompensationRefreshWorkflowInput
    ) -> CompensationRefreshWorkflowResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type="CompensationRefreshWorkflow",
            input_summary=_input_summary(payload),
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        try:
            await workflow.execute_activity(
                check_spend_budget,
                SpendBudgetInput(tenant_id=payload.tenant_id),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
            result = await workflow.execute_activity(
                refresh_compensation_activity,
                payload,
                start_to_close_timeout=_DEFAULT_TIMEOUT,
                retry_policy=_COMPENSATION_RETRY,
            )
        except CancelledError:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="CompensationRefreshWorkflow",
                status="canceled",
                started_at=started_at,
                error_code="workflow_canceled",
                error_message="Workflow canceled by request.",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise
        except ActivityError as exc:
            error_code = _activity_error_code(exc) or "compensation_refresh_failed"
            error_message = str(exc.cause if exc.cause else exc)
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="CompensationRefreshWorkflow",
                status="failed",
                started_at=started_at,
                error_code=error_code,
                error_message=error_message,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            return CompensationRefreshWorkflowResult(
                status="failed",
                error=error_message,
                error_code=error_code,
            )
        except Exception as exc:  # noqa: BLE001
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="CompensationRefreshWorkflow",
                status="failed",
                started_at=started_at,
                error_code=_exception_error_code(exc) or "workflow_error",
                error_message=str(exc),
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise

        await emit_workflow_outcome(
            tenant_id=payload.tenant_id,
            workflow_type="CompensationRefreshWorkflow",
            status="succeeded",
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        return CompensationRefreshWorkflowResult(status="succeeded", result=dict(result))


def _input_summary(payload: CompensationRefreshWorkflowInput) -> dict[str, Any]:
    return {
        "jobUrl": payload.job_url,
        "allJobs": payload.job_url is None,
        "limit": payload.limit,
        "includeEuroTopTech": payload.include_euro_top_tech,
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


__all__ = [
    "CompensationRefreshWorkflow",
    "CompensationRefreshWorkflowInput",
    "CompensationRefreshWorkflowResult",
    "refresh_compensation_activity",
]
