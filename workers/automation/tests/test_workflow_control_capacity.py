"""Short controls must finish while the configured remote capacity stays full."""
from __future__ import annotations

import asyncio
from datetime import timedelta
import json
import threading
import uuid
from unittest.mock import patch

import pytest
from temporalio import activity, workflow
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner

from jobctrl.database import get_connection, init_db
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.preparation_recovery import cancel_preparation_state_activity
from jobctrl.infrastructure.temporal.activity_runtime_telemetry import ActiveActivityInventory
from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
from jobctrl.infrastructure.temporal.run_in_activity import (
    run_blocking_with_heartbeat,
    shutdown_activity_executors,
)
from jobctrl.infrastructure.temporal.worker import build_worker
from jobctrl.llm import check_spend_budget, record_llm_spend
from jobctrl.preparation.workflow import (
    JobPreparationInput,
    JobPreparationWorkflow,
    _cancel_material_stage_state,
)
from jobctrl.state import ensure_job_stage_rows, set_stage_state
from .temporal_env import local_env

_CONTROL_PATCHES = {"workflow-local-spend-preflight-v1", "workflow-local-preparation-cancel-v1"}


@workflow.defn
class _HoldRemoteWorkflow:
    @workflow.run
    async def run(self) -> None:
        await workflow.execute_activity(
            "hold_remote", start_to_close_timeout=timedelta(seconds=30),
        )


@workflow.defn
class _CancelControlWorkflow:
    def __init__(self):
        self.ready = False

    @workflow.query
    def is_ready(self) -> bool:
        return self.ready

    @workflow.run
    async def run(self, payload: JobPreparationInput) -> None:
        self.ready = True
        try:
            await workflow.wait_condition(lambda: False)
        except (asyncio.CancelledError, CancelledError):
            # The same owner-scoped cancellation helper as JobPreparationWorkflow.
            await _cancel_material_stage_state("cover", payload)
            raise


def _seed_cover(owner: str) -> str:
    jid = canonical_job_id(str(uuid.uuid4()))
    conn = get_connection()
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,title,company,site,strategy,discovered_at) "
        "VALUES ('local',?,?,'Synthetic role','Synthetic company','synthetic','test',?)",
        (str(jid), f"https://example.test/{jid}", "2026-10-21T00:00:00+00:00"),
    )
    ensure_job_stage_rows(conn, jid, tenant_id=LOCAL_TENANT)
    set_stage_state(
        conn, jid, "cover", "running", tenant_id=LOCAL_TENANT,
        metadata={"activityOwner": owner}, validate_transition=False,
    )
    conn.commit()
    return str(jid)


async def _until(predicate, timeout=5):
    async def wait():
        while not predicate():
            await asyncio.sleep(0.01)
    await asyncio.wait_for(wait(), timeout)


@pytest.mark.parametrize("slots", [1, 4])
@pytest.mark.parametrize("control", ["cancel", "budget"])
@pytest.mark.asyncio
async def test_control_finishes_with_all_remote_slots_held(monkeypatch, tmp_path, slots, control):
    import jobctrl.database as database
    db = tmp_path / "controls.db"
    monkeypatch.setattr(database, "DB_PATH", db)
    init_db(db)
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"daily_budget_usd": 1.0}))
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config))
    record_llm_spend(lane="scoring", input_tokens=1, output_tokens=1, estimated_usd=1.0)
    release = threading.Event()
    started = []
    lock = threading.Lock()
    inventory = ActiveActivityInventory()

    @activity.defn(name="hold_remote")
    async def hold_remote():
        def hold():
            with lock:
                started.append(threading.get_ident())
            assert release.wait(20), "test did not release synthetic heavy work"
        await run_blocking_with_heartbeat(hold, starting_message="held", poll_interval=0.1)

    queue = f"control-capacity-{uuid.uuid4()}"
    async with local_env() as env:
        worker = build_worker(
            env.client, task_queue=queue,
            workflows=[_HoldRemoteWorkflow, _CancelControlWorkflow, JobPreparationWorkflow],
            activities=[hold_remote, cancel_preparation_state_activity, check_spend_budget,
                        record_workflow_started, record_workflow_outcome],
            max_concurrent_activities=slots, activity_inventory=inventory,
        )
        handle = None
        holds = []
        try:
            async with worker:
                try:
                    for _ in range(slots + 1):
                        holds.append(await env.client.start_workflow(
                            _HoldRemoteWorkflow.run, id=f"hold-{uuid.uuid4()}", task_queue=queue,
                        ))
                    await _until(lambda: len(started) == slots)
                    if control == "cancel":
                        jid = _seed_cover("unbound")
                        handle = await env.client.start_workflow(
                            _CancelControlWorkflow.run,
                            JobPreparationInput(tenant_id="local", job_id=canonical_job_id(jid),
                                                steps=["cover"], target_version="test", idempotency_key="test"),
                            id=f"cancel-{uuid.uuid4()}", task_queue=queue,
                        )
                        while not await handle.query(_CancelControlWorkflow.is_ready):
                            await asyncio.sleep(0.01)
                        conn = get_connection()
                        conn.execute(
                            "UPDATE job_stage_states SET metadata_json=? WHERE job_id=? AND stage='cover'",
                            (json.dumps({"activityOwner": handle.first_execution_run_id}), jid),
                        )
                        conn.commit()
                        successor = _seed_cover("successor-owner")
                        await handle.cancel()
                    else:
                        jid = str(uuid.uuid4())
                        handle = await env.client.start_workflow(
                            JobPreparationWorkflow.run,
                            JobPreparationInput(tenant_id="local", job_id=canonical_job_id(jid),
                                                steps=["score"], target_version="test", idempotency_key="test"),
                            id=f"budget-{uuid.uuid4()}", task_queue=queue,
                        )
                    with pytest.raises(WorkflowFailureError) as failure:
                        await asyncio.wait_for(handle.result(), timeout=3)
                    if control == "cancel":
                        assert isinstance(failure.value.cause, CancelledError)
                        rows = dict(get_connection().execute(
                            "SELECT job_id,state FROM job_stage_states WHERE stage='cover'",
                        ))
                        assert rows[jid] == "canceled"
                        assert rows[successor] == "running"
                    else:
                        cause = failure.value.cause
                        if isinstance(cause, ActivityError):
                            cause = cause.cause
                        assert isinstance(cause, ApplicationError)
                        assert cause.type == "budget_exceeded"
                        assert cause.non_retryable
                    assert len(started) == slots  # Queued heavy work has not been admitted.
                    assert inventory.snapshot().active_activity_count == slots
                    assert not release.is_set()
                    history = await handle.fetch_history()
                    assert not any(e.HasField("activity_task_scheduled_event_attributes") for e in history.events)
                    await Replayer(
                        workflows=[_CancelControlWorkflow, JobPreparationWorkflow],
                        workflow_runner=UnsandboxedWorkflowRunner(),
                    ).replay_workflow(history)
                finally:
                    release.set()
                    # A timed-out observation does not cancel the actual workflow.
                    if handle is not None:
                        try:
                            await asyncio.wait_for(handle.result(), timeout=5)
                        except WorkflowFailureError:
                            pass
                    for hold in holds:
                        await asyncio.wait_for(hold.result(), timeout=5)
        finally:
            shutdown_activity_executors()



@pytest.mark.asyncio
async def test_old_remote_spend_and_cancel_histories_still_replay(monkeypatch):
    queue = f"old-controls-{uuid.uuid4()}"
    original_patched = workflow.patched
    def old_controls(marker):
        return False if marker in _CONTROL_PATCHES else original_patched(marker)

    async with local_env() as env:
        worker = build_worker(
            env.client, task_queue=queue,
            workflows=[_CancelControlWorkflow, JobPreparationWorkflow],
            activities=[cancel_preparation_state_activity, check_spend_budget,
                        record_workflow_started, record_workflow_outcome],
        )
        try:
            with patch("temporalio.workflow.patched", side_effect=old_controls):
                async with worker:
                    # Install refusal before dispatch, so worker timing cannot
                    # accidentally admit an unregistered heavy activity.
                    with patch(
                        "jobctrl.llm.enforce_spend_budget",
                        side_effect=ApplicationError("Synthetic refusal", type="budget_exceeded", non_retryable=True),
                    ):
                        budget = await env.client.start_workflow(
                            JobPreparationWorkflow.run,
                            JobPreparationInput(tenant_id="local", job_id=canonical_job_id(str(uuid.uuid4())),
                                                steps=["score"], target_version="old", idempotency_key="old"),
                            id=f"old-budget-{uuid.uuid4()}", task_queue=queue,
                        )
                        with pytest.raises(WorkflowFailureError):
                            await asyncio.wait_for(budget.result(), timeout=5)
                    cancel = await env.client.start_workflow(
                        _CancelControlWorkflow.run,
                        JobPreparationInput(tenant_id="local", job_id=canonical_job_id(str(uuid.uuid4())),
                                            steps=["cover"], target_version="old", idempotency_key="old"),
                        id=f"old-cancel-{uuid.uuid4()}", task_queue=queue,
                    )
                    while not await cancel.query(_CancelControlWorkflow.is_ready):
                        await asyncio.sleep(0.01)
                    await cancel.cancel()
                    with pytest.raises(WorkflowFailureError):
                        await asyncio.wait_for(cancel.result(), timeout=5)
            for handle in (budget, cancel):
                history = await handle.fetch_history()
                remote_names = [e.activity_task_scheduled_event_attributes.activity_type.name
                                for e in history.events if e.HasField("activity_task_scheduled_event_attributes")]
                expected = "check_spend_budget" if handle is budget else "cancel_preparation_state"
                assert remote_names == [expected]
                await Replayer(
                    workflows=[_CancelControlWorkflow, JobPreparationWorkflow],
                    workflow_runner=UnsandboxedWorkflowRunner(),
                ).replay_workflow(history)
        finally:
            shutdown_activity_executors()


@pytest.mark.asyncio
async def test_model_work_cannot_enter_the_local_control_pool():
    from jobctrl.infrastructure.temporal.control import execute_control_activity
    with pytest.raises(ValueError, match="not an allowlisted workflow control"):
        await execute_control_activity(object(), None)
