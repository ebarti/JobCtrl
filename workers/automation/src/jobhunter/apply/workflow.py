"""Temporal workflow for the apply stage.

This is a single-activity workflow. It is its own workflow (rather than a
one-stage ``JobPipelineWorkflow``) because the apply path takes its own
parameter shape and a tighter retry policy — keeping it isolated lets PR 3
register ``apply`` as ``mode="workflow"`` with a clean mapping.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from jobhunter.apply.activities import (
        ApplyActivityInput,
        ApplyActivityOutput,
        apply_activity,
    )


@dataclass(frozen=True)
class ApplyWorkflowInput:
    tenant_id: str
    job_url: str | None = None
    dry_run: bool = False
    headless: bool = False
    model: str = "haiku"
    min_score: int = 7
    workers: int = 1
    limit: int = 1


@dataclass(frozen=True)
class ApplyWorkflowResult:
    ok: bool
    run_id: str
    status: str
    error: str | None = None
    applied: int = 0
    failed: int = 0


_APPLY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(minutes=1),
    maximum_attempts=2,
)
_APPLY_TIMEOUT = timedelta(hours=2)


@workflow.defn(name="ApplyWorkflow")
class ApplyWorkflow:
    """Run a single apply launcher invocation through Temporal."""

    @workflow.run
    async def run(self, payload: ApplyWorkflowInput) -> ApplyWorkflowResult:
        info = workflow.info()
        try:
            result: ApplyActivityOutput = await workflow.execute_activity(
                apply_activity,
                ApplyActivityInput(
                    tenant_id=payload.tenant_id,
                    job_url=payload.job_url,
                    limit=max(1, payload.limit),
                    min_score=payload.min_score,
                    model=payload.model,
                    headless=payload.headless,
                    dry_run=payload.dry_run,
                    workers=payload.workers,
                ),
                start_to_close_timeout=_APPLY_TIMEOUT,
                retry_policy=_APPLY_RETRY,
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


__all__ = ["ApplyWorkflow", "ApplyWorkflowInput", "ApplyWorkflowResult"]
