"""Temporal workflow that drives the JobHunter pipeline stages serially."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from jobhunter.apply.activities import (
        ApplyActivityInput,
        ApplyActivityOutput,
        apply_activity,
    )
    from jobhunter.discovery.activities import (
        DiscoverActivityInput,
        DiscoverActivityOutput,
        discover_activity,
    )
    from jobhunter.domain.pipeline.state_machine import (
        StageTransition,
        TransitionRejected,
        transition,
    )
    from jobhunter.domain.pipeline_types import Pending
    from jobhunter.enrichment.activities import (
        EnrichActivityInput,
        EnrichActivityOutput,
        enrich_activity,
    )
    from jobhunter.materials.activities import (
        CoverActivityInput,
        CoverActivityOutput,
        PdfActivityInput,
        PdfActivityOutput,
        TailorActivityInput,
        TailorActivityOutput,
        cover_activity,
        pdf_activity,
        tailor_activity,
    )
    from jobhunter.scoring.activities import (
        ScoreActivityInput,
        ScoreActivityOutput,
        score_activity,
    )


@dataclass(frozen=True)
class JobPipelineWorkflowInput:
    tenant_id: str
    job_url: str
    stages: list[str]
    min_score: int = 7
    workers: int = 1
    limit: int = 0


@dataclass(frozen=True)
class JobPipelineWorkflowResult:
    stages_completed: list[str] = field(default_factory=list)
    stages_skipped: list[str] = field(default_factory=list)
    stages_failed: list[str] = field(default_factory=list)
    failure: str | None = None


# Default per-activity policy. Apply gets the apply-specific override below.
_DEFAULT_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(minutes=1),
    maximum_attempts=3,
)
_APPLY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(minutes=1),
    maximum_attempts=2,
)
_DEFAULT_TIMEOUT = timedelta(minutes=30)
_APPLY_TIMEOUT = timedelta(hours=2)


def _check_state_machine(stage: str) -> str | None:
    """Drive a fresh ``Pending`` state through ``Enqueue`` then ``Start``.

    Returns ``None`` if both transitions are valid; otherwise the rejection
    reason. The workflow consults this to decide whether to skip a stage —
    persistence still happens inside the stage runner via ``set_stage_state``.
    """
    pending = Pending(attempt_count=0, max_attempts=0)
    enqueued = transition(pending, StageTransition.Enqueue)
    if isinstance(enqueued, TransitionRejected):
        return enqueued.reason
    started = transition(enqueued, StageTransition.Start)
    if isinstance(started, TransitionRejected):
        return started.reason
    return None


@workflow.defn(name="JobPipelineWorkflow")
class JobPipelineWorkflow:
    """Drives the requested pipeline stages serially via per-stage activities."""

    @workflow.run
    async def run(self, payload: JobPipelineWorkflowInput) -> JobPipelineWorkflowResult:
        completed: list[str] = []
        skipped: list[str] = []
        failed: list[str] = []
        failure: str | None = None

        for stage in payload.stages:
            rejection = _check_state_machine(stage)
            if rejection is not None:
                skipped.append(stage)
                continue

            try:
                await _execute_stage(stage, payload)
            except ActivityError as exc:
                failed.append(stage)
                failure = f"{stage}: {exc.cause if exc.cause else exc}"
                break

            completed.append(stage)

        return JobPipelineWorkflowResult(
            stages_completed=completed,
            stages_skipped=skipped,
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
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "cover":
        return await workflow.execute_activity(
            cover_activity,
            CoverActivityInput(
                tenant_id=payload.tenant_id,
                min_score=payload.min_score,
                limit=payload.limit,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "pdf":
        return await workflow.execute_activity(
            pdf_activity,
            PdfActivityInput(tenant_id=payload.tenant_id, limit=payload.limit),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "apply":
        return await workflow.execute_activity(
            apply_activity,
            ApplyActivityInput(
                tenant_id=payload.tenant_id,
                job_url=payload.job_url,
                limit=max(1, payload.limit),
                min_score=payload.min_score,
                workers=payload.workers,
            ),
            start_to_close_timeout=_APPLY_TIMEOUT,
            retry_policy=_APPLY_RETRY,
            heartbeat_timeout=timedelta(seconds=60),
        )
    raise workflow.ApplicationError(
        f"Unknown stage: {stage}",
        non_retryable=True,
    )


__all__ = [
    "JobPipelineWorkflow",
    "JobPipelineWorkflowInput",
    "JobPipelineWorkflowResult",
    "_check_state_machine",
]


# Keep a reference so static analysers know we use these output dataclasses
# at the workflow boundary even though we never bind their values.
_OUTPUT_TYPES: tuple[type, ...] = (
    DiscoverActivityOutput,
    EnrichActivityOutput,
    ScoreActivityOutput,
    TailorActivityOutput,
    CoverActivityOutput,
    PdfActivityOutput,
    ApplyActivityOutput,
)
