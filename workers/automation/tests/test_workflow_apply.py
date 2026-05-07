"""Tests for ``ApplyWorkflow``.

The apply path is its own single-activity workflow because it needs a
different retry policy and parameter shape than the generic pipeline.
"""

from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.apply.activities import apply_activity
from jobhunter.apply.workflow import ApplyWorkflow, ApplyWorkflowInput


@pytest.mark.asyncio
async def test_apply_workflow_returns_ok_when_apply_main_succeeds():
    queue = f"apply-wf-{uuid.uuid4()}"
    workflow_id = f"apply-{uuid.uuid4()}"

    with patch(
        "jobhunter.apply.launcher.main",
        return_value=(3, 0),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ApplyWorkflow],
                activities=[apply_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    ApplyWorkflow.run,
                    ApplyWorkflowInput(
                        tenant_id="local",
                        job_url="https://example.com/job",
                        min_score=8,
                        limit=3,
                        workers=2,
                        model="haiku",
                        headless=True,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )

    apply_main_mock.assert_called_once()
    assert result.ok is True
    assert result.status == "ok"
    assert result.applied == 3
    assert result.failed == 0
    assert result.error is None
    assert result.run_id == workflow_id


@pytest.mark.asyncio
async def test_apply_workflow_returns_failure_when_apply_main_raises():
    queue = f"apply-wf-fail-{uuid.uuid4()}"
    workflow_id = f"apply-fail-{uuid.uuid4()}"

    with patch(
        "jobhunter.apply.launcher.main",
        side_effect=RuntimeError("apply boom"),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ApplyWorkflow],
                activities=[apply_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    ApplyWorkflow.run,
                    ApplyWorkflowInput(
                        tenant_id="local",
                        job_url="https://example.com/job",
                        limit=1,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )

    # The activity catches its own exception and returns a structured
    # failure ApplyActivityOutput, so the workflow does not see ActivityError.
    apply_main_mock.assert_called()
    assert result.ok is False
    assert result.status == "failed"
    assert result.error == "apply boom"
    assert result.run_id == workflow_id
