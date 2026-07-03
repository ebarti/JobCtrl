"""Tests for ``DiscoverWorkflow`` decomposition and schedules."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import pytest
from temporalio import activity, workflow
from temporalio.client import ScheduleOverlapPolicy, WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.cli import _reconcile_discovery_schedule
from jobhunter.config import DEFAULT_DISCOVERY_SEARCH_CONFIG, load_discovery_schedule_settings
from jobhunter.domain.discovery.scheduler import DiscoveryRunProgress
from jobhunter.discovery.activities import (
    DiscoveryEnrichmentActivityOutput,
    DiscoveryEnrichmentActivityInput,
    DiscoverySourceActivityInput,
    DiscoverySourceActivityOutput,
    PlanDiscoverySourcesInput,
    PlanDiscoverySourcesOutput,
)
from jobhunter.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
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


def _reset_state() -> None:
    _EVENTS.clear()
    _TARGETS.clear()
    global _FAIL_FAMILY
    _FAIL_FAMILY = None


def _discovery_activities():
    return [
        _record_workflow_started,
        _record_workflow_outcome,
        _plan_discovery_sources,
        _discovery_source_family,
        _discovery_enrichment,
        _derive_preparation_targets,
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


@activity.defn(name="derive_preparation_targets")
async def _derive_preparation_targets(payload) -> list[_Target]:
    _EVENTS.append(("derive", payload["min_score"], payload["limit"]))
    return list(_TARGETS)


@workflow.defn(name="JobPreparationWorkflow")
class _StubPreparationWorkflow:
    @workflow.run
    async def run(self, payload: dict[str, Any]) -> dict[str, str]:
        return {"job_url": str(payload.get("job_url") or "")}


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
            workflows=[DiscoverWorkflow, _StubPreparationWorkflow],
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
        "derive",
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
            workflows=[DiscoverWorkflow, _StubPreparationWorkflow],
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
    def __init__(self) -> None:
        self.deleted = 0
        self.updated = 0
        self.update_result = None

    async def delete(self) -> None:
        self.deleted += 1

    async def update(self, updater) -> None:
        self.updated += 1
        self.update_result = updater(None)


class _FakeScheduleClient:
    def __init__(self, *, create_raises: bool = False) -> None:
        self.handle = _FakeScheduleHandle()
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
