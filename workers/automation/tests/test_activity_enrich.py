"""Happy-path test for ``enrich_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl.enrichment.activities import (
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
async def test_enrich_activity_invokes_observed_enrich_core():
    queue = f"enrich-{uuid.uuid4()}"

    with patch(
        "jobctrl.pipeline.runner._run_stage_observed",
        return_value=({"status": "ok"}, 0.2, "ok"),
    ) as observed_mock:
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

    observed_mock.assert_called_once()
    args, kwargs = observed_mock.call_args
    assert args[0] == "enrich"
    assert args[2]["workers"] == 2
    assert args[2]["limit"] == 5
    assert kwargs["mode"] == "workflow"
    assert output.status == "ok"
    assert output.elapsed == pytest.approx(0.2)
