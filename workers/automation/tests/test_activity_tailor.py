"""Happy-path test for ``tailor_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.materials.activities import (
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
        )


@pytest.mark.asyncio
async def test_tailor_activity_invokes_run_pipeline_with_tailor_stage():
    fake_pipeline_result = {
        "stages": [{"stage": "tailor", "status": "ok", "elapsed": 0.4}],
        "errors": {},
        "elapsed": 0.4,
    }
    queue = f"tailor-{uuid.uuid4()}"

    with patch(
        "jobhunter.pipeline.run_pipeline",
        return_value=fake_pipeline_result,
    ) as runner_mock:
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

    runner_mock.assert_called_once()
    kwargs = runner_mock.call_args.kwargs
    assert kwargs["stages"] == ["tailor"]
    assert kwargs["min_score"] == 8
    assert kwargs["limit"] == 3
    assert kwargs["retailor"] is True
    assert kwargs["tailor_models"] == ("local:draft-a", "openai:draft-b")
    assert kwargs["tailor_judge_model"] == "gemini:judge-c"
    assert kwargs["tailor_judge_min_score"] == 0.9
    assert output.status == "ok"
    assert output.elapsed == pytest.approx(0.4)
