"""Pipeline-level event and OTel observability regressions."""

from __future__ import annotations

import sys
import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from temporalio import workflow
from .temporal_env import time_skipping_env
from temporalio.worker import UnsandboxedWorkflowRunner, Worker
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import set_tracer_provider

from jobctrl.domain.discovery.source_registry import SourceKind, SourcePriority, SourceState
from jobctrl.pipeline import runner
from jobctrl.scoring.activities import ScoreActivityInput, ScoreActivityOutput, score_activity


@workflow.defn(name="PipelineObservableScoreHarness")
class _PipelineObservableScoreHarness:
    @workflow.run
    async def run(self, payload: ScoreActivityInput) -> ScoreActivityOutput:
        return await workflow.execute_activity(
            score_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
        )


@pytest.fixture
def in_memory_exporter(monkeypatch):
    from opentelemetry import trace as trace_api
    from opentelemetry.util._once import Once

    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER_SET_ONCE", Once())
    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER", None)

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    set_tracer_provider(provider)
    yield exporter
    exporter.clear()


@pytest.fixture(autouse=True)
def no_operational_metric_side_effects(monkeypatch):
    monkeypatch.setattr(runner, "_record_operational_attempt", lambda **_kwargs: None)


@pytest.mark.asyncio
async def test_score_activity_emits_pipeline_span_and_stage_events(monkeypatch, in_memory_exporter):
    events: list[tuple[str, str, str, dict]] = []
    queue = f"pipeline-observable-score-{uuid.uuid4()}"

    monkeypatch.setattr(runner, "_run_score", lambda **_kwargs: {"status": "ok"})
    monkeypatch.setattr(
        runner,
        "_record_pipeline_event",
        lambda stage, event_type, level, message, payload=None: events.append(
            (stage, event_type, level, {**(payload or {}), "message": message})
        ),
        raising=False,
    )

    async with time_skipping_env() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[_PipelineObservableScoreHarness],
            activities=[score_activity],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            output = await env.client.execute_workflow(
                _PipelineObservableScoreHarness.run,
                ScoreActivityInput(tenant_id="local", limit=1),
                id=f"pipeline-observable-score-wf-{uuid.uuid4()}",
                task_queue=queue,
            )

    assert output.status == "ok"
    assert [(event[0], event[1], event[2]) for event in events] == [
        ("score", "StageStarted", "info"),
        ("score", "StageCompleted", "info"),
    ]
    spans = {span.name: dict(span.attributes or {}) for span in in_memory_exporter.get_finished_spans()}
    assert "pipeline.stage.score" in spans
    assert spans["pipeline.stage.score"]["jobctrl.pipeline.stage"] == "score"
    assert spans["pipeline.stage.score"]["langfuse.observation.type"] == "span"


def test_tailor_stage_fails_pipeline_when_quality_gate_fails(monkeypatch):
    monkeypatch.setattr(
        "jobctrl.scoring.tailor.run_tailoring",
        lambda **_kwargs: {"approved": 0, "failed": 2, "errors": 0, "elapsed": 0.1},
    )

    with pytest.raises(runner.LlmTransientError, match="2 tailored resume"):
        runner._run_tailor()


def test_tailor_stage_errors_pipeline_when_tailoring_errors(monkeypatch):
    monkeypatch.setattr(
        "jobctrl.scoring.tailor.run_tailoring",
        lambda **_kwargs: {"approved": 0, "failed": 1, "errors": 1, "elapsed": 0.1},
    )

    with pytest.raises(runner.LlmTransientError, match="1 tailoring error"):
        runner._run_tailor()


def test_discover_source_progress_does_not_round_active_work_to_zero():
    progress = runner._discovery_progress_payload(
        completed=0,
        total=6,
        current_step="JobSpy",
        source_progress=runner.DiscoveryRunProgress(
            completed=2,
            total=72,
            unit="searches",
        ),
    )["progress"]

    assert progress["percent"] == 1


def test_smart_extract_sites_infer_search_type_from_query_placeholder() -> None:
    source = runner.ScheduledSource(
        source_id="smart_extract:welcometothejungle",
        display_name="WelcomeToTheJungle",
        source_kind=SourceKind.SMART_EXTRACT,
        priority=SourcePriority.FALLBACK,
        configured_state=SourceState.EXPERIMENTAL,
        crawl_budget=1,
        decision="run",
        reason="test",
        recommended_state="normal",
        adapter_config={
            "name": "WelcomeToTheJungle",
            "url": "https://www.welcometothejungle.com/en/jobs?query={query_encoded}",
        },
    )

    assert runner._smart_extract_sites((source,)) == [
        {
            "name": "WelcomeToTheJungle",
            "url": "https://www.welcometothejungle.com/en/jobs?query={query_encoded}",
            "type": "search",
            "query_mode": "search_only",
        }
    ]


def test_smart_extract_sites_preserve_configured_query_mode() -> None:
    source = runner.ScheduledSource(
        source_id="smart_extract:wellfound",
        display_name="Wellfound",
        source_kind=SourceKind.SMART_EXTRACT,
        priority=SourcePriority.FALLBACK,
        configured_state=SourceState.EXPERIMENTAL,
        crawl_budget=1,
        decision="run",
        reason="test",
        recommended_state="normal",
        adapter_config={
            "name": "Wellfound",
            "url": "https://wellfound.com/location/spain",
            "type": "search",
            "query_mode": "source_first",
        },
    )

    assert runner._smart_extract_sites((source,))[0]["query_mode"] == "source_first"


def test_enrich_limit_propagates_to_runner(monkeypatch):
    calls: list[dict[str, int]] = []

    monkeypatch.setitem(
        sys.modules,
        "jobctrl.enrichment.detail",
        SimpleNamespace(
            run_enrichment=lambda limit=0, workers=1, reset_linkedin_candidates=True, on_job_enriched=None: calls.append(
                {"limit": limit, "workers": workers, "reset_linkedin_candidates": reset_linkedin_candidates}
            )
            or {"processed": 0, "ok": 0, "partial": 0, "error": 0, "site_errors": {}}
        ),
    )

    assert runner._run_enrich(workers=3, limit=1) == {
        "status": "ok",
        "counts": {"processed": 0, "ok": 0, "partial": 0, "error": 0},
        "site_errors": {},
    }
    assert calls == [{"limit": 1, "workers": 3, "reset_linkedin_candidates": True}]


