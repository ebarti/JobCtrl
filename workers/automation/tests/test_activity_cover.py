"""Happy-path test for ``cover_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.materials.activities import (
    CoverActivityInput,
    CoverActivityOutput,
    cover_activity,
)


@workflow.defn(name="CoverHarness")
class _CoverHarness:
    @workflow.run
    async def run(self, payload: CoverActivityInput) -> CoverActivityOutput:
        return await workflow.execute_activity(
            cover_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
        )


@pytest.mark.asyncio
async def test_cover_activity_invokes_run_pipeline_with_cover_stage():
    fake_pipeline_result = {
        "stages": [{"stage": "cover", "status": "ok", "elapsed": 0.5}],
        "errors": {},
        "elapsed": 0.5,
    }
    queue = f"cover-{uuid.uuid4()}"

    with patch(
        "jobhunter.pipeline.run_pipeline",
        return_value=fake_pipeline_result,
    ) as runner_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_CoverHarness],
                activities=[cover_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output: CoverActivityOutput = await env.client.execute_workflow(
                    _CoverHarness.run,
                    CoverActivityInput(tenant_id="local", min_score=6, limit=2),
                    id=f"cover-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    runner_mock.assert_called_once()
    kwargs = runner_mock.call_args.kwargs
    assert kwargs["stages"] == ["cover"]
    assert kwargs["min_score"] == 6
    assert kwargs["limit"] == 2
    assert output.status == "ok"
    assert output.elapsed == pytest.approx(0.5)
