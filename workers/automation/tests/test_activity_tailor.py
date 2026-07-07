"""Happy-path test for ``tailor_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.client import WorkflowFailureError
from temporalio.common import RetryPolicy
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctl.materials.activities import (
    TailorActivityInput,
    TailorActivityOutput,
    tailor_activity,
)


@workflow.defn(name="TailorHarness")
class _TailorHarness:
    @workflow.run
    async def run(self, payload: TailorActivityInput) -> TailorActivityOutput:
        return await workflow.execute_activity(
            tailor_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


@pytest.mark.asyncio
async def test_tailor_activity_invokes_observed_tailor_core():
    queue = f"tailor-{uuid.uuid4()}"

    with patch(
        "jobctl.pipeline.runner._run_stage_observed",
        return_value=({"status": "ok"}, 0.4, "ok"),
    ) as observed_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_TailorHarness],
                activities=[tailor_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output: TailorActivityOutput = await env.client.execute_workflow(
                    _TailorHarness.run,
                    TailorActivityInput(
                        tenant_id="local",
                        min_score=8,
                        limit=3,
                        workers=2,
                        retailor=True,
                        tailor_models=("local:draft-a", "openai:draft-b"),
                        tailor_judge_model="gemini:judge-c",
                        tailor_judge_min_score=0.9,
                    ),
                    id=f"tailor-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    observed_mock.assert_called_once()
    args, kwargs = observed_mock.call_args
    assert args[0] == "tailor"
    assert args[2]["min_score"] == 8
    assert args[2]["limit"] == 3
    assert args[2]["retailor"] is True
    assert args[2]["tailor_models"] == ("local:draft-a", "openai:draft-b")
    assert args[2]["tailor_judge_model"] == "gemini:judge-c"
    assert args[2]["tailor_judge_min_score"] == 0.9
    assert kwargs["mode"] == "workflow"
    assert output.status == "ok"
    assert output.elapsed == pytest.approx(0.4)


@pytest.mark.asyncio
async def test_tailor_activity_raises_observed_failure_status():
    queue = f"tailor-{uuid.uuid4()}"

    with patch(
        "jobctl.pipeline.runner._run_stage_observed",
        return_value=({"status": "failed", "error": "failed"}, 0.4, "failed"),
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_TailorHarness],
                activities=[tailor_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                with pytest.raises(WorkflowFailureError):
                    await env.client.execute_workflow(
                        _TailorHarness.run,
                        TailorActivityInput(tenant_id="local"),
                        id=f"tailor-wf-{uuid.uuid4()}",
                        task_queue=queue,
                    )
