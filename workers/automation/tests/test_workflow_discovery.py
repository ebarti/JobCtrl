"""Tests for ``DiscoverWorkflow`` decomposition and schedules."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from temporalio import activity
from temporalio.client import ScheduleOverlapPolicy, WorkflowFailureError
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl.cli import _reconcile_discovery_schedule
from jobctrl.config import DEFAULT_DISCOVERY_SEARCH_CONFIG, load_discovery_schedule_settings
from jobctrl.domain.discovery.scheduler import DiscoveryRunProgress
from jobctrl.discovery.activities import (
    DiscoveryEnrichmentActivityOutput,
    DiscoveryEnrichmentActivityInput,
    DiscoveryPreparationFanoutInput,
    DiscoveryPreparationFanoutOutput,
    DiscoverySourceActivityInput,
    DiscoverySourceActivityOutput,
    PlanDiscoverySourcesInput,
    PlanDiscoverySourcesOutput,
    _build_per_job_handoff,
    discovery_preparation_fanout_activity,
)
from jobctrl.discovery.workflow import (
    DiscoverWorkflow,
    DiscoverWorkflowInput,
    DiscoverWorkflowResult,
    _activity_error_was_cancelled,
)
from jobctrl.infrastructure.temporal.finalize import WorkflowOutcomeInput, WorkflowStartedInput
from jobctrl.llm import SpendBudgetStatus
from jobctrl.pipeline import runner


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
_MAX_PARALLEL: int = 1
_SOURCE_CONCURRENCY: dict[str, int] = {"current": 0, "peak": 0}


def _reset_state() -> None:
    _EVENTS.clear()
    _TARGETS.clear()
    _RESUME_GATE.clear()
    global _FAIL_FAMILY, _MAX_PARALLEL
    _FAIL_FAMILY = None
    _MAX_PARALLEL = 1
    _SOURCE_CONCURRENCY["current"] = 0
    _SOURCE_CONCURRENCY["peak"] = 0


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

    async def fake_execute(_payload, _discovery_execution) -> None:
        raise CancelledError("canceled by test")

    async def fake_check_spend(_payload) -> None:
        return None

    monkeypatch.setattr(workflow_instance, "_execute", fake_execute)
    monkeypatch.setattr("jobctrl.discovery.workflow._check_spend", fake_check_spend)
    monkeypatch.setattr("jobctrl.discovery.workflow.emit_workflow_started", fake_started)
    monkeypatch.setattr("jobctrl.discovery.workflow.emit_workflow_outcome", fake_outcome)
    monkeypatch.setattr("jobctrl.discovery.workflow.workflow.now", lambda: "2026-01-01T00:00:00Z")
    monkeypatch.setattr(
        "jobctrl.discovery.workflow.workflow.info",
        lambda: SimpleNamespace(workflow_id="discover-local", run_id="temporal-run-test"),
    )

    with pytest.raises(CancelledError):
        await workflow_instance.run(DiscoverWorkflowInput(tenant_id="local"))

    assert _EVENTS == [
        ("workflow_started", "DiscoverWorkflow"),
        ("workflow_outcome", "canceled"),
    ]


@pytest.mark.asyncio
async def test_discover_workflow_captures_temporal_execution_identity_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow_instance = DiscoverWorkflow()
    captured: dict[str, Any] = {"info_calls": 0}

    def fake_info():
        captured["info_calls"] = int(captured["info_calls"]) + 1
        return SimpleNamespace(
            workflow_id="discover-local",
            run_id="temporal-run-stable",
        )

    async def fake_execute(_payload, discovery_execution) -> DiscoverWorkflowResult:
        captured["execution"] = discovery_execution
        return DiscoverWorkflowResult()

    async def no_op(**_kwargs) -> None:
        return None

    async def no_spend(_payload) -> None:
        return None

    monkeypatch.setattr(workflow_instance, "_execute", fake_execute)
    monkeypatch.setattr("jobctrl.discovery.workflow._check_spend", no_spend)
    monkeypatch.setattr("jobctrl.discovery.workflow.emit_workflow_started", no_op)
    monkeypatch.setattr("jobctrl.discovery.workflow.emit_workflow_outcome", no_op)
    monkeypatch.setattr("jobctrl.discovery.workflow.workflow.info", fake_info)
    monkeypatch.setattr("jobctrl.discovery.workflow.workflow.now", lambda: "2026-01-01T00:00:00Z")

    result = await workflow_instance.run(DiscoverWorkflowInput(tenant_id="local"))

    assert result == DiscoverWorkflowResult()
    assert captured["info_calls"] == 1
    assert captured["execution"].tenant_id == "local"
    assert captured["execution"].workflow_id == "discover-local"
    assert captured["execution"].temporal_run_id == "temporal-run-stable"


def _discovery_activities():
    return [
        _check_spend_budget,
        _record_workflow_started,
        _record_workflow_outcome,
        _plan_discovery_sources,
        _discovery_source_family,
        _discovery_enrichment,
        _discovery_preparation_fanout,
    ]


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
        max_parallel_families=_MAX_PARALLEL,
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
    _EVENTS.append(
        (
            "enrichment",
            payload.limit,
            payload.stream_while_discovering,
            payload.pipeline_step_item_key,
        )
    )
    return DiscoveryEnrichmentActivityOutput(status="ok", passes=1, pending=0)


@activity.defn(name="discovery_enrichment")
async def _partial_discovery_enrichment(
    payload: DiscoveryEnrichmentActivityInput,
) -> DiscoveryEnrichmentActivityOutput:
    _EVENTS.append(("enrichment", payload.limit))
    return DiscoveryEnrichmentActivityOutput(
        status="partial",
        passes=1,
        pending=0,
        site_errors={"indeed": {"error_class": "RuntimeError", "error_message": "boom"}},
    )


@activity.defn(name="discovery_preparation_fanout")
async def _discovery_preparation_fanout(
    payload: DiscoveryPreparationFanoutInput,
) -> DiscoveryPreparationFanoutOutput:
    _EVENTS.append(("fanout", payload.min_score, payload.limit, payload.include_pending_tailor))
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
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    monkeypatch.setattr(
        "jobctrl.pipeline.preparation.start_discovery_preparation_workflows",
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
            llm_model="codex:model",
        )
    )

    assert captured["activity_name"] == "discover:preparation"
    assert captured["fanout_kwargs"] == {
        "min_score": 8,
        "limit": 5,
        "workers": 3,
        "validation_mode": "strict",
        "llm_model": "codex:model",
        "tailor_models": ("draft",),
        "tailor_judge_model": "judge",
        "tailor_judge_min_score": 8.5,
        "tenant_id": "local",
        # R9 Phase 1: the fan-out activity forwards the score-only vs
        # full-derive selector; default preserves the pre-streaming behavior.
        "include_pending_tailor": True,
        "discovery_execution": None,
        "discovery_cohort_kind": "observed_this_run",
        "finalize_observed_work_plans": False,
    }
    assert result == DiscoveryPreparationFanoutOutput(started=2, queued=1, targets=3)


@pytest.mark.asyncio
async def test_discovery_preparation_fanout_activity_forwards_score_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """R9 Phase 1: ``include_pending_tailor=False`` reaches the fan-out so
    streaming passes after the first derive score-only targets."""
    captured: dict[str, Any] = {}

    async def fake_run_blocking(fn, **kwargs):
        return fn()

    def fake_start_fanout(**kwargs):
        captured["fanout_kwargs"] = kwargs
        return {"started": {"job_preparation": 0}, "queued": {"job_preparation": 0}, "targets": 0}

    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    monkeypatch.setattr(
        "jobctrl.pipeline.preparation.start_discovery_preparation_workflows",
        fake_start_fanout,
    )

    await discovery_preparation_fanout_activity(
        DiscoveryPreparationFanoutInput(tenant_id="local", include_pending_tailor=False)
    )

    assert captured["fanout_kwargs"]["include_pending_tailor"] is False


def test_build_per_job_handoff_disabled_returns_none() -> None:
    assert (
        _build_per_job_handoff(
            DiscoveryEnrichmentActivityInput(tenant_id="local", per_job_handoff=False)
        )
        is None
    )


def test_build_per_job_handoff_starts_scored_prep_with_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """R9 Phase 2: when enabled, the enrichment activity's handoff callback
    starts each enriched job's preparation with the run's prep params."""
    calls: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        "jobctrl.pipeline.preparation.start_job_preparation_workflow",
        lambda url, **kwargs: calls.append((url, kwargs)),
    )

    handoff = _build_per_job_handoff(
        DiscoveryEnrichmentActivityInput(
            tenant_id="local",
            per_job_handoff=True,
            min_score=8,
            validation_mode="strict",
            llm_model="codex:model",
            tailor_models=("draft",),
            tailor_judge_model="judge",
            tailor_judge_min_score=8.5,
        )
    )
    assert handoff is not None
    handoff("https://example.com/job/1")

    assert [url for url, _ in calls] == ["https://example.com/job/1"]
    _, kwargs = calls[0]
    assert kwargs["min_score"] == 8
    assert kwargs["validation_mode"] == "strict"
    assert kwargs["llm_model"] == "codex:model"
    assert kwargs["tailor_models"] == ("draft",)
    assert kwargs["tailor_judge_model"] == "judge"
    assert kwargs["tailor_judge_min_score"] == 8.5
    assert str(kwargs["tenant_id"]) == "local"


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
    # One producer-lifetime enrichment pass overlaps source crawling; the
    # per-family score-only fan-outs and terminal reconcile remain backstops.
    kinds = [event[0] for event in _EVENTS]
    enrichment_events = [event for event in _EVENTS if event[0] == "enrichment"]
    assert [event[2] for event in enrichment_events] == [True, False]
    assert [event[3] for event in enrichment_events] == ["streaming:live", "terminal"]
    live_enrichment = _EVENTS.index(enrichment_events[0])
    first_source = kinds.index("source")
    second_source = kinds.index("source", first_source + 1)
    assert live_enrichment < second_source
    assert kinds.count("fanout") == 5
    assert _EVENTS.index(enrichment_events[-1]) > max(
        index for index, event in enumerate(_EVENTS) if event[0] == "source"
    )
    assert _EVENTS[-1] == ("workflow_outcome", "succeeded")


@activity.defn(name="discovery_source_family")
async def _source_waiting_for_live_enrichment(
    payload: DiscoverySourceActivityInput,
) -> DiscoverySourceActivityOutput:
    """Model a JobStreaming family that has committed a job but is still crawling."""

    _EVENTS.append(("source_committed_job", payload.family))
    await asyncio.wait_for(_RESUME_GATE["live_enrichment_started"].wait(), timeout=5)
    _EVENTS.append(("source_completed", payload.family))
    return DiscoverySourceActivityOutput(
        family=payload.family,
        status="ok",
        result={"new": 1},
        source_ids=[f"{payload.family}:source"],
    )


@activity.defn(name="discovery_enrichment")
async def _live_enrichment_probe(
    payload: DiscoveryEnrichmentActivityInput,
) -> DiscoveryEnrichmentActivityOutput:
    if getattr(payload, "stream_while_discovering", False):
        _EVENTS.append(("live_enrichment_started", payload.pipeline_step_item_key))
        _RESUME_GATE["live_enrichment_started"].set()
        try:
            while True:
                activity.heartbeat("waiting for more discovered jobs")
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            _EVENTS.append(("live_enrichment_canceled", payload.pipeline_step_item_key))
            raise
    _EVENTS.append(("terminal_enrichment", payload.pipeline_step_item_key))
    return DiscoveryEnrichmentActivityOutput(status="ok", passes=1, pending=0)


@pytest.mark.asyncio
async def test_discover_workflow_starts_enrichment_before_source_family_completes() -> None:
    """A committed job must not wait for a broad-board family crawl to finish."""

    _reset_state()
    _RESUME_GATE["live_enrichment_started"] = asyncio.Event()
    queue = f"discover-live-enrichment-{uuid.uuid4()}"
    activities = [
        _check_spend_budget,
        _record_workflow_started,
        _record_workflow_outcome,
        _plan_discovery_sources,
        _source_waiting_for_live_enrichment,
        _live_enrichment_probe,
        _discovery_preparation_fanout,
    ]

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=activities,
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            try:
                result = await asyncio.wait_for(
                    env.client.execute_workflow(
                        DiscoverWorkflow.run,
                        DiscoverWorkflowInput(tenant_id="local"),
                        id=f"{queue}-wf",
                        task_queue=queue,
                    ),
                    timeout=15,
                )
            except TimeoutError:
                pytest.fail(f"workflow timed out with events: {_EVENTS!r}")

    assert result.families_completed == ["jobspy", "workday", "smartextract"]
    kinds = [event[0] for event in _EVENTS]
    assert kinds.index("live_enrichment_started") < kinds.index("source_completed")
    assert kinds.index("live_enrichment_canceled") < kinds.index("terminal_enrichment")


@pytest.mark.asyncio
async def test_only_the_preloop_sweep_derives_pending_tailor() -> None:
    """R9 Phase 2 race guard: the ONE-TIME straggler sweep before the family loop
    is the only fan-out that derives ``pending_tailor`` (include_pending_tailor=
    True); every streaming + terminal fan-out is score-only. This is what keeps a
    fresh job — already scored into ``pending_tailor`` by its per-job handoff —
    from being double-fanned as a racing TAILOR_RESUME workflow."""
    _reset_state()
    _TARGETS.append(
        _Target(
            job_url="https://example.com/job/1",
            idempotency_key="target-1",
            target_version="3",
            steps=["score", "tailor"],
        )
    )
    queue = f"discover-scoreonly-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_discovery_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            await env.client.execute_workflow(
                DiscoverWorkflow.run,
                DiscoverWorkflowInput(tenant_id="local"),
                id=f"discover-scoreonly-{uuid.uuid4()}",
                task_queue=queue,
            )

    include_tailor_flags = [event[3] for event in _EVENTS if event[0] == "fanout"]
    # 3 families -> pre-loop sweep + 3 streaming + terminal = 5 fan-outs.
    # Only the first (pre-loop straggler sweep) derives pending_tailor.
    assert include_tailor_flags == [True, False, False, False, False]


@pytest.mark.asyncio
async def test_discover_workflow_tolerates_partial_source_failure() -> None:
    """One failed family must not abort discovery: enrichment + preparation still
    run and the workflow SUCCEEDS with the failed family recorded (legacy
    partial-source semantics)."""
    _reset_state()
    global _FAIL_FAMILY
    _FAIL_FAMILY = "workday"
    _TARGETS.append(
        _Target(
            job_url="https://example.com/job/1",
            idempotency_key="target-1",
            target_version="3",
            steps=["score", "tailor"],
        )
    )
    queue = f"discover-partial-{uuid.uuid4()}"

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
                DiscoverWorkflowInput(tenant_id="local"),
                id=f"discover-partial-{uuid.uuid4()}",
                task_queue=queue,
            )

    source_events = [event for event in _EVENTS if event[0] == "source"]
    assert [event[1] for event in source_events] == ["jobspy", "workday", "smartextract"]
    assert result.families_completed == ["jobspy", "smartextract"]
    assert result.families_failed == ["workday"]
    assert result.preparation_started == 1
    assert any(event[0] == "enrichment" for event in _EVENTS)
    assert any(event[0] == "fanout" for event in _EVENTS)
    # I2 under streaming: jobspy completed first and its jobs were enriched +
    # fanned out BEFORE the workday family ran and failed. A later family's
    # failure must not undo the earlier family's streaming fan-out.
    kinds = [event[0] for event in _EVENTS]
    jobspy_source = next(
        index
        for index, event in enumerate(_EVENTS)
        if event[0] == "source" and event[1] == "jobspy"
    )
    workday_source = next(
        index
        for index, event in enumerate(_EVENTS)
        if event[0] == "source" and event[1] == "workday"
    )
    # Live enrichment is already active before the failing later source; the
    # completed family's score-only fan-out lands between the two sources.
    live_enrichment = next(
        index
        for index, event in enumerate(_EVENTS)
        if event[0] == "enrichment" and event[2] is True
    )
    assert live_enrichment < workday_source
    assert "fanout" in kinds[jobspy_source:workday_source]
    # A failed family produces no streaming enrichment/fanout of its own: the
    # pre-loop straggler sweep + two completed families + one terminal reconcile
    # give exactly four fan-outs (workday contributes none).
    assert kinds.count("fanout") == 4
    assert _EVENTS[-1] == ("workflow_outcome", "succeeded")


def _partial_enrichment_activities():
    return [
        _check_spend_budget,
        _record_workflow_started,
        _record_workflow_outcome,
        _plan_discovery_sources,
        _discovery_source_family,
        _partial_discovery_enrichment,
        _discovery_preparation_fanout,
    ]


@pytest.mark.asyncio
async def test_discover_workflow_preserves_partial_enrichment_site_errors() -> None:
    _reset_state()
    _TARGETS.append(
        _Target(
            job_url="https://example.com/job/1",
            idempotency_key="target-1",
            target_version="3",
            steps=["score", "tailor"],
        )
    )
    queue = f"discover-partial-enrichment-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_partial_enrichment_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            result = await env.client.execute_workflow(
                DiscoverWorkflow.run,
                DiscoverWorkflowInput(tenant_id="local"),
                id=f"discover-partial-enrichment-{uuid.uuid4()}",
                task_queue=queue,
            )

    assert result.enrichment_status == "partial"
    assert result.enrichment_site_errors == {
        "indeed": {"error_class": "RuntimeError", "error_message": "boom"}
    }
    assert result.preparation_started == 1
    assert _EVENTS[-1] == ("workflow_outcome", "succeeded")


@activity.defn(name="discovery_source_family")
async def _always_failing_source_family(
    payload: DiscoverySourceActivityInput,
) -> DiscoverySourceActivityOutput:
    _EVENTS.append(("source", payload.family))
    raise ApplicationError(
        f"{payload.family} unavailable",
        type="source_unavailable",
        non_retryable=True,
    )


def _all_fail_activities():
    return [
        _check_spend_budget,
        _record_workflow_started,
        _record_workflow_outcome,
        _plan_discovery_sources,
        _always_failing_source_family,
        _discovery_enrichment,
        _discovery_preparation_fanout,
    ]


@pytest.mark.asyncio
async def test_discover_workflow_fails_only_when_every_source_fails() -> None:
    """When ALL families fail the workflow still runs enrichment + preparation,
    then fails terminally as a source failure (legacy semantics)."""
    _reset_state()
    queue = f"discover-allfail-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_all_fail_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            with pytest.raises(WorkflowFailureError) as excinfo:
                await env.client.execute_workflow(
                    DiscoverWorkflow.run,
                    DiscoverWorkflowInput(tenant_id="local"),
                    id=f"discover-allfail-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert any(event[0] == "enrichment" for event in _EVENTS)
    assert any(event[0] == "fanout" for event in _EVENTS)
    # No family completed, so there is no per-family fanout. The live
    # producer-lifetime enrichment and terminal reconcile both still run.
    kinds = [event[0] for event in _EVENTS]
    assert kinds.count("enrichment") == 2
    assert kinds.count("fanout") == 2
    assert ("workflow_outcome", "failed") in _EVENTS
    cause = excinfo.value.cause
    assert isinstance(cause, ApplicationError)
    assert cause.type == "discovery_source_failed"


@activity.defn(name="discovery_enrichment")
async def _failing_enrichment(
    payload: DiscoveryEnrichmentActivityInput,
) -> DiscoveryEnrichmentActivityOutput:
    _EVENTS.append(("enrichment", payload.limit))
    raise ApplicationError(
        "discover:enrichment failed: Error: BrowserType.launch: Executable doesn't exist at /x",
        type="configuration",
        non_retryable=True,
    )


def _enrichment_fail_activities():
    return [
        _check_spend_budget,
        _record_workflow_started,
        _record_workflow_outcome,
        _plan_discovery_sources,
        _discovery_source_family,
        _failing_enrichment,
        _discovery_preparation_fanout,
    ]


@pytest.mark.asyncio
async def test_discover_workflow_surfaces_real_enrichment_failure_after_preparation() -> None:
    """A non-retryable enrichment failure fails the workflow with the REAL cause
    (never "failed: failed"), and preparation still runs first."""
    _reset_state()
    _TARGETS.append(
        _Target(
            job_url="https://example.com/job/1",
            idempotency_key="target-1",
            target_version="3",
            steps=["score", "tailor"],
        )
    )
    queue = f"discover-enrichfail-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_enrichment_fail_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            with pytest.raises(WorkflowFailureError) as excinfo:
                await env.client.execute_workflow(
                    DiscoverWorkflow.run,
                    DiscoverWorkflowInput(tenant_id="local"),
                    id=f"discover-enrichfail-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert any(event[0] == "fanout" for event in _EVENTS)
    assert ("workflow_outcome", "failed") in _EVENTS
    cause = excinfo.value.cause
    assert isinstance(cause, ApplicationError)
    assert "Executable doesn't exist" in str(cause)
    assert cause.type == "configuration"


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
        _check_spend_budget,
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
        "jobctrl.discovery.workflow._DEFAULT_HEARTBEAT_TIMEOUT",
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


# ---------------------------------------------------------------------------
# R9 Phase 3 — parallel source families (gated)
# ---------------------------------------------------------------------------


@activity.defn(name="discovery_source_family")
async def _parallel_tracking_source(payload: DiscoverySourceActivityInput) -> DiscoverySourceActivityOutput:
    """Records peak concurrency and completes families in a different order than
    they were submitted, so tests can assert both the cap and the deterministic
    submission-order fold."""
    _SOURCE_CONCURRENCY["current"] += 1
    _SOURCE_CONCURRENCY["peak"] = max(_SOURCE_CONCURRENCY["peak"], _SOURCE_CONCURRENCY["current"])
    _EVENTS.append(("source", payload.family))
    try:
        # Later-submitted families finish first, so completion order != order.
        hold = {"jobspy": 0.15, "workday": 0.10, "smartextract": 0.05}.get(payload.family, 0.05)
        await asyncio.sleep(hold)
        if payload.family == _FAIL_FAMILY:
            raise ApplicationError(
                f"{payload.family} unavailable", type="source_unavailable", non_retryable=True
            )
        return DiscoverySourceActivityOutput(
            family=payload.family, status="ok", result={"new": 1}, source_ids=[]
        )
    finally:
        _SOURCE_CONCURRENCY["current"] -= 1


def _parallel_activities():
    return [
        _check_spend_budget,
        _record_workflow_started,
        _record_workflow_outcome,
        _plan_discovery_sources,
        _parallel_tracking_source,
        _discovery_enrichment,
        _discovery_preparation_fanout,
    ]


async def _run_parallel_discover(queue: str) -> Any:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_parallel_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            return await env.client.execute_workflow(
                DiscoverWorkflow.run,
                DiscoverWorkflowInput(tenant_id="local"),
                id=f"{queue}-wf",
                task_queue=queue,
            )


@pytest.mark.asyncio
async def test_parallel_families_respect_the_cap() -> None:
    """Phase 3 bound: with 3 families and a cap of 2, no more than 2 source
    crawls run concurrently, and at least 2 do (parallelism actually happens)."""
    _reset_state()
    global _MAX_PARALLEL
    _MAX_PARALLEL = 2
    result = await _run_parallel_discover(f"discover-cap2-{uuid.uuid4().hex[:8]}")

    assert result.families_completed == ["jobspy", "workday", "smartextract"]
    assert _SOURCE_CONCURRENCY["peak"] == 2


@pytest.mark.asyncio
async def test_sequential_default_runs_one_family_at_a_time() -> None:
    """The default cap (1) keeps families strictly sequential — the safe,
    unchanged behavior."""
    _reset_state()  # _MAX_PARALLEL stays 1
    result = await _run_parallel_discover(f"discover-cap1-{uuid.uuid4().hex[:8]}")

    assert result.families_completed == ["jobspy", "workday", "smartextract"]
    assert _SOURCE_CONCURRENCY["peak"] == 1


@pytest.mark.asyncio
async def test_parallel_family_results_fold_in_submission_order() -> None:
    """Determinism: even though families finish in reverse order (smartextract
    first), the completed list is folded in submission order — the fold does not
    depend on wall-clock completion order, so replay stays deterministic."""
    _reset_state()
    global _MAX_PARALLEL
    _MAX_PARALLEL = 3
    result = await _run_parallel_discover(f"discover-cap3-{uuid.uuid4().hex[:8]}")

    assert _SOURCE_CONCURRENCY["peak"] == 3
    assert result.families_completed == ["jobspy", "workday", "smartextract"]


@pytest.mark.asyncio
async def test_parallel_partial_failure_preserves_folding() -> None:
    """I2 under parallelism: a family failing while peers run concurrently keeps
    the tolerated-partial-failure folding — the run SUCCEEDS with the failed
    family recorded, and the peers' streaming fan-out still ran."""
    _reset_state()
    global _MAX_PARALLEL, _FAIL_FAMILY
    _MAX_PARALLEL = 3
    _FAIL_FAMILY = "workday"
    _TARGETS.append(
        _Target(job_url="https://example.com/job/1", idempotency_key="t1", target_version="3", steps=["score"])
    )
    result = await _run_parallel_discover(f"discover-parfail-{uuid.uuid4().hex[:8]}")

    assert result.families_completed == ["jobspy", "smartextract"]
    assert result.families_failed == ["workday"]
    assert any(event[0] == "fanout" for event in _EVENTS)
    assert _EVENTS[-1] == ("workflow_outcome", "succeeded")


@activity.defn(name="discovery_source_family")
async def _blocking_cancelable_source(payload: DiscoverySourceActivityInput) -> DiscoverySourceActivityOutput:
    _EVENTS.append(("source", payload.family))
    _SOURCE_CONCURRENCY["current"] += 1
    if _SOURCE_CONCURRENCY["current"] >= _MAX_PARALLEL:
        _RESUME_GATE["all_started"].set()
    try:
        while True:
            activity.heartbeat("blocking")
            await asyncio.sleep(0.1)
    except asyncio.CancelledError:
        _EVENTS.append(("source_canceled", payload.family))
        raise


@pytest.mark.asyncio
async def test_parallel_family_cancellation_cancels_the_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """Phase 3 cancel-all: canceling the run while multiple families crawl in
    parallel cooperatively cancels every in-flight family and terminalizes the
    workflow as canceled."""
    _reset_state()
    monkeypatch.setattr(
        "jobctrl.discovery.workflow._DEFAULT_HEARTBEAT_TIMEOUT", timedelta(seconds=2)
    )
    global _MAX_PARALLEL
    _MAX_PARALLEL = 2
    _RESUME_GATE["all_started"] = asyncio.Event()
    queue = f"discover-parcancel-{uuid.uuid4().hex[:8]}"

    activities = [
        _check_spend_budget,
        _record_workflow_started,
        _record_workflow_outcome,
        _plan_discovery_sources,
        _blocking_cancelable_source,
        _discovery_enrichment,
        _discovery_preparation_fanout,
    ]

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=activities,
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            handle = await env.client.start_workflow(
                DiscoverWorkflow.run,
                DiscoverWorkflowInput(tenant_id="local"),
                id=f"{queue}-wf",
                task_queue=queue,
            )
            await asyncio.wait_for(_RESUME_GATE["all_started"].wait(), timeout=30)
            await handle.cancel()
            with pytest.raises(WorkflowFailureError) as excinfo:
                await asyncio.wait_for(handle.result(), timeout=60)

    # The run terminates as a cancellation.
    assert isinstance(excinfo.value.cause, CancelledError)
    # Both concurrently-active families received cooperative cancellation — the
    # cancel fans out to EVERY in-flight family, not just one.
    canceled = {event[1] for event in _EVENTS if event[0] == "source_canceled"}
    assert canceled == {"jobspy", "workday"}


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


def test_jobstreaming_progress_snapshot_becomes_typed_provider_facts() -> None:
    progress = runner._discovery_provider_progress(
        {
            "providerProgress": {
                "site": "indeed",
                "phase": "search",
                "unit": "page",
                "completedUnits": 3,
                "totalUnits": None,
                "rawItemsSeen": 12,
                "jobsEmitted": 4,
                "hasMore": True,
            }
        }
    )

    assert progress is not None
    assert progress.site == "indeed"
    assert progress.completed_units == 3
    assert progress.total_units is None
    assert progress.raw_items_seen == 12
    assert progress.jobs_emitted == 4
    assert progress.has_more is True


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
        "jobctrl.config.load_discovery_schedule_settings",
        lambda: (False, "0 7 * * *"),
    )
    client = _FakeScheduleClient()

    await _reconcile_discovery_schedule(client, "jobctrl-test")

    assert client.created == []
    assert client.handle.deleted == 1


@pytest.mark.asyncio
async def test_discovery_schedule_reconcile_creates_skip_overlap_schedule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.config.load_discovery_schedule_settings",
        lambda: (True, "15 9 * * *"),
    )
    client = _FakeScheduleClient()

    await _reconcile_discovery_schedule(client, "jobctrl-test")

    [(schedule_id, schedule)] = client.created
    assert schedule_id == "jobctrl-discovery-local"
    assert schedule.spec.cron_expressions == ["15 9 * * *"]
    assert schedule.policy.overlap is ScheduleOverlapPolicy.SKIP
    assert schedule.action.id == "discover-local"
    assert schedule.action.task_queue == "jobctrl-test"


@pytest.mark.asyncio
async def test_discovery_schedule_reconcile_updates_existing_schedule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.config.load_discovery_schedule_settings",
        lambda: (True, "30 6 * * *"),
    )
    client = _FakeScheduleClient(create_raises=True)

    await _reconcile_discovery_schedule(client, "jobctrl-test")

    assert client.handle.updated == 1
    assert client.handle.update_result.schedule.spec.cron_expressions == ["30 6 * * *"]
    assert client.handle.update_result.schedule.policy.overlap is ScheduleOverlapPolicy.SKIP


@pytest.mark.asyncio
async def test_discovery_schedule_reconcile_failure_does_not_block_worker_boot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.config.load_discovery_schedule_settings",
        lambda: (True, "not a valid cron"),
    )
    client = _FakeScheduleClient(create_raises=True, update_raises=True)

    await _reconcile_discovery_schedule(client, "jobctrl-test")

    assert client.handle.updated == 0
