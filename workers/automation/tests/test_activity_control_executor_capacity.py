"""Synthetic control execution while canceled stage generations remain live."""

import asyncio
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from jobctrl import config, database
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.preparation_recovery import CancelPreparationStateInput, cancel_preparation_state_activity
from jobctrl.infrastructure.temporal import run_in_activity as ria
from jobctrl.infrastructure.temporal.finalize import (
    WorkflowOutcomeInput, WorkflowStartedInput, record_workflow_outcome, record_workflow_started,
)
from jobctrl.llm import SpendBudgetInput, check_spend_budget, record_llm_spend
from jobctrl.state import ensure_job_stage_rows, set_stage_state


async def wait_status(predicate):
    async def poll():
        while not predicate(ria.activity_executor_status()):
            await asyncio.sleep(0.001)
    await asyncio.wait_for(poll(), 2)


@pytest.mark.asyncio
async def test_real_controls_settle_owned_state_while_all_stage_generations_remain_blocked(monkeypatch, tmp_path):
    from jobctrl.infrastructure.scoring import criteria_provider

    db_path = tmp_path / "controls.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr(criteria_provider, "read_daily_budget_usd", lambda **_: 1.0)
    monkeypatch.setattr(ria, "_record_abandoned_thread_metric", lambda *_: None)
    conn = database.init_db(db_path)
    jobs = [str(canonical_job_id(str(uuid.uuid4()))) for _ in range(2)]
    for job_id, owner in zip(jobs, ("old-owner", "successor-owner"), strict=True):
        conn.execute(
            "INSERT INTO jobs (tenant_id,job_id,url,title,company,site,strategy,discovered_at) "
            "VALUES ('local',?,?,'Synthetic role','Synthetic company','synthetic','test',?)",
            (job_id, f"https://example.test/{job_id}", "2026-10-21T00:00:00+00:00"),
        )
        ensure_job_stage_rows(conn, canonical_job_id(job_id), tenant_id=LOCAL_TENANT)
        set_stage_state(conn, canonical_job_id(job_id), "cover", "running", tenant_id=LOCAL_TENANT,
                        metadata={"activityOwner": owner}, validate_transition=False)
    conn.commit()
    record_llm_spend(lane="scoring", input_tokens=1, output_tokens=1, estimated_usd=1.0)
    starts = [threading.Event() for _ in range(3)]
    releases = [threading.Event() for _ in range(3)]
    tasks = []
    cleanup_threads = []
    actual_cleanup = database.close_thread_connections

    def tracked_cleanup():
        cleanup_threads.append(threading.get_ident())
        return actual_cleanup()

    monkeypatch.setattr(database, "close_thread_connections", tracked_cleanup)
    ria.set_activity_executor(ThreadPoolExecutor(max_workers=1))

    def hold(index):
        starts[index].set()
        if not releases[index].wait(10):
            raise TimeoutError("synthetic stage not released")

    async def stage(index):
        return await ria.run_blocking_with_heartbeat(
            lambda: hold(index), starting_message="synthetic", activity_name="synthetic",
            poll_interval=0.01, cancel_wait_seconds=0.01,
        )

    try:
        for index in range(3):
            env = ActivityEnvironment()
            task = asyncio.create_task(env.run(stage, index))
            tasks.append(task)
            assert await asyncio.to_thread(starts[index].wait, 2)
            env.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        before = ria.activity_executor_status()
        assert before.next_submission == "refusing"
        assert before.control_next_submission == "accepting"
        assert before.unfinished_retired_calls == 3

        payload = CancelPreparationStateInput(
            tenant_id="local", workflow_id="old-owner", stage="cover", job_ids=tuple(jobs),
            expected_app_dir=str(tmp_path), expected_db_path=str(db_path),
        )
        result = await asyncio.wait_for(ActivityEnvironment().run(cancel_preparation_state_activity, payload), 2)
        assert result.canceled == 1
        rows = dict(conn.execute("SELECT job_id,state FROM job_stage_states WHERE stage='cover'"))
        assert rows == {jobs[0]: "canceled", jobs[1]: "running"}

        with pytest.raises(ApplicationError) as budget:
            await asyncio.wait_for(ActivityEnvironment().run(check_spend_budget, SpendBudgetInput(lane="scoring")), 2)
        assert budget.value.type == "budget_exceeded" and budget.value.non_retryable
        common = dict(tenant_id="local", workflow_id="synthetic-workflow", workflow_type="synthetic",
                      temporal_run_id="synthetic-run", expected_app_dir=str(tmp_path), expected_db_path=str(db_path))
        await asyncio.wait_for(ActivityEnvironment().run(record_workflow_started, WorkflowStartedInput(**common)), 2)
        await asyncio.wait_for(ActivityEnvironment().run(
            record_workflow_outcome, WorkflowOutcomeInput(status="canceled", **common)), 2)
        event_types = {row[0] for row in conn.execute("SELECT event_type FROM job_events WHERE stage='workflow'")}
        assert {"WorkflowStarted", "WorkflowCanceled"} <= event_types
        assert cleanup_threads and all(thread != threading.get_ident() for thread in cleanup_threads)
        after = ria.activity_executor_status()
        assert after.next_submission == "refusing" and after.unfinished_retired_calls == 3
        assert after.control_next_submission == "accepting" and after.control_unfinished_calls == 0
        assert not any(event.is_set() for event in releases)
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='cover'", (jobs[1],)).fetchone()[0] == "running"
    finally:
        for event in releases:
            event.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await ria.drain_activity_executors()
        ria.set_activity_executor(None)
        database.close_thread_connections()


@pytest.mark.asyncio
async def test_control_lane_refuses_at_two_then_recovers_only_after_return(monkeypatch):
    monkeypatch.setattr(ria, "_record_abandoned_thread_metric", lambda *_: None)
    starts = [threading.Event(), threading.Event()]
    releases = [threading.Event(), threading.Event()]
    tokens = [threading.Event(), threading.Event()]
    tasks = []

    def hold(index):
        starts[index].set()
        if not releases[index].wait(10):
            raise TimeoutError("synthetic control not released")

    async def control(index):
        return await ria.run_blocking_with_heartbeat(
            lambda: hold(index), starting_message="control", activity_name="synthetic-control",
            poll_interval=0.01, cancel_wait_seconds=0.01, on_cancel=tokens[index].set, control=True,
        )

    async def healthy():
        return await ria.run_blocking_with_heartbeat(
            lambda: "recovered", starting_message="control", activity_name="synthetic-control", control=True,
        )

    ria.set_activity_executor(ThreadPoolExecutor(max_workers=1))
    try:
        for index in range(2):
            env = ActivityEnvironment()
            task = asyncio.create_task(env.run(control, index))
            tasks.append(task)
            assert await asyncio.to_thread(starts[index].wait, 2)
            env.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert tokens[index].is_set()
        status = ria.activity_executor_status()
        assert status.control_next_submission == "refusing" and status.control_unfinished_calls == 2
        assert status.unfinished_retired_generations == 0
        with pytest.raises(ria.ControlActivityCapacityExhausted) as error:
            await ActivityEnvironment().run(healthy)
        assert error.value.retryable
        releases[0].set()
        await wait_status(lambda status: status.control_next_submission == "accepting")
        assert await ActivityEnvironment().run(healthy) == "recovered"
        assert not releases[1].is_set()
        drain = asyncio.create_task(ria.drain_activity_executors())
        await asyncio.sleep(0.02)
        assert not drain.done()
        assert ria.activity_executor_status().control_next_submission == "draining"
        releases[1].set()
        await asyncio.wait_for(drain, 2)
    finally:
        for event in releases:
            event.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        if not ria._ACTIVITY_DRAINING:
            await ria.drain_activity_executors()
        ria.set_activity_executor(None)
