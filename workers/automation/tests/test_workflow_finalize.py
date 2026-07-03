"""Loop closure (P0): finalize activities record a terminal Workflow* event on
a workflow's normal-completion and failure exit paths, so
``workflow_run_projections`` terminalizes without a reaper.

Cancellation is intentionally NOT covered here: Temporal cancels
newly-scheduled activities during workflow cancellation, so finalize cannot
reliably record from the cancel path — the describe-reconciler owns that (see
test_worker_reconciler.py). The finalize activities write to the session
sandbox DB (``get_connection``); each test uses a unique ``workflow_id`` so its
row is isolated from others.
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from unittest.mock import patch

import pytest
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.database import get_connection
from jobhunter.domain.errors import ConfigurationError, TransientNetworkError
from jobhunter.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobhunter.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
from jobhunter.scoring.activities import score_activity
from jobhunter.llm import SpendBudgetStatus

_OK_OBSERVED = ({"status": "ok"}, 0.0, "ok")


@activity.defn(name="check_spend_budget")
async def _check_spend_budget(_payload) -> SpendBudgetStatus:
    return SpendBudgetStatus(
        day="2026-07-03",
        input_tokens=0,
        output_tokens=0,
        estimated_usd=0.0,
        daily_budget_usd=25.0,
        exceeded=False,
    )


def _activities():
    return [score_activity, _check_spend_budget, record_workflow_started, record_workflow_outcome]


def _workflow_run_row(workflow_id: str):
    conn = get_connection()
    return conn.execute(
        "SELECT status, workflow_type, error_code, error_message, events_json FROM workflow_run_projections WHERE workflow_id = ?",
        (workflow_id,),
    ).fetchone()


def _row_value(row, key):
    if row is None:
        return None
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return None


@pytest.mark.asyncio
async def test_finalize_records_succeeded_on_normal_completion() -> None:
    queue = f"finalize-ok-{uuid.uuid4()}"
    workflow_id = f"run-{uuid.uuid4().hex}"

    with patch("jobhunter.pipeline.runner._run_stage_observed", return_value=_OK_OBSERVED):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(tenant_id="local", stages=["score"]),
                    id=workflow_id,
                    task_queue=queue,
                )

    row = _workflow_run_row(workflow_id)
    assert _row_value(row, "status") == "succeeded"
    assert _row_value(row, "workflow_type") == "JobPipelineWorkflow"
    events = _row_value(row, "events_json") or "[]"
    assert "WorkflowStarted" in events
    assert "WorkflowCompleted" in events


@pytest.mark.asyncio
async def test_finalize_records_failed_on_stage_failure() -> None:
    queue = f"finalize-fail-{uuid.uuid4()}"
    workflow_id = f"run-{uuid.uuid4().hex}"

    failing = ({"status": "failed", "error": "llm exploded"}, 0.1, "failed")
    with patch("jobhunter.pipeline.runner._run_stage_observed", return_value=failing):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(tenant_id="local", stages=["score"]),
                    id=workflow_id,
                    task_queue=queue,
                )

    row = _workflow_run_row(workflow_id)
    assert _row_value(row, "status") == "failed"
    assert "WorkflowFailed" in (_row_value(row, "events_json") or "[]")


@pytest.mark.asyncio
async def test_configuration_error_records_non_retryable_error_code_on_attempt_one() -> None:
    queue = f"finalize-config-{uuid.uuid4()}"
    workflow_id = f"run-{uuid.uuid4().hex}"
    attempts = 0

    def _raise_configuration(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        raise ConfigurationError("missing scoring config")

    with patch("jobhunter.pipeline.runner._run_stage_observed", side_effect=_raise_configuration):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(tenant_id="local", stages=["score"]),
                    id=workflow_id,
                    task_queue=queue,
                )

    row = _workflow_run_row(workflow_id)
    assert attempts == 1
    assert result.stages_failed == ["score"]
    assert _row_value(row, "status") == "failed"
    assert _row_value(row, "error_code") == "configuration"


@pytest.mark.asyncio
async def test_transient_error_retries_then_records_succeeded() -> None:
    queue = f"finalize-transient-{uuid.uuid4()}"
    workflow_id = f"run-{uuid.uuid4().hex}"
    attempts = 0

    def _raise_twice(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise TransientNetworkError("temporary network outage")
        return _OK_OBSERVED

    with patch("jobhunter.pipeline.runner._run_stage_observed", side_effect=_raise_twice):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(tenant_id="local", stages=["score"]),
                    id=workflow_id,
                    task_queue=queue,
                )

    row = _workflow_run_row(workflow_id)
    assert attempts == 3
    assert result.stages_completed == ["score"]
    assert _row_value(row, "status") == "succeeded"
    assert "WorkflowCompleted" in (_row_value(row, "events_json") or "[]")


@pytest.mark.asyncio
async def test_workflow_cancel_records_canceled_projection_row() -> None:
    queue = f"finalize-cancel-{uuid.uuid4()}"
    workflow_id = f"run-{uuid.uuid4().hex}"
    runner_started = threading.Event()
    runner_observed_cancel = threading.Event()

    def _blocking_runner(_stage, _runner, kwargs, **_ignored):
        cancel_event = kwargs.get("cancel_event")
        runner_started.set()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if cancel_event is not None and cancel_event.is_set():
                runner_observed_cancel.set()
                return _OK_OBSERVED
            time.sleep(0.01)
        return _OK_OBSERVED

    with patch("jobhunter.pipeline.runner._run_stage_observed", side_effect=_blocking_runner):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(tenant_id="local", stages=["score"]),
                    id=workflow_id,
                    task_queue=queue,
                )
                assert await asyncio.to_thread(runner_started.wait, 5)
                await handle.cancel()

                with pytest.raises(WorkflowFailureError):
                    await handle.result()

                row = None
                for _ in range(50):
                    row = _workflow_run_row(workflow_id)
                    if _row_value(row, "status") == "canceled":
                        break
                    await asyncio.sleep(0.1)

    assert runner_observed_cancel.is_set()
    assert _row_value(row, "status") == "canceled"
    assert _row_value(row, "error_code") == "workflow_canceled"
    assert "WorkflowCanceled" in (_row_value(row, "events_json") or "[]")
