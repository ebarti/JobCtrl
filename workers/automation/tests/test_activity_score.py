"""Happy-path test for ``score_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.scoring.activities import (
    ScoreActivityInput,
    ScoreActivityOutput,
    score_activity,
)


@workflow.defn(name="ScoreHarness")
class _ScoreHarness:
    @workflow.run
    async def run(self, payload: ScoreActivityInput) -> ScoreActivityOutput:
        return await workflow.execute_activity(
            score_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
        )


@pytest.mark.asyncio
async def test_score_activity_invokes_run_pipeline_with_score_stage():
    fake_pipeline_result = {
        "stages": [{"stage": "score", "status": "ok", "elapsed": 0.3}],
        "errors": {},
        "elapsed": 0.3,
    }
    queue = f"score-{uuid.uuid4()}"

    with patch(
        "jobhunter.pipeline.run_pipeline",
        return_value=fake_pipeline_result,
    ) as runner_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_ScoreHarness],
                activities=[score_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output: ScoreActivityOutput = await env.client.execute_workflow(
                    _ScoreHarness.run,
                    ScoreActivityInput(tenant_id="local", limit=10, workers=1, rescore=True),
                    id=f"score-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    runner_mock.assert_called_once()
    kwargs = runner_mock.call_args.kwargs
    assert kwargs["stages"] == ["score"]
    assert kwargs["limit"] == 10
    assert kwargs["rescore"] is True
    assert output.status == "ok"
    assert output.elapsed == pytest.approx(0.3)
