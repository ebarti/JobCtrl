"""Temporal workflow for the apply stage.

This is a single-activity workflow. It is its own workflow (rather than a
one-stage ``JobPipelineWorkflow``) because the apply path takes its own
parameter shape and a tighter retry policy — keeping it isolated lets PR 3
register ``apply`` as ``mode="workflow"`` with a clean mapping.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from jobctrl.apply.activities import (
        ApplyActivityInput,
        ApplyActivityOutput,
        apply_activity,
    )
    from jobctrl.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )
    from jobctrl.llm import SpendBudgetInput, check_spend_budget


@dataclass(frozen=True)
class ApplyWorkflowInput:
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    job_url: str | None = None
    dry_run: bool = False
    headless: bool = False
    model: str = "default"
    min_score: int = 7
    workers: int = 1
    limit: int = 1
    approval_required: bool = True
    # Run-forever poll mode — when True, the activity translates to the
    # ``apply.launcher`` ``limit=0`` sentinel that drives the continuous loop.
    continuous: bool = False
    # Settings-controlled standing loop. The workflow id is deterministic and
    # the activity re-reads apply settings at batch time.
    auto_apply_loop: bool = False


@dataclass(frozen=True)
class ApplyWorkflowResult:
    ok: bool
    run_id: str
    status: str
    error: str | None = None
    applied: int = 0
    failed: int = 0


_APPLY_LIVE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(minutes=1),
    maximum_attempts=1,
)
_APPLY_DRY_RUN_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(minutes=1),
    maximum_attempts=2,
)
_APPLY_TIMEOUT = timedelta(hours=2)
_APPLY_CONTINUOUS_BATCH_TIMEOUT = timedelta(hours=1)
_APPLY_CONTINUOUS_EMPTY_POLL_DELAY = timedelta(seconds=30)


@workflow.defn(name="ApplyWorkflow")
class ApplyWorkflow:
    """Run a single apply launcher invocation through Temporal."""

    @workflow.run
    async def run(self, payload: ApplyWorkflowInput) -> ApplyWorkflowResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type="ApplyWorkflow",
            input_summary=_apply_input_summary(payload),
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        # See JobPipelineWorkflow.run: the cancel path deliberately does not
        # record here (Temporal cancels newly-scheduled activities during
        # cancellation); the describe-reconciler terminalizes WorkflowCanceled.
        try:
            await workflow.execute_activity(
                check_spend_budget,
                SpendBudgetInput(tenant_id=payload.tenant_id),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
            result = await self._run_apply(payload)
        except Exception as exc:  # noqa: BLE001 — record then re-raise
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="ApplyWorkflow",
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
            workflow_type="ApplyWorkflow",
            status="succeeded" if result.ok else "failed",
            started_at=started_at,
            error_code=None if result.ok else "apply_failed",
            error_message=None if result.ok else result.error,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        if payload.continuous:
            if result.applied + result.failed == 0:
                await workflow.sleep(_APPLY_CONTINUOUS_EMPTY_POLL_DELAY)
            workflow.continue_as_new(payload)
        return result

    async def _run_apply(self, payload: ApplyWorkflowInput) -> ApplyWorkflowResult:
        info = workflow.info()
        activity_limit = 25 if payload.continuous else payload.limit
        try:
            result: ApplyActivityOutput = await workflow.execute_activity(
                apply_activity,
                ApplyActivityInput(
                    tenant_id=payload.tenant_id,
                    expected_app_dir=payload.expected_app_dir,
                    expected_db_path=payload.expected_db_path,
                    job_url=payload.job_url,
                    limit=activity_limit,
                    min_score=payload.min_score,
                    model=payload.model,
                    headless=payload.headless,
                    dry_run=payload.dry_run,
                    workers=payload.workers,
                    approval_required=payload.approval_required,
                    continuous=False,
                    auto_apply_loop=payload.auto_apply_loop,
                ),
                start_to_close_timeout=(
                    _APPLY_CONTINUOUS_BATCH_TIMEOUT
                    if payload.continuous
                    else _APPLY_TIMEOUT
                ),
                retry_policy=_APPLY_DRY_RUN_RETRY if payload.dry_run else _APPLY_LIVE_RETRY,
                heartbeat_timeout=timedelta(seconds=60),
            )
        except ActivityError as exc:
            return ApplyWorkflowResult(
                ok=False,
                run_id=info.workflow_id,
                status="failed",
                error=str(exc.cause if exc.cause else exc),
            )

        return ApplyWorkflowResult(
            ok=result.status == "ok",
            run_id=info.workflow_id,
            status=result.status,
            error=result.error,
            applied=result.applied,
            failed=result.failed,
        )


def _apply_input_summary(payload: ApplyWorkflowInput) -> dict[str, Any]:
    """Compact, camelCase input summary for the workflow-run read-model."""
    return {
        "jobUrl": payload.job_url,
        "dryRun": payload.dry_run,
        "continuous": payload.continuous,
        "autoApplyLoop": payload.auto_apply_loop,
        "limit": payload.limit,
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


__all__ = ["ApplyWorkflow", "ApplyWorkflowInput", "ApplyWorkflowResult"]
