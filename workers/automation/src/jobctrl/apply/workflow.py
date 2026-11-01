"""Temporal workflow for the apply stage.

This is a single-activity workflow. It is its own workflow (rather than a
one-stage ``JobPipelineWorkflow``) because the apply path takes its own
parameter shape and a tighter retry policy — keeping it isolated lets PR 3
register ``apply`` as ``mode="workflow"`` with a clean mapping.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

from jobctrl.domain.identifiers import JobId, canonical_job_id

with workflow.unsafe.imports_passed_through():
    from jobctrl.infrastructure.temporal.control import execute_control_activity
    from jobctrl.apply.activities import (
        ApplyActivityInput,
        ApplyActivityOutput,
        ApplyFrontierInput,
        apply_activity,
        capture_apply_dispatch_frontier_activity,
    )
    from jobctrl.apply.batch_outcome import ApplyBatchCounts
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
    job_id: JobId | None = None
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
    # None is a pre-upgrade dispatch; it can run jobs without Skip history.
    dispatch_frontier: int | None = None

    def __post_init__(self) -> None:
        if self.job_id is not None:
            object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))


@dataclass(frozen=True)
class ApplyWorkflowResult:
    ok: bool
    run_id: str
    status: str
    error: str | None = None
    applied: int = 0
    failed: int = 0
    # None identifies historical or failed executions with no observation.
    worker_crashes: int | None = None
    counts_known: bool | None = None
    settled_refusals: int | None = None


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
            await execute_control_activity(
                check_spend_budget,
                SpendBudgetInput(tenant_id=payload.tenant_id, lane="apply"),
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

        handled_refusals = (
            result.status == "failed" and result.error is None and result.worker_crashes == 0
            and type(result.failed) is int and result.failed > 0
            and type(result.settled_refusals) is int and result.settled_refusals == result.failed
        )
        continue_refusals = (
            payload.continuous and handled_refusals
            and workflow.patched('apply-standing-refusal-continuation-v1')
        )
        if payload.continuous and (result.ok or continue_refusals):
            if result.applied == 0 and (result.failed == 0 or continue_refusals):
                await workflow.sleep(_APPLY_CONTINUOUS_EMPTY_POLL_DELAY)
            if workflow.patched('apply-standing-dispatch-frontier-v1'):
                frontier = await workflow.execute_activity(
                    capture_apply_dispatch_frontier_activity,
                    ApplyFrontierInput(payload.tenant_id, payload.expected_app_dir, payload.expected_db_path),
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                workflow.continue_as_new(replace(payload, dispatch_frontier=frontier))
            legacy_payload = asdict(payload)
            legacy_payload.pop('dispatch_frontier')
            workflow.continue_as_new(legacy_payload)
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
        return result

    async def _run_apply(self, payload: ApplyWorkflowInput) -> ApplyWorkflowResult:
        info = workflow.info()
        activity_limit = 25 if payload.continuous else payload.limit
        try:
            inputs = ApplyActivityInput(
                    tenant_id=payload.tenant_id,
                    expected_app_dir=payload.expected_app_dir,
                    expected_db_path=payload.expected_db_path,
                    job_id=payload.job_id,
                    limit=activity_limit,
                    min_score=payload.min_score,
                    model=payload.model,
                    headless=payload.headless,
                    dry_run=payload.dry_run,
                    workers=payload.workers,
                    approval_required=payload.approval_required,
                    continuous=False,
                    auto_apply_loop=payload.auto_apply_loop,
                    standing_refusal_poll=payload.continuous or payload.auto_apply_loop,
                    dispatch_frontier=payload.dispatch_frontier,
                )
            if not workflow.patched('apply-activity-dispatch-frontier-v1'):
                legacy_inputs = asdict(inputs)
                legacy_inputs.pop('dispatch_frontier')
                legacy_inputs.pop('standing_refusal_poll')
                inputs = legacy_inputs
            result: ApplyActivityOutput = await workflow.execute_activity(
                apply_activity,
                inputs,
                start_to_close_timeout=(_APPLY_CONTINUOUS_BATCH_TIMEOUT if payload.continuous else _APPLY_TIMEOUT),
                retry_policy=_APPLY_DRY_RUN_RETRY if payload.dry_run else _APPLY_LIVE_RETRY,
                heartbeat_timeout=timedelta(seconds=60),
            )
        except ActivityError as exc:
            counts = None
            cause = exc.cause
            if isinstance(cause, ApplicationError) and cause.type == "apply_launcher_cleanup_incomplete" and len(cause.details) == 1:
                try:
                    counts = ApplyBatchCounts.from_dict(cause.details[0])
                except ValueError:
                    pass
            return ApplyWorkflowResult(
                ok=False,
                run_id=info.workflow_id,
                status="failed",
                error=str(exc.cause if exc.cause else exc),
                applied=counts.applied if counts is not None else 0,
                failed=counts.failed if counts is not None else 0,
                worker_crashes=counts.worker_crashes if counts is not None else None,
                counts_known=counts is not None,
            )

        return ApplyWorkflowResult(
            ok=result.status == "ok",
            run_id=info.workflow_id,
            status=result.status,
            error=result.error,
            applied=result.applied,
            failed=result.failed,
            worker_crashes=getattr(result, "worker_crashes", None),
            # Old activity histories cannot establish that their counts
            # included work from every worker.
            counts_known=getattr(result, "worker_crashes", None) is not None,
            settled_refusals=getattr(result, "settled_refusals", None),
        )


def _apply_input_summary(payload: ApplyWorkflowInput) -> dict[str, Any]:
    """Compact, camelCase input summary for the workflow-run read-model."""
    return {
        "jobId": str(payload.job_id) if payload.job_id is not None else None,
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
