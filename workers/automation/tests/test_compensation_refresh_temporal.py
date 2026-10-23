"""Actual activity timeout propagation with synthetic public rows and an owned DB."""
import asyncio
from datetime import timedelta
import threading
from types import SimpleNamespace
import uuid

import pytest
from temporalio import workflow
from temporalio.client import WorkflowFailureError
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, TimeoutError as ActivityTimeout, TimeoutType
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl import database as database_module
from jobctrl.database import close_connection, init_db
from jobctrl.discovery.activities import AutomaticCompensationRefreshActivityInput, automatic_compensation_refresh_activity
from jobctrl.infrastructure.compensation.sqlite_market_repository import ReportedCompensationSourceLoad
from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat, shutdown_activity_executors
from tests.compensation_fakes import ClassificationModel, configure_classifier, observation, put_job, refresh
from tests.temporal_env import local_env


@workflow.defn(name="OwnedCompensationTimeoutWorkflow")
class OwnedCompensationTimeoutWorkflow:
    @workflow.run
    async def run(self):
        return await workflow.execute_activity(
            automatic_compensation_refresh_activity,
            AutomaticCompensationRefreshActivityInput(tenant_id="local"),
            start_to_close_timeout=timedelta(seconds=2),
            heartbeat_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("capacity", [1, 2])
async def test_real_activity_timeout_stops_admission_and_releases_owned_refresh(tmp_path, monkeypatch, capacity):
    path = tmp_path / "owned-compensation-timeout.sqlite"
    monkeypatch.setattr(database_module, "DB_PATH", path)
    conn = init_db(path)
    put_job(conn)
    configure_classifier(monkeypatch, ClassificationModel())
    refresh(conn)
    accepted = conn.execute("SELECT last_direct_fact_id FROM compensation_market_refresh_state").fetchone()[0]
    release = threading.Event()
    started = threading.Event()
    lock = threading.Lock()
    calls = 0

    class Model(ClassificationModel):
        def chat_json(self, *args, **kwargs):
            nonlocal calls
            with lock:
                calls += 1
                if calls == capacity:
                    started.set()
            assert release.wait(timeout=10)
            return super().chat_json(*args, **kwargs)

    configure_classifier(monkeypatch, Model())
    async def fast_heartbeat(fn, **kwargs):
        # A server timeout is delivered to the worker through heartbeating.
        # Scale the poll with this fixture's two-second activity deadline.
        kwargs["poll_interval"] = 0.05
        return await run_blocking_with_heartbeat(fn, **kwargs)

    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat", fast_heartbeat,
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.concurrency.resolve_max_concurrent_activities",
        lambda: SimpleNamespace(value=capacity),
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.automatic_refresh.load_default_reported_compensation_observations",
        lambda **_kwargs: ReportedCompensationSourceLoad(observations=tuple(
            observation(source_url=f"https://example.org/timeout/{i}") for i in range(6)
        )),
    )

    def no_live_fetch(**_kwargs):
        raise AssertionError("owned timeout QA cannot fetch a public provider")

    monkeypatch.setattr("jobctrl.infrastructure.compensation.automatic_refresh.load_ecb_daily_exchange_rates", no_live_fetch)
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.automatic_refresh.load_eurostat_actual_individual_consumption_price_levels",
        no_live_fetch,
    )
    try:
        async with local_env() as env:
            queue = f"owned-compensation-{uuid.uuid4()}"
            async with Worker(
                env.client, task_queue=queue,
                workflows=[OwnedCompensationTimeoutWorkflow], activities=[automatic_compensation_refresh_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                try:
                    handle = await env.client.start_workflow(
                        OwnedCompensationTimeoutWorkflow.run, id=f"owned-compensation-{uuid.uuid4()}",
                        task_queue=queue,
                    )
                    assert await asyncio.to_thread(started.wait, 5)
                    with pytest.raises(WorkflowFailureError) as failure:
                        await asyncio.wait_for(handle.result(), 10)
                    assert isinstance(failure.value.cause, ActivityError)
                    assert isinstance(failure.value.cause.cause, ActivityTimeout)
                    assert failure.value.cause.cause.type == TimeoutType.START_TO_CLOSE
                    deadline = asyncio.get_running_loop().time() + 3
                    while asyncio.get_running_loop().time() < deadline:
                        row = conn.execute(
                            "SELECT refresh_status,last_error_code,lease_owner,last_direct_fact_id "
                            "FROM compensation_market_refresh_state",
                        ).fetchone()
                        if row[0] == "failed":
                            break
                        await asyncio.sleep(0.01)
                    assert tuple(row) == ("failed", "compensation_refresh_canceled", None, accepted)
                    assert calls == capacity and not release.is_set()
                finally:
                    release.set()
    finally:
        release.set()
        shutdown_activity_executors()
        close_connection(path)
