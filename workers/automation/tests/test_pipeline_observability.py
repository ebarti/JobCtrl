"""Pipeline-level event and OTel observability regressions."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import set_tracer_provider

from jobhunter.pipeline import runner


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


def test_sequential_stage_emits_pipeline_span_and_stage_events(monkeypatch, in_memory_exporter):
    events: list[tuple[str, str, str, dict]] = []

    monkeypatch.setitem(runner._STAGE_RUNNERS, "score", lambda **_kwargs: {"status": "ok"})
    monkeypatch.setattr(
        runner,
        "_record_pipeline_event",
        lambda stage, event_type, level, message, payload=None: events.append(
            (stage, event_type, level, {**(payload or {}), "message": message})
        ),
        raising=False,
    )

    result = runner._run_sequential(["score"], min_score=7, limit=1)

    assert result["errors"] == {}
    assert [(event[0], event[1], event[2]) for event in events] == [
        ("score", "StageStarted", "info"),
        ("score", "StageCompleted", "info"),
    ]
    spans = {span.name: dict(span.attributes or {}) for span in in_memory_exporter.get_finished_spans()}
    assert "pipeline.stage.score" in spans
    assert spans["pipeline.stage.score"]["jobhunter.pipeline.stage"] == "score"
    assert spans["pipeline.stage.score"]["langfuse.observation.type"] == "span"


def test_discover_emits_source_events(monkeypatch):
    events: list[tuple[str, str, str, dict]] = []

    monkeypatch.setattr(runner.config, "load_search_config", lambda: {"disable_jobspy": True})
    monkeypatch.setattr(
        runner,
        "_record_pipeline_event",
        lambda stage, event_type, level, message, payload=None: events.append(
            (stage, event_type, level, {**(payload or {}), "message": message})
        ),
        raising=False,
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(run_workday_discovery=lambda workers=1: None),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(run_smart_extract=lambda workers=1: None),
    )

    result = runner._run_discover(workers=2)

    assert result["workday"] == "ok"
    assert result["smartextract"] == "ok"
    source_events = [(event_type, payload.get("source")) for _, event_type, _, payload in events]
    assert source_events == [
        ("StageStarted", "jobspy"),
        ("StageCompleted", "jobspy"),
        ("StageStarted", "workday"),
        ("StageCompleted", "workday"),
        ("StageStarted", "smartextract"),
        ("StageCompleted", "smartextract"),
    ]
