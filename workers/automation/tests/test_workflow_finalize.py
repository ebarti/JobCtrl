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

import uuid
from unittest.mock import patch

import pytest
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.database import get_connection
from jobhunter.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobhunter.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
from jobhunter.scoring.activities import score_activity

_OK_RESULT = {"stages": [{"stage": "score", "status": "ok", "elapsed": 0.0}]}


def _workflow_run_row(workflow_id: str):
    conn = get_connection()
    return conn.execute(
        "SELECT status, workflow_type, error_message, events_json FROM workflow_run_projections WHERE workflow_id = ?",
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

    with patch("jobhunter.pipeline.run_pipeline", return_value=_OK_RESULT):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=[score_activity, record_workflow_started, record_workflow_outcome],
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

    failing = {
        "stages": [{"stage": "score", "status": "failed", "elapsed": 0.1}],
        "errors": {"score": "llm exploded"},
        "elapsed": 0.1,
    }
    with patch("jobhunter.pipeline.run_pipeline", return_value=failing):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=[score_activity, record_workflow_started, record_workflow_outcome],
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
