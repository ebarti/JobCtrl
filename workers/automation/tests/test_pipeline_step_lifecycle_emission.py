"""Focused fixtures for activity-owned pipeline-step lifecycle emission."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from temporalio.exceptions import ApplicationError

from jobctrl.discovery import activities as discovery_activities
from jobctrl.discovery import workflow as discovery_workflow
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.infrastructure.temporal.pipeline_step_lifecycle import (
    PipelineStepScope,
    begin_pipeline_step_attempt,
    pdf_pipeline_step_item_key,
)
from jobctrl.materials import activities as materials_activities
from jobctrl.preparation import workflow as preparation_workflow


def _execution() -> DiscoveryExecutionRef:
    return DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="temporal-run-lifecycle",
    )


@dataclass
class _LifecycleRecorder:
    completed_counts: list[int | None] = field(default_factory=list)
    failures: list[dict[str, Any]] = field(default_factory=list)

    def completed(self, *, item_count: int | None = None) -> None:
        self.completed_counts.append(item_count)

    def failed(self, **kwargs: Any) -> None:
        self.failures.append(dict(kwargs))

    def failed_from_exception(
        self,
        exc: Exception,
        *,
        fallback_error_code: str,
        item_count: int | None = None,
    ) -> None:
        self.failures.append(
            {
                "exception": exc,
                "fallback_error_code": fallback_error_code,
                "item_count": item_count,
            }
        )


def test_source_plan_activity_uses_plan_scope_and_family_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    recorder = _LifecycleRecorder()

    def fake_begin(scope: PipelineStepScope | None, **kwargs: Any):
        captured["scope"] = scope
        captured["begin_kwargs"] = dict(kwargs)
        return recorder

    monkeypatch.setattr(discovery_activities, "begin_pipeline_step_attempt", fake_begin)
    monkeypatch.setattr(
        "jobctrl.pipeline.runner.plan_discovery_source_families",
        lambda **_kwargs: {
            "families": ["jobspy", "workday"],
            "progress_total": 2,
            "start_count": 0,
            "max_parallel_families": 2,
            "next_run_settings": {},
        },
    )

    output = discovery_activities.plan_discovery_sources(
        discovery_activities.PlanDiscoverySourcesInput(
            tenant_id="local",
            discovery_execution=_execution(),
        )
    )

    assert output.families == ["jobspy", "workday"]
    assert captured["begin_kwargs"] == {}
    assert (
        captured["scope"].step_kind,
        captured["scope"].item_key,
        captured["scope"].detail_code,
    ) == ("source_planning", "plan", "source_plan")
    assert recorder.completed_counts == [2]


def test_attempt_emits_honest_queued_started_and_completed_facts() -> None:
    scheduled_at = datetime(2026, 7, 14, 8, 59, 58, tzinfo=UTC)
    started_at = datetime(2026, 7, 14, 9, 0, tzinfo=UTC)
    completed_at = started_at + timedelta(seconds=4, milliseconds=250)
    events = []
    scope = PipelineStepScope(
        execution=_execution(),
        step_kind="enrichment_pass",
        item_key="streaming:pass-2",
        detail_code="streaming_pass",
    )

    attempt = begin_pipeline_step_attempt(
        scope,
        item_count=2,
        info=SimpleNamespace(
            attempt=3,
            current_attempt_scheduled_time=scheduled_at,
            started_time=started_at,
        ),
        writer=events.append,
        clock=lambda: completed_at,
    )

    assert attempt is not None
    assert [event.event_type for event in events] == [
        "PipelineStepQueued",
        "PipelineStepStarted",
    ]
    assert events[0].payload["attempt"] == 3
    assert events[0].payload["queuedAt"] == scheduled_at.isoformat()
    assert events[1].payload["startedAt"] == started_at.isoformat()
    assert events[0].payload["detail"] == {
        "code": "streaming_pass",
        "itemCount": 2,
    }

    attempt.completed(item_count=5)
    attempt.completed(item_count=99)

    assert [event.event_type for event in events] == [
        "PipelineStepQueued",
        "PipelineStepStarted",
        "PipelineStepCompleted",
    ]
    assert events[-1].payload["durationMs"] == 4_250
    assert events[-1].payload["detail"] == {
        "code": "streaming_pass",
        "itemCount": 5,
    }


def test_attempt_never_fabricates_missing_queue_metadata_or_terminal_fact() -> None:
    events = []
    scope = PipelineStepScope(
        execution=_execution(),
        step_kind="source_planning",
        item_key="plan",
        detail_code="source_plan",
    )

    with pytest.raises(RuntimeError, match="timing metadata"):
        begin_pipeline_step_attempt(
            scope,
            info=SimpleNamespace(
                attempt=1,
                started_time=datetime(2026, 7, 14, 9, 0, tzinfo=UTC),
            ),
            writer=events.append,
        )

    assert events == []

    observed = begin_pipeline_step_attempt(
        scope,
        info=SimpleNamespace(
            attempt=1,
            current_attempt_scheduled_time=datetime(
                2026, 7, 14, 8, 59, tzinfo=UTC
            ),
            started_time=datetime(2026, 7, 14, 9, 0, tzinfo=UTC),
        ),
        writer=events.append,
    )
    assert observed is not None
    assert [event.event_type for event in events] == [
        "PipelineStepQueued",
        "PipelineStepStarted",
    ]


def test_failure_persists_only_safe_machine_fields() -> None:
    events = []
    started_at = datetime(2026, 7, 14, 9, 0, tzinfo=UTC)
    attempt = begin_pipeline_step_attempt(
        PipelineStepScope(
            execution=_execution(),
            step_kind="enrichment_pass",
            item_key="terminal",
            detail_code="terminal_reconciliation",
        ),
        info=SimpleNamespace(
            attempt=1,
            current_attempt_scheduled_time=started_at,
            started_time=started_at,
        ),
        writer=events.append,
        clock=lambda: started_at + timedelta(seconds=2),
    )
    assert attempt is not None

    attempt.failed_from_exception(
        ApplicationError(
            "provider leaked secret-token-123",
            type="Unsafe Error Type",
            non_retryable=True,
        ),
        fallback_error_code="enrichment_pass_failed",
    )

    failed = events[-1]
    assert failed.event_type == "PipelineStepFailed"
    assert failed.payload["errorCode"] == "enrichment_pass_failed"
    assert failed.payload["retryable"] is False
    assert failed.payload["durationMs"] == 2_000
    assert "secret-token-123" not in json.dumps(failed.payload)


@pytest.mark.asyncio
async def test_discovery_activities_use_stable_scopes_and_terminal_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execution = _execution()
    scopes: list[tuple[PipelineStepScope, dict[str, Any], _LifecycleRecorder]] = []
    source_kwargs: dict[str, Any] = {}

    def fake_begin(scope: PipelineStepScope | None, **kwargs: Any):
        assert scope is not None
        recorder = _LifecycleRecorder()
        scopes.append((scope, dict(kwargs), recorder))
        return recorder

    async def fake_run_blocking(fn, **_kwargs):
        return fn()

    monkeypatch.setattr(discovery_activities, "begin_pipeline_step_attempt", fake_begin)
    monkeypatch.setattr(discovery_activities.activity, "heartbeat", lambda *_args: None)
    monkeypatch.setattr(
        discovery_activities.activity,
        "info",
        lambda: SimpleNamespace(
            attempt=2,
            activity_id="source-family",
            activity_run_id="activity-run-2",
        ),
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    def fake_source_family(family: str, **kwargs: Any) -> dict[str, Any]:
        source_kwargs.update(kwargs)
        return {
            "family": family,
            "status": "ok",
            "result": {},
            "source_ids": [],
        }

    monkeypatch.setattr(
        "jobctrl.pipeline.runner.run_discovery_source_family",
        fake_source_family,
    )
    monkeypatch.setattr(
        "jobctrl.pipeline.runner.run_discovery_enrichment_stage",
        lambda **_kwargs: {"status": "ok", "passes": 2, "pending": 0},
    )
    monkeypatch.setattr(
        "jobctrl.pipeline.runner.run_discovery_hygiene",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        "jobctrl.pipeline.preparation.start_discovery_preparation_workflows",
        lambda **_kwargs: {
            "started": {"job_preparation": 2},
            "queued": {"job_preparation": 0},
            "targets": 2,
        },
    )
    monkeypatch.setattr(
        discovery_activities,
        "_record_preparation_progress",
        lambda *_args, **_kwargs: None,
    )

    await discovery_activities.discovery_source_family_activity(
        discovery_activities.DiscoverySourceActivityInput(
            tenant_id="local",
            family="workday",
            discovery_execution=execution,
        )
    )
    await discovery_activities.discovery_enrichment_activity(
        discovery_activities.DiscoveryEnrichmentActivityInput(
            tenant_id="local",
            discovery_execution=execution,
            pipeline_step_item_key="streaming:pass-4",
            pipeline_step_detail_code="streaming_pass",
        )
    )
    await discovery_activities.discovery_preparation_fanout_activity(
        discovery_activities.DiscoveryPreparationFanoutInput(
            tenant_id="local",
            discovery_execution=execution,
            pipeline_step_kind="existing_backlog_sweep",
            pipeline_step_item_key="existing_backlog",
            pipeline_step_detail_code="existing_backlog",
        )
    )

    assert [
        (scope.step_kind, scope.item_key, scope.detail_code)
        for scope, _kwargs, _recorder in scopes
    ] == [
        ("source_family", "family:workday", "source_family"),
        ("enrichment_pass", "streaming:pass-4", "streaming_pass"),
        ("existing_backlog_sweep", "existing_backlog", "existing_backlog"),
    ]
    assert scopes[0][1] == {"item_count": 1}
    assert source_kwargs["activity_attempt"] == 2
    assert source_kwargs["activity_owner_token"] == (
        "source-family:activity-run-2:2"
    )
    assert [recorder.completed_counts for _, _, recorder in scopes] == [
        [1],
        [2],
        [2],
    ]


@pytest.mark.asyncio
async def test_workflow_assigns_deterministic_stream_and_backlog_scope_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    async def fake_enrichment(_payload, _execution_ref, **kwargs):
        calls.append(("enrichment", dict(kwargs)))
        return discovery_activities.DiscoveryEnrichmentActivityOutput(status="ok")

    async def fake_fanout(_payload, _execution_ref, **kwargs):
        calls.append(("fanout", dict(kwargs)))
        return 0

    monkeypatch.setattr(
        discovery_workflow,
        "_run_enrichment_activity",
        fake_enrichment,
    )
    monkeypatch.setattr(
        discovery_workflow,
        "_start_preparation_workflows",
        fake_fanout,
    )

    instance = discovery_workflow.DiscoverWorkflow()
    payload = discovery_workflow.DiscoverWorkflowInput(tenant_id="local")
    execution = _execution()
    await instance._stream_family_preparation(
        payload,
        execution,
        pass_ordinal=3,
    )
    await instance._sweep_preexisting_preparation(payload, execution)

    assert calls == [
        (
            "enrichment",
            {
                "progress_completed": 0,
                "progress_total": 0,
                "per_job_handoff": True,
                "pipeline_step_item_key": "streaming:pass-3",
                "pipeline_step_detail_code": "streaming_pass",
            },
        ),
        (
            "fanout",
            {
                "include_pending_tailor": False,
                "progress_completed": 0,
                "progress_total": 0,
                "pipeline_step_kind": "preparation_fanout",
                "pipeline_step_item_key": "streaming:pass-3",
                "pipeline_step_detail_code": "streaming_pass",
            },
        ),
        (
            "fanout",
            {
                "include_pending_tailor": True,
                "cohort_kind": "existing_backlog",
                "progress_completed": 0,
                "progress_total": 0,
                "pipeline_step_kind": "existing_backlog_sweep",
                "pipeline_step_item_key": "existing_backlog",
                "pipeline_step_detail_code": "existing_backlog",
            },
        ),
    ]


@pytest.mark.asyncio
async def test_pdf_error_status_emits_safe_failed_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw_idempotency_key = "preparation:https://example.com/private-job?id=secret"
    captured: dict[str, Any] = {}
    recorder = _LifecycleRecorder()

    def fake_begin(scope: PipelineStepScope | None, **_kwargs):
        captured["scope"] = scope
        return recorder

    async def fake_run_blocking(_fn, **_kwargs):
        return {"status": "error", "rendered": [], "error": "private renderer detail"}

    monkeypatch.setattr(materials_activities, "begin_pipeline_step_attempt", fake_begin)
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )

    output = await materials_activities.render_pdf_activity(
        materials_activities.RenderPdfActivityInput(
            tenant_id="local",
            job_url="https://example.com/private-job",
            discovery_execution=_execution(),
            pipeline_step_idempotency_key=raw_idempotency_key,
        )
    )

    assert output.status == "error"
    assert captured["scope"].step_kind == "pdf_render"
    assert captured["scope"].detail_code == "pdf_render"
    assert captured["scope"].item_key == pdf_pipeline_step_item_key(
        raw_idempotency_key
    )
    assert raw_idempotency_key not in captured["scope"].item_key
    assert recorder.completed_counts == []
    assert recorder.failures == [
        {
            "error_code": "pdf_render_failed",
            "retryable": False,
            "item_count": 0,
        }
    ]


@pytest.mark.asyncio
async def test_preparation_workflow_forwards_discovery_scope_to_pdf_activity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    execution = _execution()

    async def fake_execute_activity(activity_fn, payload, **_kwargs):
        captured["activity"] = activity_fn
        captured["payload"] = payload
        return materials_activities.RenderPdfActivityOutput(status="ok")

    monkeypatch.setattr(
        preparation_workflow.workflow,
        "execute_activity",
        fake_execute_activity,
    )

    await preparation_workflow._execute_step(
        "pdf",
        preparation_workflow.JobPreparationInput(
            tenant_id="local",
            job_url="https://example.com/private-job",
            steps=["pdf"],
            target_version="1",
            idempotency_key="preparation:opaque-key",
            expected_app_dir="/expected/app",
            expected_db_path="/expected/jobctrl.db",
            discovery_execution=execution,
            discovery_cohort_kind="observed_this_run",
        ),
    )

    assert captured["activity"] is materials_activities.render_pdf_activity
    assert captured["payload"] == materials_activities.RenderPdfActivityInput(
        tenant_id="local",
        job_url="https://example.com/private-job",
        expected_app_dir="/expected/app",
        expected_db_path="/expected/jobctrl.db",
        discovery_execution=execution,
        pipeline_step_idempotency_key="preparation:opaque-key",
    )


def test_pdf_scope_key_is_stable_and_non_reversible() -> None:
    raw_key = "preparation:https://example.com/job/with-sensitive-query?token=abc"

    first = pdf_pipeline_step_item_key(raw_key)
    second = pdf_pipeline_step_item_key(raw_key)

    assert first == second
    assert first.startswith("pdf:")
    assert raw_key not in first
    assert len(first) == len("pdf:") + 64


def test_pdf_scope_rejects_an_empty_idempotency_key() -> None:
    with pytest.raises(ValueError, match="must be non-empty"):
        materials_activities.RenderPdfActivityInput(
            tenant_id="local",
            job_url="https://example.com/private-job",
            discovery_execution=_execution(),
            pipeline_step_idempotency_key="",
        )
