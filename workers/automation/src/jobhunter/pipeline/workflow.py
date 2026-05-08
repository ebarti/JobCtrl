"""Temporal workflow that drives the JobHunter pipeline stages serially in batch mode."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from jobhunter.discovery.activities import (
        DiscoverActivityInput,
        discover_activity,
    )
    from jobhunter.enrichment.activities import (
        EnrichActivityInput,
        enrich_activity,
    )
    from jobhunter.materials.activities import (
        CoverActivityInput,
        PdfActivityInput,
        TailorActivityInput,
        cover_activity,
        pdf_activity,
        tailor_activity,
    )
    from jobhunter.scoring.activities import (
        ScoreActivityInput,
        score_activity,
    )


@dataclass(frozen=True)
class JobPipelineWorkflowInput:
    """Input for ``JobPipelineWorkflow``.

    Drives the requested stage list in batch mode against eligible jobs in the
    local DB. Each non-apply stage runner is batch-oriented today — it walks
    the DB selectors itself — so this workflow does not currently address a
    single ``(TenantId, JobId)`` for the discover/enrich/score/tailor/cover/pdf
    stages.

    The per-job apply path lives in ``ApplyWorkflow`` (``apply/workflow.py``);
    passing ``"apply"`` in ``stages`` raises a non-retryable
    ``ApplicationError``.
    """

    tenant_id: str
    stages: list[str]
    min_score: int = 7
    workers: int = 1
    limit: int = 0
    validation_mode: str = "normal"


@dataclass(frozen=True)
class JobPipelineWorkflowResult:
    stages_completed: list[str] = field(default_factory=list)
    stages_failed: list[str] = field(default_factory=list)
    failure: str | None = None


# Default per-activity policy. Apply runs through ``ApplyWorkflow`` and gets
# its own apply-specific retry policy there.
_DEFAULT_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(minutes=1),
    maximum_attempts=3,
)
_DEFAULT_TIMEOUT = timedelta(minutes=30)
# 2 minutes gives the activity ~8 cycles of the 15s heartbeat poll inside
# ``run_blocking_with_heartbeat`` before Temporal would consider the
# activity dead. Without this knob Temporal never times out a stuck
# activity and the workflow waits the full ``start_to_close_timeout``.
_DEFAULT_HEARTBEAT_TIMEOUT = timedelta(minutes=2)


@workflow.defn(name="JobPipelineWorkflow")
class JobPipelineWorkflow:
    """Drives the configured pipeline stages serially in batch mode.

    Stage eligibility (``Pending`` / ``Queued`` / ``Running`` validity per job)
    is owned by the underlying stage runner via ``state.set_stage_state``, not
    by the workflow. The workflow simply dispatches each requested stage and
    surfaces ``ActivityError`` failures.
    """

    @workflow.run
    async def run(self, payload: JobPipelineWorkflowInput) -> JobPipelineWorkflowResult:
        completed: list[str] = []
        failed: list[str] = []
        failure: str | None = None

        for stage in payload.stages:
            try:
                await _execute_stage(stage, payload)
            except ActivityError as exc:
                failed.append(stage)
                failure = f"{stage}: {exc.cause if exc.cause else exc}"
                break

            completed.append(stage)

        return JobPipelineWorkflowResult(
            stages_completed=completed,
            stages_failed=failed,
            failure=failure,
        )


async def _execute_stage(stage: str, payload: JobPipelineWorkflowInput) -> Any:
    """Dispatch one stage to its Temporal activity."""
    if stage == "discover":
        return await workflow.execute_activity(
            discover_activity,
            DiscoverActivityInput(tenant_id=payload.tenant_id, workers=payload.workers),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "enrich":
        return await workflow.execute_activity(
            enrich_activity,
            EnrichActivityInput(
                tenant_id=payload.tenant_id,
                workers=payload.workers,
                limit=payload.limit,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "score":
        return await workflow.execute_activity(
            score_activity,
            ScoreActivityInput(
                tenant_id=payload.tenant_id,
                workers=payload.workers,
                limit=payload.limit,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "tailor":
        return await workflow.execute_activity(
            tailor_activity,
            TailorActivityInput(
                tenant_id=payload.tenant_id,
                min_score=payload.min_score,
                workers=payload.workers,
                limit=payload.limit,
                validation_mode=payload.validation_mode,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "cover":
        return await workflow.execute_activity(
            cover_activity,
            CoverActivityInput(
                tenant_id=payload.tenant_id,
                min_score=payload.min_score,
                limit=payload.limit,
                validation_mode=payload.validation_mode,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "pdf":
        return await workflow.execute_activity(
            pdf_activity,
            PdfActivityInput(tenant_id=payload.tenant_id, limit=payload.limit),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "apply":
        raise ApplicationError(
            "apply is not orchestrated by JobPipelineWorkflow; use ApplyWorkflow",
            non_retryable=True,
        )
    raise ApplicationError(
        f"Unknown stage: {stage}",
        non_retryable=True,
    )


__all__ = [
    "JobPipelineWorkflow",
    "JobPipelineWorkflowInput",
    "JobPipelineWorkflowResult",
]
