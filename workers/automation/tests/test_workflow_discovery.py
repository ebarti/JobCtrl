"""Tests for ``DiscoverWorkflow`` decomposition and schedules."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import pytest
from temporalio import activity
from temporalio.client import ScheduleOverlapPolicy, WorkflowFailureError
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.cli import _reconcile_discovery_schedule
from jobhunter.config import DEFAULT_DISCOVERY_SEARCH_CONFIG, load_discovery_schedule_settings
from jobhunter.domain.discovery.scheduler import DiscoveryRunProgress
from jobhunter.discovery.activities import (
    DiscoveryEnrichmentActivityOutput,
    DiscoveryEnrichmentActivityInput,
    DiscoveryPreparationFanoutInput,
    DiscoveryPreparationFanoutOutput,
    DiscoverySourceActivityInput,
    DiscoverySourceActivityOutput,
    PlanDiscoverySourcesInput,
    PlanDiscoverySourcesOutput,
    discovery_preparation_fanout_activity,
)
from jobhunter.discovery.workflow import (
    DiscoverWorkflow,
    DiscoverWorkflowInput,
    _activity_error_was_cancelled,
)
from jobhunter.infrastructure.temporal.finalize import WorkflowOutcomeInput, WorkflowStartedInput
from jobhunter.pipeline import runner


@dataclass(frozen=True)
class _Target:
    job_url: str
    idempotency_key: str
    target_version: str
    steps: list[str]


_EVENTS: list[tuple[str, Any]] = []
_FAIL_FAMILY: str | None = None
_TARGETS: list[_Target] = []
_RESUME_GATE: dict[str, asyncio.Event] = {}


def _reset_state() -> None:
    _EVENTS.clear()
    _TARGETS.clear()
    _RESUME_GATE.clear()
    global _FAIL_FAMILY
    _FAIL_FAMILY = None


def test_discover_workflow_detects_activity_cancellation_cause() -> None:
    exc = ActivityError(
        "activity canceled",
        scheduled_event_id=1,
        started_event_id=2,
        identity="pytest",
        activity_type="discovery_source_family",
        activity_id="activity-1",
        retry_state=None,
    )
    exc.__cause__ = CancelledError("activity canceled")

    assert _activity_error_was_cancelled(exc) is True


@pytest.mark.asyncio
async def test_discover_workflow_records_canceled_outcome(monkeypatch: pytest.MonkeyPatch) -> None:
    _reset_state()
    workflow_instance = DiscoverWorkflow()

    async def fake_started(**_kwargs) -> None:
        _EVENTS.append(("workflow_started", "DiscoverWorkflow"))

    async def fake_outcome(**kwargs) -> None:
        _EVENTS.append(("workflow_outcome", kwargs["status"]))

    async def fake_execute(_payload) -> None:
        raise CancelledError("canceled by test")

    monkeypatch.setattr(workflow_instance, "_execute", fake_execute)
    monkeypatch.setattr("jobhunter.discovery.workflow.emit_workflow_started", fake_started)
    monkeypatch.setattr("jobhunter.discovery.workflow.emit_workflow_outcome", fake_outcome)
    monkeypatch.setattr("jobhunter.discovery.workflow.workflow.now", lambda: "2026-01-01T00:00:00Z")

    with pytest.raises(CancelledError):
        await workflow_instance.run(DiscoverWorkflowInput(tenant_id="local"))

    assert _EVENTS == [
        ("workflow_started", "DiscoverWorkflow"),
        ("workflow_outcome", "canceled"),
    ]


def _discovery_activities():
    return [
        _record_workflow_started,
        _record_workflow_outcome,
        _plan_discovery_sources,
        _discovery_source_family,
        _discovery_enrichment,
        _discovery_preparation_fanout,
    ]


@activity.defn(name="record_workflow_started")
async def _record_workflow_started(payload: WorkflowStartedInput) -> None:
    _EVENTS.append(("workflow_started", payload.workflow_type))


@activity.defn(name="record_workflow_outcome")
async def _record_workflow_outcome(payload: WorkflowOutcomeInput) -> None:
    _EVENTS.append(("workflow_outcome", payload.status))


@activity.defn(name="plan_discovery_sources")
async def _plan_discovery_sources(payload: PlanDiscoverySourcesInput) -> PlanDiscoverySourcesOutput:
    _EVENTS.append(("plan", payload.source_ids))
    return PlanDiscoverySourcesOutput(
        families=["jobspy", "workday", "smartextract"],
        progress_total=5,
        start_count=7,
    )


@activity.defn(name="discovery_source_family")
async def _discovery_source_family(payload: DiscoverySourceActivityInput) -> DiscoverySourceActivityOutput:
    _EVENTS.append(
        (
            "source",
            payload.family,
            payload.start_count,
            payload.progress_completed,
            payload.progress_total,
        )
    )
    if payload.family == _FAIL_FAMILY:
        raise ApplicationError(
            f"{payload.family} unavailable",
            type="source_unavailable",
            non_retryable=True,
        )
    return DiscoverySourceActivityOutput(
        family=payload.family,
        status="ok",
        result={"new": 1},
        source_ids=[f"{payload.family}:source"],
    )


@activity.defn(name="discovery_enrichment")
async def _discovery_enrichment(payload: DiscoveryEnrichmentActivityInput) -> DiscoveryEnrichmentActivityOutput:
    _EVENTS.append(("enrichment", payload.limit))
    return DiscoveryEnrichmentActivityOutput(status="ok", passes=1, pending=0)


@activity.defn(name="discovery_preparation_fanout")
async def _discovery_preparation_fanout(
    payload: DiscoveryPreparationFanoutInput,
) -> DiscoveryPreparationFanoutOutput:
    _EVENTS.append(("fanout", payload.min_score, payload.limit))
    return DiscoveryPreparationFanoutOutput(started=len(_TARGETS), queued=0, targets=len(_TARGETS))


@pytest.mark.asyncio
async def test_discovery_preparation_fanout_activity_uses_root_workflow_fanout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_run_blocking(fn, **kwargs):
        captured["activity_name"] = kwargs["activity_name"]
        return fn()

    def fake_start_fanout(**kwargs):
        captured["fanout_kwargs"] = kwargs
        return {
            "started": {"job_preparation": 2},
            "queued": {"job_preparation": 1},
            "targets": 3,
        }

    monkeypatch.setattr(
        "jobhunter.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        "jobhunter.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    monkeypatch.setattr(
        "jobhunter.pipeline.preparation.start_discovery_preparation_workflows",
        fake_start_fanout,
    )

    result = await discovery_preparation_fanout_activity(
        DiscoveryPreparationFanoutInput(
            tenant_id="local",
            min_score=8,
            limit=5,
            workers=3,
            validation_mode="strict",
            tailor_models=("draft",),
            tailor_judge_model="judge",
            tailor_judge_min_score=8.5,
            llm_model="local:model",
        )
    )

    assert captured["activity_name"] == "discover:preparation"
    assert captured["fanout_kwargs"] == {
        "min_score": 8,
        "limit": 5,
        "workers": 3,
        "validation_mode": "strict",
        "llm_model": "local:model",
        "tailor_models": ("draft",),
        "tailor_judge_model": "judge",
        "tailor_judge_min_score": 8.5,
        "tenant_id": "local",
    }
    assert result == DiscoveryPreparationFanoutOutput(started=2, queued=1, targets=3)


@pytest.mark.asyncio
async def test_discover_workflow_runs_sources_then_enrichment_and_fanout() -> None:
    _reset_state()
    _TARGETS.append(
        _Target(
            job_url="https://example.com/job/1",
            idempotency_key="target-1",
            target_version="3",
            steps=["score", "tailor"],
        )
    )
    queue = f"discover-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_discovery_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            result = await env.client.execute_workflow(
                DiscoverWorkflow.run,
                DiscoverWorkflowInput(
                    tenant_id="local",
                    source_ids=("workday:acme",),
                    limit=10,
                    min_score=8,
                ),
                id=f"discover-success-{uuid.uuid4()}",
                task_queue=queue,
            )

    assert result.families_completed == ["jobspy", "workday", "smartextract"]
    assert result.families_failed == []
    assert result.preparation_started == 1
    assert [event[0] for event in _EVENTS] == [
        "workflow_started",
        "plan",
        "source",
        "source",
        "source",
        "enrichment",
        "fanout",
        "workflow_outcome",
    ]
    assert _EVENTS[-1] == ("workflow_outcome", "succeeded")


@pytest.mark.asyncio
async def test_discover_workflow_collects_source_failures_before_failing() -> None:
    _reset_state()
    global _FAIL_FAMILY
    _FAIL_FAMILY = "workday"
    queue = f"discover-fail-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_discovery_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            with pytest.raises(WorkflowFailureError):
                await env.client.execute_workflow(
                    DiscoverWorkflow.run,
                    DiscoverWorkflowInput(tenant_id="local"),
                    id=f"discover-source-fail-{uuid.uuid4()}",
                    task_queue=queue,
                )

    source_events = [event for event in _EVENTS if event[0] == "source"]
    assert [event[1] for event in source_events] == ["jobspy", "workday", "smartextract"]
    assert ("workflow_outcome", "failed") in _EVENTS
    assert not any(event[0] == "enrichment" for event in _EVENTS)
    assert not any(event[0] == "derive" for event in _EVENTS)


@activity.defn(name="discovery_source_family")
async def _resumable_source_family(payload: DiscoverySourceActivityInput) -> DiscoverySourceActivityOutput:
    attempt = activity.info().attempt
    _EVENTS.append(("source_attempt", payload.family, attempt))
    if payload.family == "jobspy" and attempt == 1:
        # First attempt heartbeats like a real source crawl but never
        # completes; when the worker hosting it is killed the heartbeats stop
        # and the server detects the death via the heartbeat timeout.
        _RESUME_GATE["first_attempt_started"].set()
        while True:
            activity.heartbeat("mid-flight")
            await asyncio.sleep(0.2)
    return DiscoverySourceActivityOutput(
        family=payload.family,
        status="ok",
        result={"new": 1},
        source_ids=[f"{payload.family}:source"],
    )


def _resumption_activities():
    return [
        _record_workflow_started,
        _record_workflow_outcome,
        _plan_discovery_sources,
        _resumable_source_family,
        _discovery_enrichment,
        _discovery_preparation_fanout,
    ]


@pytest.mark.asyncio
async def test_discover_workflow_kill_worker_resumption(monkeypatch: pytest.MonkeyPatch) -> None:
    """THE resumption proof: kill the worker mid source activity, restart a
    fresh worker on the same task queue, and the discovery workflow completes
    (sources, enrichment, prep fan-out, terminal outcome) with zero manual
    action and no reaper."""
    _reset_state()
    # Production heartbeat timeout is 2 minutes; shrink it so the server
    # detects the killed worker in seconds instead of stalling the suite. The
    # recovery mechanism under test (heartbeat-timeout -> retry -> redelivery
    # to the surviving worker) is unchanged.
    monkeypatch.setattr(
        "jobhunter.discovery.workflow._DEFAULT_HEARTBEAT_TIMEOUT",
        timedelta(seconds=2),
    )
    _RESUME_GATE["first_attempt_started"] = asyncio.Event()
    _TARGETS.append(
        _Target(
            job_url="https://example.com/job/1",
            idempotency_key="target-1",
            target_version="3",
            steps=["score", "tailor"],
        )
    )
    queue = f"discover-resume-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        # max_cached_workflows=0 disables sticky task queues: the time-skipping
        # test server never fires the sticky schedule-to-start timeout for a
        # dead worker's queue, so without this the post-crash workflow task
        # would wait forever on the killed worker's sticky queue. A real server
        # reposts to the shared queue after the sticky timeout; this routes
        # there directly.
        first_worker = Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_resumption_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
            graceful_shutdown_timeout=timedelta(0),
            max_cached_workflows=0,
        )
        first_worker_run = asyncio.create_task(first_worker.run())

        handle = await env.client.start_workflow(
            DiscoverWorkflow.run,
            DiscoverWorkflowInput(tenant_id="local", min_score=8),
            id=f"discover-resume-{uuid.uuid4()}",
            task_queue=queue,
        )

        # Wait until the first source-family attempt is genuinely mid-flight,
        # then kill the worker without letting it complete the activity.
        await asyncio.wait_for(_RESUME_GATE["first_attempt_started"].wait(), timeout=30)
        first_worker_run.cancel()
        await asyncio.gather(first_worker_run, return_exceptions=True)

        # Fresh worker on the same task queue: Temporal redelivers the
        # incomplete source activity and the workflow runs to completion.
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_resumption_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
            max_cached_workflows=0,
        ):
            result = await asyncio.wait_for(handle.result(), timeout=120)

    assert result.families_completed == ["jobspy", "workday", "smartextract"]
    assert result.families_failed == []
    assert result.preparation_started == 1

    attempts = [event for event in _EVENTS if event[0] == "source_attempt"]
    assert ("source_attempt", "jobspy", 1) in attempts, "first attempt never started"
    assert any(
        event[1] == "jobspy" and event[2] > 1 for event in attempts
    ), "jobspy was not redelivered to the restarted worker"
    assert any(event[0] == "enrichment" for event in _EVENTS)
    assert any(event[0] == "fanout" for event in _EVENTS), "prep fan-out did not run after restart"
    assert _EVENTS[-1] == ("workflow_outcome", "succeeded")


def test_discovery_source_progress_emits_temporal_heartbeat(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[dict[str, Any]] = []
    progress = DiscoveryRunProgress(
        completed=2,
        total=5,
        unit="employers",
        current_query="software engineer",
        current_location="remote",
        new_jobs=3,
        existing_jobs=4,
        filtered_jobs=1,
        error_count=0,
        raw_total=8,
    )
    monkeypatch.setattr(runner.temporal_activity, "heartbeat", lambda payload: captured.append(payload))

    runner._record_discovery_source_progress(
        source="workday",
        label="Workday scraper",
        run_id=f"run-{uuid.uuid4()}",
        source_ids=("workday:acme-wd1-myworkdayjobs-com",),
        progress_completed=1,
        progress_total=4,
        source_progress=progress,
        message="Workday progress",
    )

    assert captured == [progress.to_dict()]


def test_discovery_schedule_defaults_disabled() -> None:
    assert DEFAULT_DISCOVERY_SEARCH_CONFIG["scheduling_enabled"] is False
    assert load_discovery_schedule_settings() == (False, "0 7 * * *")


class _FakeScheduleHandle:
    def __init__(self, *, update_raises: bool = False) -> None:
        self.deleted = 0
        self.updated = 0
        self.update_result = None
        self.update_raises = update_raises

    async def delete(self) -> None:
        self.deleted += 1

    async def update(self, updater) -> None:
        if self.update_raises:
            raise RuntimeError("bad persisted schedule")
        self.updated += 1
        self.update_result = updater(None)


class _FakeScheduleClient:
    def __init__(self, *, create_raises: bool = False, update_raises: bool = False) -> None:
        self.handle = _FakeScheduleHandle(update_raises=update_raises)
        self.create_raises = create_raises
        self.created: list[tuple[str, Any]] = []

    def get_schedule_handle(self, _schedule_id: str) -> _FakeScheduleHandle:
        return self.handle

    async def create_schedule(self, schedule_id: str, schedule) -> None:
        if self.create_raises:
            raise RuntimeError("already exists")
        self.created.append((schedule_id, schedule))


@pytest.mark.asyncio
async def test_discovery_schedule_reconcile_deletes_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "jobhunter.config.load_discovery_schedule_settings",
        lambda: (False, "0 7 * * *"),
    )
    client = _FakeScheduleClient()

    await _reconcile_discovery_schedule(client, "jobhunter-test")

    assert client.created == []
    assert client.handle.deleted == 1


@pytest.mark.asyncio
async def test_discovery_schedule_reconcile_creates_skip_overlap_schedule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobhunter.config.load_discovery_schedule_settings",
        lambda: (True, "15 9 * * *"),
    )
    client = _FakeScheduleClient()

    await _reconcile_discovery_schedule(client, "jobhunter-test")

    [(schedule_id, schedule)] = client.created
    assert schedule_id == "jobhunter-discovery-local"
    assert schedule.spec.cron_expressions == ["15 9 * * *"]
    assert schedule.policy.overlap is ScheduleOverlapPolicy.SKIP
    assert schedule.action.id == "discover-local"
    assert schedule.action.task_queue == "jobhunter-test"


@pytest.mark.asyncio
async def test_discovery_schedule_reconcile_updates_existing_schedule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobhunter.config.load_discovery_schedule_settings",
        lambda: (True, "30 6 * * *"),
    )
    client = _FakeScheduleClient(create_raises=True)

    await _reconcile_discovery_schedule(client, "jobhunter-test")

    assert client.handle.updated == 1
    assert client.handle.update_result.schedule.spec.cron_expressions == ["30 6 * * *"]
    assert client.handle.update_result.schedule.policy.overlap is ScheduleOverlapPolicy.SKIP


@pytest.mark.asyncio
async def test_discovery_schedule_reconcile_failure_does_not_block_worker_boot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobhunter.config.load_discovery_schedule_settings",
        lambda: (True, "not a valid cron"),
    )
    client = _FakeScheduleClient(create_raises=True, update_raises=True)

    await _reconcile_discovery_schedule(client, "jobhunter-test")

    assert client.handle.updated == 0
