"""Happy-path test for ``apply_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
import sqlite3
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl import config
from jobctrl.apply.activities import (
    ApplyActivityInput,
    ApplyActivityOutput,
    apply_activity,
)


JOB_ID = "90000000-0000-4000-8000-000000000001"


def test_apply_activity_input_rejects_url_shaped_job_id() -> None:
    with pytest.raises(ValueError, match="canonical UUID"):
        ApplyActivityInput(tenant_id="local", job_id="https://example.com/job")


@pytest.fixture(autouse=True)
def permit_browser_for_existing_apply_activity_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """Activity behavior tests run after the separate capability check."""

    from jobctrl import browser_capabilities

    monkeypatch.setattr(
        browser_capabilities,
        "require_system_browser_capability",
        lambda _capability: Path("/test/Chromium"),
    )


@workflow.defn(name="ApplyHarness")
class _ApplyHarness:
    @workflow.run
    async def run(self, payload: ApplyActivityInput) -> ApplyActivityOutput:
        return await workflow.execute_activity(
            apply_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=10),
            heartbeat_timeout=timedelta(seconds=60),
        )


@pytest.mark.asyncio
async def test_apply_activity_invokes_apply_main_and_returns_ok():
    queue = f"apply-{uuid.uuid4()}"

    with patch(
        "jobctrl.apply.launcher.main",
        return_value=(2, 0),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_ApplyHarness],
                activities=[apply_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output: ApplyActivityOutput = await env.client.execute_workflow(
                    _ApplyHarness.run,
                    ApplyActivityInput(
                        tenant_id="local",
                        job_id=JOB_ID,
                        limit=2,
                        min_score=8,
                        model="haiku",
                        headless=True,
                    ),
                    id=f"apply-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    apply_main_mock.assert_called_once()
    kwargs = apply_main_mock.call_args.kwargs
    assert kwargs["limit"] == 2
    assert kwargs["target_job_id"] == JOB_ID
    assert kwargs["tenant_id"] == "local"
    assert kwargs["min_score"] == 8
    assert kwargs["headless"] is True
    assert kwargs["model"] == "haiku"
    assert kwargs["install_signal_handlers"] is False
    assert output.status == "ok"
    assert output.applied == 2
    assert output.failed == 0
    assert output.error is None


@pytest.mark.asyncio
async def test_apply_activity_continuous_calls_apply_main_with_limit_zero():
    """``continuous=True`` must drive ``apply_main`` with ``limit=0`` (run-forever sentinel)."""
    queue = f"apply-{uuid.uuid4()}"

    with patch(
        "jobctrl.apply.launcher.main",
        return_value=(0, 0),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_ApplyHarness],
                activities=[apply_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                await env.client.execute_workflow(
                    _ApplyHarness.run,
                    ApplyActivityInput(
                        tenant_id="local",
                        limit=5,  # ignored when continuous=True
                        continuous=True,
                    ),
                    id=f"apply-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    apply_main_mock.assert_called_once()
    assert apply_main_mock.call_args.kwargs["limit"] == 0


@pytest.mark.asyncio
async def test_auto_apply_activity_live_reads_min_score_and_workers(monkeypatch, tmp_path):
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        '{"apply_concurrency": 4}',
        encoding="utf-8",
    )
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings_path))
    db_path = tmp_path / "jobctrl.db"
    sqlite3.connect(db_path).close()
    monkeypatch.setattr(config, "DB_PATH", db_path)
    discovery = config._default_discovery_search_config()
    discovery["automation"] = {
        "min_fit_score": 9,
        "apply_approval_required": True,
    }
    config._save_discovery_search_config_to_db(discovery)
    queue = f"apply-{uuid.uuid4()}"

    with patch(
        "jobctrl.apply.launcher.main",
        return_value=(0, 0),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_ApplyHarness],
                activities=[apply_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                await env.client.execute_workflow(
                    _ApplyHarness.run,
                    ApplyActivityInput(
                        tenant_id="local",
                        min_score=4,
                        workers=1,
                        auto_apply_loop=True,
                    ),
                    id=f"apply-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    apply_main_mock.assert_called_once()
    assert apply_main_mock.call_args.kwargs["min_score"] == 9
    assert apply_main_mock.call_args.kwargs["workers"] == 4


@pytest.mark.asyncio
async def test_apply_activity_continuous_dry_run_keeps_submit_guard_mode():
    queue = f"apply-{uuid.uuid4()}"

    with patch(
        "jobctrl.apply.launcher.main",
        return_value=(0, 0),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_ApplyHarness],
                activities=[apply_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                await env.client.execute_workflow(
                    _ApplyHarness.run,
                    ApplyActivityInput(
                        tenant_id="local",
                        limit=5,
                        continuous=True,
                        dry_run=True,
                    ),
                    id=f"apply-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    apply_main_mock.assert_called_once()
    assert apply_main_mock.call_args.kwargs["limit"] == 0
    assert apply_main_mock.call_args.kwargs["dry_run"] is True


@pytest.mark.asyncio
async def test_apply_activity_non_continuous_floors_limit_at_one():
    """``continuous=False`` keeps ``max(1, limit)`` semantics — ``limit=0`` becomes 1."""
    queue = f"apply-{uuid.uuid4()}"

    with patch(
        "jobctrl.apply.launcher.main",
        return_value=(0, 0),
    ) as apply_main_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_ApplyHarness],
                activities=[apply_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                await env.client.execute_workflow(
                    _ApplyHarness.run,
                    ApplyActivityInput(tenant_id="local", limit=0, continuous=False),
                    id=f"apply-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    apply_main_mock.assert_called_once()
    assert apply_main_mock.call_args.kwargs["limit"] == 1
