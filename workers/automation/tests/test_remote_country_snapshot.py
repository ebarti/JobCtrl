"""Freeze the board country before a location-free Remote crawl starts."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import replace
import json
from uuid import uuid4

import pytest
from jobstreaming import AdapterRegistry, JobResponse, Scraper, Site
from jobstreaming.glassdoor import Glassdoor
from temporalio import activity
from temporalio.testing import ActivityEnvironment
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl import config, database
from jobctrl.discovery import jobspy
from jobctrl.discovery.activities import (
    PlanDiscoverySourcesInput,
    PlanDiscoverySourcesOutput,
    discovery_source_family_activity,
    plan_discovery_sources,
)
from jobctrl.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import SqliteDiscoverySearchUnitRepository
from jobctrl.infrastructure.temporal import run_in_activity
from jobctrl.pipeline import runner
from jobctrl.wizard import init as wizard
from tests.temporal_env import local_env
from tests.test_workflow_discovery import (
    _automatic_compensation_refresh,
    _cancel_enrichment_cohort,
    _check_spend_budget,
    _discovery_enrichment,
    _discovery_preparation_fanout,
    _record_workflow_outcome,
    _record_workflow_started,
)


class _Glassdoor(Glassdoor):
    calls = []

    def __init__(self, **_kwargs):
        Scraper.__init__(self, Site.GLASSDOOR)

    def scrape(self, request, context=None):
        self.calls.append((request.country.name, request.location, request.is_remote, request.hours_old))
        return JobResponse()


class _NoopLimiter:
    @contextmanager
    def slot(self, *_args, **_kwargs):
        yield


def _registry():
    registry = AdapterRegistry()
    registry.register(Site.GLASSDOOR, _Glassdoor)
    return registry


@pytest.fixture
def owned(tmp_path, monkeypatch):
    db_path = tmp_path / "owned.db"
    conn = database.init_db(db_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr(wizard, "DB_PATH", db_path)
    monkeypatch.setattr(config, "load_sites_config", lambda: {})
    monkeypatch.setattr(config, "load_employers_config", lambda: {})
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    monkeypatch.setattr("jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime", lambda **_kwargs: None)
    monkeypatch.setattr("jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *_a, **_k: _registry())
    conn.execute(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, version, experience_target_role, "
        "experience_target_locations, experience_target_work_models, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("local", "default", 1, "Synthetic engineer", "", "remote", "2026-01-01"),
    )
    conn.commit()
    _Glassdoor.calls.clear()
    yield db_path, conn
    database.close_connection(db_path)


def _save_settings(conn, settings):
    conn.execute(
        "INSERT INTO discovery_settings (tenant_id, search_config_json, created_at, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(tenant_id) DO UPDATE SET search_config_json = excluded.search_config_json",
        ("local", json.dumps(settings), "2026-01-01", "2026-01-01"),
    )
    conn.commit()


def _run_saved_plan(conn, plan, run_id):
    effective = runner._apply_discovery_next_run_settings(config.load_search_config(), plan.next_run_settings)
    execution = DiscoveryExecutionRef("local", "owned-country", run_id)
    result = jobspy.run_discovery(
        cfg=effective, discovery_execution=execution, activity_attempt=1,
        activity_owner_token="owned-country-1", adapter_registry=_registry(),
    )
    assert result["errors"] == 0
    units = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)
    assert len(units) == 1 and units[0].state == "completed"
    return effective, execution, units[0]


@pytest.mark.parametrize("settings,expected", [
    ({"country": "canada", "defaults": {"country_indeed": "usa"}}, "usa"),
    ({"country": "canada", "defaults": {}}, "canada"),
    ({"defaults": {}}, "usa"),
])
def test_new_plan_freezes_resolved_country_across_settings_change(owned, settings, expected):
    _, conn = owned
    settings = {**settings, "boards": ["glassdoor"]}
    _save_settings(conn, settings)
    plan = ActivityEnvironment().run(plan_discovery_sources, PlanDiscoverySourcesInput(tenant_id="local"))
    assert plan.next_run_settings["country_indeed"] == expected
    changed_country = "canada" if expected == "usa" else "usa"
    _save_settings(conn, {"boards": ["glassdoor"], "country": changed_country,
                          "defaults": {"country_indeed": changed_country}})
    effective, execution, unit = _run_saved_plan(conn, plan, f"owned-{uuid4()}")
    assert effective["defaults"]["country_indeed"] == expected
    assert unit.spec.country_indeed == expected
    assert _Glassdoor.calls == [(expected.upper(), None, True, 72)]
    before = [(unit.unit_id, unit.spec.to_json(), unit.state)]
    next_country = "spain"
    _save_settings(conn, {"boards": ["glassdoor"], "defaults": {"country_indeed": next_country}})
    effective = runner._apply_discovery_next_run_settings(config.load_search_config(), plan.next_run_settings)
    assert effective["defaults"]["country_indeed"] == expected
    jobspy.run_discovery(
        cfg=effective, discovery_execution=execution, activity_attempt=2,
        activity_owner_token="owned-country-2", adapter_registry=_registry(),
    )
    replayed = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)
    assert [(unit.unit_id, unit.spec.to_json(), unit.state) for unit in replayed] == before
    assert _Glassdoor.calls == [(expected.upper(), None, True, 72)]


def test_actual_wizard_preserves_board_and_country_and_recorded_plan(owned, monkeypatch):
    _, conn = owned
    _save_settings(conn, {"boards": ["glassdoor"], "defaults": {"country_indeed": "canada"}})
    plan = ActivityEnvironment().run(plan_discovery_sources, PlanDiscoverySourcesInput(tenant_id="local"))
    answers = iter(["Remote", "0", "Synthetic engineer"])
    monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(answers))
    wizard._setup_searches()
    saved = json.loads(conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0])
    assert saved["boards"] == ["glassdoor"]
    assert saved["defaults"]["country_indeed"] == "canada"
    effective, _, unit = _run_saved_plan(conn, plan, f"owned-wizard-{uuid4()}")
    assert effective["defaults"]["country_indeed"] == "canada"
    assert unit.spec.country_indeed == "canada"
    assert _Glassdoor.calls == [("CANADA", None, True, 72)]


@pytest.mark.parametrize("current,expected", [
    ({"country": "usa", "defaults": {"country_indeed": "canada"}}, "canada"),
    ({"country": "canada", "defaults": {}}, "canada"),
    ({"defaults": {}}, "usa"),
])
def test_old_snapshot_without_country_retains_existing_live_fallback(current, expected):
    legacy = {"boards": ["glassdoor"], "hours_old": 72, "results_per_site": 5}
    effective = runner._apply_discovery_next_run_settings(current, legacy)
    specs = jobspy._durable_search_specs(
        {**effective, "queries": [{"query": "Synthetic engineer"}],
         "locations": [{"location": "", "remote": True}]},
        tiers=None, locations=None, sites=["glassdoor"], results_per_site=5, hours_old=72,
    )
    assert specs[0].country_indeed == expected
    assert "country_indeed" not in legacy


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy_snapshot", [False, True])
async def test_temporal_plan_country_survives_wizard_and_replays(owned, monkeypatch, legacy_snapshot):
    _, conn = owned
    _save_settings(conn, {"boards": ["glassdoor"], "defaults": {"country_indeed": "canada"}})
    answers = iter(["Remote", "0", "Synthetic engineer"])
    monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(answers))

    @activity.defn(name="plan_discovery_sources")
    def plan_then_wizard(payload: PlanDiscoverySourcesInput) -> PlanDiscoverySourcesOutput:
        result = plan_discovery_sources(payload)
        assert result.next_run_settings["country_indeed"] == "canada"
        if legacy_snapshot:
            snapshot = dict(result.next_run_settings)
            snapshot.pop("country_indeed", None)
            result = replace(result, next_run_settings=snapshot)
        wizard._setup_searches()
        # A supported settings change still exercises the old-snapshot live
        # fallback versus the new snapshot's frozen country.
        config._save_discovery_search_config_to_db({"boards": ["glassdoor"], "defaults": {}})
        return result

    previous = run_in_activity._activity_executor()
    pool = run_in_activity.ActivityThreadPoolExecutor(max_workers=4)
    run_in_activity.set_activity_executor(pool)
    queue = f"owned-country-{uuid4()}"
    try:
        async with local_env() as env:
            async with Worker(
                env.client, task_queue=queue, workflows=[DiscoverWorkflow],
                activities=[_check_spend_budget, _record_workflow_started, _record_workflow_outcome,
                            _cancel_enrichment_cohort, plan_then_wizard, discovery_source_family_activity,
                            _discovery_enrichment, _discovery_preparation_fanout, _automatic_compensation_refresh],
                activity_executor=pool, workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    DiscoverWorkflow.run,
                    DiscoverWorkflowInput(tenant_id="local", source_ids=("jobspy:glassdoor",)),
                    id=queue, task_queue=queue,
                )
                result = await asyncio.wait_for(handle.result(), 60)
                history = await handle.fetch_history()
        expected = "usa" if legacy_snapshot else "canada"
        assert result.families_completed == ["jobspy"] and result.families_failed == []
        current_settings = json.loads(conn.execute(
            "SELECT search_config_json FROM discovery_settings WHERE tenant_id = 'local'",
        ).fetchone()[0])
        assert "country_indeed" not in current_settings["defaults"]
        assert _Glassdoor.calls == [(expected.upper(), None, True, 72)]
        execution = DiscoveryExecutionRef("local", queue, handle.first_execution_run_id)
        units = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)
        assert len(units) == 1 and units[0].spec.country_indeed == expected
        await Replayer(workflows=[DiscoverWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
        assert _Glassdoor.calls == [(expected.upper(), None, True, 72)]
    finally:
        run_in_activity.shutdown_activity_executors()
        pool.shutdown(wait=True)
        run_in_activity.set_activity_executor(previous)
