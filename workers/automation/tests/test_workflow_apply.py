"""Tests for ``ApplyWorkflow``.

The apply path is its own single-activity workflow because it needs a
different retry policy and parameter shape than the generic pipeline.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from temporalio import activity
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.apply.activities import apply_activity
from jobhunter.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobhunter.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobhunter.llm import SpendBudgetStatus


@activity.defn(name="check_spend_budget")
async def _check_spend_budget(_payload) -> SpendBudgetStatus:
    return SpendBudgetStatus(
        day="2026-07-03",
        input_tokens=0,
        output_tokens=0,
        estimated_usd=0.0,
        daily_budget_usd=25.0,
        exceeded=False,
    )


def _activities():
    return [apply_activity, _check_spend_budget, record_workflow_started, record_workflow_outcome]


@pytest.mark.asyncio
async def test_apply_workflow_returns_ok_when_apply_main_succeeds():
    queue = f"apply-wf-{uuid.uuid4()}"
    workflow_id = f"apply-{uuid.uuid4()}"

    with patch(
        "jobhunter.apply.launcher.main",
        return_value=(3, 0),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
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
                        job_url="https://example.com/job",
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
        "jobhunter.apply.launcher.main",
        side_effect=RuntimeError("apply boom"),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
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
                        job_url="https://example.com/job",
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
        "jobhunter.apply.launcher.main",
        side_effect=[RuntimeError("transient"), (1, 0)],
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
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
                        job_url="https://example.com/job",
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
        "jobhunter.apply.workflow.workflow.info",
        lambda: SimpleNamespace(workflow_id="apply-continuous"),
    )
    monkeypatch.setattr(
        "jobhunter.apply.workflow.workflow.execute_activity",
        fake_execute_activity,
    )

    result = await ApplyWorkflow()._run_apply(
        ApplyWorkflowInput(tenant_id="local", continuous=True, limit=0)
    )

    assert result.ok is True
    assert captured["payload"].limit == 25
    assert captured["payload"].continuous is False
    assert captured["timeout"] == timedelta(hours=1)

    class ContinueAsNewRaised(RuntimeError):
        pass

    async def fake_started(**_kwargs):
        return None

    async def fake_outcome(**_kwargs):
        return None

    async def fake_sleep(delay):
        captured["sleep"] = delay

    def fake_continue_as_new(payload):
        captured["continued_payload"] = payload
        raise ContinueAsNewRaised

    async def fake_run_apply(_payload):
        return result

    workflow = ApplyWorkflow()
    monkeypatch.setattr(workflow, "_run_apply", fake_run_apply)
    monkeypatch.setattr("jobhunter.apply.workflow.emit_workflow_started", fake_started)
    monkeypatch.setattr("jobhunter.apply.workflow.emit_workflow_outcome", fake_outcome)
    monkeypatch.setattr(
        "jobhunter.apply.workflow.workflow.now",
        lambda: datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    monkeypatch.setattr(
        "jobhunter.apply.workflow.workflow.continue_as_new",
        fake_continue_as_new,
    )
    monkeypatch.setattr("jobhunter.apply.workflow.workflow.sleep", fake_sleep)

    with pytest.raises(ContinueAsNewRaised):
        await workflow.run(ApplyWorkflowInput(tenant_id="local", continuous=True))
    assert captured["sleep"] == timedelta(seconds=30)
    assert captured["continued_payload"].continuous is True


@pytest.mark.asyncio
async def test_apply_workflow_does_not_retry_lookup_errors():
    """``LookupError`` is wrapped in a non-retryable ``ApplicationError``."""
    queue = f"apply-wf-lookup-{uuid.uuid4()}"
    workflow_id = f"apply-lookup-{uuid.uuid4()}"

    with patch(
        "jobhunter.apply.launcher.main",
        side_effect=LookupError("no job URL provided"),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
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
    assert "no job URL provided" in (result.error or "")
