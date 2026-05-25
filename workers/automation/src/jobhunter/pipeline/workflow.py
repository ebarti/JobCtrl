"""Temporal workflow that drives the JobHunter pipeline stages serially in batch mode."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from jobhunter.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
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
        TailorActivityInput,
        cover_activity,
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
    single ``(TenantId, JobId)`` for the discover/enrich/score/tailor/cover
    stages.

    The apply step is delegated to ``ApplyWorkflow`` as a child workflow so
    mixed requests such as ``score -> tailor -> apply`` preserve request-order
    semantics while all work still runs under Temporal.
    """

    tenant_id: str
    stages: list[str]
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    min_score: int = 7
    workers: int = 1
    limit: int = 0
    validation_mode: str = "normal"
    dry_run: bool = False
    rescore: bool = False
    retailor: bool = False
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float = 0.82
    job_url: str | None = None
    headless: bool = False
    model: str = "default"
    continuous: bool = False


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
            DiscoverActivityInput(
                tenant_id=payload.tenant_id,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                workers=payload.workers,
                limit=payload.limit,
                dry_run=payload.dry_run,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "enrich":
        return await workflow.execute_activity(
            enrich_activity,
            EnrichActivityInput(
                tenant_id=payload.tenant_id,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                workers=payload.workers,
                limit=payload.limit,
                dry_run=payload.dry_run,
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
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                workers=payload.workers,
                limit=payload.limit,
                dry_run=payload.dry_run,
                rescore=payload.rescore,
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
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                min_score=payload.min_score,
                workers=payload.workers,
                limit=payload.limit,
                validation_mode=payload.validation_mode,
                dry_run=payload.dry_run,
                retailor=payload.retailor,
                tailor_models=payload.tailor_models,
                tailor_judge_model=payload.tailor_judge_model,
                tailor_judge_min_score=payload.tailor_judge_min_score,
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
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                min_score=payload.min_score,
                limit=payload.limit,
                validation_mode=payload.validation_mode,
                dry_run=payload.dry_run,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_DEFAULT_RETRY,
        )
    if stage == "apply":
        return await workflow.execute_child_workflow(
            ApplyWorkflow.run,
            ApplyWorkflowInput(
                tenant_id=payload.tenant_id,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                job_url=payload.job_url,
                dry_run=payload.dry_run,
                headless=payload.headless,
                model=payload.model,
                min_score=payload.min_score,
                workers=payload.workers,
                limit=payload.limit,
                continuous=payload.continuous,
            ),
            id=f"{workflow.info().workflow_id}-apply",
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
