"""Tests for ``ApplyWorkflow``.

The apply path is its own single-activity workflow because it needs a
different retry policy and parameter shape than the generic pipeline.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from .apply_execution_fixture import in_process_apply_execution as in_process_apply_execution
from .test_apply_regressions import owned_email_path as owned_email_path

import pytest
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ActivityError, ApplicationError
from .temporal_env import time_skipping_env
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl.apply.activities import apply_activity, capture_apply_dispatch_frontier_activity
from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput, ApplyWorkflowResult
from jobctrl.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobctrl.llm import SpendBudgetStatus


JOB_ID = "90000000-0000-4000-8000-000000000001"


def test_apply_workflow_input_rejects_url_shaped_job_id() -> None:
    with pytest.raises(ValueError, match="canonical UUID"):
        ApplyWorkflowInput(tenant_id="local", job_id="https://example.com/job")


@pytest.fixture(autouse=True)
def permit_browser_for_existing_apply_workflow_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """Workflow retry tests execute after the capability gate has passed."""

    from jobctrl import browser_capabilities

    monkeypatch.setattr(
        browser_capabilities,
        "require_system_browser_capability",
        lambda _capability: Path("/test/Chromium"),
    )


@activity.defn(name="check_spend_budget")
async def _check_spend_budget(_payload) -> SpendBudgetStatus:
    return SpendBudgetStatus(
        day="2026-07-03",
        input_tokens=0,
        output_tokens=0,
        estimated_usd=0.0,
        daily_budget_usd=25.0,
        lane="apply",
        lane_input_tokens=0,
        lane_output_tokens=0,
        lane_token_limit=0,
        lane_exceeded=False,
        global_exceeded=False,
        exceeded=False,
    )


def _activities():
    return [apply_activity, capture_apply_dispatch_frontier_activity, _check_spend_budget, record_workflow_started, record_workflow_outcome]


@pytest.mark.asyncio
async def test_apply_workflow_returns_ok_when_apply_main_succeeds():
    queue = f"apply-wf-{uuid.uuid4()}"
    workflow_id = f"apply-{uuid.uuid4()}"

    with patch(
        "jobctrl.apply.launcher.main",
        return_value=(3, 0),
    ) as apply_main_mock:
        async with time_skipping_env() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ApplyWorkflow],
                activities=_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    ApplyWorkflow.run,
                    ApplyWorkflowInput(
                        tenant_id="local",
                        min_score=8,
                        limit=3,
                        workers=2,
                        model="haiku",
                        headless=True,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )

    apply_main_mock.assert_called_once()
    assert result.ok is True
    assert result.status == "ok"
    assert result.applied == 3
    assert result.failed == 0
    assert result.error is None
    assert result.run_id == workflow_id


@pytest.mark.asyncio
async def test_live_apply_workflow_does_not_retry_transient_failures():
    """Live apply activity has ``maximum_attempts=1`` for at-most-once submit safety."""
    queue = f"apply-wf-retry-{uuid.uuid4()}"
    workflow_id = f"apply-retry-{uuid.uuid4()}"

    with patch(
        "jobctrl.apply.launcher.main",
        side_effect=RuntimeError("apply boom"),
    ) as apply_main_mock:
        async with time_skipping_env() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ApplyWorkflow],
                activities=_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    ApplyWorkflow.run,
                    ApplyWorkflowInput(
                        tenant_id="local",
                        limit=1,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )

    assert apply_main_mock.call_count == 1
    assert result.ok is False
    assert result.status == "failed"
    assert "apply boom" in (result.error or "")
    assert result.run_id == workflow_id


@pytest.mark.asyncio
async def test_dry_run_apply_workflow_recovers_when_first_attempt_fails():
    """Dry-run keeps retry allowance because browser-layer enforcement prevents submit."""
    queue = f"apply-wf-recover-{uuid.uuid4()}"
    workflow_id = f"apply-recover-{uuid.uuid4()}"

    with patch(
        "jobctrl.apply.launcher.main",
        side_effect=[RuntimeError("transient"), (1, 0)],
    ) as apply_main_mock:
        async with time_skipping_env() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ApplyWorkflow],
                activities=_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    ApplyWorkflow.run,
                    ApplyWorkflowInput(
                        tenant_id="local",
                        limit=1,
                        dry_run=True,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )

    assert apply_main_mock.call_count == 2
    assert result.ok is True
    assert result.status == "ok"
    assert result.applied == 1
    assert result.failed == 0


@pytest.mark.asyncio
async def test_apply_workflow_continuous_batch_is_bounded_and_continues_as_new(monkeypatch):
    captured = {}

    async def fake_execute_activity(_activity, payload, **kwargs):
        captured["payload"] = payload
        captured["timeout"] = kwargs["start_to_close_timeout"]
        if _activity is capture_apply_dispatch_frontier_activity:
            return 3
        return SimpleNamespace(status="ok", error=None, applied=0, failed=0)

    monkeypatch.setattr(
        "jobctrl.apply.workflow.workflow.info",
        lambda: SimpleNamespace(workflow_id="apply-continuous"),
    )
    monkeypatch.setattr(
        "jobctrl.apply.workflow.workflow.execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr("jobctrl.apply.workflow.workflow.patched", lambda _patch_id: True)

    result = await ApplyWorkflow()._run_apply(
        ApplyWorkflowInput(
            tenant_id="local",
            job_id=JOB_ID,
            continuous=True,
            limit=0,
        )
    )

    assert result.ok is True
    assert captured["payload"].job_id == JOB_ID
    assert captured["payload"].limit == 25
    assert captured["payload"].continuous is False
    assert captured["payload"].standing_refusal_poll is True
    assert captured["timeout"] == timedelta(hours=1)

    class ContinueAsNewRaised(RuntimeError):
        pass

    async def fake_started(**_kwargs):
        return None

    async def fake_outcome(**kwargs):
        captured.setdefault("outcomes", []).append(kwargs)

    async def fake_sleep(delay):
        captured["sleep"] = delay

    def fake_continue_as_new(payload):
        captured["continued_payload"] = payload
        raise ContinueAsNewRaised

    async def fake_run_apply(_payload):
        return result

    workflow = ApplyWorkflow()
    monkeypatch.setattr(workflow, "_run_apply", fake_run_apply)
    monkeypatch.setattr("jobctrl.apply.workflow.emit_workflow_started", fake_started)
    monkeypatch.setattr("jobctrl.apply.workflow.emit_workflow_outcome", fake_outcome)
    monkeypatch.setattr(
        "jobctrl.apply.workflow.workflow.now",
        lambda: datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    monkeypatch.setattr(
        "jobctrl.apply.workflow.workflow.continue_as_new",
        fake_continue_as_new,
    )
    monkeypatch.setattr("jobctrl.apply.workflow.workflow.sleep", fake_sleep)

    async def fake_preflight(_activity, payload, **_kwargs):
        captured.setdefault("preflight_lanes", []).append(payload.lane)
    monkeypatch.setattr("jobctrl.apply.workflow.execute_control_activity", fake_preflight)

    with pytest.raises(ContinueAsNewRaised):
        await workflow.run(ApplyWorkflowInput(tenant_id="local", continuous=True))
    assert captured["sleep"] == timedelta(seconds=30)
    assert captured["continued_payload"].continuous is True
    assert captured.get("outcomes", []) == []
    assert captured["preflight_lanes"] == ["apply"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failed,settled,crashes,error,continues", [
    (1, 1, 0, None, True),
    (2, 1, 0, None, False),  # One failure has no refusal proof.
    (1, 1, 1, "apply_worker_crashed", False),
    (1, 1, 0, "apply_launcher_cleanup_incomplete", False),
    (1, None, None, None, False),  # Historical activity result has no proof.
    (1, True, 0, None, False),
])
async def test_continuous_apply_only_continues_proven_refusals(
    monkeypatch, failed, settled, crashes, error, continues,
):
    from jobctrl.apply import workflow as apply_workflow

    result = ApplyWorkflowResult(ok=False, run_id="synthetic", status="failed", error=error,
                                 failed=failed, worker_crashes=crashes, settled_refusals=settled)
    instance = ApplyWorkflow()
    async def run_apply(_payload):
        return result
    async def noop(*_args, **_kwargs):
        return None
    async def frontier(*_args, **_kwargs):
        return 4
    outcomes = []
    async def outcome(**kwargs):
        outcomes.append(kwargs)
    patch_ids = []
    def patched(patch_id):
        patch_ids.append(patch_id)
        return True
    class Continued(Exception):
        pass
    def continue_as_new(_payload):
        raise Continued
    monkeypatch.setattr(instance, "_run_apply", run_apply)
    monkeypatch.setattr(apply_workflow, "emit_workflow_started", noop)
    monkeypatch.setattr(apply_workflow, "emit_workflow_outcome", outcome)
    monkeypatch.setattr(apply_workflow, "execute_control_activity", noop)
    monkeypatch.setattr(apply_workflow.workflow, "now", lambda: datetime(2026, 1, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(apply_workflow.workflow, "patched", patched)
    monkeypatch.setattr(apply_workflow.workflow, "sleep", noop)
    monkeypatch.setattr(apply_workflow.workflow, "execute_activity", frontier)
    monkeypatch.setattr(apply_workflow.workflow, "continue_as_new", continue_as_new)
    if continues:
        with pytest.raises(Continued):
            await instance.run(ApplyWorkflowInput(tenant_id="local", continuous=True))
        assert outcomes == []
        assert "apply-standing-refusal-continuation-v1" in patch_ids
    else:
        assert await instance.run(ApplyWorkflowInput(tenant_id="local", continuous=True)) == result
        assert outcomes[0]["status"] == "failed"
        assert "apply-standing-refusal-continuation-v1" not in patch_ids


@pytest.mark.asyncio
async def test_continuous_apply_workflow_budget_exceeded_halts_before_apply():
    queue = f"apply-wf-budget-{uuid.uuid4()}"
    workflow_id = f"apply-budget-{uuid.uuid4()}"

    @activity.defn(name="check_spend_budget")
    async def budget_exceeded(_payload):
        raise ApplicationError(
            "LLM daily spend budget exceeded",
            type="budget_exceeded",
            non_retryable=True,
        )

    with patch(
        "jobctrl.apply.launcher.main",
        return_value=(1, 0),
    ) as apply_main_mock:
        async with time_skipping_env() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ApplyWorkflow],
                activities=[
                    apply_activity,
                    budget_exceeded,
                    record_workflow_started,
                    record_workflow_outcome,
                ],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                with pytest.raises(WorkflowFailureError) as exc_info:
                    await env.client.execute_workflow(
                        ApplyWorkflow.run,
                        ApplyWorkflowInput(tenant_id="local", continuous=True),
                        id=workflow_id,
                        task_queue=queue,
                    )

    cause = exc_info.value.cause
    app_error = cause.cause if isinstance(cause, ActivityError) else cause
    assert isinstance(app_error, ApplicationError)
    assert app_error.type == "budget_exceeded"
    assert app_error.non_retryable
    assert apply_main_mock.call_count == 0


@pytest.mark.asyncio
async def test_apply_workflow_does_not_retry_lookup_errors():
    """``LookupError`` is wrapped in a non-retryable ``ApplicationError``."""
    queue = f"apply-wf-lookup-{uuid.uuid4()}"
    workflow_id = f"apply-lookup-{uuid.uuid4()}"

    with patch(
        "jobctrl.apply.launcher.main",
        side_effect=LookupError("no matching JobId"),
    ) as apply_main_mock:
        async with time_skipping_env() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ApplyWorkflow],
                activities=_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    ApplyWorkflow.run,
                    ApplyWorkflowInput(
                        tenant_id="local",
                        limit=1,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )

    # Non-retryable ⇒ called exactly once.
    assert apply_main_mock.call_count == 1
    assert result.ok is False
    assert result.status == "failed"
    assert "no matching JobId" in (result.error or "")


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["targeted", "batch", "standing"])
async def test_registered_apply_rpc_real_activity_main_never_reclaims_manual_skip(tmp_path, monkeypatch, entry):
    """Owned exact schema + native RPC/Temporal/activity/launcher, no Apply-core stubs."""
    import asyncio
    import threading
    from jobctrl import config, database
    from jobctrl.domain.rpc.messages import JsonRpcRequest
    from jobctrl.infrastructure.rpc.handlers import register_default_handlers
    from jobctrl.infrastructure.rpc.server import JsonRpcServer
    from jobctrl.infrastructure.temporal.finalize import record_workflow_started, record_workflow_outcome
    from jobctrl.llm import check_spend_budget
    from jobctrl.apply import launcher
    from jobctrl.state import ensure_job_stage_rows, set_stage_state
    from tests.test_exact_v7_apply_acquire_job_identity import _insert_ready_job, LOCAL_JOB_ID

    monkeypatch.setattr(launcher, "_stop_event", threading.Event())
    db_path = tmp_path / "owned.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(config, "LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr(config, "ensure_dirs", lambda: None)
    # These are external browser/profile transports only. No browser may start.
    monkeypatch.setattr(launcher, "_load_profile_snapshot", lambda: SimpleNamespace())
    monkeypatch.setattr("jobctrl.browser_capabilities.require_system_browser_capability", lambda _: Path("/synthetic/Chromium"))
    monkeypatch.setattr(launcher, "run_job", lambda *a, **k: pytest.fail("manual stop reached sender/use-case"))
    conn = database.init_db(db_path)
    _insert_ready_job(conn, "local", LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, "score", "succeeded", validate_transition=False)
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "skipped", retryable=False, validate_transition=False, attempt_count=2)
    conn.commit()
    before = [tuple(row) for row in conn.execute("SELECT * FROM job_materials_artifacts")]
    loop = asyncio.get_running_loop()
    queue = f"skip-{uuid.uuid4()}"
    async with time_skipping_env() as env:
        async def starter(spec):
            future = asyncio.run_coroutine_threadsafe(env.client.start_workflow(
                spec.workflow.run, args=spec.args, id=spec.workflow_id or f"skip-{uuid.uuid4()}", task_queue=queue,
            ), loop)
            return await asyncio.wrap_future(future)

        async def canceler(_):
            return None

        rpc = JsonRpcServer(workflow_starter=starter)
        register_default_handlers(rpc, canceler=canceler)
        async with Worker(env.client, task_queue=queue, workflows=[ApplyWorkflow],
                          activities=[apply_activity, capture_apply_dispatch_frontier_activity, check_spend_budget, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            params = {"tenantId": "local", "expectedAppDir": str(tmp_path), "expectedDbPath": str(db_path),
                      "limit": 2, "workers": 1, "continuous": entry == "standing"}
            if entry == "targeted":
                params["jobId"] = LOCAL_JOB_ID
            response = await asyncio.to_thread(rpc.dispatch, JsonRpcRequest(method="apply", id=1173, params=params))
            assert response.error is None, response
            workflow_id = response.result["workflowId"]
            handle = env.client.get_workflow_handle(workflow_id)
            if entry == "standing":
                async with asyncio.timeout(45):
                    while conn.execute("SELECT COUNT(*) FROM operational_attempt_metrics WHERE attempt_kind='apply_batch' AND outcome != 'started'").fetchone()[0] < 1:
                        await asyncio.sleep(0.05)
                await handle.cancel()
                with pytest.raises(WorkflowFailureError):
                    await handle.result()
            else:
                result = await handle.result()
                assert result["ok"] and result["applied"] == result["failed"] == 0
            assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type IN ('ApplyRunStarted','ApplySubmitIntended')").fetchone()[0] == 0
            assert tuple(conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()) == ("skipped", 2)
            assert [tuple(row) for row in conn.execute("SELECT * FROM job_materials_artifacts")] == before
            print({"entry": entry, "job": LOCAL_JOB_ID, "workflow": workflow_id,
                   "temporal_run": (await handle.describe()).run_id, "claims": 0, "intents": 0, "sender_calls": 0})
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_standing_apply_renews_frontier_after_completed_poll(tmp_path, monkeypatch):
    """The first old poll stays fenced; a subsequent poll may observe reset."""
    import asyncio
    import json
    import threading
    from jobctrl import config, database
    from jobctrl.apply import launcher, workflow as apply_workflow
    from jobctrl.domain.apply.value_objects import DryRunComplete
    from jobctrl.domain.rpc.messages import JsonRpcRequest
    from jobctrl.infrastructure.rpc.handlers import register_default_handlers
    from jobctrl.infrastructure.rpc.server import JsonRpcServer
    from jobctrl.state import ensure_job_stage_rows, record_job_event, reset_job_stage, set_stage_state
    from tests.test_exact_v7_apply_acquire_job_identity import _insert_ready_job, LOCAL_JOB_ID

    db_path = tmp_path / 'owned.db'
    for name, value in [('APP_DIR', tmp_path), ('DB_PATH', db_path), ('LOG_DIR', tmp_path / 'logs'),
                        ('APPLY_WORKER_DIR', tmp_path / 'workers'), ('CHROME_WORKER_DIR', tmp_path / 'chrome')]:
        monkeypatch.setattr(config, name, value)
    monkeypatch.setattr(database, 'DB_PATH', db_path)
    monkeypatch.setattr(config, 'ensure_dirs', lambda: None)
    monkeypatch.setattr(launcher, '_stop_event', threading.Event())
    monkeypatch.setattr(launcher, '_load_profile_snapshot', lambda: SimpleNamespace())
    monkeypatch.setattr(apply_workflow, '_APPLY_CONTINUOUS_EMPTY_POLL_DELAY', timedelta(milliseconds=50))
    monkeypatch.setattr('jobctrl.enrichment.availability.require_fresh_active', lambda *_a, **_k: None)
    monkeypatch.setattr('jobctrl.enrichment.availability.assert_fresh_candidate', lambda *_a, **_k: None)
    monkeypatch.setattr('jobctrl.enrichment.availability.fresh_active', lambda *_a, **_k: True)
    calls = []
    release_fake = threading.Event()
    def fake_run(job, *_args, **_kwargs):
        calls.append(job['job_id'])
        assert release_fake.wait(10), 'synthetic observer did not release the fake run'
        return DryRunComplete(navigated_to='', coverage='partial'), 0
    monkeypatch.setattr(launcher, 'run_job', fake_run)
    conn = database.init_db(db_path)
    _insert_ready_job(conn, 'local', LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, 'score', 'succeeded', validate_transition=False)
    conn.commit()
    loop = asyncio.get_running_loop()
    queue = f'synthetic-standing-{uuid.uuid4()}'
    async with time_skipping_env() as env:
        async def starter(spec):
            future = asyncio.run_coroutine_threadsafe(env.client.start_workflow(
                spec.workflow.run, args=spec.args, id=spec.workflow_id or f'owned-{uuid.uuid4()}', task_queue=queue), loop)
            return await asyncio.wrap_future(future)
        rpc = JsonRpcServer(workflow_starter=starter)
        register_default_handlers(rpc, canceler=lambda _: None)
        response = await asyncio.to_thread(rpc.dispatch, JsonRpcRequest(method='apply', id=1, params={
            'tenantId': 'local', 'expectedAppDir': str(tmp_path), 'expectedDbPath': str(db_path),
            'workers': 1, 'limit': 1, 'dryRun': True, 'continuous': True}))
        assert response.error is None, response
        set_stage_state(conn, LOCAL_JOB_ID, 'apply', 'skipped', retryable=False, validate_transition=False)
        record_job_event(conn, LOCAL_JOB_ID, 'apply', 'StageSkipped', payload={'previousState': 'pending', 'manualDisposition': 'skip'})
        conn.commit()
        reset_job_stage(conn, LOCAL_JOB_ID, 'apply')
        reset_event = conn.execute("SELECT MAX(event_id) FROM job_events WHERE event_type='StageReset'").fetchone()[0]
        handle = env.client.get_workflow_handle(response.result['workflowId'])
        async with Worker(env.client, task_queue=queue, workflows=[ApplyWorkflow], activities=_activities(),
                          workflow_runner=UnsandboxedWorkflowRunner()):
            try:
                async with asyncio.timeout(45):
                    while not calls:
                        await asyncio.sleep(.05)
                await handle.cancel()
                release_fake.set()
                outcome = await handle.result()
                assert outcome['ok'] is False and outcome['status'] == 'failed'
                assert outcome['error'] == 'Cancelled'
            finally:
                release_fake.set()
        starts = [json.loads(row[0]) for row in conn.execute("SELECT payload_json FROM job_events WHERE event_type='ApplyRunStarted'")]
        assert len(starts) == len(calls) == 1
        assert starts[0]['dispatch_frontier'] >= reset_event
        terminal = [json.loads(row[0]) for row in conn.execute("SELECT payload_json FROM job_events WHERE event_type='WorkflowFailed'")]
        assert terminal[-1]['errorCode'] == 'apply_failed' and terminal[-1]['errorMessage'] == 'Cancelled'
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplySubmitIntended'").fetchone()[0] == 0
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_standing_email_refusal_continues_through_peer_and_new_authority(owned_email_path, monkeypatch):
    """A real Temporal execution keeps polling after a settled refusal, not a failed workflow rerun."""
    import asyncio
    from temporalio.client import WorkflowExecutionStatus
    from jobctrl import config, database
    from jobctrl.apply import launcher, workflow as apply_workflow
    from jobctrl.apply.activities import ApplyActivityOutput
    from jobctrl.domain.apply.process_manager import _build_email_application_candidate, _candidate_payload
    from jobctrl.domain.apply.use_cases import _email_application_context
    from jobctrl.infrastructure.apply_controls import capture_apply_dispatch_frontier
    from jobctrl.infrastructure.scoring import criteria_provider
    from jobctrl.state import record_job_event
    from tests.test_apply_regressions import _insert_ready_job, _insert_review_decision, _seed_current_apply_binding

    s = owned_email_path
    for name, value in [("APP_DIR", s.db_path.parent), ("DB_PATH", s.db_path),
                        ("LOG_DIR", s.db_path.parent / "logs"),
                        ("APPLY_WORKER_DIR", s.db_path.parent / "workers"),
                        ("CHROME_WORKER_DIR", s.db_path.parent / "chrome")]:
        monkeypatch.setattr(config, name, value)
    monkeypatch.setattr(database, "DB_PATH", s.db_path)
    monkeypatch.setattr(config, "ensure_dirs", lambda: None)
    monkeypatch.setattr(launcher, "_load_profile_snapshot", lambda: s.snapshot)
    monkeypatch.setattr(criteria_provider, "read_apply_approval_required", lambda default: False)
    monkeypatch.setattr(criteria_provider, "read_min_fit_score", lambda default: default)
    monkeypatch.setattr(criteria_provider, "read_apply_concurrency", lambda default: default)
    monkeypatch.setattr(apply_workflow, "_APPLY_CONTINUOUS_EMPTY_POLL_DELAY", timedelta(milliseconds=100))
    s.conn.execute("UPDATE jobs SET title='Changed synthetic role' WHERE job_id=?", (s.job_id,))
    s.conn.commit()
    calls = []
    real_run = launcher.run_job
    def observe(job, *args, **kwargs):
        calls.append(str(job["job_id"]))
        return real_run(job, *args, **kwargs)
    monkeypatch.setattr(launcher, "run_job", observe)
    # Prepare a fully reviewed peer before launch. Its temporary low score
    # keeps it out of the first polls; raising the score admits it atomically.
    peer_url = "https://example.com/z-peer"
    peer_apply = "https://example.com/z-apply"
    peer = _insert_ready_job(s.conn, url=peer_url, application_url=peer_apply)
    _seed_current_apply_binding(s.conn, job_id=peer, application_url=peer_apply, run_id="peer-dry-run")
    s.conn.execute("UPDATE jobs SET company='Other Example',site='Other Example' WHERE job_id=?", (peer,))
    s.conn.execute("UPDATE job_enrichments SET full_description='Send to apply@example.com' WHERE job_id=?", (peer,))
    s.conn.execute("UPDATE job_scores SET fit_score=1 WHERE job_id=?", (peer,))
    for kind, filename in (("tailored_resume", "resume.txt"), ("resume_pdf", "resume.pdf")):
        s.conn.execute("UPDATE job_materials_artifacts SET path=? WHERE job_id=? AND artifact_type=?",
                       (str(s.db_path.parent / filename), peer, kind))
    columns, joins = launcher._apply_candidate_select_parts()
    row = dict(s.conn.execute(f"SELECT {columns} FROM jobs {joins} WHERE jobs.job_id=?", (peer,)).fetchone())
    candidate = _build_email_application_candidate("apply@example.com", _email_application_context(row, s.snapshot))
    candidate_payload = _candidate_payload(candidate, run_id="peer-reviewed", duration_ms=0)
    record_job_event(s.conn, peer, "apply", "EmailApplicationCandidateRecorded", payload=candidate_payload)
    _insert_review_decision(s.conn, job_id=peer, materials_generation=1, profile_version=1,
                            application_url=peer_apply, decision_id="peer-approved")
    s.conn.execute("UPDATE application_review_decisions SET email_recipient=?,email_attachment_artifact_id=? "
                   "WHERE job_id=?", (candidate.recipient_email, candidate.attachment_artifact_id, peer))
    source = launcher._email_source_binding(s.conn, "local", peer, row)
    record_job_event(s.conn, peer, "apply", "ApplyReviewDecisionRecorded", payload={
        "decisionId": "peer-approved", "emailApprovalBinding": {
            "version": 1, "candidateSha256": launcher._email_candidate_digest(candidate_payload),
            "materialsSha256": launcher._email_materials_digest(source),
            "postingUrlSha256": launcher._email_binding_digest([source["posting_url"]]),
            "postingInputsSha256": launcher._email_posting_inputs_digest(source),
        },
    })
    s.conn.commit()
    frontier, _ = capture_apply_dispatch_frontier(s.conn, tenant_id="local")
    queue = f"synthetic-email-standing-{uuid.uuid4()}"
    workflow_id = f"synthetic-email-standing-{uuid.uuid4()}"
    async with time_skipping_env() as env:
        async with Worker(env.client, task_queue=queue, workflows=[ApplyWorkflow], activities=_activities(),
                          workflow_runner=UnsandboxedWorkflowRunner()):
            handle = await env.client.start_workflow(
                ApplyWorkflow.run,
                ApplyWorkflowInput(tenant_id="local", expected_app_dir=str(s.db_path.parent),
                                   expected_db_path=str(s.db_path), continuous=True, workers=1,
                                   approval_required=False, dispatch_frontier=frontier),
                id=workflow_id, task_queue=queue,
            )
            latest = env.client.get_workflow_handle(workflow_id)
            first_run = handle.result_run_id
            assert first_run
            async def next_run(previous):
                async with asyncio.timeout(30):
                    while True:
                        description = await latest.describe()
                        assert description.status in {WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.CONTINUED_AS_NEW}
                        if description.run_id != previous and description.status == WorkflowExecutionStatus.RUNNING:
                            return description.run_id
                        await asyncio.sleep(.1)
            async def until(predicate):
                async with asyncio.timeout(30):
                    while not predicate():
                        description = await latest.describe()
                        assert description.status in {WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.CONTINUED_AS_NEW}
                        await asyncio.sleep(.1)
            try:
                await until(lambda: s.conn.execute(
                    "SELECT count(*) FROM job_events WHERE job_id=? AND event_type='ApplyEmailAuthorityParked'",
                    (s.job_id,)).fetchone()[0] == 1)
                second_run = await next_run(first_run)
                await next_run(second_run)  # An unchanged authority survives an additional poll.
                assert calls == [s.job_id] and s.sender_calls == 0
                assert tuple(s.conn.execute("SELECT state,attempt_count FROM job_stage_states "
                                            "WHERE job_id=? AND stage='apply'", (s.job_id,)).fetchone()) == ("failed", 0)
                assert s.conn.execute("SELECT count(*) FROM job_events WHERE job_id=? "
                                      "AND event_type='ApplyEmailAuthorityRefusalRefunded'", (s.job_id,)).fetchone()[0] == 1
                first = env.client.get_workflow_handle(workflow_id, run_id=first_run)
                history = await first.fetch_history()
                outputs = []
                scheduled = {event.event_id for event in history.events
                             if event.HasField("activity_task_scheduled_event_attributes")
                             and event.activity_task_scheduled_event_attributes.activity_type.name == "apply"}
                for event in history.events:
                    if (event.HasField("activity_task_completed_event_attributes")
                            and event.activity_task_completed_event_attributes.scheduled_event_id in scheduled):
                        payloads = event.activity_task_completed_event_attributes.result.payloads
                        outputs.append((await env.client.data_converter.decode(payloads, [ApplyActivityOutput]))[0])
                assert any((out.status, out.applied, out.failed, out.worker_crashes, out.settled_refusals)
                           == ("failed", 0, 1, 0, 1) for out in outputs)
                assert any(event.HasField("workflow_execution_continued_as_new_event_attributes") for event in history.events)
                await Replayer(workflows=[ApplyWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)

                s.conn.execute("UPDATE jobs SET title='Changed synthetic role again' WHERE job_id=?", (s.job_id,))
                s.conn.commit()
                await until(lambda: s.conn.execute("SELECT count(*) FROM job_events WHERE job_id=? "
                                                   "AND event_type='ApplyEmailAuthorityParked'", (s.job_id,)).fetchone()[0] == 2)
                assert calls == [s.job_id, s.job_id] and s.sender_calls == 0
                assert s.conn.execute("SELECT count(*) FROM job_events WHERE job_id=? AND event_type='ApplySubmitIntended'",
                                      (s.job_id,)).fetchone()[0] == 0
                s.conn.execute("UPDATE job_scores SET fit_score=9 WHERE job_id=?", (peer,))
                s.conn.commit()
                await until(lambda: s.conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'",
                                                  (peer,)).fetchone()[0] == "succeeded")
                assert calls == [s.job_id, s.job_id, peer] and s.sender_calls == len(s.sends) == 1
                await until(lambda: s.conn.execute("SELECT count(*) FROM job_events WHERE job_id=? "
                                                   "AND event_type='ApplyClaimSettled'", (peer,)).fetchone()[0] == 1)
                peer_run = (await latest.describe()).run_id
                await next_run(peer_run)
            finally:
                description = await latest.describe()
                if description.status == WorkflowExecutionStatus.RUNNING:
                    await latest.terminate("synthetic test complete")


@pytest.mark.asyncio
async def test_legacy_apply_history_replays_after_frontier_patch(tmp_path, monkeypatch):
    """A pre-patch command and input replay without inventing a new marker."""
    from dataclasses import asdict
    from jobctrl import config, database

    path = tmp_path / 'owned-replay.db'
    monkeypatch.setattr(config, 'APP_DIR', tmp_path)
    monkeypatch.setattr(config, 'DB_PATH', path)
    monkeypatch.setattr(database, 'DB_PATH', path)
    database.init_db(path)
    monkeypatch.setattr('jobctrl.apply.launcher.main', lambda **_kwargs: (0, 0))
    payload = asdict(ApplyWorkflowInput(tenant_id='local', expected_app_dir=str(tmp_path), expected_db_path=str(path)))
    payload.pop('dispatch_frontier')
    queue = f'legacy-replay-{uuid.uuid4()}'
    async with time_skipping_env() as env:
        with monkeypatch.context() as legacy:
            legacy.setattr('temporalio.workflow.patched', lambda _patch_id: False)
            async with Worker(env.client, task_queue=queue, workflows=[ApplyWorkflow], activities=_activities(),
                              workflow_runner=UnsandboxedWorkflowRunner()):
                handle = await env.client.start_workflow(ApplyWorkflow.run, payload, id=f'legacy-{uuid.uuid4()}', task_queue=queue)
                await handle.result()
                history = await handle.fetch_history()
        await Replayer(workflows=[ApplyWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
    database.close_connection(path)


@pytest.mark.asyncio
@pytest.mark.parametrize('release', [False, True])
async def test_registered_rpc_dispatch_before_skip_cannot_revive_after_reset(tmp_path, monkeypatch, release):
    """An old unstarted workflow is fenced; a new post-reset request may run."""
    import asyncio
    import json
    import threading
    from jobctrl import config, database
    from jobctrl.apply import launcher
    from jobctrl.domain.apply.value_objects import DryRunComplete
    from jobctrl.domain.rpc.messages import JsonRpcRequest
    from jobctrl.infrastructure.rpc.handlers import register_default_handlers
    from jobctrl.infrastructure.rpc.server import JsonRpcServer
    from jobctrl.state import ensure_job_stage_rows, record_job_event, reset_job_stage, set_stage_state
    from tests.test_exact_v7_apply_acquire_job_identity import _insert_ready_job, LOCAL_JOB_ID

    db_path = tmp_path / 'owned.db'
    monkeypatch.setattr(config, 'APP_DIR', tmp_path)
    monkeypatch.setattr(config, 'DB_PATH', db_path)
    monkeypatch.setattr(database, 'DB_PATH', db_path)
    monkeypatch.setattr(config, 'LOG_DIR', tmp_path / 'logs')
    monkeypatch.setattr(config, 'APPLY_WORKER_DIR', tmp_path / 'workers')
    monkeypatch.setattr(config, 'CHROME_WORKER_DIR', tmp_path / 'chrome')
    monkeypatch.setattr(config, 'ensure_dirs', lambda: None)
    monkeypatch.setattr(launcher, '_stop_event', threading.Event())
    monkeypatch.setattr(launcher, '_load_profile_snapshot', lambda: SimpleNamespace())
    monkeypatch.setattr('jobctrl.enrichment.availability.require_fresh_active', lambda *_a, **_k: None)
    monkeypatch.setattr('jobctrl.enrichment.availability.assert_fresh_candidate', lambda *_a, **_k: None)
    monkeypatch.setattr('jobctrl.enrichment.availability.fresh_active', lambda *_a, **_k: True)
    fake_runs = []
    def fake_run(job, *_args, **_kwargs):
        fake_runs.append(job['job_id'])
        return DryRunComplete(navigated_to='', coverage='partial'), 0
    monkeypatch.setattr(launcher, 'run_job', fake_run)
    conn = database.init_db(db_path)
    _insert_ready_job(conn, 'local', LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, 'score', 'succeeded', validate_transition=False)
    conn.commit()
    loop = asyncio.get_running_loop()
    queue = f'synthetic-preclaim-{uuid.uuid4()}'
    async with time_skipping_env() as env:
        async def starter(spec):
            future = asyncio.run_coroutine_threadsafe(env.client.start_workflow(
                spec.workflow.run, args=spec.args, id=spec.workflow_id or f'owned-{uuid.uuid4()}', task_queue=queue), loop)
            return await asyncio.wrap_future(future)
        rpc = JsonRpcServer(workflow_starter=starter)
        register_default_handlers(rpc, canceler=lambda _: None)
        params = {'tenantId': 'local', 'expectedAppDir': str(tmp_path), 'expectedDbPath': str(db_path),
                  'jobId': LOCAL_JOB_ID, 'workers': 1, 'limit': 1, 'dryRun': True}
        old = await asyncio.to_thread(rpc.dispatch, JsonRpcRequest(method='apply', id=1, params=params))
        assert old.error is None, old
        old_handle = env.client.get_workflow_handle(old.result['workflowId'], run_id=old.result['firstExecutionRunId'])
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()[0] == 'pending'
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplyClaimAcquired'").fetchone()[0] == 0
        set_stage_state(conn, LOCAL_JOB_ID, 'apply', 'skipped', retryable=False, validate_transition=False)
        record_job_event(conn, LOCAL_JOB_ID, 'apply', 'StageSkipped', payload={'previousState': 'pending', 'manualDisposition': 'skip'})
        conn.commit()
        if release:
            reset_job_stage(conn, LOCAL_JOB_ID, 'apply')
            new = await asyncio.to_thread(rpc.dispatch, JsonRpcRequest(method='apply', id=2, params=params))
            assert new.error is None, new
            assert new.result['workflowId'] != old.result['workflowId']
            new_handle = env.client.get_workflow_handle(new.result['workflowId'], run_id=new.result['firstExecutionRunId'])
        async with Worker(env.client, task_queue=queue, workflows=[ApplyWorkflow], activities=_activities(),
                          workflow_runner=UnsandboxedWorkflowRunner()):
            await old_handle.result()
            if release:
                await new_handle.result()
        starts = [json.loads(row[0]) for row in conn.execute("SELECT payload_json FROM job_events WHERE event_type='ApplyRunStarted'")]
        assert len(starts) == len(fake_runs) == int(release)
        if release:
            assert starts[0]['workflow_id'] == new.result['workflowId']
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplySubmitIntended'").fetchone()[0] == 0
    database.close_connection(db_path)


@pytest.mark.asyncio
@pytest.mark.parametrize('overlap', ['unchanged', 'before_intent', 'after_intent', 'lost_ack', 'dry_run'])
async def test_registered_rpc_to_real_submission_settlement_and_restart(tmp_path, monkeypatch, overlap):
    """Keep every Apply layer real; replace only browser, DNS, profile and sender transports."""
    import asyncio
    import hashlib
    import json
    import socket
    import sqlite3
    import threading
    from jobctrl import config, database
    from jobctrl.apply import launcher
    from jobctrl.domain.identifiers import JobId
    from jobctrl.domain.rpc.messages import JsonRpcRequest
    from jobctrl.infrastructure import apply as adapters
    from jobctrl.infrastructure.rpc.handlers import register_default_handlers
    from jobctrl.infrastructure.rpc.server import JsonRpcServer
    from jobctrl.state import ensure_job_stage_rows, record_job_event, reset_job_stage, set_stage_state
    from tests.test_apply_saga import _FakeAgent, _FakeBrowser, _FakeEmailSender
    from tests.test_apply_use_cases import _FakeSnapshot
    from tests.test_exact_v7_apply_acquire_job_identity import (
        _insert_ready_job, _insert_profile, _insert_approval_with_dry_run, LOCAL_JOB_ID, OTHER_JOB_ID,
    )

    path = tmp_path / 'owned.db'
    for module in [config, database]:
        monkeypatch.setattr(module, 'DB_PATH', path)
    for name, value in [('APP_DIR', tmp_path), ('LOG_DIR', tmp_path / 'logs'),
                        ('APPLY_WORKER_DIR', tmp_path / 'apply-workers'), ('CHROME_WORKER_DIR', tmp_path / 'chrome-workers')]:
        monkeypatch.setattr(config, name, value)
    monkeypatch.setattr(launcher, '_stop_event', threading.Event())
    snapshot = _FakeSnapshot()
    snapshot.version = 1
    monkeypatch.setattr(launcher, '_load_profile_snapshot', lambda: snapshot)
    original_resolver = socket.getaddrinfo
    def resolver(host, port, *args, **kwargs):
        if host == 'example.test':
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.215.14', port))]
        return original_resolver(host, port, *args, **kwargs)
    monkeypatch.setattr(socket, 'getaddrinfo', resolver)
    conn = database.init_db(path)
    _insert_ready_job(conn, 'local', LOCAL_JOB_ID)
    _insert_ready_job(conn, 'local', OTHER_JOB_ID, url='https://example.test/jobs/peer')
    _insert_profile(conn, 'local', 1)
    _insert_approval_with_dry_run(conn, 'local', LOCAL_JOB_ID, profile_version=1)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, OTHER_JOB_ID)
    set_stage_state(conn, OTHER_JOB_ID, 'apply', 'running', attempt_count=1, validate_transition=False)
    record_job_event(conn, JobId(OTHER_JOB_ID), 'apply', 'ApplyClaimAcquired', payload={'run_id': 'peer-run', 'launcher_id': 'peer-launcher'})
    record_job_event(conn, JobId(OTHER_JOB_ID), 'apply', 'ApplyRunStarted', payload={'run_id': 'peer-run'})
    set_stage_state(conn, LOCAL_JOB_ID, 'score', 'succeeded', validate_transition=False)
    conn.execute("UPDATE job_enrichments SET full_description='Apply by email to apply@example.com' WHERE job_id=?", (LOCAL_JOB_ID,))
    artifact_id = f'{LOCAL_JOB_ID}:resume_pdf'
    conn.execute("UPDATE application_review_decisions SET email_recipient='apply@example.com',email_attachment_artifact_id=? WHERE job_id=?", (artifact_id, LOCAL_JOB_ID))
    files = []
    for kind in ['tailored_resume', 'resume_pdf']:
        material = tmp_path / kind
        material.write_bytes(b'%PDF-1.7\nowned synthetic\n%%EOF' if kind == 'resume_pdf' else b'Owned synthetic resume')
        files.append(material)
        conn.execute('UPDATE job_materials_artifacts SET path=? WHERE job_id=? AND artifact_type=?', (str(material), LOCAL_JOB_ID, kind))
    conn.commit()
    def fingerprint():
        return {'rows': hashlib.sha256(json.dumps([tuple(r) for r in conn.execute('SELECT * FROM job_materials_artifacts')]).encode()).hexdigest(),
                'files': [hashlib.sha256(f.read_bytes()).hexdigest() for f in files]}
    before = fingerprint()
    peer_state = tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='apply'", (OTHER_JOB_ID,)).fetchone())
    peer_events = [tuple(row) for row in conn.execute("SELECT * FROM job_events WHERE job_id=? ORDER BY event_id", (OTHER_JOB_ID,))]
    initial_claims = conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplyRunStarted'").fetchone()[0]

    dispositions = []
    def peer_skip():
        with sqlite3.connect(path) as writer:
            writer.row_factory = sqlite3.Row
            writer.execute('BEGIN IMMEDIATE')
            prior = writer.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()
            set_stage_state(writer, LOCAL_JOB_ID, 'apply', 'skipped', retryable=False, validate_transition=False, attempt_count=prior['attempt_count'], expected_version=prior['version'])
            record_job_event(writer, JobId(LOCAL_JOB_ID), 'apply', 'StageSkipped', payload={'manualDisposition': 'skip', 'previousState': prior['state']})
            disposition = dict(writer.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone())
        dispositions.append(disposition)

    class Agent(_FakeAgent):
        def submit_application(self, **kwargs):
            from dataclasses import replace
            from tests.test_claude_code_cli_adapter import _report

            if overlap in {'before_intent', 'dry_run'}:
                peer_skip()  # Independent committed writer after real claim, before final-intent lock.
            result = super().submit_application(**kwargs)
            if overlap == 'dry_run':
                from jobctrl.domain.apply.value_objects import DryRunComplete
                result = replace(result, submission_result=DryRunComplete(navigated_to='', coverage='partial'))
            observation = 'Synthetic browser observation: apply@example.com'
            return replace(result, events=(
                {'event_type': 'ClaudeLaunched', 'occurred_at': '2026-10-29T00:00:00Z', 'payload': {}},
                {'event_type': 'AssistantText', 'occurred_at': '2026-10-29T00:00:01Z', 'message': observation, 'payload': {'text_chars': len(observation)}},
                {'event_type': 'ToolUse', 'occurred_at': '2026-10-29T00:00:02Z', 'message': 'browser_snapshot', 'payload': {'tool': 'browser_snapshot'}},
                {'event_type': 'ApplyTerminalDetermination', 'occurred_at': '2026-10-29T00:00:03Z',
                 'payload': {'result': _report('dry_run_complete' if overlap == 'dry_run' else 'email_only',
                                               recipient_email=None if overlap == 'dry_run' else 'apply@example.com',
                                               quote=observation), 'model': 'synthetic', 'input_fingerprint': 'synthetic-input'}},
            ))
    class Sender(_FakeEmailSender):
        def send_email_application(self, candidate, *, operation):
            if overlap in {'after_intent', 'lost_ack'}:
                peer_skip()  # The final intent transaction has committed and released its writer.
            result = super().send_email_application(candidate, operation=operation)
            database.close_connection(path)  # Reopen worker storage for post-intent settlement.
            if overlap == 'lost_ack':
                raise ConnectionError('synthetic provider accepted; acknowledgement lost')
            return result
    agent, browser, sender = Agent(behaviour='email_only'), _FakeBrowser(), Sender()
    monkeypatch.setattr(adapters, 'ClaudeCodeCliAdapter', lambda: agent)
    monkeypatch.setattr(adapters, 'LocalChromeAdapter', lambda: browser)
    monkeypatch.setattr(adapters, 'GmailEmailApplicationSender', lambda: sender)
    loop = asyncio.get_running_loop()
    queue = f'integrated-skip-{uuid.uuid4()}'
    async with time_skipping_env() as env:
        async def starter(spec):
            return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(env.client.start_workflow(
                spec.workflow.run, args=spec.args, id=spec.workflow_id or f'owned-{uuid.uuid4()}', task_queue=queue), loop))
        async def canceler(_):
            return None
        rpc = JsonRpcServer(workflow_starter=starter)
        register_default_handlers(rpc, canceler=canceler)
        async with Worker(env.client, task_queue=queue, workflows=[ApplyWorkflow], activities=_activities(), workflow_runner=UnsandboxedWorkflowRunner()):
            response = await asyncio.to_thread(rpc.dispatch, JsonRpcRequest(method='apply', id=1173, params={
                'tenantId': 'local', 'expectedAppDir': str(tmp_path), 'expectedDbPath': str(path),
                'jobId': LOCAL_JOB_ID, 'workers': 1, 'limit': 1, 'dryRun': overlap == 'dry_run'}))
            assert response.error is None, response
            handle = env.client.get_workflow_handle(response.result['workflowId'], run_id=response.result['firstExecutionRunId'])
            workflow_result = await handle.result()
            if overlap in {'before_intent', 'dry_run'}:
                assert workflow_result['applied'] == workflow_result['failed'] == 0
            counts = dict(conn.execute("SELECT event_type,COUNT(*) FROM job_events WHERE stage='apply' GROUP BY event_type"))
            for observation_event in ('ClaudeLaunched', 'AssistantText', 'ToolUse', 'ApplyTerminalDetermination'):
                assert counts.get(observation_event) == 1
            expected_sends = 0 if overlap in {'before_intent', 'dry_run'} else 1
            assert agent.calls == browser.launches == browser.cleanups == 1
            assert len(sender.sent) == expected_sends
            assert counts.get('ApplySubmitIntended', 0) == expected_sends
            assert counts['ApplyRunStarted'] - initial_claims == 1
            final = dict(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone())
            assert final['state'] == ('succeeded' if overlap == 'unchanged' else 'skipped')
            assert final['attempt_count'] == 1
            if dispositions:
                assert final == dispositions[-1]  # Late settlement cannot alter this committed Skip.
            assert fingerprint() == before
            assert tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='apply'", (OTHER_JOB_ID,)).fetchone()) == peer_state
            assert [tuple(row) for row in conn.execute("SELECT * FROM job_events WHERE job_id=? ORDER BY event_id", (OTHER_JOB_ID,))] == peer_events
            from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
            ProjectionBuilder(conn_factory=lambda: conn).refresh()
            projected_run = conn.execute(
                "SELECT run_id,status,result,events_json FROM apply_run_projections WHERE job_id=? "
                "ORDER BY started_at DESC LIMIT 1", (LOCAL_JOB_ID,),
            ).fetchone()
            expected_outcome = ('succeeded', 'applied') if overlap in {'unchanged', 'after_intent'} else (
                ('manual', 'needs_verification') if overlap == 'lost_ack' else
                ('dry_run_complete', 'dry_run_complete') if overlap == 'dry_run' else ('manual', 'manual')
            )
            assert (projected_run['status'], projected_run['result']) == expected_outcome
            assert 'Synthetic browser observation' not in projected_run['events_json']
            assert 'apply@example.com' not in projected_run['events_json']
            assert dict(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()) == final
            # Close/reopen canonical storage, then use registered RPC again. It must not
            # enter the agent or sender, including after a provider's lost acknowledgement.
            conn.close()
            conn = sqlite3.connect(path)
            conn.row_factory = sqlite3.Row
            if expected_sends:
                with pytest.raises(ValueError, match='intent'):
                    reset_job_stage(conn, LOCAL_JOB_ID, 'apply')
            response2 = await asyncio.to_thread(rpc.dispatch, JsonRpcRequest(method='apply', id=1174, params={
                'tenantId': 'local', 'expectedAppDir': str(tmp_path), 'expectedDbPath': str(path),
                'jobId': LOCAL_JOB_ID, 'workers': 1, 'limit': 1}))
            assert response2.error is None, response2
            await env.client.get_workflow_handle(response2.result['workflowId'], run_id=response2.result['firstExecutionRunId']).result()
            assert len(sender.sent) == expected_sends and agent.calls == 1
            assert dict(conn.execute("SELECT event_type,COUNT(*) FROM job_events WHERE stage='apply' GROUP BY event_type")) == counts
            assert fingerprint() == before
            print(json.dumps({'overlap': overlap, 'job': LOCAL_JOB_ID, 'workflow': handle.id,
                'temporal_run': (await handle.describe()).run_id, 'restart_workflow': response2.result['workflowId'], 'restart_temporal_run': response2.result['firstExecutionRunId'],
                'run_events': [{'event_id': r['event_id'], 'event_type': r['event_type'], 'payload': json.loads(r['payload_json'])} for r in conn.execute("SELECT event_id,event_type,payload_json FROM job_events WHERE stage='apply' AND event_type IN ('ApplyRunStarted','ApplySubmitIntended') ORDER BY event_id")],
                'events': counts, 'events_after_restart': dict(conn.execute("SELECT event_type,COUNT(*) FROM job_events WHERE stage='apply' GROUP BY event_type")),
                'sender_calls': len(sender.sent), 'committed_local_dispositions': dispositions, 'stage': final, 'original_run_projection': dict(projected_run), 'artifacts_before': before, 'artifacts_after': fingerprint()}))
    conn.close()
    database.close_connection(path)
