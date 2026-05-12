"""Happy-path test for ``discover_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.discovery.activities import (
    DiscoverActivityInput,
    DiscoverActivityOutput,
    discover_activity,
)


@workflow.defn(name="DiscoverHarness")
class _DiscoverHarness:
    @workflow.run
    async def run(self, payload: DiscoverActivityInput) -> DiscoverActivityOutput:
        return await workflow.execute_activity(
            discover_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
        )


@pytest.mark.asyncio
async def test_discover_activity_invokes_run_pipeline_with_discover_stage():
    fake_pipeline_result = {
        "stages": [{"stage": "discover", "status": "ok", "elapsed": 0.1}],
        "errors": {},
        "elapsed": 0.1,
    }
    queue = f"discover-{uuid.uuid4()}"

    with patch(
        "jobhunter.pipeline.run_pipeline",
        return_value=fake_pipeline_result,
    ) as runner_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_DiscoverHarness],
                activities=[discover_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output: DiscoverActivityOutput = await env.client.execute_workflow(
                    _DiscoverHarness.run,
                    DiscoverActivityInput(tenant_id="local", limit=5, workers=2),
                    id=f"discover-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    runner_mock.assert_called_once()
    kwargs = runner_mock.call_args.kwargs
    assert kwargs["stages"] == ["discover"]
    assert kwargs["workers"] == 2
    assert kwargs["limit"] == 5
    assert output.status == "ok"
    assert output.elapsed == pytest.approx(0.1)
