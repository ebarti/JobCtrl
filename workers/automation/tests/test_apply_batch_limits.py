"""Finite Apply batches bound claims through the workflow and activity path."""

from __future__ import annotations

import threading
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from temporalio import activity
from temporalio import workflow
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl import browser_capabilities
from jobctrl.apply import launcher
from jobctrl.apply.activities import ApplyActivityInput, ApplyActivityOutput, apply_activity
from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobctrl.domain.apply.value_objects import DryRunComplete, Failed
from jobctrl.infrastructure.scoring import criteria_provider
from jobctrl.infrastructure.temporal import runtime_guard
from jobctrl.infrastructure.temporal.finalize import WorkflowOutcomeInput, WorkflowStartedInput
from jobctrl.llm import SpendBudgetInput, SpendBudgetStatus

from .temporal_env import local_env


class _NoLive:
    def __init__(self, *_args, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def update(self, *_args):
        pass


class _SyntheticQueue:
    def __init__(self, count: int, *, skipped: bool = False):
        self.jobs = [
            {"tenant_id": "local", "job_id": str(uuid.uuid4()), "title": f"Synthetic {i}"}
            for i in range(count)
        ]
        self.lock = threading.Lock()
        self.calls: list[tuple[int, str | None, bool]] = []
        self.claims: list[str] = []
        self.processed: list[str] = []
        self.skipped = skipped

    def acquire(self, *, worker_id, target_job_id, approval_required, **_kwargs):
        with self.lock:
            self.calls.append((worker_id, str(target_job_id) if target_job_id else None, approval_required))
            if target_job_id is not None:
                # A released skipped candidate remains eligible for a second
                # claim unless the targeted worker itself terminates.
                job = next((job for job in self.jobs if job["job_id"] == str(target_job_id)), None)
            else:
                job = self.jobs.pop(0) if self.jobs else None
            if job is not None:
                self.claims.append(job["job_id"])
            # Guard the test process if a zero-allocation worker becomes a
            # continuous poller on the buggy implementation.
            if len(self.calls) > 12:
                launcher._stop_event.set()
            return job

    def run(self, job, **_kwargs):
        with self.lock:
            self.processed.append(job["job_id"])
        if self.skipped:
            return None, 0
        return DryRunComplete(navigated_to="https://example.test/", coverage="partial"), 1


@pytest.fixture
def apply_queue(monkeypatch):
    monkeypatch.setattr(browser_capabilities, "require_system_browser_capability", lambda _name: Path("/synthetic/browser"))
    monkeypatch.setattr(launcher.config, "ensure_dirs", lambda: None)
    monkeypatch.setattr(launcher, "_load_profile_snapshot", lambda: object())
    monkeypatch.setattr(launcher, "recover_ambiguous_running_apply", lambda _console: 0)
    monkeypatch.setattr(launcher, "_record_apply_batch_metric", lambda **_kwargs: None)
    monkeypatch.setattr(launcher, "kill_all_chrome", lambda: None)
    monkeypatch.setattr(launcher, "init_worker", lambda _worker_id: None)
    monkeypatch.setattr(launcher, "update_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher, "add_event", lambda *_args: None)
    monkeypatch.setattr(launcher, "render_full", lambda: "")
    monkeypatch.setattr(launcher, "get_totals", lambda: {"cost": 0})
    monkeypatch.setattr(launcher, "Live", _NoLive)
    monkeypatch.setattr(launcher, "mark_result", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher, "release_lock", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runtime_guard, "assert_activity_runtime", lambda **_kwargs: None)
    monkeypatch.setattr(criteria_provider, "read_apply_approval_required", lambda *, default: default)
    launcher._stop_event.clear()

    def install(*, count=6, skipped=False):
        queue = _SyntheticQueue(count, skipped=skipped)
        monkeypatch.setattr(launcher, "acquire_job", queue.acquire)
        monkeypatch.setattr(launcher, "run_job", queue.run)
        return queue

    yield install
    launcher._stop_event.clear()


@pytest.mark.parametrize("limit", [1, 2])
@pytest.mark.parametrize("skipped", [False, True])
def test_finite_batch_claims_no_more_than_limit(apply_queue, limit, skipped):
    queue = apply_queue(skipped=skipped)
    result = launcher.main(limit=limit, workers=3, dry_run=True, install_signal_handlers=False)
    assert result == (0, 0)
    assert len(queue.claims) == limit
    assert queue.claims == queue.processed
    assert all(worker < limit and approval for worker, _target, approval in queue.calls)
    assert len(queue.jobs) == 6 - limit


def test_targeted_skipped_job_does_not_repeat_or_claim_another(apply_queue):
    queue = apply_queue(skipped=True)
    target = queue.jobs[0]["job_id"]
    launcher.main(limit=2, workers=3, target_job_id=target, dry_run=True, install_signal_handlers=False)
    assert queue.claims == [target]
    assert queue.processed == [target]
    assert queue.calls == [(0, target, True)]


def test_interrupted_claim_counts_toward_finite_limit(apply_queue, monkeypatch):
    queue = apply_queue()

    def interrupted(job, **_kwargs):
        queue.processed.append(job["job_id"])
        raise KeyboardInterrupt

    monkeypatch.setattr(launcher, "run_job", interrupted)
    launcher.main(limit=1, workers=3, dry_run=True, install_signal_handlers=False)
    assert len(queue.claims) == 1
    assert len(queue.jobs) == 5


def test_failed_claim_is_counted_and_reported(apply_queue, monkeypatch):
    queue = apply_queue()
    recorded = []
    monkeypatch.setattr(launcher, "run_job", lambda *_args, **_kwargs: (Failed(error="synthetic", retryable=True), 4))
    monkeypatch.setattr(launcher, "mark_result", lambda job_id, status, reason, **kwargs: recorded.append(
        (job_id, status, reason, kwargs["permanent"])
    ))
    assert launcher.main(limit=1, workers=3, dry_run=True, install_signal_handlers=False) == (0, 1)
    assert recorded == [(queue.claims[0], "failed", "synthetic", False)]
    assert len(queue.jobs) == 5


def test_finite_batch_reports_only_admitted_workers(apply_queue, monkeypatch):
    apply_queue()
    metrics = []
    monkeypatch.setattr(launcher, "_record_apply_batch_metric", lambda **kwargs: metrics.append(kwargs))
    launcher.main(limit=1, workers=3, dry_run=True, install_signal_handlers=False)
    assert [(metric["outcome"], metric["workers"]) for metric in metrics] == [("started", 1), ("dry_run", 1)]


def test_explicit_continuous_workers_poll_until_stopped(apply_queue, monkeypatch):
    queue = apply_queue(count=0)
    # A controlled wait ends each standing worker without waiting on a clock.
    monkeypatch.setattr(launcher._stop_event, "wait", lambda timeout: True)
    launcher.main(limit=3, continuous=True, workers=2, dry_run=True, install_signal_handlers=False)
    assert {worker for worker, _target, _approval in queue.calls} == {0, 1}
    assert queue.claims == []


@activity.defn(name="check_spend_budget")
async def _check_budget(_payload: SpendBudgetInput) -> SpendBudgetStatus:
    return SpendBudgetStatus(day="2026-10-26", input_tokens=0, output_tokens=0, estimated_usd=0.0,
                             daily_budget_usd=25.0, lane="apply", lane_input_tokens=0,
                             lane_output_tokens=0, lane_token_limit=0, lane_exceeded=False,
                             global_exceeded=False, exceeded=False)


@activity.defn(name="record_workflow_started")
async def _record_started(_payload: WorkflowStartedInput) -> None:
    return None


@activity.defn(name="record_workflow_outcome")
async def _record_outcome(_payload: WorkflowOutcomeInput) -> None:
    return None


@workflow.defn(name="ApplyContinuousActivityHarness")
class _ContinuousActivityHarness:
    @workflow.run
    async def run(self, payload: ApplyActivityInput) -> ApplyActivityOutput:
        return await workflow.execute_activity(apply_activity, payload, start_to_close_timeout=timedelta(seconds=30))


@pytest.mark.asyncio
async def test_continuous_activity_explicitly_keeps_all_workers_polling(apply_queue, monkeypatch):
    queue = apply_queue(count=0)
    monkeypatch.setattr(launcher._stop_event, "wait", lambda timeout: True)
    task_queue = f"apply-continuous-{uuid.uuid4()}"
    async with local_env() as env:
        async with Worker(env.client, task_queue=task_queue, workflows=[_ContinuousActivityHarness],
                          activities=[apply_activity], workflow_runner=UnsandboxedWorkflowRunner()):
            result = await env.client.execute_workflow(
                _ContinuousActivityHarness.run, ApplyActivityInput(tenant_id="local", continuous=True, workers=2),
                id=f"apply-continuous-{uuid.uuid4()}", task_queue=task_queue, execution_timeout=timedelta(seconds=30),
            )
    assert result.status == "ok"
    assert {worker for worker, _target, _approval in queue.calls} == {0, 1}


@pytest.mark.asyncio
@pytest.mark.parametrize(("limit", "targeted", "skipped"), [(1, False, False), (2, False, False), (2, True, True)])
async def test_workflow_activity_and_launcher_share_finite_limit(apply_queue, limit, targeted, skipped):
    queue = apply_queue(skipped=skipped)
    target = queue.jobs[0]["job_id"] if targeted else None
    task_queue = f"apply-limit-{uuid.uuid4()}"
    async with local_env() as env:
        async with Worker(
            env.client, task_queue=task_queue, workflows=[ApplyWorkflow],
            activities=[apply_activity, _check_budget, _record_started, _record_outcome],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            result = await env.client.execute_workflow(
                ApplyWorkflow.run,
                ApplyWorkflowInput(tenant_id="local", limit=limit, workers=3, dry_run=True, job_id=target),
                id=f"apply-limit-{uuid.uuid4()}", task_queue=task_queue,
                execution_timeout=timedelta(seconds=30),
            )
    assert result.ok
    assert len(queue.claims) == (1 if targeted else limit)
    assert queue.claims == queue.processed
    assert all(approval for _worker, _target, approval in queue.calls)
    if targeted:
        assert queue.claims == [target]
        assert queue.calls == [(0, target, True)]
    else:
        assert len(queue.jobs) == 6 - limit
