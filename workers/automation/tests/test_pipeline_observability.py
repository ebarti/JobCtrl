"""Pipeline-level event and OTel observability regressions."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import set_tracer_provider

from jobhunter.domain.discovery.source_registry import SourceKind, SourcePriority, SourceState
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


@pytest.fixture(autouse=True)
def no_operational_metric_side_effects(monkeypatch):
    monkeypatch.setattr(runner, "_record_operational_attempt", lambda **_kwargs: None)


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
        SimpleNamespace(run_workday_discovery=lambda employers=None, workers=1, limit=0, run_id=None: None),
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
        SimpleNamespace(run_discovery=lambda cfg=None, limit=0: calls.append(("jobspy", limit, None))),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(
            run_workday_discovery=lambda employers=None, workers=1, limit=0, run_id=None: calls.append(
                ("workday", limit, workers)
            )
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
        ("workday", 1, 4),
        ("smartextract", 1, 4),
    ]


def test_discover_passes_remaining_limit_to_downstream_sources(monkeypatch):
    calls: list[tuple[str, int]] = []
    job_count = {"value": 100}

    def run_jobspy(cfg=None, limit=0):
        calls.append(("jobspy", limit))
        job_count["value"] = 106
        return {"new": 6, "existing": 0, "errors": 0}

    def run_workday(employers=None, workers=1, limit=0, run_id=None):
        calls.append(("workday", limit))
        job_count["value"] = 108
        return {"new": 2, "existing": 0, "errors": 0}

    monkeypatch.setattr(runner.config, "load_search_config", lambda: {})
    monkeypatch.setattr(runner, "_pipeline_job_count", lambda: job_count["value"], raising=False)
    monkeypatch.setitem(sys.modules, "jobhunter.discovery.jobspy", SimpleNamespace(run_discovery=run_jobspy))
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(run_workday_discovery=run_workday),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(
            run_smart_extract=lambda sites=None, workers=1, limit=0: calls.append(("smartextract", limit))
        ),
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)

    result = runner._run_discover(workers=4, limit=10)

    assert result == {"jobspy": "ok", "workday": "ok", "smartextract": "ok"}
    assert calls == [("jobspy", 10), ("workday", 4), ("smartextract", 2)]


def test_discover_filters_adapter_inputs_to_runnable_sources(monkeypatch):
    calls: dict[str, object] = {}

    def scheduled_source(
        source_id: str,
        *,
        kind: SourceKind,
        should_run: bool,
        adapter_config: dict[str, object],
    ) -> runner.ScheduledSource:
        return runner.ScheduledSource(
            source_id=source_id,
            display_name=source_id,
            source_kind=kind,
            priority=SourcePriority.LEAD_GENERATOR,
            configured_state=SourceState.EXPERIMENTAL,
            crawl_budget=1 if should_run else 0,
            decision="run" if should_run else "skip",
            reason="test",
            recommended_state="normal",
            adapter_config=adapter_config,
        )

    monkeypatch.setattr(
        runner,
        "_plan_discovery_schedule",
        lambda _limit: runner.DiscoverySchedule(
            (
                scheduled_source(
                    "jobspy:linkedin",
                    kind=SourceKind.BROAD_BOARD,
                    should_run=True,
                    adapter_config={"board": "linkedin"},
                ),
                scheduled_source(
                    "jobspy:indeed",
                    kind=SourceKind.BROAD_BOARD,
                    should_run=False,
                    adapter_config={"board": "indeed"},
                ),
                scheduled_source(
                    "workday:acme",
                    kind=SourceKind.ATS_API,
                    should_run=True,
                    adapter_config={"employer_key": "acme"},
                ),
                scheduled_source(
                    "workday:contoso",
                    kind=SourceKind.ATS_API,
                    should_run=False,
                    adapter_config={"employer_key": "contoso"},
                ),
            )
        ),
    )
    monkeypatch.setattr(runner.config, "load_search_config", lambda: {"boards": ["linkedin", "indeed"]})
    monkeypatch.setattr(
        runner.config,
        "load_employers_config",
        lambda: {"employers": {"acme": {"name": "Acme"}, "contoso": {"name": "Contoso"}}},
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.jobspy",
        SimpleNamespace(run_discovery=lambda cfg=None, limit=0: calls.setdefault("boards", cfg["boards"])),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(
            run_workday_discovery=lambda employers=None, workers=1, limit=0, run_id=None: calls.setdefault(
                "employers",
                sorted((employers or {}).keys()),
            )
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(run_smart_extract=lambda sites=None, workers=1, limit=0: {}),
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)

    runner._run_discover(workers=4, limit=0)

    assert calls == {"boards": ["linkedin"], "employers": ["acme"]}


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
        }
    ]


def test_discover_limit_skips_remaining_sources_after_cap(monkeypatch):
    calls: list[str] = []
    job_counts = iter([10, 11])

    monkeypatch.setattr(runner.config, "load_search_config", lambda: {})
    monkeypatch.setattr(runner, "_pipeline_job_count", lambda: next(job_counts), raising=False)
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.jobspy",
        SimpleNamespace(run_discovery=lambda cfg=None, limit=0: calls.append("jobspy")),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(run_workday_discovery=lambda employers=None, workers=1, limit=0, run_id=None: calls.append("workday")),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(run_smart_extract=lambda sites=None, workers=1, limit=0: calls.append("smartextract")),
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)

    result = runner._run_discover(workers=4, limit=1)

    assert calls == ["jobspy"]
    assert result == {"jobspy": "ok", "workday": "skipped_limit", "smartextract": "skipped_limit"}


def test_discover_limit_does_not_skip_remaining_sources_after_existing_candidate(monkeypatch):
    calls: list[str] = []

    monkeypatch.setattr(runner.config, "load_search_config", lambda: {})
    monkeypatch.setattr(runner, "_pipeline_job_count", lambda: 10, raising=False)
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.jobspy",
        SimpleNamespace(
            run_discovery=lambda cfg=None, limit=0: (
                calls.append("jobspy") or {"new": 0, "existing": 1, "errors": 0}
            )
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(run_workday_discovery=lambda employers=None, workers=1, limit=0, run_id=None: calls.append("workday")),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(run_smart_extract=lambda sites=None, workers=1, limit=0: calls.append("smartextract")),
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)

    result = runner._run_discover(workers=4, limit=1)

    assert calls == ["jobspy", "workday", "smartextract"]
    assert result == {"jobspy": "ok", "workday": "ok", "smartextract": "ok"}


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
