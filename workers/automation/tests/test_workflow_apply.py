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
from jobhunter.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)


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
                activities=[apply_activity, record_workflow_started, record_workflow_outcome],
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
async def test_apply_workflow_retries_transient_failures_then_surfaces():
    """A transient ``RuntimeError`` is retried up to ``max_attempts=2``."""
    queue = f"apply-wf-retry-{uuid.uuid4()}"
    workflow_id = f"apply-retry-{uuid.uuid4()}"

    with patch(
        "jobhunter.apply.launcher.main",
        side_effect=RuntimeError("apply boom"),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ApplyWorkflow],
                activities=[apply_activity, record_workflow_started, record_workflow_outcome],
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

    # ``max_attempts=2`` on the workflow's retry policy ⇒ the activity is
    # invoked twice before ``ActivityError`` surfaces and the workflow catches
    # it as a structured failure.
    assert apply_main_mock.call_count == 2
    assert result.ok is False
    assert result.status == "failed"
    assert "apply boom" in (result.error or "")
    assert result.run_id == workflow_id


@pytest.mark.asyncio
async def test_apply_workflow_recovers_when_first_attempt_fails():
    """If the first attempt raises and the second succeeds, the workflow returns ``ok``."""
    queue = f"apply-wf-recover-{uuid.uuid4()}"
    workflow_id = f"apply-recover-{uuid.uuid4()}"

    with patch(
        "jobhunter.apply.launcher.main",
        side_effect=[RuntimeError("transient"), (1, 0)],
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ApplyWorkflow],
                activities=[apply_activity, record_workflow_started, record_workflow_outcome],
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

    assert apply_main_mock.call_count == 2
    assert result.ok is True
    assert result.status == "ok"
    assert result.applied == 1
    assert result.failed == 0


@pytest.mark.asyncio
async def test_apply_workflow_does_not_retry_lookup_errors():
    """``LookupError`` is wrapped in a non-retryable ``ApplicationError``."""
    queue = f"apply-wf-lookup-{uuid.uuid4()}"
    workflow_id = f"apply-lookup-{uuid.uuid4()}"

    with patch(
        "jobhunter.apply.launcher.main",
        side_effect=LookupError("no job URL provided"),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ApplyWorkflow],
                activities=[apply_activity, record_workflow_started, record_workflow_outcome],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    ApplyWorkflow.run,
                    ApplyWorkflowInput(
                        tenant_id="local",
                        limit=1,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )

    # Non-retryable ⇒ called exactly once.
    assert apply_main_mock.call_count == 1
    assert result.ok is False
    assert result.status == "failed"
    assert "no job URL provided" in (result.error or "")
