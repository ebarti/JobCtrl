"""Escaped Apply workers must not turn a failed batch into success."""

from __future__ import annotations

import asyncio
import json
import threading
import uuid
from datetime import timedelta

import pytest
from temporalio import activity
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl import config, database
from jobctrl.apply import chrome, launcher, ownership
from jobctrl.apply.activities import apply_activity
from jobctrl.apply.batch_outcome import ApplyBatchWorkersCrashed
from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobctrl.domain.apply.value_objects import Applied, DryRunComplete, Failed
from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
from jobctrl.state import record_job_event

from .apply_execution_fixture import in_process_apply_execution as in_process_apply_execution
from .temporal_env import local_env
from .test_apply_batch_limits import _check_budget
from .test_apply_launcher_ownership import _events, owned_runtime as owned_runtime


async def _workflow(app, *, dry_run, workers=2, limit=4, job_id=None):
    queue = f"apply-crash-{uuid.uuid4()}"
    workflow_id = f"apply-crash-{uuid.uuid4()}"
    async with local_env() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[ApplyWorkflow],
            activities=[apply_activity, _check_budget, record_workflow_started, record_workflow_outcome],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            handle = await env.client.start_workflow(
                ApplyWorkflow.run,
                ApplyWorkflowInput(
                    tenant_id="local", expected_app_dir=str(app), expected_db_path=str(config.DB_PATH),
                    limit=limit, workers=workers, job_id=job_id, dry_run=dry_run, approval_required=False,
                ),
                id=workflow_id,
                task_queue=queue,
                execution_timeout=timedelta(seconds=30),
            )
            result = await asyncio.wait_for(handle.result(), timeout=30)
            history = await handle.fetch_history()
        await Replayer(workflows=[ApplyWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
    scheduled = [
        event for event in history.events
        if event.HasField("activity_task_scheduled_event_attributes")
        and event.activity_task_scheduled_event_attributes.activity_type.name == "apply"
    ]
    assert len(scheduled) == 1  # A possibly submitted application must not be retried.
    started = [
        event.activity_task_started_event_attributes for event in history.events
        if event.HasField("activity_task_started_event_attributes")
        and event.activity_task_started_event_attributes.scheduled_event_id == scheduled[0].event_id
    ]
    assert len(started) == 1 and started[0].attempt == 1
    return workflow_id, result


def _terminal_evidence(workflow_id):
    conn = database.get_connection()
    projection = conn.execute(
        "SELECT status FROM workflow_run_projections WHERE workflow_id = ?", (workflow_id,)
    ).fetchone()
    terminal = conn.execute(
        "SELECT outcome, error_class, metadata_json, total_count FROM operational_attempt_metrics "
        "WHERE stage='apply' AND attempt_kind='apply_batch' ORDER BY metric_id DESC LIMIT 1"
    ).fetchone()
    return (
        projection["status"], terminal["outcome"], terminal["error_class"],
        json.loads(terminal["metadata_json"]), terminal["total_count"],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mode", "dry_run", "expected", "crashes", "metric"),
    [
        ("all_crash", False, (0, 0), 2, "failed"),
        ("mixed", True, (2, 0), 1, "failed"),
        ("after_progress", False, (3, 0), 1, "failed"),
        ("after_handled", False, (2, 1), 1, "failed"),
        ("handled", False, (1, 1), 0, "failed"),
        ("empty", True, (0, 0), 0, "dry_run"),
    ],
)
async def test_real_workflow_retains_completed_counts_and_reports_worker_crashes(
    owned_runtime, monkeypatch, mode, dry_run, expected, crashes, metric,
):
    app, first, second = owned_runtime
    original_history = {job: _events(database.get_connection(), job) for job in (first, second)}
    first_claim = threading.Barrier(2)
    lock = threading.Lock()
    attempts = {}
    roles = {}
    recorded = []

    def acquire(*, worker_id, run_ctx, **_kwargs):
        ident = threading.get_ident()
        with lock:
            if ident not in roles:
                roles[ident] = run_ctx["launcher_run"].worker_ids[:2].index(worker_id)
            role = roles[ident]
            attempts[role] = attempts.get(role, 0) + 1
            attempt = attempts[role]
        if attempt == 1:
            first_claim.wait(timeout=10)
        if mode == "empty" or (mode == "handled" and attempt > 1):
            return None
        if mode == "all_crash" or (mode == "mixed" and role == 1) or (
            mode in {"after_progress", "after_handled"} and role == 0 and attempt == 2
        ):
            raise RuntimeError("synthetic pre-claim worker crash")
        return {"tenant_id": "local", "job_id": str(uuid.uuid4()), "title": f"synthetic-{role}"}

    def run_job(job, **_kwargs):
        # This is a synthetic completed result. No browser or email is invoked.
        if mode in {"handled", "after_handled"} and job["title"] == "synthetic-0":
            return Failed(error="synthetic handled failure", retryable=True), 1
        return Applied(applied_at="2026-10-28T00:00:00Z", verification_confidence=1.0), 1

    def mark(job_id, status, *args, **kwargs):
        with lock:
            recorded.append((job_id, status))

    monkeypatch.setattr(launcher, "acquire_job", acquire)
    monkeypatch.setattr(launcher, "run_job", run_job)
    monkeypatch.setattr(launcher, "mark_result", mark)
    workflow_id, result = await _workflow(app, dry_run=dry_run)

    assert (result.applied, result.failed) == expected
    assert result.ok is (expected[1] == 0 and crashes == 0)
    assert result.status == ("ok" if result.ok else "failed")
    assert result.error == ("apply_worker_crashed" if crashes else None)
    assert result.worker_crashes == crashes
    assert result.counts_known is True
    status, outcome, error_class, metadata, total_count = _terminal_evidence(workflow_id)
    assert status == ("succeeded" if result.ok else "failed")
    assert outcome == metric
    assert metadata["applied"] == expected[0]
    assert metadata["failed"] == expected[1]
    assert metadata["workerCrashes"] == crashes
    assert metadata["failedJobs"] == expected[1]
    assert total_count == sum(expected)
    assert error_class == ("apply_worker_crashed" if mode in {"all_crash", "mixed", "after_progress", "after_handled"} else None)
    assert sum(status == "applied" for _job, status in recorded) == expected[0]
    assert sum(status == "failed" for _job, status in recorded) == (1 if mode in {"handled", "after_handled"} else 0)
    assert {job: _events(database.get_connection(), job) for job in (first, second)} == original_history


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("completed", "dry_run", "targeted"),
    [(None, False, False), (None, True, True), ("applied", False, False), ("failed", True, False)],
)
async def test_single_worker_crash_preserves_completed_counts(owned_runtime, monkeypatch, completed, dry_run, targeted):
    app, first, _ = owned_runtime
    calls = []
    recorded = []

    def acquire(**kwargs):
        calls.append(kwargs)
        if completed and len(calls) == 1:
            return {"tenant_id": "local", "job_id": str(uuid.uuid4()), "title": "synthetic"}
        raise RuntimeError("synthetic pre-claim worker crash")

    def run_job(_job, **_kwargs):
        if completed == "failed":
            return Failed(error="synthetic handled failure", retryable=True), 1
        return Applied(applied_at="2026-10-28T00:00:00Z", verification_confidence=1.0), 1

    monkeypatch.setattr(launcher, "acquire_job", acquire)
    monkeypatch.setattr(launcher, "run_job", run_job)
    monkeypatch.setattr(launcher, "mark_result", lambda _job_id, status, *_args, **_kwargs: recorded.append(status))
    workflow_id, result = await _workflow(
        app, dry_run=dry_run, workers=2 if targeted else 1, limit=2, job_id=first if targeted else None,
    )

    expected = (int(completed == "applied"), int(completed == "failed"))
    assert (result.ok, result.status, result.error) == (False, "failed", "apply_worker_crashed")
    assert (result.applied, result.failed, result.worker_crashes, result.counts_known) == (*expected, 1, True)
    status, outcome, error_class, metadata, total_count = _terminal_evidence(workflow_id)
    assert (status, outcome, error_class) == ("failed", "failed", "apply_worker_crashed")
    assert (metadata["applied"], metadata["failedJobs"], metadata["workerCrashes"], total_count) == (*expected, 1, sum(expected))
    assert metadata["workers"] == 1
    assert recorded == ([completed] if completed else [])
    if targeted:
        assert len(calls) == 1 and str(calls[0]["target_job_id"]) == first


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["empty", "applied", "failed"])
async def test_single_worker_normal_outcomes_are_unchanged(owned_runtime, monkeypatch, outcome):
    app, _, _ = owned_runtime
    monkeypatch.setattr(launcher, "acquire_job", lambda **_kwargs: None if outcome == "empty" else {
        "tenant_id": "local", "job_id": str(uuid.uuid4()), "title": "synthetic",
    })
    monkeypatch.setattr(launcher, "run_job", lambda *_args, **_kwargs: (
        Failed(error="synthetic handled failure", retryable=True) if outcome == "failed"
        else Applied(applied_at="2026-10-28T00:00:00Z", verification_confidence=1.0), 1,
    ))
    monkeypatch.setattr(launcher, "mark_result", lambda *_args, **_kwargs: None)
    workflow_id, result = await _workflow(app, dry_run=False, workers=1, limit=1)

    expected = (int(outcome == "applied"), int(outcome == "failed"))
    assert (result.ok, result.status, result.error) == (outcome != "failed", "failed" if outcome == "failed" else "ok", None)
    assert (result.applied, result.failed, result.worker_crashes, result.counts_known) == (*expected, 0, True)
    status, metric, error_class, metadata, total_count = _terminal_evidence(workflow_id)
    assert (status, metric, error_class) == (
        ("failed", "failed", None) if outcome == "failed" else ("succeeded", "succeeded", None)
    )
    assert (metadata["applied"], metadata["failedJobs"], metadata["workerCrashes"], total_count) == (*expected, 0, sum(expected))


@pytest.mark.asyncio
async def test_single_worker_crash_after_submit_intent_keeps_ambiguity(owned_runtime, monkeypatch):
    app, first, _ = owned_runtime
    original_release = launcher.release_lock
    calls = []

    def run_job(job, *, run_ctx, **_kwargs):
        calls.append(job["job_id"])
        conn = database.get_connection()
        record_job_event(conn, first, "apply", "ApplySubmitIntended", tenant_id="local",
                         payload={"run_id": run_ctx["run_id"]})
        conn.commit()
        raise RuntimeError("synthetic loss after submit intent")

    def release(job_id, **kwargs):
        original_release(job_id, **kwargs)
        raise RuntimeError("synthetic failure after safe release")

    monkeypatch.setattr(launcher, "run_job", run_job)
    monkeypatch.setattr(launcher, "release_lock", release)
    workflow_id, result = await _workflow(app, dry_run=True, workers=2, limit=1, job_id=first)

    assert calls == [first]
    assert (result.ok, result.error, result.applied, result.failed, result.worker_crashes, result.counts_known) == (
        False, "apply_worker_crashed", 0, 0, 1, True,
    )
    conn = database.get_connection()
    assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (first,)).fetchone()[0] == "running"
    assert any(kind == "ApplySubmitIntended" for kind, _ in _events(conn, first))
    assert launcher.acquire_job(target_job_id=first, run_ctx={"dry_run": True}, approval_required=False) is None
    assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (first,)).fetchone()[0] == "needs_verification"
    assert _terminal_evidence(workflow_id)[0:2] == ("failed", "failed")


@pytest.mark.asyncio
async def test_single_worker_cleanup_refusal_preserves_completed_counts(owned_runtime, monkeypatch):
    app, _, _ = owned_runtime
    run = ownership.ApplyLauncherRun()
    cleanups = []
    claims = []

    def cleanup(workers):
        cleanups.append(workers)
        if len(cleanups) >= 2:
            raise RuntimeError("synthetic cleanup refusal")

    def acquire(**_kwargs):
        claims.append(True)
        return {"tenant_id": "local", "job_id": str(uuid.uuid4()), "title": "synthetic"}

    monkeypatch.setattr(ownership, "ApplyLauncherRun", lambda: run)
    monkeypatch.setattr(chrome, "cleanup_workers", cleanup)
    monkeypatch.setattr(launcher, "acquire_job", acquire)
    monkeypatch.setattr(launcher, "run_job", lambda *_args, **_kwargs: (
        Applied(applied_at="2026-10-28T00:00:00Z", verification_confidence=1.0), 1,
    ))
    monkeypatch.setattr(launcher, "mark_result", lambda *_args, **_kwargs: None)
    workflow_id, result = await _workflow(app, dry_run=True, workers=1, limit=2)

    assert claims == [True]
    assert not result.ok and "apply_launcher_cleanup_incomplete" in result.error
    assert (result.applied, result.failed, result.worker_crashes, result.counts_known) == (1, 0, 1, True)
    assert run._cleanup_error is not None
    status, outcome, error_class, metadata, total_count = _terminal_evidence(workflow_id)
    assert (status, outcome, error_class) == ("failed", "failed", "ApplyLauncherCleanupIncomplete")
    assert (metadata["applied"], metadata["failedJobs"], metadata["workerCrashes"], total_count) == (1, 0, 1, 1)


@pytest.mark.asyncio
async def test_crash_after_submit_intent_preserves_ambiguity_and_peer_history(owned_runtime, monkeypatch):
    app, first, second = owned_runtime
    original_acquire = launcher.acquire_job
    original_release = launcher.release_lock
    claimed = threading.Barrier(2)
    calls = []

    def acquire(**kwargs):
        job = original_acquire(**kwargs)
        if job:
            claimed.wait(timeout=10)
        return job

    def run_job(job, *, run_ctx, **_kwargs):
        calls.append(job["job_id"])
        if job["job_id"] == first:
            conn = database.get_connection()
            record_job_event(conn, first, "apply", "ApplySubmitIntended", tenant_id="local",
                             payload={"run_id": run_ctx["run_id"]})
            conn.commit()
            raise RuntimeError("synthetic loss after submit intent")
        return DryRunComplete(navigated_to="https://example.test/apply"), 1

    def release(job_id, **kwargs):
        original_release(job_id, **kwargs)
        if str(job_id) == first:
            raise RuntimeError("synthetic failure after safe release")

    monkeypatch.setattr(launcher, "acquire_job", acquire)
    monkeypatch.setattr(launcher, "run_job", run_job)
    monkeypatch.setattr(launcher, "release_lock", release)
    workflow_id, result = await _workflow(app, dry_run=True)

    assert not result.ok and result.failed == 0 and result.worker_crashes == 1
    assert result.error == "apply_worker_crashed" and result.counts_known is True
    assert sorted(calls) == sorted([first, second])
    conn = database.get_connection()
    # The unfinished claim retains custody until the existing source-owner
    # recovery runs; a released lock alone does not establish completion.
    assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (first,)).fetchone()[0] == "running"
    assert any(kind == "ApplySubmitIntended" for kind, _ in _events(conn, first))
    assert any(kind == "DryRunCompleted" for kind, _ in _events(conn, second))
    assert launcher.acquire_job(target_job_id=first, run_ctx={"dry_run": True}, approval_required=False) is None
    assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (first,)).fetchone()[0] == "needs_verification"
    assert _terminal_evidence(workflow_id)[0:2] == ("failed", "failed")


@pytest.mark.asyncio
@pytest.mark.parametrize("dry_run", [False, True])
async def test_cleanup_incomplete_still_fences_claims_and_joins_the_peer(owned_runtime, monkeypatch, dry_run):
    app, _first, _second = owned_runtime
    run = ownership.ApplyLauncherRun()
    peer_entered = threading.Event()
    cleanup_failed = threading.Event()
    claims = []
    completed = []

    def cleanup(workers):
        if workers == (run.worker_ids[0],):
            assert peer_entered.wait(10)
            cleanup_failed.set()
            raise RuntimeError("synthetic cleanup refusal")

    def acquire(*, worker_id, **_kwargs):
        claims.append(worker_id)
        return {"tenant_id": "local", "job_id": str(uuid.uuid4()), "title": "synthetic"}

    def execute(_job, **_kwargs):
        peer_entered.set()
        assert cleanup_failed.wait(10)
        assert run.stop_event.wait(10)
        return Applied(applied_at="2026-10-28T00:00:00Z", verification_confidence=1.0), 1

    monkeypatch.setattr(ownership, "ApplyLauncherRun", lambda: run)
    monkeypatch.setattr(chrome, "cleanup_workers", cleanup)
    monkeypatch.setattr(launcher, "acquire_job", acquire)
    monkeypatch.setattr(launcher, "run_job", execute)
    monkeypatch.setattr(launcher, "mark_result", lambda job_id, status, **_kwargs: completed.append(status))

    workflow_id, result = await _workflow(app, dry_run=dry_run)

    assert claims == [run.worker_ids[1]]
    assert completed == ["applied"]
    assert not result.ok and result.status == "failed"
    assert (result.applied, result.failed, result.worker_crashes, result.counts_known) == (1, 0, 1, True)
    assert "apply_launcher_cleanup_incomplete" in result.error
    assert run._cleanup_error is not None
    assert (app / "apply-workers" / f"worker-{run.worker_ids[0]}").is_dir()
    terminal = database.get_connection().execute(
        "SELECT outcome, metadata_json FROM operational_attempt_metrics "
        "WHERE stage='apply' AND attempt_kind='apply_batch' ORDER BY metric_id DESC LIMIT 1"
    ).fetchone()
    assert terminal["outcome"] == "failed"
    assert json.loads(terminal["metadata_json"])["applied"] == 1
    assert _terminal_evidence(workflow_id)[0] == "failed"


@pytest.mark.asyncio
async def test_cleanup_without_joined_counts_marks_counts_unknown(owned_runtime, monkeypatch):
    app, _, _ = owned_runtime

    def refused(**_kwargs):
        raise ownership.ApplyLauncherCleanupIncomplete("synthetic unverified cleanup")

    monkeypatch.setattr(launcher, "main", refused)
    _workflow_id, result = await _workflow(app, dry_run=True)
    assert not result.ok and result.counts_known is False
    assert result.worker_crashes is None
    assert "apply_launcher_cleanup_incomplete" in result.error


def test_direct_launcher_reports_worker_crashes_without_inventing_failed_jobs(owned_runtime, monkeypatch, capsys):
    def crash(**_kwargs):
        raise RuntimeError("synthetic pre-claim worker crash")

    monkeypatch.setattr(launcher, "acquire_job", crash)
    with pytest.raises(ApplyBatchWorkersCrashed) as caught:
        launcher.main(limit=2, workers=2, dry_run=False, install_signal_handlers=False)
    assert caught.value.counts.to_dict() == {"applied": 0, "failed": 0, "worker_crashes": 2}
    assert "0 applied, 0 failed, 2 worker(s) crashed" in capsys.readouterr().out


@pytest.mark.parametrize("interrupt", [KeyboardInterrupt(), SystemExit(7)])
def test_single_worker_interrupt_is_not_a_worker_crash(owned_runtime, monkeypatch, interrupt):
    metrics = []

    def interrupt_before_claim(**_kwargs):
        raise interrupt

    monkeypatch.setattr(launcher, "acquire_job", interrupt_before_claim)
    monkeypatch.setattr(launcher, "_record_apply_batch_metric", lambda **kwargs: metrics.append(kwargs))
    if isinstance(interrupt, SystemExit):
        with pytest.raises(SystemExit, match="7"):
            launcher.main(limit=1, workers=1, install_signal_handlers=False)
    else:
        assert launcher.main(limit=1, workers=1, install_signal_handlers=False) == (0, 0)
    assert metrics[-1]["outcome"] == "failed"
    assert metrics[-1]["worker_crashes"] == 0
    assert metrics[-1]["error_class"] == ("SystemExit" if isinstance(interrupt, SystemExit) else "manual_abort_apply")


def test_legacy_temporal_results_do_not_invent_a_crash_observation():
    from temporalio.converter import DefaultPayloadConverter
    from jobctrl.apply.activities import ApplyActivityOutput
    from jobctrl.apply.workflow import ApplyWorkflowResult

    converter = DefaultPayloadConverter()
    activity_payload = converter.to_payload({"status": "ok", "applied": 0, "failed": 0, "error": None})
    activity_result = converter.from_payload(activity_payload, ApplyActivityOutput)
    assert activity_result.worker_crashes is None
    workflow_payload = converter.to_payload({"ok": False, "run_id": "historical", "status": "failed", "error": "legacy", "applied": 0, "failed": 0})
    workflow_result = converter.from_payload(workflow_payload, ApplyWorkflowResult)
    assert workflow_result.worker_crashes is None
    assert workflow_result.counts_known is None


@activity.defn(name="apply")
async def _legacy_apply_activity(_payload) -> dict:
    return {"status": "ok", "applied": 1, "failed": 0, "error": None}


@pytest.mark.asyncio
async def test_legacy_activity_result_keeps_count_completeness_unknown(owned_runtime):
    app, _, _ = owned_runtime
    queue = f"legacy-apply-{uuid.uuid4()}"
    async with local_env() as env:
        async with Worker(
            env.client, task_queue=queue, workflows=[ApplyWorkflow],
            activities=[_legacy_apply_activity, _check_budget, record_workflow_started, record_workflow_outcome],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            handle = await env.client.start_workflow(
                ApplyWorkflow.run,
                ApplyWorkflowInput(tenant_id="local", expected_app_dir=str(app), expected_db_path=str(config.DB_PATH)),
                id=f"legacy-apply-{uuid.uuid4()}", task_queue=queue,
            )
            result = await asyncio.wait_for(handle.result(), 30)
            history = await handle.fetch_history()
        await Replayer(workflows=[ApplyWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
    assert result.ok and result.applied == 1 and result.failed == 0
    assert result.worker_crashes is None and result.counts_known is False


@pytest.mark.asyncio
@pytest.mark.parametrize("dry_run", [False, True])
async def test_finish_cleanup_failure_records_failed_metric_after_completed_work(owned_runtime, monkeypatch, dry_run):
    app, _, _ = owned_runtime
    run = ownership.ApplyLauncherRun()
    lock = threading.Lock()
    completed = []

    def cleanup(_workers):
        if run._finishing:
            raise RuntimeError("synthetic finish-time cleanup refusal")

    def acquire(**_kwargs):
        return {"tenant_id": "local", "job_id": str(uuid.uuid4()), "title": "synthetic"}

    def execute(_job, **_kwargs):
        return Applied(applied_at="2026-10-28T00:00:00Z", verification_confidence=1.0), 1

    def mark(_job_id, status, **_kwargs):
        with lock:
            completed.append(status)

    monkeypatch.setattr(ownership, "ApplyLauncherRun", lambda: run)
    monkeypatch.setattr(chrome, "cleanup_workers", cleanup)
    monkeypatch.setattr(launcher, "acquire_job", acquire)
    monkeypatch.setattr(launcher, "run_job", execute)
    monkeypatch.setattr(launcher, "mark_result", mark)
    workflow_id, result = await _workflow(app, dry_run=dry_run)

    assert completed == ["applied"] * 4
    assert (result.ok, result.applied, result.failed, result.worker_crashes, result.counts_known) == (False, 4, 0, 0, True)
    status, outcome, error_class, metadata, total_count = _terminal_evidence(workflow_id)
    assert (status, outcome, error_class) == ("failed", "failed", "ApplyLauncherCleanupIncomplete")
    assert (metadata["applied"], metadata["failedJobs"], metadata["workerCrashes"], total_count) == (4, 0, 0, 4)
