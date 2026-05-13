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
        SimpleNamespace(run_workday_discovery=lambda workers=1, limit=0: None),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(run_smart_extract=lambda sites=None, workers=1, limit=0: None),
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


def test_discover_limit_propagates_to_sources(monkeypatch):
    calls: list[tuple[str, int, int | None]] = []

    monkeypatch.setattr(runner.config, "load_search_config", lambda: {})
    monkeypatch.setattr(runner, "_pipeline_job_count", lambda: 0, raising=False)
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.jobspy",
        SimpleNamespace(run_discovery=lambda limit=0: calls.append(("jobspy", limit, None))),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(
            run_workday_discovery=lambda workers=1, limit=0: calls.append(("workday", limit, workers))
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(
            run_smart_extract=lambda sites=None, workers=1, limit=0: calls.append(
                ("smartextract", limit, workers)
            )
        ),
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)

    result = runner._run_discover(workers=4, limit=1)

    assert result == {"jobspy": "ok", "workday": "ok", "smartextract": "ok"}
    assert calls == [
        ("jobspy", 1, None),
        ("workday", 1, 1),
        ("smartextract", 1, 1),
    ]


def test_discover_limit_skips_remaining_sources_after_cap(monkeypatch):
    calls: list[str] = []
    job_counts = iter([10, 11])

    monkeypatch.setattr(runner.config, "load_search_config", lambda: {})
    monkeypatch.setattr(runner, "_pipeline_job_count", lambda: next(job_counts), raising=False)
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.jobspy",
        SimpleNamespace(run_discovery=lambda limit=0: calls.append("jobspy")),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(run_workday_discovery=lambda workers=1, limit=0: calls.append("workday")),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(run_smart_extract=lambda workers=1, limit=0: calls.append("smartextract")),
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)

    result = runner._run_discover(workers=4, limit=1)

    assert calls == ["jobspy"]
    assert result == {"jobspy": "ok", "workday": "skipped_limit", "smartextract": "skipped_limit"}


def test_discover_limit_skips_remaining_sources_after_existing_candidate(monkeypatch):
    calls: list[str] = []

    monkeypatch.setattr(runner.config, "load_search_config", lambda: {})
    monkeypatch.setattr(runner, "_pipeline_job_count", lambda: 10, raising=False)
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.jobspy",
        SimpleNamespace(
            run_discovery=lambda limit=0: (calls.append("jobspy") or {"new": 0, "existing": 1, "errors": 0})
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(run_workday_discovery=lambda workers=1, limit=0: calls.append("workday")),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(run_smart_extract=lambda workers=1, limit=0: calls.append("smartextract")),
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)

    result = runner._run_discover(workers=4, limit=1)

    assert calls == ["jobspy"]
    assert result == {"jobspy": "ok", "workday": "skipped_limit", "smartextract": "skipped_limit"}


def test_enrich_limit_propagates_to_runner(monkeypatch):
    calls: list[dict[str, int]] = []

    monkeypatch.setitem(
        sys.modules,
        "jobhunter.enrichment.detail",
        SimpleNamespace(run_enrichment=lambda limit=0, workers=1: calls.append({"limit": limit, "workers": workers})),
    )

    assert runner._run_enrich(workers=3, limit=1) == {"status": "ok"}
    assert calls == [{"limit": 1, "workers": 3}]


def test_stage_kwargs_include_limits_for_discover_and_enrich():
    assert runner._build_stage_kwargs("discover", workers=2, limit=1) == {"workers": 2, "limit": 1}
    assert runner._build_stage_kwargs("enrich", workers=2, limit=1) == {"workers": 2, "limit": 1}
