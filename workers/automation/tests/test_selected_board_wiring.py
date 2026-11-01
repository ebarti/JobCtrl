"""Selected retained boards must reach provider units independently of defaults."""

from __future__ import annotations

from dataclasses import replace

import pytest

from jobctrl import config, database
from jobctrl.discovery import jobspy
from jobctrl.database import close_connection, init_db
from jobctrl.discovery.jobspy import _durable_search_specs
from jobctrl.domain.errors import ConfigurationError
from jobctrl.pipeline import runner


@pytest.fixture
def retained_board_registry(tmp_path, monkeypatch):
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr(config, "load_sites_config", lambda: {})
    monkeypatch.setattr(config, "load_employers_config", lambda: {})

    def seed(source_id, *, state="experimental", owner="system", seed_url=None):
        conn.execute(
            "INSERT INTO source_registry_entries "
            "(tenant_id, source_id, kind, display_name, owner, priority, state, "
            "policy_id, seed_url, created_at, updated_at) "
            "VALUES ('local', ?, 'broad_board', 'Unrelated label', ?, "
            "'lead_generator', ?, 'broad_board_lead_generator', ?, "
            "'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            (source_id, owner, state, seed_url),
        )
        conn.commit()

    yield conn, seed
    close_connection(db_path)


@pytest.mark.parametrize("board,source_id", [
    ("glassdoor", "jobspy:glassdoor"),
    ("indeed", "jobspy:indeed"),
    ("linkedin", "jobspy:linkedin"),
    ("zip_recruiter", "jobspy:zip-recruiter"),
])
@pytest.mark.parametrize("state,expected_budget", [
    ("experimental", 100),
    ("disabled", 0),
    ("quarantined", 5),
])
def test_retained_board_reaches_provider_units_with_its_original_state(
    retained_board_registry, board, source_id, state, expected_budget,
):
    conn, seed = retained_board_registry
    seed(source_id, state=state)
    original_rows = list(conn.execute("SELECT * FROM source_registry_entries"))
    default_board = "indeed" if board == "linkedin" else "linkedin"
    search_cfg = {
        "boards": [default_board],
        "queries": [{"query": "Engineering Director", "tier": 1}],
        "locations": [{"location": "Spain", "label": "Spain"}],
    }

    # Use the same read/selection/scheduling/configuration/unit compilation path
    # as a source-family activity, with no provider or semantic test doubles.
    schedule = runner._plan_discovery_schedule(
        100, source_ids=(source_id,), search_cfg=search_cfg,
    )
    source, = schedule.for_prefix("jobspy")
    assert source.configured_state.value == ("active" if state == "experimental" else state)
    assert source.crawl_budget == expected_budget
    assert source.adapter_config["board"] == board
    effective = runner._jobspy_config_for_sources(search_cfg, (source,))
    units = _durable_search_specs(
        effective, tiers=None, locations=None,
        sites=config.resolve_jobspy_boards(effective) if source.should_run else [],
        results_per_site=100, hours_old=72,
    )
    assert [unit.sites for unit in units] == ([(board,)] if expected_budget else [])
    assert effective["boards"] == ([board] if expected_budget else [])
    assert search_cfg["boards"] == [default_board]
    assert list(conn.execute("SELECT * FROM source_registry_entries")) == original_rows


def test_explicit_two_board_selection_does_not_silently_drop_retained_board(
    retained_board_registry,
):
    conn, seed = retained_board_registry
    seed("jobspy:zip-recruiter", owner="user", seed_url="https://example.test/jobs")
    before = list(conn.execute("SELECT * FROM source_registry_entries"))
    cfg = {"boards": ["linkedin"]}
    schedule = runner._plan_discovery_schedule(
        100, source_ids=("jobspy:linkedin", "jobspy:zip-recruiter"), search_cfg=cfg,
    )
    sources = schedule.for_prefix("jobspy")
    assert schedule.runnable_source_ids == ("jobspy:linkedin", "jobspy:zip-recruiter")
    assert schedule.budget_for_prefix("jobspy") == 200
    assert runner._jobspy_config_for_sources(cfg, sources)["boards"] == ["linkedin", "zip_recruiter"]
    assert sources[1].adapter_config["url"] == "https://example.test/jobs"
    assert list(conn.execute("SELECT * FROM source_registry_entries")) == before


@pytest.mark.parametrize("invalid_board", [None, "", "  ", 123])
def test_runnable_board_without_provider_identity_fails_explicitly(
    retained_board_registry, invalid_board,
):
    _, seed = retained_board_registry
    seed("jobspy:unknown")
    schedule = runner._plan_discovery_schedule(
        100, source_ids=("jobspy:unknown",), search_cfg={"boards": ["linkedin"]},
    )
    source, = schedule.for_prefix("jobspy")
    assert source.should_run
    source = replace(source, adapter_config={"board": invalid_board})
    with pytest.raises(ConfigurationError, match="jobspy:unknown.*no provider board identity"):
        runner._jobspy_config_for_sources({"boards": ["linkedin"]}, (source,))


def test_disabled_unknown_board_does_not_need_provider_wiring(retained_board_registry):
    _, seed = retained_board_registry
    seed("jobspy:unknown", state="disabled")
    schedule = runner._plan_discovery_schedule(
        100, source_ids=("jobspy:unknown",), search_cfg={"boards": ["linkedin"]},
    )
    assert runner._jobspy_config_for_sources({}, schedule.sources)["boards"] == []


@pytest.mark.parametrize("unknown", [False, True])
def test_real_family_dispatch_records_both_boards_or_configuration_failure(
    retained_board_registry, monkeypatch, unknown,
):
    conn, seed = retained_board_registry
    retained_id = "jobspy:unknown" if unknown else "jobspy:zip-recruiter"
    seed(retained_id)
    cfg = {
        "boards": ["linkedin"],
        "queries": [{"query": "Engineering Director", "tier": 1}],
        "locations": [{"location": "Spain", "label": "Spain"}],
    }
    monkeypatch.setattr(config, "load_search_config", lambda: cfg)
    dispatches = []

    def provider_boundary(*, cfg, limit, **_kwargs):
        units = _durable_search_specs(
            cfg, tiers=None, locations=None, sites=config.resolve_jobspy_boards(cfg),
            results_per_site=100, hours_old=72,
        )
        dispatches.append({"boards": [unit.sites for unit in units], "limit": limit})
        return {"new": 0, "existing": 0, "errors": 0}

    # Only acquisition is substituted. Real registry, scheduler, family lifecycle,
    # empty capture recovery and exact-schema persistence remain active.
    monkeypatch.setattr(jobspy, "run_discovery", provider_boundary)
    from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
    execution = DiscoveryExecutionRef("local", "owned-selected-boards", "owned-selected-run")
    frozen = runner.plan_discovery_source_families(
        limit=100, source_ids=("jobspy:linkedin", retained_id), discovery_execution=execution,
    )
    ownership = {"discovery_execution": execution, "source_result_limits": frozen["source_result_limits"]}
    before = list(conn.execute("SELECT * FROM source_registry_entries"))
    if unknown:
        with pytest.raises(ConfigurationError, match="no provider board identity"):
            runner.run_discovery_source_family(
                "jobspy", limit=100, source_ids=("jobspy:linkedin", retained_id), **ownership,
            )
        assert dispatches == []
    else:
        result = runner.run_discovery_source_family(
            "jobspy", limit=100, source_ids=("jobspy:linkedin", retained_id), **ownership,
        )
        assert result["status"] == "ok"
        assert result["source_ids"] == ["jobspy:linkedin", retained_id]
        assert dispatches == [{"boards": [("linkedin",), ("zip_recruiter",)], "limit": 100}]
    stored, = conn.execute("SELECT status, error_classes_json FROM discovery_runs")
    assert stored["status"] == ("failed" if unknown else "completed")
    assert stored["error_classes_json"] == ('["ConfigurationError"]' if unknown else '[]')
    assert list(conn.execute("SELECT * FROM source_registry_entries")) == before
    assert cfg["boards"] == ["linkedin"]


@pytest.mark.asyncio
async def test_actual_activity_keeps_missing_board_configuration_non_retryable(
    retained_board_registry, monkeypatch,
):
    from temporalio.exceptions import ApplicationError
    from temporalio.testing import ActivityEnvironment
    from jobctrl.discovery.activities import (
        DiscoverySourceActivityInput,
        discovery_source_family_activity,
    )

    conn, seed = retained_board_registry
    seed("jobspy:unknown")
    monkeypatch.setattr(config, "load_search_config", lambda: {"boards": ["linkedin"]})
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )
    dispatches = []
    monkeypatch.setattr(jobspy, "run_discovery", lambda **kwargs: dispatches.append(kwargs))
    env = ActivityEnvironment()
    from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
    execution = DiscoveryExecutionRef("local", "owned-missing-board", "owned-missing-board-run")
    recorded = runner.plan_discovery_source_families(
        limit=100, source_ids=("jobspy:linkedin", "jobspy:unknown"), discovery_execution=execution,
    )
    with pytest.raises(ApplicationError) as excinfo:
        await env.run(
            discovery_source_family_activity,
            DiscoverySourceActivityInput(
                tenant_id="local", family="jobspy", limit=100,
                source_ids=("jobspy:linkedin", "jobspy:unknown"),
                discovery_execution=execution, use_source_result_budget=True,
                source_result_limits=recorded["source_result_limits"],
            ),
        )
    assert excinfo.value.type == "configuration"
    assert excinfo.value.non_retryable is True
    assert "jobspy:unknown" in str(excinfo.value)
    assert dispatches == []
    stored, = conn.execute("SELECT status, error_classes_json FROM discovery_runs")
    assert tuple(stored) == ("failed", '["ConfigurationError"]')
