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

import pytest
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ActivityError, ApplicationError
from .temporal_env import time_skipping_env
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl.apply.activities import apply_activity
from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
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
    return [apply_activity, _check_spend_budget, record_workflow_started, record_workflow_outcome]


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
        return SimpleNamespace(status="ok", error=None, applied=0, failed=0)

    monkeypatch.setattr(
        "jobctrl.apply.workflow.workflow.info",
        lambda: SimpleNamespace(workflow_id="apply-continuous"),
    )
    monkeypatch.setattr(
        "jobctrl.apply.workflow.workflow.execute_activity",
        fake_execute_activity,
    )

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
    monkeypatch.setattr(launcher, "kill_all_chrome", lambda: None)
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
                          activities=[apply_activity, check_spend_budget, record_workflow_started, record_workflow_outcome],
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
