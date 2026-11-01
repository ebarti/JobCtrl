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
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError
from .temporal_env import local_env, time_skipping_env
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl.database import get_connection
from jobctrl.domain.errors import ConfigurationError, TransientNetworkError
from jobctrl.domain.events.workflow import WorkflowCompletedPayload, create_workflow_completed
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.temporal.finalize import (
    _emit,
    record_workflow_outcome,
    record_workflow_started,
)
from jobctrl.infrastructure.preparation_recovery import recover_preparation_state_activity
from jobctrl.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
from jobctrl.scoring.activities import score_activity
from jobctrl.llm import SpendBudgetStatus
from jobctrl.discovery.job_url_import_workflow import JobUrlImportWorkflow, JobUrlImportWorkflowInput
from jobctrl.infrastructure.temporal.activity_runtime_telemetry import ActiveActivityInventory
from jobctrl.infrastructure.temporal.worker import build_worker
from jobctrl.infrastructure.temporal.run_in_activity import shutdown_activity_executors

_OK_OBSERVED = ({"status": "ok"}, 0.0, "ok")


@activity.defn(name="check_spend_budget")
async def _check_spend_budget(_payload) -> SpendBudgetStatus:
    return SpendBudgetStatus(
        day="2026-07-03",
        input_tokens=0,
        output_tokens=0,
        estimated_usd=0.0,
        daily_budget_usd=25.0,
        lane="scoring",
        lane_input_tokens=0,
        lane_output_tokens=0,
        lane_token_limit=0,
        lane_exceeded=False,
        global_exceeded=False,
        exceeded=False,
    )


def _activities():
    return [
        score_activity,
        recover_preparation_state_activity,
        _check_spend_budget,
        record_workflow_started,
        record_workflow_outcome,
    ]


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


def test_repeated_lifecycle_write_is_idempotent_only_for_the_exact_execution() -> None:
    workflow_id, first_run, second_run = f"run-{uuid.uuid4().hex}", str(uuid.uuid4()), str(uuid.uuid4())

    def emit(run_id):
        _emit(None, None, create_workflow_completed(LOCAL_TENANT, WorkflowCompletedPayload(
            workflow_id=workflow_id, workflow_type="JobPipelineWorkflow", temporal_run_id=run_id,
        )))

    emit(first_run)
    emit(first_run)
    def count():
        return get_connection().execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type='WorkflowCompleted' AND json_extract(payload_json, '$.workflowId')=?",
            (workflow_id,),
        ).fetchone()[0]
    assert count() == 1
    emit(second_run)
    emit(second_run)
    assert count() == 2


@pytest.mark.asyncio
async def test_canceling_url_import_records_canceled_instead_of_failed() -> None:
    queue, workflow_id = f"import-cancel-{uuid.uuid4()}", f"import-cancel-{uuid.uuid4()}"
    started = asyncio.Event()

    @activity.defn(name="job_url_import")
    async def pending_import(_payload):
        started.set()
        await asyncio.Event().wait()

    async with time_skipping_env() as env:
        async with Worker(
            env.client, task_queue=queue, workflows=[JobUrlImportWorkflow],
            activities=[pending_import, record_workflow_started, record_workflow_outcome],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            handle = await env.client.start_workflow(
                JobUrlImportWorkflow.run, JobUrlImportWorkflowInput(tenant_id="local", url="https://example.com/jobs/owned"),
                id=workflow_id, task_queue=queue,
            )
            await asyncio.wait_for(started.wait(), timeout=5)
            await handle.cancel()
            with pytest.raises(WorkflowFailureError) as failed:
                await handle.result()
            assert isinstance(failed.value.cause, CancelledError)
    row = _workflow_run_row(workflow_id)
    assert _row_value(row, "status") == "canceled"
    assert _row_value(row, "error_code") == "workflow_canceled"
    assert "WorkflowFailed" not in _row_value(row, "events_json")


@pytest.mark.asyncio
async def test_lifecycle_records_complete_while_all_remote_activity_slots_are_occupied() -> None:
    queue = f"finalize-capacity-{uuid.uuid4()}"
    busy_id, control_id = f"run-{uuid.uuid4().hex}", f"run-{uuid.uuid4().hex}"
    started, release = asyncio.Event(), asyncio.Event()
    inventory = ActiveActivityInventory()

    @activity.defn(name="score")
    async def busy_score(_payload):
        started.set()
        await release.wait()
        return {"status": "ok", "elapsed": 0.0}

    async with local_env() as env:
        worker = build_worker(
            env.client, task_queue=queue, workflows=[JobPipelineWorkflow],
            activities=[busy_score, _check_spend_budget, record_workflow_started, record_workflow_outcome],
            max_concurrent_activities=1, activity_inventory=inventory,
        )
        try:
            async with worker:
                busy = await env.client.start_workflow(
                    JobPipelineWorkflow.run, JobPipelineWorkflowInput(tenant_id="local", stages=["score"]),
                    id=busy_id, task_queue=queue,
                )
                await asyncio.wait_for(started.wait(), timeout=5)
                control = await env.client.start_workflow(
                    JobPipelineWorkflow.run, JobPipelineWorkflowInput(tenant_id="local", stages=[]),
                    id=control_id, task_queue=queue,
                )
                try:
                    await asyncio.wait_for(control.result(), timeout=3)
                    assert _row_value(_workflow_run_row(control_id), "status") == "succeeded"
                    assert inventory.snapshot().active_activity_count == 1
                    assert not release.is_set()
                finally:
                    release.set()
                    await asyncio.wait_for(busy.result(), timeout=5)
                    await asyncio.wait_for(control.result(), timeout=5)
            history = await env.client.get_workflow_handle(control_id).fetch_history()
            await Replayer(
                workflows=[JobPipelineWorkflow], workflow_runner=UnsandboxedWorkflowRunner(),
            ).replay_workflow(history)
        finally:
            shutdown_activity_executors()


@activity.defn(name="record_workflow_started")
async def _fail_start_marker(_payload) -> None:
    raise ApplicationError("Synthetic lifecycle-start failure", type="configuration", non_retryable=True)


@pytest.mark.asyncio
async def test_finalize_records_failure_when_start_marker_activity_fails() -> None:
    queue = f"finalize-start-fail-{uuid.uuid4()}"
    workflow_id = f"run-{uuid.uuid4().hex}"
    activities = [a for a in _activities() if a is not record_workflow_started]
    async with time_skipping_env() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[JobPipelineWorkflow],
            activities=[*activities, _fail_start_marker],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            with pytest.raises(WorkflowFailureError) as failed:
                await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(tenant_id="local", stages=["score"]),
                    id=workflow_id,
                    task_queue=queue,
                )
            assert isinstance(failed.value.cause, (ActivityError, ApplicationError))
        history = await env.client.get_workflow_handle(workflow_id).fetch_history()
        await Replayer(
            workflows=[JobPipelineWorkflow], workflow_runner=UnsandboxedWorkflowRunner()
        ).replay_workflow(history)
    row = _workflow_run_row(workflow_id)
    assert row is not None
    assert _row_value(row, "status") == "failed"
    assert _row_value(row, "error_code") == "configuration"
    assert "WorkflowFailed" in (_row_value(row, "events_json") or "[]")


@pytest.mark.asyncio
async def test_start_failure_history_without_new_patch_remains_replayable() -> None:
    queue = f"finalize-legacy-start-{uuid.uuid4()}"
    workflow_id = f"run-{uuid.uuid4().hex}"
    activities = [a for a in _activities() if a is not record_workflow_started]
    async with time_skipping_env() as env:
        with patch("jobctrl.infrastructure.temporal.finalize.workflow.patched", return_value=False):
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=[*activities, _fail_start_marker],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                with pytest.raises(WorkflowFailureError):
                    await env.client.execute_workflow(
                        JobPipelineWorkflow.run,
                        JobPipelineWorkflowInput(tenant_id="local", stages=["score"]),
                        id=workflow_id,
                        task_queue=queue,
                    )
        assert _workflow_run_row(workflow_id) is None
        history = await env.client.get_workflow_handle(workflow_id).fetch_history()
        await Replayer(
            workflows=[JobPipelineWorkflow], workflow_runner=UnsandboxedWorkflowRunner()
        ).replay_workflow(history)


@pytest.mark.asyncio
async def test_finalize_records_succeeded_on_normal_completion() -> None:
    queue = f"finalize-ok-{uuid.uuid4()}"
    workflow_id = f"run-{uuid.uuid4().hex}"

    with patch("jobctrl.pipeline.runner._run_stage_observed", return_value=_OK_OBSERVED):
        async with time_skipping_env() as env:
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
    with patch("jobctrl.pipeline.runner._run_stage_observed", return_value=failing):
        async with time_skipping_env() as env:
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

    with patch("jobctrl.pipeline.runner._run_stage_observed", side_effect=_raise_configuration):
        async with time_skipping_env() as env:
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

    with patch("jobctrl.pipeline.runner._run_stage_observed", side_effect=_raise_twice):
        async with time_skipping_env() as env:
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

    with patch("jobctrl.pipeline.runner._run_stage_observed", side_effect=_blocking_runner):
        async with time_skipping_env() as env:
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
