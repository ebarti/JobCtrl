"""Protocol and persistence checks for exact-run preparation observations."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from copy import deepcopy
from dataclasses import replace
from uuid import uuid4

import pytest
from temporalio import activity
from temporalio.api.common.v1 import Payloads, WorkflowType
from temporalio.api.history.v1 import (
    HistoryEvent,
    WorkflowExecutionCompletedEventAttributes,
    WorkflowExecutionStartedEventAttributes,
)
from temporalio.converter import DataConverter
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl import database
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.infrastructure.temporal import preparation_outcome_audit as audit
from jobctrl.preparation.workflow import JobPreparationInput, JobPreparationWorkflow

from .temporal_env import time_skipping_env


@pytest.fixture()
def owned(tmp_path, monkeypatch):
    path = tmp_path / "outcomes.db"
    conn = database.init_db(path)
    monkeypatch.setattr(database, "DB_PATH", path)
    yield conn
    database.close_connection(path)


def seed(conn, suffix="case", *, status="succeeded", cohort="observed_this_run"):
    job_id = str(uuid4())
    target = audit.PreparationOutcomeTarget("local", "prep-preparation:" + suffix, "prep-run-" + suffix)
    raw = {
        "tenant_id": "local",
        "job_id": job_id,
        "steps": ["score", "tailor", "cover", "pdf"],
        "target_version": "1",
        "idempotency_key": "preparation:" + suffix,
        "discovery_execution": {
            "tenant_id": "local",
            "workflow_id": "discover-" + suffix,
            "temporal_run_id": "discover-run-" + suffix,
        },
        "discovery_cohort_kind": cohort,
    }
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url) VALUES ('local', ?, ?)", (job_id, "https://example.test/" + suffix)
    )
    conn.execute(
        "INSERT INTO workflow_run_projections (workflow_id, tenant_id, workflow_type, status, temporal_run_id) "
        "VALUES (?, 'local', 'JobPreparationWorkflow', ?, ?)",
        (target.workflow_id, status, target.temporal_run_id),
    )
    conn.execute(
        "INSERT INTO discovery_execution_jobs (tenant_id, discover_workflow_id, discover_run_id, job_id, cohort_kind, "
        "preparation_workflow_id, work_plan_state, required_steps_json, linked_at) "
        "VALUES ('local', ?, ?, ?, ?, ?, 'planned', ?, '2026-10-22T00:00:00Z')",
        (
            raw["discovery_execution"]["workflow_id"],
            raw["discovery_execution"]["temporal_run_id"],
            job_id,
            cohort,
            target.workflow_id,
            json.dumps(raw["steps"]),
        ),
    )
    conn.commit()
    return target, raw


def result(*, skipped=True):
    return {
        "steps_completed": ["score"] if skipped else ["score", "tailor", "cover", "pdf"],
        "steps_skipped": ["tailor"] if skipped else [],
        "steps_failed": [],
        "failure": None,
        "error_code": None,
    }


async def history(raw, value=None):
    converter = DataConverter.default
    return [
        HistoryEvent(
            event_id=1,
            workflow_execution_started_event_attributes=WorkflowExecutionStartedEventAttributes(
                workflow_type=WorkflowType(name="JobPreparationWorkflow"),
                input=Payloads(payloads=await converter.encode([raw])),
            ),
        ),
        HistoryEvent(
            event_id=2,
            workflow_execution_completed_event_attributes=WorkflowExecutionCompletedEventAttributes(
                result=Payloads(payloads=await converter.encode([result() if value is None else value])),
            ),
        ),
    ]


class Handle:
    def __init__(self, run_id, events, hook=None):
        self.run_id, self.events, self.hook = run_id, events, hook

    async def iterate(self):
        if self.hook:
            await self.hook()
        for event in self.events:
            yield event

    def fetch_history_events(self, *, wait_new_event=False):
        assert wait_new_event is False
        return self.iterate()


class Client:
    data_converter = DataConverter.default

    def __init__(self, handles):
        self.handles, self.lookups = handles, []

    def get_workflow_handle(self, workflow_id, *, run_id):
        self.lookups.append((workflow_id, run_id))
        return self.handles[workflow_id]


def receipts(conn):
    return [
        dict(row)
        for row in conn.execute("SELECT * FROM job_events WHERE event_type = ? ORDER BY event_id", (audit.EVENT_TYPE,))
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("skipped", [True, False])
async def test_observation_uses_exact_history_and_preserves_all_owned_state(owned, skipped):
    target, raw = seed(owned)
    before_owner = tuple(owned.execute("SELECT * FROM workflow_run_projections").fetchone())
    before_member = tuple(owned.execute("SELECT * FROM discovery_execution_jobs").fetchone())
    value = result(skipped=skipped)
    observation = await audit.preparation_outcome_from_history(
        Handle(target.temporal_run_id, await history(raw, value)), target
    )
    assert observation is not None
    assert audit.missing_preparation_outcomes(owned) == [target]
    assert audit.record_preparation_outcome(owned, observation)
    assert not audit.record_preparation_outcome(owned, observation)
    assert audit.missing_preparation_outcomes(owned) == []
    rows = receipts(owned)
    assert len(rows) == 1
    row = rows[0]
    payload = json.loads(row["payload_json"])
    assert (row["tenant_id"], row["job_id"], row["entity_kind"], row["entity_ref"]) == (
        "local",
        raw["job_id"],
        "workflow_run",
        target.workflow_id,
    )
    assert row["idempotency_key"] == f"preparation-outcome:1:local:{target.workflow_id}:{target.temporal_run_id}"
    assert payload["jobId"] == raw["job_id"]
    assert payload["decoderVersion"] == 1 and payload["terminalHistoryEventId"] == 2
    assert payload["result"] == {
        "stepsCompleted": value["steps_completed"],
        "stepsSkipped": value["steps_skipped"],
        "stepsFailed": [],
        "failure": None,
        "errorCode": None,
    }
    assert payload["evidenceKind"] == "temporal_history"
    assert payload["discoveryExecution"] == {
        "tenantId": "local",
        "workflowId": "discover-case",
        "temporalRunId": "discover-run-case",
    }
    assert tuple(owned.execute("SELECT * FROM workflow_run_projections").fetchone()) == before_owner
    assert tuple(owned.execute("SELECT * FROM discovery_execution_jobs").fetchone()) == before_member
    assert not owned.execute("SELECT 1 FROM pipeline_step_projections").fetchone()
    assert not owned.in_transaction


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault",
    [
        "tenant",
        "job",
        "key",
        "plan",
        "unknown_step",
        "duplicate_step",
        "wrong_discover",
        "missing_lineage",
        "cohort",
        "failure",
        "error",
        "failed_step",
        "missing_result_field",
        "extra_result_field",
        "contradictory_prefix",
        "duplicate_skip",
        "bool_steps",
    ],
)
async def test_malformed_foreign_and_failed_histories_never_append(owned, fault):
    target, raw = seed(owned)
    value = result()
    if fault == "tenant":
        raw["tenant_id"] = "other"
    elif fault == "job":
        raw["job_id"] = str(uuid4())
    elif fault == "key":
        raw["idempotency_key"] = "preparation:foreign"
    elif fault == "plan":
        raw["steps"] = ["tailor", "cover", "pdf"]
    elif fault == "unknown_step":
        raw["steps"] = ["score", "launch", "pdf"]
    elif fault == "duplicate_step":
        raw["steps"] = ["score", "score", "pdf"]
    elif fault == "wrong_discover":
        raw["discovery_execution"]["temporal_run_id"] = "foreign"
    elif fault == "missing_lineage":
        raw.pop("discovery_execution")
    elif fault == "cohort":
        raw["discovery_cohort_kind"] = "foreign"
    elif fault == "failure":
        value["failure"] = "private failure prose must never be retained"
    elif fault == "error":
        value["error_code"] = "failed"
    elif fault == "failed_step":
        value["steps_failed"] = ["tailor"]
    elif fault == "missing_result_field":
        value.pop("failure")
    elif fault == "extra_result_field":
        value["untrusted"] = "not retained"
    elif fault == "contradictory_prefix":
        value["steps_completed"] = ["score", "cover"]
    elif fault == "duplicate_skip":
        value["steps_skipped"] = ["tailor", "tailor"]
    elif fault == "bool_steps":
        value["steps_skipped"] = True
    observation = await audit.preparation_outcome_from_history(
        Handle(target.temporal_run_id, await history(raw, value)), target
    )
    if observation is not None:
        assert not audit.record_preparation_outcome(owned, observation)
    assert receipts(owned) == []
    assert not owned.in_transaction


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault",
    [
        "wrong_run",
        "no_start",
        "no_terminal",
        "repeated_id",
        "two_starts",
        "payload_count",
        "oversize",
        "failed_terminal",
        "continued_run",
    ],
)
async def test_history_envelope_bounds_fail_closed(owned, fault, monkeypatch):
    target, raw = seed(owned)
    events = await history(raw)
    run_id = target.temporal_run_id
    if fault == "wrong_run":
        run_id = "foreign"
    elif fault == "no_start":
        events = events[1:]
    elif fault == "no_terminal":
        events = events[:1]
    elif fault == "repeated_id":
        events[1].event_id = 1
    elif fault == "two_starts":
        duplicate = deepcopy(events[0])
        duplicate.event_id = 2
        events[1].event_id = 3
        events.insert(1, duplicate)
    elif fault == "payload_count":
        events[1].workflow_execution_completed_event_attributes.result.ClearField("payloads")
    elif fault == "oversize":
        monkeypatch.setattr(audit, "MAX_PAYLOAD_BYTES", 1)
    elif fault == "failed_terminal":
        events[1] = HistoryEvent(event_id=2)
        events[1].workflow_execution_failed_event_attributes.SetInParent()
    elif fault == "continued_run":
        events[1].workflow_execution_completed_event_attributes.new_execution_run_id = "later"
    assert await audit.preparation_outcome_from_history(Handle(run_id, events), target) is None
    assert receipts(owned) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["new_run", "failed", "new_owner", "new_plan", "removed_member"])
async def test_append_rechecks_current_owner_and_member_after_history_io(owned, change):
    target, raw = seed(owned)
    events = await history(raw)

    async def change_owner():
        assert not owned.in_transaction
        path = owned.execute("PRAGMA database_list").fetchone()[2]
        with sqlite3.connect(path, timeout=0.1) as peer:
            if change == "new_run":
                peer.execute("UPDATE workflow_run_projections SET temporal_run_id = 'new-run'")
            elif change == "failed":
                peer.execute("UPDATE workflow_run_projections SET status = 'failed'")
            elif change == "new_owner":
                peer.execute("UPDATE discovery_execution_jobs SET preparation_workflow_id = 'prep-new-owner'")
            elif change == "new_plan":
                peer.execute('UPDATE discovery_execution_jobs SET required_steps_json = \'["tailor","pdf"]\'')
            else:
                peer.execute("DELETE FROM discovery_execution_jobs")

    client = Client({target.workflow_id: Handle(target.temporal_run_id, events, change_owner)})
    assert await audit.reconcile_preparation_outcomes(client, conn=owned) == 0
    assert receipts(owned) == []
    assert not owned.in_transaction


@pytest.mark.asyncio
async def test_current_invalid_result_keeps_prior_accepted_receipt_and_promotion_is_valid(owned):
    target, raw = seed(owned, cohort="existing_backlog")
    owned.execute("UPDATE discovery_execution_jobs SET cohort_kind = 'observed_this_run'")
    owned.commit()
    observation = await audit.preparation_outcome_from_history(
        Handle(target.temporal_run_id, await history(raw)), target
    )
    assert observation is not None and audit.record_preparation_outcome(owned, observation)
    accepted = receipts(owned)
    owned.execute("UPDATE workflow_run_projections SET temporal_run_id = 'new-run'")
    owned.commit()
    current = replace(target, temporal_run_id="new-run")
    bad = result()
    bad["failure"] = "failed"
    client = Client({target.workflow_id: Handle("new-run", await history(raw, bad))})
    assert audit.missing_preparation_outcomes(owned) == [current]
    assert await audit.reconcile_preparation_outcomes(client, conn=owned) == 0
    assert receipts(owned) == accepted
    assert not audit.record_preparation_outcome(owned, observation)


@pytest.mark.asyncio
async def test_inherited_transaction_is_not_committed_or_held_during_history(owned):
    target, raw = seed(owned)
    observation = await audit.preparation_outcome_from_history(
        Handle(target.temporal_run_id, await history(raw)), target
    )
    owned.execute("BEGIN IMMEDIATE")
    owned.execute("UPDATE jobs SET title = 'uncommitted owner data'")
    client = Client({})
    assert await audit.reconcile_preparation_outcomes(client, conn=owned) == 0
    assert client.lookups == [] and owned.in_transaction
    with pytest.raises(RuntimeError, match="own transaction"):
        audit.record_preparation_outcome(owned, observation)
    assert owned.in_transaction
    owned.rollback()
    assert receipts(owned) == []


@pytest.mark.asyncio
async def test_append_failure_rolls_back_only_its_owned_receipt(owned, monkeypatch):
    from jobctrl import state

    target, raw = seed(owned)
    observation = await audit.preparation_outcome_from_history(
        Handle(target.temporal_run_id, await history(raw)), target
    )
    original = state.record_job_event

    def fail_after_insert(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("injected append fault")

    monkeypatch.setattr(state, "record_job_event", fail_after_insert)
    with pytest.raises(RuntimeError, match="injected"):
        audit.record_preparation_outcome(owned, observation)
    assert receipts(owned) == [] and not owned.in_transaction
    assert owned.execute("SELECT status FROM workflow_run_projections").fetchone()[0] == "succeeded"


@pytest.mark.asyncio
async def test_bounded_selection_rotates_past_unavailable_owner(owned, monkeypatch):
    first, first_raw = seed(owned, "a")
    second, second_raw = seed(owned, "b")
    monkeypatch.setattr(audit, "MAX_RUNS_PER_PASS", 1)
    assert audit.missing_preparation_outcomes(owned, limit=100) == [first]

    async def unavailable():
        raise RuntimeError("unavailable")

    client = Client(
        {
            first.workflow_id: Handle(first.temporal_run_id, [], unavailable),
            second.workflow_id: Handle(second.temporal_run_id, await history(second_raw)),
        }
    )
    assert await audit.reconcile_preparation_outcomes(client, conn=owned) == 0
    assert await audit.reconcile_preparation_outcomes(client, conn=owned) == 1
    assert len(receipts(owned)) == 1 and receipts(owned)[0]["job_id"] == second_raw["job_id"]


@pytest.mark.asyncio
async def test_history_budget_and_cancellation_do_not_append_partial_receipts(owned, monkeypatch):
    target, raw = seed(owned)
    entered = asyncio.Event()

    async def wait_forever():
        assert not owned.in_transaction
        entered.set()
        await asyncio.Event().wait()

    client = Client({target.workflow_id: Handle(target.temporal_run_id, await history(raw), wait_forever)})
    monkeypatch.setattr(audit, "PASS_TIMEOUT_SECONDS", 0.02)
    assert await audit.reconcile_preparation_outcomes(client, conn=owned) == 0
    assert entered.is_set() and receipts(owned) == [] and not owned.in_transaction
    monkeypatch.setattr(audit, "PASS_TIMEOUT_SECONDS", 5.0)
    task = asyncio.create_task(audit.reconcile_preparation_outcomes(client, conn=owned))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert receipts(owned) == [] and not owned.in_transaction


@activity.defn(name="check_spend_budget")
async def _budget(_payload):
    return {
        "day": "2026-10-22",
        "input_tokens": 0,
        "output_tokens": 0,
        "estimated_usd": 0.0,
        "daily_budget_usd": 25.0,
        "lane": "scoring",
        "lane_input_tokens": 0,
        "lane_output_tokens": 0,
        "lane_token_limit": 0,
        "lane_exceeded": False,
        "global_exceeded": False,
        "exceeded": False,
    }


@activity.defn(name="record_workflow_started")
async def _started(_payload):
    return None


@activity.defn(name="record_workflow_outcome")
async def _finished(_payload):
    return None


@activity.defn(name="score_job")
async def _score(_payload):
    return {"status": "ok", "score_version": 1}


@activity.defn(name="tailor_job")
async def _tailor(_payload):
    return {"status": "skipped", "reason": "score_below_threshold"}


@pytest.mark.asyncio
async def test_real_preparation_completed_result_backfills_owned_sqlite_without_model_calls(owned):
    target, raw = seed(owned)
    queue = "preparation-outcome-" + uuid4().hex
    from jobctrl.domain.discovery.execution import DiscoveryExecutionRef

    async with time_skipping_env() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[JobPreparationWorkflow],
            activities=[_budget, _started, _finished, _score, _tailor],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            handle = await env.client.start_workflow(
                JobPreparationWorkflow.run,
                JobPreparationInput(
                    tenant_id="local",
                    job_id=canonical_job_id(raw["job_id"]),
                    steps=raw["steps"],
                    target_version="1",
                    idempotency_key=raw["idempotency_key"],
                    discovery_execution=DiscoveryExecutionRef(**raw["discovery_execution"]),
                    discovery_cohort_kind="observed_this_run",
                ),
                id=target.workflow_id,
                task_queue=queue,
            )
            value = await handle.result()
            assert value.steps_completed == ["score"] and value.steps_skipped == ["tailor"]
            owned.execute("UPDATE workflow_run_projections SET temporal_run_id = ?", (handle.first_execution_run_id,))
            owned.commit()
            assert await audit.reconcile_preparation_outcomes(env.client, conn=owned) == 1
            assert await audit.reconcile_preparation_outcomes(env.client, conn=owned) == 0
    payload = json.loads(receipts(owned)[0]["payload_json"])
    assert payload["temporalRunId"] == handle.first_execution_run_id
    assert payload["result"]["stepsSkipped"] == ["tailor"]
    assert not owned.execute("SELECT 1 FROM pipeline_step_projections").fetchone()


@pytest.mark.asyncio
async def test_busy_peer_writer_defers_without_blocking_event_loop_or_changing_timeout(owned):
    import time

    target, raw = seed(owned)
    observation = await audit.preparation_outcome_from_history(
        Handle(target.temporal_run_id, await history(raw)), target
    )
    path = owned.execute("PRAGMA database_list").fetchone()[2]
    original_timeout = owned.execute("PRAGMA busy_timeout").fetchone()[0]
    peer = sqlite3.connect(path)
    try:
        peer.execute("BEGIN IMMEDIATE")
        started = time.monotonic()
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            audit.record_preparation_outcome(owned, observation)
        assert time.monotonic() - started < 0.5
        assert not owned.in_transaction
        assert owned.execute("PRAGMA busy_timeout").fetchone()[0] == original_timeout
    finally:
        peer.rollback()
        peer.close()
    assert receipts(owned) == []
    assert audit.record_preparation_outcome(owned, observation)


@pytest.mark.asyncio
async def test_history_event_bound_and_domain_factory_reject_contradictions(owned, monkeypatch):
    from jobctrl.domain.events.workflow import create_preparation_workflow_outcome_observed

    target, raw = seed(owned)
    events = await history(raw)
    observation = await audit.preparation_outcome_from_history(Handle(target.temporal_run_id, events), target)
    assert observation is not None
    monkeypatch.setattr(audit, "MAX_HISTORY_EVENTS", 1)
    assert await audit.preparation_outcome_from_history(Handle(target.temporal_run_id, events), target) is None
    with pytest.raises(ValueError, match="contradictory"):
        create_preparation_workflow_outcome_observed("local", replace(observation, steps_completed=("score", "cover")))
    with pytest.raises(ValueError, match="identity"):
        create_preparation_workflow_outcome_observed("local", replace(observation, terminal_history_event_id=True))
    assert receipts(owned) == []
