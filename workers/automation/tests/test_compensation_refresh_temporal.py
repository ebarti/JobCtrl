"""Actual activity timeout propagation with synthetic public rows and an owned DB."""
import asyncio
import json
from datetime import timedelta
import threading
from types import SimpleNamespace
from urllib.error import HTTPError
import uuid

import pytest
from temporalio import workflow
from temporalio.client import WorkflowFailureError
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, TimeoutError as ActivityTimeout, TimeoutType
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl import database as database_module
from jobctrl.database import close_connection, init_db
from jobctrl.discovery.activities import (
    AutomaticCompensationRefreshActivityInput, AutomaticCompensationRefreshActivityOutput,
    automatic_compensation_refresh_activity,
)
from jobctrl.infrastructure.compensation.levels_fyi_public import load_levels_fyi_public_observations
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


@workflow.defn(name="OwnedCompensationReceiptWorkflow")
class OwnedCompensationReceiptWorkflow:
    @workflow.run
    async def run(self) -> AutomaticCompensationRefreshActivityOutput:
        return await workflow.execute_activity(
            automatic_compensation_refresh_activity,
            AutomaticCompensationRefreshActivityInput(tenant_id="local"),
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_kind", ["unavailable", "page_budget_exhausted", "unparsed"])
async def test_actual_activity_records_scoped_source_and_cached_classification_receipts(
    tmp_path, monkeypatch, failure_kind,
):
    path = tmp_path / "owned-compensation-receipts.sqlite"
    monkeypatch.setattr(database_module, "DB_PATH", path)
    conn = init_db(path)
    put_job(conn, family="engineering_management", seniority="director")
    put_job(conn, job_id="22222222-2222-4222-8222-222222222222", family="operations", seniority="director")
    model = ClassificationModel(family="unknown")
    configure_classifier(monkeypatch, model)
    refresh(conn, rows=(observation(),))
    assert len(model.calls) == 1
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.concurrency.resolve_max_concurrent_activities",
        lambda: SimpleNamespace(value=2),
    )

    def fetch(url):
        if failure_kind == "page_budget_exhausted":
            pytest.fail("zero allowance must perform no public request")
        if failure_kind == "unavailable":
            raise HTTPError(url, 403, "private exception message", {}, None)
        return "<html><body>synthetic unsupported salary structure</body></html>"

    def load(**kwargs):
        outcomes = []
        load_levels_fyi_public_observations(
            kwargs["levels_fyi_targets"], fetch_text=fetch, on_load_outcome=outcomes.append,
            max_pages=0 if failure_kind == "page_budget_exhausted" else 25,
        )
        return ReportedCompensationSourceLoad(
            observations=(observation(),),
            source_errors=(f"levels_fyi_public_{failure_kind}",),
            levels_fyi_target_outcomes=outcomes[0].targets,
        )

    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.automatic_refresh.load_default_reported_compensation_observations", load,
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.automatic_refresh.load_eurostat_actual_individual_consumption_price_levels",
        lambda **_kwargs: (),
    )
    try:
        async with local_env() as env:
            queue = f"owned-compensation-receipt-{uuid.uuid4()}"
            async with Worker(
                env.client, task_queue=queue, workflows=[OwnedCompensationReceiptWorkflow],
                activities=[automatic_compensation_refresh_activity], workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    OwnedCompensationReceiptWorkflow.run, id=queue, task_queue=queue,
                )
                result = await asyncio.wait_for(handle.result(), 30)
                description = await handle.describe()
                history = await handle.fetch_history()
            completed = [event.activity_task_completed_event_attributes for event in history.events
                         if event.HasField("activity_task_completed_event_attributes")]
            scheduled = [event.activity_task_scheduled_event_attributes for event in history.events
                         if event.HasField("activity_task_scheduled_event_attributes")]
            assert len(completed) == len(scheduled) == 1
            recorded = json.loads(completed[0].result.payloads[0].data)
            assert recorded["diagnostics"] == result.diagnostics
            assert result.failed_results == result.insufficient_results == 1
            assert result.diagnostics["owner"] == f"discover:{queue}:{description.run_id}:{scheduled[0].activity_id}:1"
            targets = {item["occupationFamilyCode"]: item for item in result.diagnostics["levelsFyiTargets"]}
            assert targets["operations"]["coverage"] == "unsupported_role" and not targets["operations"]["failed"]
            target = targets["engineering_management"]
            expected_error = f"levels_fyi_public_{failure_kind}"
            assert target["failed"] and target["errorCodes"] == [expected_error]
            assert expected_error in result.warnings
            if failure_kind == "unavailable":
                assert {request["httpStatus"] for request in target["requests"]} == {403}
            elif failure_kind == "page_budget_exhausted":
                assert target["pageBudgetExhausted"] and target["requests"] == []
            else:
                assert {request["status"] for request in target["requests"]} == {"available"}
                assert target["parsedPages"] == 0
            receipt, = result.diagnostics["rejectedObservations"]
            assert receipt["reason"] == "missing_role_family"
            stored = conn.execute(
                "SELECT entity_id FROM semantic_determinations WHERE tenant_id='local' AND determination_id=?",
                (receipt["classificationId"],),
            ).fetchone()
            assert stored[0] == receipt["sourceFingerprint"] == receipt["classificationEntityId"]
            assert len(model.calls) == 1  # The recorded receipt joins the pre-existing accepted classification.
            assert "private exception message" not in json.dumps(recorded)
            assert not any(event.HasField(name) for event in history.events for name in (
                "activity_task_failed_event_attributes", "activity_task_timed_out_event_attributes",
                "workflow_task_failed_event_attributes",
            ))
            await Replayer(
                workflows=[OwnedCompensationReceiptWorkflow], workflow_runner=UnsandboxedWorkflowRunner(),
            ).replay_workflow(history)
    finally:
        shutdown_activity_executors()
        close_connection(path)


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
