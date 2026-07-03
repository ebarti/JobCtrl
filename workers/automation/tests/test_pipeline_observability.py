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


def _scheduled_source(
    source_id: str,
    *,
    kind: SourceKind,
    adapter_config: dict[str, object],
    crawl_budget: int = 100,
) -> runner.ScheduledSource:
    return runner.ScheduledSource(
        source_id=source_id,
        display_name=source_id,
        source_kind=kind,
        priority=SourcePriority.CANONICAL,
        configured_state=SourceState.ACTIVE,
        crawl_budget=crawl_budget,
        decision="run",
        reason="test",
        recommended_state="normal",
        adapter_config=adapter_config,
    )


def _standard_discovery_schedule(
    _limit: int,
    *,
    source_ids: tuple[str, ...] = (),
) -> runner.DiscoverySchedule:
    sources = (
        _scheduled_source(
            "jobspy:indeed",
            kind=SourceKind.BROAD_BOARD,
            adapter_config={"board": "indeed"},
        ),
        _scheduled_source(
            "greenhouse:barcelona",
            kind=SourceKind.ATS_API,
            adapter_config={"ats_kind": "greenhouse", "board_token": "barcelona"},
        ),
        _scheduled_source(
            "workday:acme",
            kind=SourceKind.ATS_API,
            adapter_config={"employer_key": "acme"},
        ),
        _scheduled_source(
            "smart_extract:example",
            kind=SourceKind.SMART_EXTRACT,
            adapter_config={"name": "Example", "url": "https://example.test/jobs"},
        ),
    )
    if source_ids:
        selected = set(source_ids)
        sources = tuple(source for source in sources if source.source_id in selected)
    return runner.DiscoverySchedule(sources)


@pytest.fixture(autouse=True)
def no_discovery_detail_enrichment(monkeypatch):
    """Keep discovery-source tests scoped to source scheduling."""
    monkeypatch.setattr(runner, "_plan_discovery_schedule", _standard_discovery_schedule)
    monkeypatch.setattr(
        runner,
        "run_scheduled_ats_sources",
        lambda *_args, **_kwargs: {
            "total": 0,
            "new_jobs": 0,
            "existing_jobs": 0,
            "observed_jobs": 0,
            "duplicate_jobs": 0,
        },
    )
    monkeypatch.setattr(
        runner,
        "_start_discovery_enrichment_worker",
        lambda *, workers, limit: (
            SimpleNamespace(set=lambda: None),
            {"status": "ok", "passes": 0, "pending": 0},
            SimpleNamespace(join=lambda: None),
        ),
    )
    monkeypatch.setattr(
        "jobhunter.pipeline.preparation.drain_discovery_preparation",
        lambda **_kwargs: {"status": "ok", "has_work": False},
    )


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


def test_tailor_stage_fails_pipeline_when_quality_gate_fails(monkeypatch):
    monkeypatch.setattr(
        "jobhunter.scoring.tailor.run_tailoring",
        lambda **_kwargs: {"approved": 0, "failed": 2, "errors": 0, "elapsed": 0.1},
    )

    with pytest.raises(runner.LlmTransientError, match="2 tailored resume"):
        runner._run_tailor()


def test_tailor_stage_errors_pipeline_when_tailoring_errors(monkeypatch):
    monkeypatch.setattr(
        "jobhunter.scoring.tailor.run_tailoring",
        lambda **_kwargs: {"approved": 0, "failed": 1, "errors": 1, "elapsed": 0.1},
    )

    with pytest.raises(runner.LlmTransientError, match="1 tailoring error"):
        runner._run_tailor()


def test_tailor_quality_gate_failure_propagates_through_pipeline(monkeypatch):
    monkeypatch.setattr(
        "jobhunter.scoring.tailor.run_tailoring",
        lambda **_kwargs: {"approved": 0, "failed": 1, "errors": 0, "elapsed": 0.1},
    )

    with pytest.raises(runner.LlmTransientError, match="failed validation"):
        runner._run_sequential(["tailor"], min_score=7)


def test_tailor_quality_gate_failure_propagates_through_streaming_pipeline(monkeypatch):
    monkeypatch.setattr(
        "jobhunter.scoring.tailor.run_tailoring",
        lambda **_kwargs: {"approved": 0, "failed": 1, "errors": 0, "elapsed": 0.1},
    )
    monkeypatch.setattr(runner, "_count_pending", lambda stage, min_score=7, retailor=False: 1)

    result = runner._run_streaming(["tailor"], min_score=7)

    assert result["stages"][0]["status"] == "failed"
    assert result["errors"] == {"tailor": "failed"}


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
    assert result["ats_api"] == "ok"
    source_events = [
        (event_type, payload.get("source"))
        for _, event_type, _, payload in events
        if payload.get("source")
    ]
    assert source_events == [
        ("StageStarted", "jobspy"),
        ("StageCompleted", "jobspy"),
        ("StageStarted", "ats_api"),
        ("StageCompleted", "ats_api"),
        ("StageStarted", "workday"),
        ("StageCompleted", "workday"),
        ("StageStarted", "smartextract"),
        ("StageCompleted", "smartextract"),
    ]


def test_discover_persists_jobspy_source_progress(monkeypatch):
    events: list[tuple[str, str, str, dict]] = []

    def run_jobspy(
        cfg=None,
        limit=0,
        run_id=None,
        progress_callback=None,
        cancel_event=None,
    ):
        assert run_id is not None
        assert progress_callback is not None
        progress_callback(
            {
                "completed": 35,
                "total": 72,
                "unit": "searches",
                "current_query": "Head of Platform",
                "current_location": "Spain (remote)",
                "new_jobs": 13,
                "existing_jobs": 46,
                "filtered_jobs": 412,
                "errors": 0,
                "raw_total": 1000,
                "message": "JobSpy search completed",
            }
        )
        return {"new": 13, "existing": 46, "errors": 0, "filtered": 412, "raw_total": 1000}

    monkeypatch.setattr(
        runner.config,
        "load_search_config",
        lambda: {
            "queries": [{"query": "Head of Platform"}],
            "locations": [{"label": "spain", "location": "Spain (remote)", "remote": True}],
            "defaults": {"results_per_site": 100},
        },
    )
    monkeypatch.setattr(
        runner,
        "_record_pipeline_event",
        lambda stage, event_type, level, message, payload=None: events.append(
            (stage, event_type, level, {**(payload or {}), "message": message})
        ),
        raising=False,
    )
    monkeypatch.setitem(sys.modules, "jobhunter.discovery.jobspy", SimpleNamespace(run_discovery=run_jobspy))
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

    result = runner._run_discover(workers=2, limit=1000)

    assert result["jobspy"] == "ok"
    progress_events = [
        payload for _stage, event_type, _level, payload in events if event_type == "StageProgress"
    ]
    assert progress_events
    progress = progress_events[0]["progress"]
    assert progress["percent"] > 0
    assert progress["sourceProgress"] == {
        "completed": 35,
        "total": 72,
        "unit": "searches",
        "current_query": "Head of Platform",
        "currentQuery": "Head of Platform",
        "current_location": "Spain (remote)",
        "currentLocation": "Spain (remote)",
        "new_jobs": 13,
        "newJobs": 13,
        "existing_jobs": 46,
        "existingJobs": 46,
        "filtered_jobs": 412,
        "filteredJobs": 412,
        "error_count": 0,
        "errorCount": 0,
        "raw_total": 1000,
        "rawTotal": 1000,
    }


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


def test_discover_runs_hygiene_before_and_after_sources(monkeypatch):
    calls: list[str] = []

    monkeypatch.setattr(runner.config, "load_search_config", lambda: {"disable_jobspy": True})
    monkeypatch.setattr(
        runner,
        "retire_invalid_source_jobs",
        lambda _conn, *, search_cfg, run_id="discovery:hygiene": calls.append(run_id)
        or {"retired_jobs": 0, "jobs": []},
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)
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

    runner._run_discover(workers=2)

    assert calls == ["discovery:hygiene:before", "discovery:hygiene:after"]


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

    assert result == {"jobspy": "ok", "ats_api": "ok", "workday": "ok", "smartextract": "ok", "enrichment": "ok"}
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

    assert result == {"jobspy": "ok", "ats_api": "ok", "workday": "ok", "smartextract": "ok", "enrichment": "ok"}
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
        lambda _limit, **_kwargs: runner.DiscoverySchedule(
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


def test_discover_source_ids_run_only_selected_source_group(monkeypatch):
    calls: list[tuple[str, list[str], int]] = []

    monkeypatch.setattr(runner.config, "load_search_config", lambda: {})
    monkeypatch.setattr(
        runner.config,
        "load_employers_config",
        lambda: {"employers": {"acme": {"name": "Acme"}}},
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.jobspy",
        SimpleNamespace(run_discovery=lambda **_kwargs: pytest.fail("JobSpy should not run")),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(
            run_workday_discovery=lambda employers=None, workers=1, limit=0, run_id=None: calls.append(
                ("workday", sorted((employers or {}).keys()), workers)
            )
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(run_smart_extract=lambda **_kwargs: pytest.fail("Smart extract should not run")),
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)

    result = runner._run_discover(workers=4, limit=10, source_ids=("workday:acme",))

    assert calls == [("workday", ["acme"], 4)]
    assert result["jobspy"] is None
    assert result["workday"] == "ok"
    assert result["smartextract"] is None
    assert result["enrichment"] == "ok"


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
    assert result == {
        "jobspy": "ok",
        "ats_api": "skipped_limit",
        "workday": "skipped_limit",
        "smartextract": "skipped_limit",
        "enrichment": "ok",
    }


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
    assert result == {"jobspy": "ok", "ats_api": "ok", "workday": "ok", "smartextract": "ok", "enrichment": "ok"}


def test_discovery_detail_enrichment_uses_same_worker_count(monkeypatch):
    calls: list[dict[str, int]] = []
    pending_counts = iter([1, 0, 0])
    done = runner.threading.Event()
    done.set()
    result: dict = {}

    monkeypatch.setattr(runner, "_count_pending", lambda stage, min_score=7, retailor=False: next(pending_counts))
    monkeypatch.setattr(
        runner,
        "_run_enrich",
        lambda workers=1, limit=0: calls.append({"workers": workers, "limit": limit}) or {"status": "ok"},
    )

    runner._run_discovery_enrichment_until_idle(done, result, workers=4, limit=10)

    assert calls == [{"workers": 4, "limit": 10}]
    assert result == {"status": "ok", "passes": 1, "pending": 0}


def test_discover_status_fails_when_internal_enrichment_fails():
    status = runner._stage_status(
        "discover",
        {
            "jobspy": "ok",
            "workday": "ok",
            "smartextract": "ok",
            "enrichment": "error: timeout",
        },
    )

    assert status == "error: timeout"


def test_sequential_pipeline_blocks_score_after_discovery_enrichment_failure(monkeypatch):
    calls: list[str] = []

    monkeypatch.setitem(
        runner._STAGE_RUNNERS,
        "discover",
        lambda **_kwargs: calls.append("discover") or {"enrichment": "error: timeout"},
    )
    monkeypatch.setitem(
        runner._STAGE_RUNNERS,
        "score",
        lambda **_kwargs: calls.append("score") or {"status": "ok"},
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)

    result = runner._run_sequential(["discover", "score"], min_score=7)

    assert calls == ["discover"]
    assert result["stages"] == [
        {"stage": "discover", "status": "error: timeout", "elapsed": result["stages"][0]["elapsed"]},
        {"stage": "score", "status": "blocked: upstream discover failed", "elapsed": 0.0},
    ]
    assert result["errors"] == {
        "discover": "error: timeout",
        "score": "blocked: upstream discover failed",
    }


def test_streaming_stage_blocks_on_failed_upstream(monkeypatch):
    tracker = runner._StageTracker()
    stop_event = runner.threading.Event()
    tracker.mark_done("discover", {"status": "error: timeout"})

    monkeypatch.setattr(runner, "_count_pending", lambda stage, min_score=7, retailor=False: 1)
    monkeypatch.setitem(
        runner._STAGE_RUNNERS,
        "score",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("score should not run")),
    )

    runner._run_stage_streaming("score", tracker, stop_event)

    assert tracker.get_results()["score"]["status"] == "blocked: upstream discover failed"
    assert tracker.get_results()["score"]["blocked_by"] == "discover"


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
    discover_kwargs = runner._build_stage_kwargs("discover", workers=2, limit=1)
    assert discover_kwargs == {
        "workers": 2,
        "limit": 1,
        "min_score": 7,
        "validation_mode": "normal",
        "llm_model": runner.DEFAULT_PIPELINE_LLM_MODEL_SPEC,
        "tailor_models": (),
        "tailor_judge_model": None,
        "tailor_judge_min_score": None,
    }
    assert runner._build_stage_kwargs("enrich", workers=2, limit=1) == {"workers": 2, "limit": 1}
