"""Tests for ``JobPipelineWorkflow``.

Exercises the workflow end-to-end via Temporal's ``WorkflowEnvironment`` with
the underlying stage runners stubbed so the test stays fast and hermetic.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import activity, workflow
from temporalio.client import WorkflowFailureError
from temporalio.common import RetryPolicy
from temporalio.exceptions import CancelledError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.apply.activities import apply_activity
from jobhunter.discovery.activities import discover_activity
from jobhunter.enrichment.activities import enrich_activity
from jobhunter.materials.activities import (
    cover_activity,
    pdf_activity,
    tailor_activity,
)
from jobhunter.pipeline.workflow import (
    JobPipelineWorkflow,
    JobPipelineWorkflowInput,
)
from jobhunter.scoring.activities import score_activity


_OK_RESULT = {
    "stages": [{"stage": "_", "status": "ok", "elapsed": 0.0}],
    "errors": {},
    "elapsed": 0.0,
}


def _all_activities():
    return [
        discover_activity,
        enrich_activity,
        score_activity,
        tailor_activity,
        cover_activity,
        pdf_activity,
        apply_activity,
    ]


@pytest.mark.asyncio
async def test_pipeline_workflow_runs_requested_stages_in_order():
    queue = f"pipeline-{uuid.uuid4()}"

    with patch(
        "jobhunter.pipeline.run_pipeline",
        return_value=_OK_RESULT,
    ) as runner_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        job_url="https://example.com/job",
                        stages=["discover", "enrich", "score"],
                    ),
                    id=f"pipeline-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["discover", "enrich", "score"]
    assert result.stages_skipped == []
    assert result.stages_failed == []
    assert result.failure is None

    invoked_stages = [call.kwargs["stages"][0] for call in runner_mock.call_args_list]
    assert invoked_stages == ["discover", "enrich", "score"]


@pytest.mark.asyncio
async def test_pipeline_workflow_skips_stage_when_state_machine_rejects():
    queue = f"pipeline-skip-{uuid.uuid4()}"

    def _veto(stage: str) -> str | None:
        return "vetoed" if stage == "enrich" else None

    with (
        patch(
            "jobhunter.pipeline.run_pipeline",
            return_value=_OK_RESULT,
        ) as runner_mock,
        patch(
            "jobhunter.pipeline.workflow._check_state_machine",
            side_effect=_veto,
        ),
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        job_url="https://example.com/job",
                        stages=["discover", "enrich", "score"],
                    ),
                    id=f"pipeline-skip-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["discover", "score"]
    assert result.stages_skipped == ["enrich"]
    assert result.stages_failed == []
    invoked_stages = [call.kwargs["stages"][0] for call in runner_mock.call_args_list]
    assert invoked_stages == ["discover", "score"]


@pytest.mark.asyncio
async def test_pipeline_workflow_records_failed_stage_and_stops():
    queue = f"pipeline-fail-{uuid.uuid4()}"

    def _runner(*, stages: list[str], **kwargs):
        if stages == ["enrich"]:
            raise RuntimeError("boom")
        return _OK_RESULT

    with patch("jobhunter.pipeline.run_pipeline", side_effect=_runner):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                # Override retry on the workflow side by reaching attempts
                # quickly — the workflow uses its default retry policy which
                # caps at 3 attempts. ``RuntimeError`` is retryable, so the
                # workflow surfaces ActivityError after the third attempt.
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        job_url="https://example.com/job",
                        stages=["discover", "enrich", "score"],
                    ),
                    id=f"pipeline-fail-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["discover"]
    assert result.stages_failed == ["enrich"]
    assert result.failure is not None
    assert result.failure.startswith("enrich:")
    assert "score" not in result.stages_completed
    assert "score" not in result.stages_failed


# ---------------------------------------------------------------------------
# Cancellation: a workflow cancel must surface CancelledError inside the
# running activity. We use a custom workflow that calls a long-running
# activity, then cancel the workflow mid-flight and verify the activity
# observed the cancellation.
# ---------------------------------------------------------------------------


_cancel_observed = False


@activity.defn(name="LongRunningActivity")
async def _long_running_activity() -> str:
    global _cancel_observed
    activity.heartbeat("start")
    try:
        for _ in range(120):
            await asyncio.sleep(0.5)
            activity.heartbeat("tick")
    except asyncio.CancelledError:
        _cancel_observed = True
        raise
    return "done"


@workflow.defn(name="CancellableHarness")
class _CancellableHarness:
    @workflow.run
    async def run(self) -> str:
        return await workflow.execute_activity(
            _long_running_activity,
            start_to_close_timeout=timedelta(minutes=5),
            heartbeat_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


@pytest.mark.asyncio
async def test_workflow_cancel_propagates_to_activity_as_cancelled_error():
    """Cancelling the workflow surfaces ``CancelledError`` inside the activity."""
    global _cancel_observed
    _cancel_observed = False
    queue = f"cancel-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[_CancellableHarness],
            activities=[_long_running_activity],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            handle = await env.client.start_workflow(
                _CancellableHarness.run,
                id=f"cancel-wf-{uuid.uuid4()}",
                task_queue=queue,
            )
            # Give the activity a moment to start before cancelling.
            await asyncio.sleep(0.5)
            await handle.cancel()

            with pytest.raises(WorkflowFailureError) as exc_info:
                await handle.result()

    # The workflow surfaces the cancellation as CancelledError.
    assert isinstance(exc_info.value.cause, CancelledError)
    assert _cancel_observed is True
