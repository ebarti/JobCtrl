"""Literal saved Remote rows through the durable plan and synthetic boards."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
import asyncio
import json
from uuid import uuid4

import pytest
from jobstreaming import AdapterCapabilities, AdapterRegistry, JobResponse, Scraper, Site
from jobstreaming.glassdoor import Glassdoor
from jobstreaming.indeed import Indeed
from jobstreaming.ziprecruiter import add_params as zip_search_params
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.testing import ActivityEnvironment
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl import config, database
from jobctrl.discovery import jobspy
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.search_units import DiscoverySearchSpec
from jobctrl.discovery.activities import (
    DiscoverySourceActivityInput,
    DiscoverySourceActivityOutput,
    PlanDiscoverySourcesInput,
    PlanDiscoverySourcesOutput,
)
from jobctrl.infrastructure.discovery.jobstreaming_gateway import (
    JobStreamingGateway,
    JobStreamingSearchSpec,
    RemoteSearchConfigurationError,
)
from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import SqliteDiscoverySearchUnitRepository
from jobctrl.infrastructure.temporal.finalize import WorkflowOutcomeInput
from jobctrl.pipeline import runner


class _SyntheticBoard(Scraper):
    capabilities = AdapterCapabilities(filters=frozenset({"location", "is_remote", "hours_old"}))
    calls = []

    def __init__(self, site, **_kwargs):
        super().__init__(site)

    def scrape(self, request, context=None):
        self.calls.append((self.site.value, request.search_term, request.location, request.is_remote, request.hours_old))
        return JobResponse()


class _SyntheticIndeed(Indeed):
    calls = _SyntheticBoard.calls

    def __init__(self, **_kwargs):
        # Keep the real adapter type/capabilities without constructing a transport.
        Scraper.__init__(self, Site.INDEED)

    def scrape(self, request, context=None):
        self.calls.append((self.site.value, request.search_term, request.location, request.is_remote, request.hours_old))
        return JobResponse()


class _SyntheticGlassdoor(Glassdoor):
    calls = _SyntheticBoard.calls

    def __init__(self, **_kwargs):
        Scraper.__init__(self, Site.GLASSDOOR)

    def scrape(self, request, context=None):
        self.calls.append((self.site.value, request.search_term, request.location, request.is_remote, request.hours_old))
        return JobResponse()


class _UnsupportedRemote(_SyntheticBoard):
    capabilities = AdapterCapabilities(filters=frozenset({"location", "hours_old"}))


def _registry():
    registry = AdapterRegistry()
    registry.register(Site.INDEED, _SyntheticIndeed)
    registry.register(Site.GLASSDOOR, _SyntheticGlassdoor)
    registry.register(Site.LINKEDIN, lambda **kwargs: _SyntheticBoard(Site.LINKEDIN, **kwargs))
    registry.register(Site.ZIP_RECRUITER, lambda **kwargs: _SyntheticBoard(Site.ZIP_RECRUITER, **kwargs))
    registry.register(Site.GOOGLE, lambda **kwargs: _UnsupportedRemote(Site.GOOGLE, **kwargs))
    return registry


def _spec(**changes):
    return replace(DiscoverySearchSpec(
        query="Synthetic engineer", provider_location="Madrid", target_location="Madrid",
        sites=("linkedin",), results_per_site=5, hours_old=72, remote_only=False,
        country_indeed="usa",
    ), **changes)


def test_location_free_remote_plan_round_trips_without_changing_nonempty_identity():
    original = _spec()
    remote = _spec(provider_location="", target_location="", remote_only=True)
    assert DiscoverySearchSpec.from_json(remote.to_json()) == remote
    assert remote.to_payload()["schema_version"] == 2
    assert remote.fingerprint() == DiscoverySearchSpec.from_json(remote.to_json()).fingerprint()
    assert original.fingerprint() == "63be012c5871923aaad636770a7e5dda1a960482c91993683f7e08f9512e13db"
    request = JobStreamingGateway.build_request(jobspy._jobstreaming_spec(remote))
    assert request.location is None
    assert request.is_remote is True
    assert request.hours_old == 72


@pytest.mark.parametrize("provider,target,remote", [
    ("", "", False), ("", "Madrid", True), ("Madrid", "", True), ("  ", "  ", True),
])
def test_location_absence_never_invents_or_broadens_a_nonremote_place(provider, target, remote):
    with pytest.raises(ValueError):
        _spec(provider_location=provider, target_location=target, remote_only=remote)


@pytest.mark.parametrize("site,location,hours,expected", [
    ("linkedin", "", 72, None),
    ("zip_recruiter", "", 72, None),
    ("glassdoor", "", 72, None),
    ("indeed", "", 72, "UnsupportedRemoteSearch"),
    ("indeed", "Madrid", 72, "UnsupportedRemoteSearch"),
    ("indeed", "", None, None),
    ("glassdoor", "Madrid", 72, "UnsupportedRemoteSearch"),
    ("glassdoor", "", 25, "UnsupportedRemoteSearch"),
    ("zip_recruiter", "", 25, "UnsupportedRemoteSearch"),
    ("google", "", 72, "UnsupportedRemoteSearch"),
])
def test_provider_scope_is_preserved_or_fails_before_the_provider_request(site, location, hours, expected):
    _SyntheticBoard.calls.clear()
    spec = JobStreamingSearchSpec(sites=(site,), query="Synthetic engineer", location=location,
                                  results_per_site=5, hours_old=hours, remote_only=True)
    if expected and site in {"indeed", "glassdoor", "zip_recruiter"}:
        with pytest.raises(RemoteSearchConfigurationError) as excinfo:
            JobStreamingGateway().collect(spec, registry=_registry(), max_retries=0)
        assert excinfo.value.code == "unsupported_remote_search"
        assert _SyntheticBoard.calls == []
        return
    result = JobStreamingGateway().collect(spec, registry=_registry(), max_retries=0)
    if expected:
        assert [(failure.site, failure.code, failure.error_type, failure.retryable) for failure in result.failures] == [
            (site, "invalid_request", expected, False),
        ]
        assert _SyntheticBoard.calls == []
        assert result.completed is False
    else:
        assert result.failures == ()
        assert result.completed is True
        assert _SyntheticBoard.calls == [(site, "Synthetic engineer", location or None, True, hours)]


@pytest.mark.parametrize("site", ["glassdoor", "zip_recruiter"])
def test_nonremote_search_keeps_existing_nonday_lookback_behavior(site):
    _SyntheticBoard.calls.clear()
    spec = JobStreamingSearchSpec(sites=(site,), query="Synthetic engineer", location="Madrid",
                                  results_per_site=5, hours_old=25, remote_only=False)
    result = JobStreamingGateway().collect(spec, registry=_registry(), max_retries=0)
    assert result.completed is True and result.failures == ()
    assert _SyntheticBoard.calls == [(site, "Synthetic engineer", "Madrid", False, 25)]


def test_pinned_provider_builders_explain_the_preflight_boundaries():
    request = JobStreamingGateway.build_request(JobStreamingSearchSpec(
        sites=("indeed",), query="Synthetic engineer", location="", results_per_site=5,
        hours_old=72, remote_only=True,
    ))
    indeed = object.__new__(Indeed)
    indeed.scraper_input = request
    filters = indeed._build_filters()
    assert "dateOnIndeed" in filters
    assert "DSQF7" not in filters  # the Remote keyword is dropped by the SDK
    assert zip_search_params(request)["remote"] == 1
    assert "location" not in zip_search_params(request)
    assert zip_search_params(request)["days"] == 3


def test_mixed_legacy_crawl_rejects_before_either_board_starts(monkeypatch):
    _SyntheticBoard.calls.clear()
    registry = _registry()

    def run(options, **_kwargs):
        spec = JobStreamingSearchSpec.from_legacy_options(options)
        return JobStreamingGateway().collect(spec, registry=registry, max_retries=0)

    monkeypatch.setattr(jobspy, "_scrape_with_retry", run)
    cfg = {"queries": [{"query": "Synthetic engineer"}], "locations": [{"location": "", "remote": True}],
           "boards": ["indeed", "linkedin"], "defaults": {"hours_old": 72}}
    with pytest.raises(RemoteSearchConfigurationError, match="Indeed.*Remote.*lookback"):
        jobspy.run_discovery(cfg=cfg)
    assert _SyntheticBoard.calls == []


@pytest.mark.parametrize("board,hours,remote_location", [
    ("indeed", 72, ""),
    ("glassdoor", 72, "London"),
    ("zip_recruiter", 25, ""),
])
def test_unsupported_later_row_rejects_the_entire_crawl_before_the_first_row(
    monkeypatch, board, hours, remote_location,
):
    cfg = {
        "queries": [{"query": "Synthetic engineer"}],
        "locations": [
            {"location": "Madrid", "remote": False},
            {"location": remote_location, "remote": True},
        ],
        "boards": ["linkedin", board],
        "defaults": {"hours_old": hours},
    }
    monkeypatch.setattr(jobspy, "_scrape_with_retry", lambda *_a, **_k: pytest.fail("provider started"))
    with pytest.raises(RemoteSearchConfigurationError):
        jobspy.run_discovery(cfg=cfg)


@pytest.mark.parametrize("board,place,hours,reason", [
    ("indeed", "", 72, "lookback"),
    ("glassdoor", "Madrid", 72, "location"),
    ("glassdoor", "", 25, "whole days"),
    ("zip_recruiter", "", 25, "whole days"),
])
def test_actual_source_plans_then_rejects_only_the_unsupported_board(
    tmp_path, monkeypatch, board, place, hours, reason,
):
    from jobctrl.discovery.activities import PlanDiscoverySourcesInput, plan_discovery_sources

    db_path = tmp_path / "jobctrl.db"
    conn = database.init_db(db_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr(config, "load_sites_config", lambda: {})
    monkeypatch.setattr(config, "load_employers_config", lambda: {})
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *_a, **_k: _registry()
    )
    settings = {"boards": ["linkedin", board], "defaults": {"hours_old": hours}}
    conn.execute(
        "INSERT INTO discovery_settings (tenant_id, search_config_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ("local", json.dumps(settings), "2026-01-01", "2026-01-01"),
    )
    conn.execute(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, version, experience_target_role, "
        "experience_target_locations, experience_target_work_models, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("local", "default", 1, "Synthetic engineer", place, "remote", "2026-01-01"),
    )
    conn.commit()
    _SyntheticBoard.calls.clear()
    try:
        execution = DiscoveryExecutionRef("local", f"owned-{board}-{hours}", "owned-run")
        plan = ActivityEnvironment().run(
            plan_discovery_sources, PlanDiscoverySourcesInput(tenant_id="local", discovery_execution=execution),
        )
        assert "jobspy" in plan.families
        assert _SyntheticBoard.calls == []
        assert conn.execute("SELECT count(*) FROM discovery_search_units").fetchone()[0] == 0
        with pytest.raises(RemoteSearchConfigurationError) as excinfo:
            runner.run_discovery_source_family(
                "jobspy", discovery_execution=execution, next_run_settings=plan.next_run_settings,
                activity_attempt=1, activity_owner_token="owned-1",
            )
        assert reason in str(excinfo.value).lower()
        assert [call[0] for call in _SyntheticBoard.calls] == ["linkedin"]
        units = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)
        assert {unit.spec.sites[0]: unit.state for unit in units} == {"linkedin": "completed", board: "failed"}
        # An explicit supported-board selection still plans normally.
        plan = ActivityEnvironment().run(
            plan_discovery_sources, PlanDiscoverySourcesInput(tenant_id="local", source_ids=("jobspy:linkedin",)),
        )
        assert "jobspy" in plan.families
    finally:
        database.close_connection(db_path)


@pytest.mark.asyncio
async def test_first_use_workflow_runs_healthy_boards_and_reports_unsupported_remote(tmp_path, monkeypatch):
    from jobctrl.discovery.activities import discovery_source_family_activity, plan_discovery_sources
    from jobctrl.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
    from jobctrl.infrastructure.temporal import run_in_activity
    from tests.temporal_env import local_env
    from tests.test_workflow_discovery import (
        _automatic_compensation_refresh, _cancel_enrichment_cohort, _check_spend_budget,
        _discovery_enrichment, _discovery_preparation_fanout, _record_workflow_started, _reset_state,
    )

    db_path = tmp_path / "jobctrl.db"
    conn = database.init_db(db_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr(config, "load_sites_config", lambda: {})
    monkeypatch.setattr(config, "load_employers_config", lambda: {})
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    monkeypatch.setattr("jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime", lambda **_k: None)
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *_a, **_k: _registry()
    )
    _reset_state()
    outcomes = []

    @activity.defn(name="discovery_source_family")
    async def source(payload: DiscoverySourceActivityInput) -> DiscoverySourceActivityOutput:
        if payload.family == "jobspy":
            return await discovery_source_family_activity(payload)
        return DiscoverySourceActivityOutput(family=payload.family, status="skipped")

    @activity.defn(name="record_workflow_outcome")
    async def outcome(payload: WorkflowOutcomeInput) -> None:
        outcomes.append(payload)

    _SyntheticBoard.calls.clear()
    queue = f"owned-first-use-remote-{uuid4()}"
    previous = run_in_activity._activity_executor()
    pool = run_in_activity.ActivityThreadPoolExecutor(max_workers=4)
    run_in_activity.set_activity_executor(pool)
    try:
        async with local_env() as env:
            async with Worker(
                env.client, task_queue=queue, workflows=[DiscoverWorkflow],
                activities=[_check_spend_budget, _record_workflow_started, outcome, plan_discovery_sources, source,
                            _cancel_enrichment_cohort, _discovery_enrichment,
                            _discovery_preparation_fanout, _automatic_compensation_refresh],
                activity_executor=pool, workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    DiscoverWorkflow.run, DiscoverWorkflowInput(tenant_id="local"), id=queue, task_queue=queue,
                )
                with pytest.raises(WorkflowFailureError) as failure:
                    await asyncio.wait_for(handle.result(), 60)
                history = await handle.fetch_history()
        assert failure.value.cause.type == "unsupported_remote_search"
        assert outcomes[-1].status == "failed"
        assert outcomes[-1].error_code == "unsupported_remote_search"
        assert {call[0] for call in _SyntheticBoard.calls} == {"linkedin", "zip_recruiter"}
        assert all(call[2:] == ("Remote", True, 72) for call in _SyntheticBoard.calls)
        assert conn.execute("SELECT count(*) FROM discovery_settings").fetchone()[0] == 0
        units = conn.execute("SELECT state, last_error_code FROM discovery_search_units").fetchall()
        assert sorted(tuple(row) for row in units) == [
            ("completed", None), ("completed", None), ("failed", "indeed:unsupported_remote_search"),
        ]
        scheduled = [
            event.activity_task_scheduled_event_attributes.activity_type.name
            for event in history.events if event.HasField("activity_task_scheduled_event_attributes")
        ]
        assert "plan_discovery_sources" in scheduled
        assert "discovery_source_family" in scheduled
        await Replayer(workflows=[DiscoverWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
    finally:
        run_in_activity.shutdown_activity_executors()
        pool.shutdown(wait=True)
        run_in_activity.set_activity_executor(previous)
        database.close_connection(db_path)


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy_patch", [False, True])
async def test_recorded_old_plan_keeps_healthy_results_and_replays(tmp_path, monkeypatch, legacy_patch):
    from jobctrl.discovery import workflow as workflow_module
    from jobctrl.discovery.activities import discovery_source_family_activity
    from jobctrl.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
    from jobctrl.infrastructure.temporal import run_in_activity
    from tests.temporal_env import local_env
    from tests.test_discover_reliability import _seed_pending
    from tests.test_workflow_discovery import (
        _EVENTS, _automatic_compensation_refresh, _cancel_enrichment_cohort, _check_spend_budget,
        _discovery_enrichment, _discovery_preparation_fanout, _record_workflow_started, _reset_state,
    )

    db_path = tmp_path / "jobctrl.db"
    conn = database.init_db(db_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr(config, "load_sites_config", lambda: {})
    monkeypatch.setattr(config, "load_employers_config", lambda: {})
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    monkeypatch.setattr("jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime", lambda **_k: None)
    monkeypatch.setattr("jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *_a, **_k: _registry())
    conn.execute(
        "INSERT INTO discovery_settings (tenant_id, search_config_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ("local", json.dumps({"boards": ["linkedin", "indeed"], "defaults": {"hours_old": 72}}),
         "2026-01-01", "2026-01-01"),
    )
    conn.execute(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, version, experience_target_role, "
        "experience_target_locations, experience_target_work_models, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("local", "default", 1, "Synthetic engineer", "", "remote", "2026-01-01"),
    )
    conn.commit()
    _reset_state()
    _SyntheticBoard.calls.clear()
    outcomes = []
    sources = []

    @activity.defn(name="plan_discovery_sources")
    async def recorded_plan(_payload: PlanDiscoverySourcesInput) -> PlanDiscoverySourcesOutput:
        # An older recorded plan included both families.
        return PlanDiscoverySourcesOutput(families=["jobspy", "ats_api"], progress_total=4, start_count=0)

    @activity.defn(name="discovery_source_family")
    async def source(payload: DiscoverySourceActivityInput) -> DiscoverySourceActivityOutput:
        sources.append(payload.family)
        if payload.family == "jobspy":
            return await discovery_source_family_activity(payload)
        _seed_pending(conn, "https://example.test/healthy-synthetic-job", "ats_api")
        return DiscoverySourceActivityOutput(family="ats_api", status="ok", result={"new": 1})

    @activity.defn(name="record_workflow_outcome")
    async def outcome(payload: WorkflowOutcomeInput) -> None:
        outcomes.append(payload)

    original_patched = workflow_module.workflow.patched
    if legacy_patch:
        def historical_branch(patch_id):
            if patch_id == workflow_module._UNSUPPORTED_REMOTE_FAILURE_PATCH:
                return False
            return original_patched(patch_id)
        monkeypatch.setattr(workflow_module.workflow, "patched", historical_branch)

    previous = run_in_activity._activity_executor()
    pool = run_in_activity.ActivityThreadPoolExecutor(max_workers=4)
    run_in_activity.set_activity_executor(pool)
    queue = f"owned-old-remote-plan-{uuid4()}"
    try:
        async with local_env() as env:
            async with Worker(
                env.client, task_queue=queue, workflows=[DiscoverWorkflow],
                activities=[_check_spend_budget, _record_workflow_started, outcome, recorded_plan, source,
                            _cancel_enrichment_cohort, _discovery_enrichment,
                            _discovery_preparation_fanout, _automatic_compensation_refresh],
                activity_executor=pool, workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    DiscoverWorkflow.run, DiscoverWorkflowInput(tenant_id="local"), id=queue, task_queue=queue,
                )
                if legacy_patch:
                    result = await asyncio.wait_for(handle.result(), 60)
                    assert result.families_completed == ["ats_api"]
                    assert result.families_failed == ["jobspy"]
                else:
                    with pytest.raises(WorkflowFailureError) as failure:
                        await asyncio.wait_for(handle.result(), 60)
                    assert failure.value.cause.type == "unsupported_remote_search"
                    assert outcomes[-1].status == "failed"
                    assert outcomes[-1].error_code == "unsupported_remote_search"
                history = await handle.fetch_history()
        assert sources == ["jobspy", "ats_api"]
        assert [call[0] for call in _SyntheticBoard.calls] == ["linkedin"]
        assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
        assert any(event[0] == "enrichment" and event[2] is False for event in _EVENTS)
        assert sum(event[0] == "fanout" for event in _EVENTS) >= 2
        monkeypatch.setattr(workflow_module.workflow, "patched", original_patched)
        await Replayer(workflows=[DiscoverWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
        assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    finally:
        run_in_activity.shutdown_activity_executors()
        pool.shutdown(wait=True)
        run_in_activity.set_activity_executor(previous)
        database.close_connection(db_path)


class _NoopLimiter:
    @contextmanager
    def slot(self, *_args, **_kwargs):
        yield


def test_saved_profile_rows_create_distinct_durable_units_for_supported_boards(tmp_path, monkeypatch):
    db_path = tmp_path / "jobctrl.db"
    conn = database.init_db(db_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr(jobspy, "init_db", lambda: conn)
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    settings = {"boards": ["linkedin", "zip_recruiter"], "defaults": {
        "results_per_site": 5, "hours_old": 72, "country_indeed": "usa",
    }}
    conn.execute(
        "INSERT INTO discovery_settings (tenant_id, search_config_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ("local", json.dumps(settings), "2026-01-01", "2026-01-01"),
    )
    conn.execute(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, version, experience_target_role, "
        "experience_target_locations, experience_target_work_models, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("local", "default", 1, "Synthetic engineer", "; Madrid; London", "remote; onsite; remote", "2026-01-01"),
    )
    conn.commit()
    try:
        saved = config.load_search_config()
        assert [(row["location"], row["remote"]) for row in saved["locations"]] == [
            ("", True), ("Madrid", False), ("London", True),
        ]
        execution = DiscoveryExecutionRef("local", "synthetic-remote-workflow", "synthetic-remote-run")
        _SyntheticBoard.calls.clear()
        result = jobspy.run_discovery(cfg=saved, discovery_execution=execution, activity_attempt=1,
                                      activity_owner_token="synthetic-owner", adapter_registry=_registry())
        units = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)
        assert len(units) == 6
        assert len({unit.unit_id for unit in units}) == 6
        assert [(unit.spec.target_location, unit.spec.remote_only) for unit in units[::2]] == [
            ("", True), ("Madrid", False), ("London", True),
        ]
        assert all(unit.state == "completed" for unit in units)
        assert result["failed_queries"] == 0
        assert result["failed_source_ids"] == []
        assert ("linkedin", "Synthetic engineer", None, True, 72) in _SyntheticBoard.calls
        assert ("linkedin", "Synthetic engineer", "Madrid", False, 72) in _SyntheticBoard.calls
        assert ("linkedin", "Synthetic engineer", "London", True, 72) in _SyntheticBoard.calls
        assert ("zip_recruiter", "Synthetic engineer", None, True, 72) in _SyntheticBoard.calls
        original_units = [(unit.unit_id, unit.spec.to_json(), unit.state) for unit in units]
        original_calls = list(_SyntheticBoard.calls)
        jobspy.run_discovery(cfg=saved, discovery_execution=execution, activity_attempt=2,
                             activity_owner_token="synthetic-retry", adapter_registry=_registry())
        replayed = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)
        assert [(unit.unit_id, unit.spec.to_json(), unit.state) for unit in replayed] == original_units
        assert _SyntheticBoard.calls == original_calls
    finally:
        database.close_connection(db_path)
