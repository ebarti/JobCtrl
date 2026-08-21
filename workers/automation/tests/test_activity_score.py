"""Happy-path test for ``score_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from .temporal_env import time_skipping_env
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl.scoring.activities import (
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
async def test_score_activity_invokes_observed_score_core():
    queue = f"score-{uuid.uuid4()}"

    with patch(
        "jobctrl.pipeline.runner._run_stage_observed",
        return_value=({"status": "ok"}, 0.3, "ok"),
    ) as observed_mock:
        async with time_skipping_env() as env:
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

    observed_mock.assert_called_once()
    args, kwargs = observed_mock.call_args
    assert args[0] == "score"
    assert args[2]["limit"] == 10
    assert args[2]["rescore"] is True
    assert kwargs["mode"] == "workflow"
    assert output.status == "ok"
    assert output.elapsed == pytest.approx(0.3)
