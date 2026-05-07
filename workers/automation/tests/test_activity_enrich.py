"""Happy-path test for ``enrich_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.enrichment.activities import (
    EnrichActivityInput,
    EnrichActivityOutput,
    enrich_activity,
)


@workflow.defn(name="EnrichHarness")
class _EnrichHarness:
    @workflow.run
    async def run(self, payload: EnrichActivityInput) -> EnrichActivityOutput:
        return await workflow.execute_activity(
            enrich_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
        )


@pytest.mark.asyncio
async def test_enrich_activity_invokes_run_pipeline_with_enrich_stage():
    fake_pipeline_result = {
        "stages": [{"stage": "enrich", "status": "ok", "elapsed": 0.2}],
        "errors": {},
        "elapsed": 0.2,
    }
    queue = f"enrich-{uuid.uuid4()}"

    with patch(
        "jobhunter.pipeline.run_pipeline",
        return_value=fake_pipeline_result,
    ) as runner_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_EnrichHarness],
                activities=[enrich_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output: EnrichActivityOutput = await env.client.execute_workflow(
                    _EnrichHarness.run,
                    EnrichActivityInput(tenant_id="local", limit=5, workers=2),
                    id=f"enrich-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    runner_mock.assert_called_once()
    kwargs = runner_mock.call_args.kwargs
    assert kwargs["stages"] == ["enrich"]
    assert kwargs["workers"] == 2
    assert kwargs["limit"] == 5
    assert output.status == "ok"
    assert output.elapsed == pytest.approx(0.2)
