"""Recovery overlaps only exact, independently owned single-job preparation."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime, timezone
import json
import sqlite3
import threading
from types import SimpleNamespace

import pytest
from temporalio.api.common.v1 import Payloads
from temporalio.api.history.v1 import HistoryEvent
from temporalio.client import WorkflowExecutionStatus
from temporalio.converter import DataConverter
from temporalio.service import RPCError, RPCStatusCode

from jobctrl.pipeline import automatic_preparation as recovery
from jobctrl.state import set_stage_state
from .test_automatic_preparation import _Client, _job, _stage, _tick, conn as conn


@pytest.fixture(autouse=True)
def _cover_policy(tmp_path, monkeypatch):
    settings = tmp_path / "overlap-settings.json"
    settings.write_text('{"cover_letter_generation": true, "pipeline_internal_concurrency": 10}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings))


class _OverlapClient(_Client):
    def __init__(self):
        super().__init__()
        self.live = []
        self.start_events = {}
        self.history_reads = []

    async def list_workflows(self, **kwargs):
        assert "ExecutionStatus = 'Running'" in kwargs["query"]
        if self.unavailable:
            raise RPCError("unavailable", RPCStatusCode.UNAVAILABLE, b"")
        for execution in self.live:
            yield execution
        for key, status in self.statuses.items():
            if isinstance(key, str) and key.startswith("prepare-auto-local-") and status == WorkflowExecutionStatus.RUNNING:
                yield SimpleNamespace(id=key, run_id=f"run:{key}", workflow_type="JobPipelineWorkflow")

    async def start_workflow(self, workflow, payload, **kwargs):
        result = await super().start_workflow(workflow, payload, **kwargs)
        event = HistoryEvent(event_id=1)
        attrs = event.workflow_execution_started_event_attributes
        attrs.workflow_type.name = "JobPipelineWorkflow"
        attrs.original_execution_run_id = f"run:{kwargs['id']}"
        attrs.input.CopyFrom(Payloads(payloads=await DataConverter.default.encode([asdict(payload)])))
        self.start_events[(kwargs["id"], attrs.original_execution_run_id)] = event
        return result

    def get_workflow_handle(self, workflow_id, *, run_id=None):
        base = super().get_workflow_handle(workflow_id, run_id=run_id)

        async def fetch_history_events(**kwargs):
            assert kwargs.get("page_size") == 1
            assert kwargs.get("wait_new_event") is False
            self.history_reads.append((workflow_id, run_id))
            event = self.start_events.get((workflow_id, run_id))
            if isinstance(event, BaseException):
                raise event
            if event is not None:
                yield event

        return SimpleNamespace(**vars(base), run_id=run_id, fetch_history_events=fetch_history_events)


def _active(client, job_id, *, workflow_type="JobPreparationWorkflow", payload=None, run_id="busy-run"):
    workflow_id = "prep-busy"
    client.live.append(SimpleNamespace(id=workflow_id, run_id=run_id, workflow_type=workflow_type))
    client.statuses[(workflow_id, run_id)] = WorkflowExecutionStatus.RUNNING
    event = HistoryEvent(event_id=1)
    attrs = event.workflow_execution_started_event_attributes
    attrs.workflow_type.name = workflow_type
    attrs.original_execution_run_id = run_id
    value = payload if payload is not None else {
        "tenant_id": "local", "job_id": str(job_id), "steps": ["score", "tailor", "cover", "pdf"],
        "expected_app_dir": "/test/app", "expected_db_path": "/test/app/recovery.db",
    }
    attrs.input.CopyFrom(Payloads(payloads=asyncio.run(DataConverter.default.encode([value]))))
    client.start_events[(workflow_id, run_id)] = event
    return event


@pytest.mark.parametrize("stage", ["score", "tailor", "cover"])
@pytest.mark.parametrize("state", ["queued", "running"])
def test_due_peer_recovers_while_unrelated_job_keeps_its_exact_owner(conn, stage, state):
    retry = _job(conn, 1)
    busy = _job(conn, 2, enriched=True)
    set_stage_state(conn, busy, stage, state, attempt_count=2,
        metadata={"activityOwner": "busy-run"}, validate_transition=False)
    conn.commit()
    before = _stage(conn, busy, stage)
    client = _OverlapClient()
    _active(client, busy)

    assert asyncio.run(_tick(client)) == 1
    assert client.starts[0][1].job_ids == (retry,)
    assert client.starts[0][1].stages == ["enrich"]
    assert _stage(conn, busy, stage) == before
    assert _stage(conn, retry)["attempt_count"] == 1
    assert asyncio.run(_tick(client)) == 0
    assert len(client.starts) == 1
    assert _stage(conn, busy, stage) == before


def test_workflow_job_is_excluded_between_activities_without_a_running_stage(conn):
    retry = _job(conn, 1)
    busy = _job(conn, 2, enriched=True)
    before = _stage(conn, busy, "score")
    client = _OverlapClient()
    _active(client, busy)
    assert asyncio.run(_tick(client)) == 1
    assert client.starts[0][1].job_ids == (retry,)
    assert _stage(conn, busy, "score") == before


@pytest.mark.parametrize("kind", ["DiscoverWorkflow", "JobPipelineWorkflow", "JobUrlImportWorkflow", "ManualCaptureImportWorkflow"])
def test_unscoped_producers_still_prevent_recovery(conn, kind):
    retry = _job(conn)
    before = _stage(conn, retry)
    client = _OverlapClient()
    _active(client, retry, workflow_type=kind)
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, retry) == before and not client.starts
    assert not client.history_reads


@pytest.mark.parametrize("corruption", ["missing", "wrong_run", "wrong_type", "wrong_event", "bad_payload", "other_tenant", "other_database", "invalid_job"])
def test_unverified_preparation_scope_keeps_recovery_read_only(conn, corruption):
    retry = _job(conn)
    before = _stage(conn, retry)
    client = _OverlapClient()
    event = _active(client, retry)
    attrs = event.workflow_execution_started_event_attributes
    if corruption == "missing":
        client.start_events.clear()
    elif corruption == "wrong_run":
        attrs.original_execution_run_id = "different-run"
    elif corruption == "wrong_type":
        attrs.workflow_type.name = "JobPipelineWorkflow"
    elif corruption == "wrong_event":
        event.event_id = 2
    else:
        payload = asyncio.run(DataConverter.default.decode(attrs.input.payloads))[0]
        if corruption == "bad_payload":
            payload = ["not an input mapping"]
        elif corruption == "other_tenant":
            payload["tenant_id"] = "other"
        elif corruption == "other_database":
            payload["expected_db_path"] = "/other/recovery.db"
        else:
            payload["job_id"] = "invalid"
        attrs.input.CopyFrom(Payloads(payloads=asyncio.run(DataConverter.default.encode([payload]))))
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, retry) == before and not client.starts


def test_preparation_history_outage_propagates_without_reserving(conn):
    retry = _job(conn)
    before = _stage(conn, retry)
    client = _OverlapClient()
    _active(client, retry)
    client.start_events[("prep-busy", "busy-run")] = RPCError("unavailable", RPCStatusCode.UNAVAILABLE, b"")
    with pytest.raises(RPCError):
        asyncio.run(_tick(client))
    assert _stage(conn, retry) == before and not client.starts


@pytest.mark.parametrize("metadata", [
    {"activityOwner": "other-run"},
    {"activityOwner": None},
    {"activityOwner": "other-run", "workflowId": "prep-busy", "temporalRunId": "busy-run"},
])
def test_foreign_or_unknown_canonical_owner_is_not_bypassed(conn, metadata):
    retry = _job(conn)
    busy = _job(conn, 2, enriched=True)
    set_stage_state(conn, busy, "tailor", "running", metadata=metadata, validate_transition=False)
    conn.commit()
    before = _stage(conn, busy, "tailor")
    client = _OverlapClient()
    _active(client, busy)
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, busy, "tailor") == before
    assert _stage(conn, retry)["state"] == "failed"
    assert not client.starts


@pytest.mark.parametrize("bindings", [None, {"expected_app_dir": None, "expected_db_path": None}])
def test_default_worker_workspace_binding_can_overlap(conn, bindings):
    retry = _job(conn)
    busy = _job(conn, 2, enriched=True)
    client = _OverlapClient()
    payload = {"tenant_id": "local", "job_id": str(busy), "steps": ["score", "tailor", "pdf"]}
    if bindings:
        payload.update(bindings)
    _active(client, busy, payload=payload)
    assert asyncio.run(_tick(client)) == 1
    assert client.starts[0][1].job_ids == (retry,)


def test_same_job_is_protected_even_before_its_next_stage_claim(conn):
    busy = _job(conn, enriched=True)
    before = _stage(conn, busy, "score")
    client = _OverlapClient()
    _active(client, busy)
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, busy, "score") == before and not client.starts


def test_retry_cooldown_still_applies_during_unrelated_work(conn):
    retry = _job(conn)
    busy = _job(conn, 2, enriched=True)
    conn.execute("UPDATE job_stage_states SET updated_at=? WHERE job_id=?", (datetime.now(timezone.utc).isoformat(), str(retry)))
    conn.commit()
    before = _stage(conn, retry)
    client = _OverlapClient()
    _active(client, busy)
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, retry) == before and not client.starts


def test_conflicting_runs_for_the_same_job_prevent_dispatch(conn):
    retry = _job(conn)
    busy = _job(conn, 2, enriched=True)
    client = _OverlapClient()
    _active(client, busy)
    _active(client, busy, run_id="replacement-run")
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, retry)["state"] == "failed" and not client.starts


def test_owner_changed_after_inventory_is_rechecked_before_admission(conn, monkeypatch):
    retry = _job(conn)
    busy = _job(conn, 2, enriched=True)
    set_stage_state(conn, busy, "tailor", "running", metadata={"activityOwner": "busy-run"}, validate_transition=False)
    conn.commit()
    client = _OverlapClient()
    _active(client, busy)
    path = conn.execute("PRAGMA database_list").fetchone()[2]

    def budget(**_kwargs):
        with sqlite3.connect(path) as other:
            other.execute("UPDATE job_stage_states SET metadata_json=? WHERE job_id=? AND stage='tailor'", (json.dumps({"activityOwner": "replacement-run"}), str(busy)))
        return SimpleNamespace(global_exceeded=False)

    monkeypatch.setattr("jobctrl.llm.read_spend_budget_status", budget)
    assert asyncio.run(_tick(client)) == 0
    assert json.loads(_stage(conn, busy, "tailor")["metadata_json"])["activityOwner"] == "replacement-run"
    assert _stage(conn, retry)["state"] == "failed" and not client.starts


def test_independent_writers_reuse_one_frozen_batch_during_overlap(conn):
    retry = _job(conn)
    busy = _job(conn, 2, enriched=True)
    set_stage_state(conn, busy, "tailor", "running", metadata={"activityOwner": "busy-run"}, validate_transition=False)
    conn.commit()
    before = _stage(conn, busy, "tailor")
    client = _OverlapClient()
    _active(client, busy)
    scopes = asyncio.run(recovery._active_preparation_scopes(client, expected_app_dir="/test/app", expected_db_path="/test/app/recovery.db"))
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    barrier = threading.Barrier(2)

    def reserve():
        with sqlite3.connect(path, timeout=5) as other:
            other.row_factory = sqlite3.Row
            barrier.wait(timeout=5)
            return recovery.reserve_recovery_batch(other, active_preparations=scopes)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = [future.result(timeout=10) for future in [pool.submit(reserve), pool.submit(reserve)]]
    assert first == second and first.job_ids == (retry,)
    assert conn.execute("SELECT count(*) FROM job_events WHERE job_id=? AND event_type='StageQueued'", (str(retry),)).fetchone()[0] == 1
    assert _stage(conn, busy, "tailor") == before


def _automatic_batch(client, jobs, *, stage="score", workers=2, workflow_id="prepare-auto-local-score-held"):
    run_id = "batch-run"
    client.live.append(SimpleNamespace(id=workflow_id, run_id=run_id, workflow_type="JobPipelineWorkflow"))
    client.statuses[(workflow_id, run_id)] = WorkflowExecutionStatus.RUNNING
    event = HistoryEvent(event_id=1)
    attrs = event.workflow_execution_started_event_attributes
    attrs.workflow_type.name = "JobPipelineWorkflow"
    attrs.original_execution_run_id = run_id
    payload = {"tenant_id": "local", "job_ids": [str(job) for job in jobs], "stages": [stage],
        "workers": workers, "automatic_recovery": True,
        "expected_app_dir": "/test/app", "expected_db_path": "/test/app/recovery.db"}
    attrs.input.CopyFrom(Payloads(payloads=asyncio.run(DataConverter.default.encode([payload]))))
    client.start_events[(workflow_id, run_id)] = event
    return event


@pytest.mark.parametrize("state", ["queued", "running"])
def test_due_peer_uses_spare_capacity_beside_an_automatic_score_batch(conn, state):
    retry = _job(conn)
    busy = [_job(conn, number, enriched=True) for number in [2, 3]]
    client = _OverlapClient()
    _automatic_batch(client, busy)
    batch = recovery.RecoveryBatch("prepare-auto-local-score-held", "score", tuple(busy), 7)
    for job in busy:
        metadata = {"workflowId": batch.workflow_id, "automaticPreparation": batch.metadata()}
        if state == "running":
            metadata.update(activityOwner="batch-run", temporalRunId="batch-run", automaticRecovery=True)
        set_stage_state(conn, job, "score", state, metadata=metadata, validate_transition=False)
    conn.commit()
    before = [_stage(conn, job, "score") for job in busy]

    assert asyncio.run(_tick(client)) == 1
    assert client.starts[0][1].job_ids == (retry,)
    assert client.starts[0][1].workers == 8
    assert [_stage(conn, job, "score") for job in busy] == before
    assert asyncio.run(_tick(client)) == 0
    assert len(client.starts) == 1


def test_automatic_batches_share_the_existing_internal_capacity(conn, tmp_path, monkeypatch):
    config = tmp_path / "two-slots.json"
    config.write_text('{"cover_letter_generation": true, "pipeline_internal_concurrency": 2}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config))
    retry = _job(conn)
    busy = [_job(conn, number, enriched=True) for number in [2, 3]]
    client = _OverlapClient()
    _automatic_batch(client, busy)
    for job in busy:
        set_stage_state(conn, job, "score", "running", metadata={"activityOwner": "batch-run"}, validate_transition=False)
    conn.commit()
    before = _stage(conn, retry)
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, retry) == before and not client.starts


def test_completed_batch_members_release_capacity_without_reclaiming_their_jobs(conn):
    retry = _job(conn)
    busy = [_job(conn, number, enriched=True) for number in [2, 3, 4]]
    client = _OverlapClient()
    _automatic_batch(client, busy, workers=3)
    for index, job in enumerate(busy):
        set_stage_state(conn, job, "score", "succeeded" if index==0 else "running", metadata={"activityOwner": "batch-run"}, validate_transition=False)
    conn.commit()
    before = [_stage(conn, job, "score") for job in busy]
    assert asyncio.run(_tick(client)) == 1
    assert client.starts[0][1].job_ids == (retry,)
    assert client.starts[0][1].workers == 8
    assert [_stage(conn, job, "score") for job in busy] == before


@pytest.mark.parametrize("corruption", ["not_automatic", "empty", "duplicate", "invalid_job", "multiple_stages", "apply", "foreign_workspace", "zero_workers", "too_many_workers", "boolean_workers"])
def test_unverified_automatic_batch_keeps_admission_read_only(conn, corruption):
    retry = _job(conn)
    busy = _job(conn, 2, enriched=True)
    client = _OverlapClient()
    event = _automatic_batch(client, [busy])
    attrs = event.workflow_execution_started_event_attributes
    payload = asyncio.run(DataConverter.default.decode(attrs.input.payloads))[0]
    if corruption == "not_automatic":
        payload["automatic_recovery"] = False
    elif corruption == "empty":
        payload["job_ids"] = []
    elif corruption == "duplicate":
        payload["job_ids"] *= 2
    elif corruption == "invalid_job":
        payload["job_ids"] = ["invalid"]
    elif corruption == "multiple_stages":
        payload["stages"] = ["score", "tailor"]
    elif corruption == "apply":
        payload["stages"] = ["apply"]
    elif corruption == "foreign_workspace":
        payload["expected_db_path"] = "/foreign/db"
    elif corruption == "zero_workers":
        payload["workers"] = 0
    elif corruption == "too_many_workers":
        payload["workers"] = 17
    else:
        payload["workers"] = True
    attrs.input.CopyFrom(Payloads(payloads=asyncio.run(DataConverter.default.encode([payload]))))
    before = _stage(conn, retry)
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, retry) == before and not client.starts


def test_unstarted_reservation_retains_identity_but_uses_remaining_capacity(conn):
    retry = _job(conn)
    reserved = recovery.reserve_recovery_batch(conn)
    before = _stage(conn, retry)
    busy = [_job(conn, number, enriched=True) for number in [2, 3]]
    client = _OverlapClient()
    _automatic_batch(client, busy)
    for job in busy:
        set_stage_state(conn, job, "score", "running", metadata={"activityOwner": "batch-run"}, validate_transition=False)
    conn.commit()
    assert asyncio.run(_tick(client)) == 1
    assert client.starts[0][2]["id"] == reserved.workflow_id
    assert client.starts[0][1].job_ids == reserved.job_ids
    assert client.starts[0][1].workers == 8
    assert _stage(conn, retry) == before
    assert conn.execute("SELECT count(*) FROM job_events WHERE event_type='StageQueued' AND job_id=?", (str(retry),)).fetchone()[0] == 1


def test_known_pending_reservation_cannot_bypass_a_foreign_canonical_owner(conn):
    retry = _job(conn)
    recovery.reserve_recovery_batch(conn)
    busy = _job(conn, 2, enriched=True)
    set_stage_state(conn, busy, "score", "running", metadata={"activityOwner": "unknown"}, validate_transition=False)
    conn.commit()
    before = _stage(conn, retry)
    client = _OverlapClient()
    assert asyncio.run(_tick(client)) == 0
    assert _stage(conn, retry) == before and not client.starts


def test_independent_writers_do_not_multiply_batch_capacity(conn):
    retry = _job(conn)
    busy = [_job(conn, number, enriched=True) for number in [2, 3]]
    client = _OverlapClient()
    _automatic_batch(client, busy)
    for job in busy:
        set_stage_state(conn, job, "score", "running", metadata={"activityOwner": "batch-run"}, validate_transition=False)
    conn.commit()
    scopes = asyncio.run(recovery._active_preparation_scopes(client, expected_app_dir="/test/app", expected_db_path="/test/app/recovery.db"))
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    barrier = threading.Barrier(2)
    def reserve():
        with sqlite3.connect(path, timeout=5) as other:
            other.row_factory = sqlite3.Row
            barrier.wait(timeout=5)
            return recovery.reserve_recovery_batch(other, active_preparations=scopes, internal_concurrency=3)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = [future.result(timeout=10) for future in [pool.submit(reserve), pool.submit(reserve)]]
    assert first == second and first.workers == 1 and first.job_ids == (retry,)
    assert conn.execute("SELECT count(*) FROM job_events WHERE event_type='StageQueued' AND job_id=?", (str(retry),)).fetchone()[0] == 1


def test_multiple_frozen_cohorts_with_conflicting_members_remain_untouched(conn):
    jobs = [_job(conn, number) for number in [1, 2, 3]]
    batches = [recovery.RecoveryBatch("prepare-auto-local-enrich-first", "enrich", tuple(jobs[:2]), 7),
               recovery.RecoveryBatch("prepare-auto-local-enrich-second", "enrich", tuple(jobs[1:]), 7)]
    for job, batch in zip(jobs, [batches[0], batches[0], batches[1]]):
        set_stage_state(conn, job, "enrich", "queued", metadata={"workflowId": batch.workflow_id, "automaticPreparation": batch.metadata()}, validate_transition=False)
    conn.commit()
    before = [_stage(conn, job) for job in jobs]
    client = _OverlapClient()
    assert asyncio.run(_tick(client)) == 0
    assert [_stage(conn, job) for job in jobs] == before and not client.starts


@pytest.mark.parametrize("state", ["queued", "running"])
def test_enrichment_activity_lease_token_is_bound_to_its_exact_batch_run(conn, state):
    retry = _job(conn)
    busy = _job(conn, 2)
    client = _OverlapClient()
    workflow_id = "prepare-auto-local-enrich-held"
    _automatic_batch(client, [busy], stage="enrich", workflow_id=workflow_id)
    batch = recovery.RecoveryBatch(workflow_id, "enrich", (busy,), 7)
    metadata = {"workflowId": workflow_id, "temporalRunId": "batch-run",
        "activityOwner": "3:batch-run:1", "activityAttempt": 1, "automaticPreparation": batch.metadata()}
    set_stage_state(conn, busy, "enrich", state, metadata=metadata, validate_transition=False)
    conn.commit()
    before = _stage(conn, busy)
    assert asyncio.run(_tick(client)) == 1
    assert client.starts[0][1].job_ids == (retry,) and client.starts[0][1].workers == 9
    assert _stage(conn, busy) == before


def test_missing_recorded_reservation_execution_cannot_start_a_replacement(conn):
    job = _job(conn)
    batch = recovery.reserve_recovery_batch(conn)
    metadata = {"workflowId": batch.workflow_id, "temporalRunId": "missing-run",
        "activityOwner": "3:missing-run:1", "activityAttempt": 1, "automaticPreparation": batch.metadata()}
    set_stage_state(conn, job, "enrich", "queued", metadata=metadata, validate_transition=False)
    conn.commit()
    before = _stage(conn, job)
    client = _OverlapClient()
    assert asyncio.run(_tick(client)) == 0
    assert not client.starts and _stage(conn, job) == before


def test_closed_reservation_settlement_rechecks_a_replacement_owner(conn):
    job = _job(conn)
    batch = recovery.reserve_recovery_batch(conn)
    metadata = {"workflowId": batch.workflow_id, "temporalRunId": "replacement-run",
        "activityOwner": "3:replacement-run:1", "activityAttempt": 1, "automaticPreparation": batch.metadata()}
    set_stage_state(conn, job, "enrich", "queued", metadata=metadata, validate_transition=False)
    conn.commit()
    before = _stage(conn, job)
    recovery._settle_closed_reservation(conn, batch, WorkflowExecutionStatus.COMPLETED, run_id="old-run")
    assert _stage(conn, job) == before
