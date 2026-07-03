"""Temporal workflow for profile imports."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

with workflow.unsafe.imports_passed_through():
    from jobhunter.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )
    from jobhunter.llm import SpendBudgetInput, check_spend_budget
    from jobhunter.profile.activities import (
        ProfileImportActivityInput,
        profile_import_activity,
    )


@dataclass(frozen=True)
class ProfileImportWorkflowInput:
    tenant_id: str
    pdf_path: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    import_profile: bool = True
    import_style: bool = True


@dataclass(frozen=True)
class ProfileImportWorkflowResult:
    status: str
    draft: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    error_code: str | None = None


_PROFILE_IMPORT_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=5),
    maximum_interval=timedelta(minutes=1),
    maximum_attempts=2,
    non_retryable_error_types=["configuration", "authentication", "missing_input", "budget_exceeded"],
)
_DEFAULT_TIMEOUT = timedelta(minutes=10)


@workflow.defn(name="ProfileImportWorkflow")
class ProfileImportWorkflow:
    """Import a resume PDF profile draft through Temporal."""

    @workflow.run
    async def run(self, payload: ProfileImportWorkflowInput) -> ProfileImportWorkflowResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type="ProfileImportWorkflow",
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
            output = await workflow.execute_activity(
                profile_import_activity,
                ProfileImportActivityInput(
                    tenant_id=payload.tenant_id,
                    pdf_path=payload.pdf_path,
                    expected_app_dir=payload.expected_app_dir,
                    expected_db_path=payload.expected_db_path,
                    import_profile=payload.import_profile,
                    import_style=payload.import_style,
                ),
                start_to_close_timeout=_DEFAULT_TIMEOUT,
                retry_policy=_PROFILE_IMPORT_RETRY,
            )
        except CancelledError:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="ProfileImportWorkflow",
                status="canceled",
                started_at=started_at,
                error_code="workflow_canceled",
                error_message="Workflow canceled by request.",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise
        except ActivityError as exc:
            error_code = _activity_error_code(exc) or "profile_import_failed"
            error_message = str(exc.cause if exc.cause else exc)
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="ProfileImportWorkflow",
                status="failed",
                started_at=started_at,
                error_code=error_code,
                error_message=error_message,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            return ProfileImportWorkflowResult(
                status="failed",
                error=error_message,
                error_code=error_code,
            )
        except Exception as exc:  # noqa: BLE001
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="ProfileImportWorkflow",
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
            workflow_type="ProfileImportWorkflow",
            status="succeeded",
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        return ProfileImportWorkflowResult(
            status=output.status,
            draft=dict(output.draft),
            error=output.error,
        )


def _input_summary(payload: ProfileImportWorkflowInput) -> dict[str, Any]:
    return {
        "filename": payload.pdf_path.rsplit("/", 1)[-1],
        "importProfile": payload.import_profile,
        "importStyle": payload.import_style,
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


__all__ = ["ProfileImportWorkflow", "ProfileImportWorkflowInput", "ProfileImportWorkflowResult"]
