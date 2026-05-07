"""Happy-path test for ``pdf_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.materials.activities import (
    PdfActivityInput,
    PdfActivityOutput,
    pdf_activity,
)


@workflow.defn(name="PdfHarness")
class _PdfHarness:
    @workflow.run
    async def run(self, payload: PdfActivityInput) -> PdfActivityOutput:
        return await workflow.execute_activity(
            pdf_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
        )


@pytest.mark.asyncio
async def test_pdf_activity_invokes_run_pipeline_with_pdf_stage():
    fake_pipeline_result = {
        "stages": [{"stage": "pdf", "status": "ok", "elapsed": 0.6}],
        "errors": {},
        "elapsed": 0.6,
    }
    queue = f"pdf-{uuid.uuid4()}"

    with patch(
        "jobhunter.pipeline.run_pipeline",
        return_value=fake_pipeline_result,
    ) as runner_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_PdfHarness],
                activities=[pdf_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output: PdfActivityOutput = await env.client.execute_workflow(
                    _PdfHarness.run,
                    PdfActivityInput(tenant_id="local", limit=4),
                    id=f"pdf-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    runner_mock.assert_called_once()
    kwargs = runner_mock.call_args.kwargs
    assert kwargs["stages"] == ["pdf"]
    assert kwargs["limit"] == 4
    assert output.status == "ok"
    assert output.elapsed == pytest.approx(0.6)
