"""Happy-path test for ``apply_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.apply.activities import (
    ApplyActivityInput,
    ApplyActivityOutput,
    apply_activity,
)


@workflow.defn(name="ApplyHarness")
class _ApplyHarness:
    @workflow.run
    async def run(self, payload: ApplyActivityInput) -> ApplyActivityOutput:
        return await workflow.execute_activity(
            apply_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=10),
            heartbeat_timeout=timedelta(seconds=60),
        )


@pytest.mark.asyncio
async def test_apply_activity_invokes_apply_main_and_returns_ok():
    queue = f"apply-{uuid.uuid4()}"

    with patch(
        "jobhunter.apply.launcher.main",
        return_value=(2, 0),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_ApplyHarness],
                activities=[apply_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output: ApplyActivityOutput = await env.client.execute_workflow(
                    _ApplyHarness.run,
                    ApplyActivityInput(
                        tenant_id="local",
                        job_url="https://example.com/job",
                        limit=2,
                        min_score=8,
                        model="haiku",
                        headless=True,
                    ),
                    id=f"apply-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    apply_main_mock.assert_called_once()
    kwargs = apply_main_mock.call_args.kwargs
    assert kwargs["limit"] == 2
    assert kwargs["target_url"] == "https://example.com/job"
    assert kwargs["min_score"] == 8
    assert kwargs["headless"] is True
    assert kwargs["model"] == "haiku"
    assert output.status == "ok"
    assert output.applied == 2
    assert output.failed == 0
    assert output.error is None
