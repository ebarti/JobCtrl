"""Literal saved Remote rows reach only synthetic JobStreaming adapters."""

from __future__ import annotations

import json
import socket
from copy import deepcopy
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
import pandas as pd
from jobstreaming import AdapterCapabilities, AdapterRegistry, InvalidRequestError, JobResponse, Scraper, Site

from jobctrl import config, database
from jobctrl.discovery import jobspy
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.search_units import DiscoverySearchSpec
from jobctrl.domain.errors import ConfigurationError
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery.jobstreaming_gateway import JobStreamingGateway, JobStreamingSearchSpec
from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import SqliteDiscoverySearchUnitRepository
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.pipeline import runner
from jobctrl.wizard import init as wizard


class _NoopLimiter:
    @contextmanager
    def slot(self, *_args, **_kwargs):
        yield


class _RecordingAdapter(Scraper):
    capabilities = AdapterCapabilities(filters=frozenset({"location", "is_remote", "hours_old"}))
    board: Site
    requests: list

    def __init__(self, **_kwargs):
        super().__init__(self.board)

    def scrape(self, request, context=None):
        assert context is not None
        type(self).requests.append(request)
        return JobResponse()


class _LinkedIn(_RecordingAdapter):
    board = Site.LINKEDIN
    requests = []


class _Glassdoor(_RecordingAdapter):
    board = Site.GLASSDOOR
    requests = []


class _ZipRecruiter(_RecordingAdapter):
    board = Site.ZIP_RECRUITER
    requests = []


class _Indeed(_RecordingAdapter):
    board = Site.INDEED
    requests = []


class _UnsupportedRemote(_LinkedIn):
    capabilities = AdapterCapabilities(filters=frozenset({"location", "hours_old"}))
    requests = []


class _InvalidRequest(_LinkedIn):
    def scrape(self, request, context=None):
        raise InvalidRequestError("synthetic provider error")


@pytest.fixture
def owned_workspace(tmp_path, monkeypatch):
    db_path = tmp_path / "owned.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(tmp_path / "config.json"))
    monkeypatch.setattr(config, "load_sites_config", lambda: {})
    monkeypatch.setattr(config, "load_employers_config", lambda: {})
    conn = database.init_db(db_path)
    monkeypatch.setattr(jobspy, "init_db", lambda: conn)
    monkeypatch.setattr(jobspy, "PolitenessGateway", lambda: SimpleNamespace(user_agent="synthetic"))
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)

    def forbid_network(*_args, **_kwargs):
        raise AssertionError("network access is forbidden in this synthetic test")

    monkeypatch.setattr(socket.socket, "connect", forbid_network)
    for adapter in (_LinkedIn, _Glassdoor, _ZipRecruiter, _Indeed, _UnsupportedRemote):
        adapter.requests = []
    yield conn
    database.close_connection(db_path)


def _seed(conn, boards):
    raw = (
        '{ "boards": ' + boards + ', "defaults": '
        '{"results_per_site": 10, "hours_old": 48, "country_indeed": "spain"}, '
        '"glassdoor_location_map": {"": "Must not be used"} }'
    )
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,))
    conn.execute(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, version, "
        "experience_target_role, experience_target_locations, experience_target_work_models, updated_at) "
        "VALUES ('local', 'default', 7, ?, ?, ?, 'updated')",
        ("Synthetic role", "Synthetic City; ; Synthetic Coast, Region", "hybrid; remote; onsite, remote"),
    )
    conn.commit()
    return raw


def _saved_rows(conn):
    return (
        conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0],
        tuple(conn.execute(
            "SELECT experience_target_role, experience_target_locations, experience_target_work_models, version "
            "FROM candidate_profiles"
        ).fetchone()),
    )


def _registry(*adapters):
    registry = AdapterRegistry()
    for adapter in adapters:
        registry.register(adapter.board, adapter)
    return registry


@pytest.mark.parametrize("location", ["Remote", "Synthetic City"])
@pytest.mark.parametrize("with_profile", [False, True])
def test_fresh_remote_wizard_saves_and_runs_compatible_boards(owned_workspace, monkeypatch, location, with_profile):
    conn = owned_workspace
    if with_profile:
        conn.execute(
            "INSERT INTO candidate_profiles (tenant_id, profile_id, version, experience_target_role, updated_at) "
            "VALUES ('local', 'default', 1, 'Synthetic role', 'updated')"
        )
        conn.commit()
    profile_before = conn.execute(
        "SELECT experience_target_role, experience_target_locations, experience_target_work_models, version "
        "FROM candidate_profiles"
    ).fetchall()
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)
    answers = iter([location, "0", "Synthetic role"])
    monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(answers))
    messages = []
    monkeypatch.setattr(wizard, "console", SimpleNamespace(print=lambda *args: messages.extend(map(str, args))))
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry",
        lambda *_a, **_k: _registry(_LinkedIn, _ZipRecruiter),
    )

    wizard._setup_searches()
    raw = conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0]
    saved = json.loads(raw)
    assert saved["boards"] == ["linkedin", "zip_recruiter"]
    assert saved["defaults"]["hours_old"] == 72 and saved["defaults"]["distance"] == 0
    assert saved["locations"] == [{"location": location, "remote": True}]
    assert saved["queries"] == [{"query": "Synthetic role", "tier": 1}]
    assert any("Indeed" in message and "LinkedIn" in message for message in messages)

    execution = DiscoveryExecutionRef("local", "owned-wizard", f"owned-{location}")
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    for attempt in (1, 2):
        result = runner.run_discovery_source_family(
            "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
            activity_attempt=attempt, activity_owner_token=f"wizard-{attempt}",
        )
        assert result["status"] == "ok"
        for adapter in (_LinkedIn, _ZipRecruiter):
            assert [(r.search_term, r.location, r.is_remote, r.hours_old) for r in adapter.requests] == [
                ("Synthetic role", location, True, 72),
            ]
        assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == raw
        assert conn.execute(
            "SELECT experience_target_role, experience_target_locations, experience_target_work_models, version "
            "FROM candidate_profiles"
        ).fetchall() == profile_before


def test_fresh_local_wizard_keeps_the_existing_default_boards(owned_workspace, monkeypatch):
    conn = owned_workspace
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)
    answers = iter(["Synthetic City", "25", "Synthetic role"])
    monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(answers))
    wizard._setup_searches()
    saved = json.loads(conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0])
    assert saved["boards"] == ["indeed", "linkedin", "zip_recruiter"]
    assert saved["locations"] == [{"location": "Synthetic City", "remote": False}]
    assert saved["defaults"]["distance"] == 25 and saved["defaults"]["hours_old"] == 72


def test_wizard_rechecks_first_use_under_the_write_lock(owned_workspace, monkeypatch):
    conn = owned_workspace
    raw = '{ "boards": ["indeed"], "defaults": {"hours_old": 48}, "synthetic_note": "preserve" }'
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)
    answers = iter(["Synthetic City", "0", "Synthetic role"])
    monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(answers))

    def concurrent_save(_path):
        conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,))
        conn.commit()
        return conn

    monkeypatch.setattr(wizard, "init_db", concurrent_save)
    with pytest.raises(ConfigurationError, match="Indeed.*lookback"):
        wizard._setup_searches()
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == raw


def test_remote_wizard_preserves_existing_settings_and_can_retry_after_board_change(owned_workspace, monkeypatch):
    conn = owned_workspace
    initial = {
        "boards": ["indeed", "linkedin"],
        "defaults": {"hours_old": 48, "results_per_site": 17, "country_indeed": "canada"},
        "locations": [{"location": "Synthetic City", "remote": False}],
        "queries": [{"query": "Earlier synthetic role", "tier": 1}],
        "exact_title_exclusions": ["Synthetic exclusion"], "synthetic_note": "preserve",
    }
    raw = json.dumps(initial, indent=2)
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,))
    conn.commit()
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)

    def answers():
        values = iter(["Synthetic New City", "0", "New synthetic role"])
        monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(values))

    answers()
    with pytest.raises(ConfigurationError, match="Indeed.*lookback"):
        wizard._setup_searches()
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == raw

    config._update_discovery_search_config(lambda current: {**current, "boards": ["linkedin"]})
    answers()
    wizard._setup_searches()
    updated = json.loads(conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0])
    assert updated["boards"] == ["linkedin"]
    assert updated["defaults"]["hours_old"] == 48
    assert updated["defaults"]["results_per_site"] == 17
    assert updated["defaults"]["country_indeed"] == "canada"
    assert updated["exact_title_exclusions"] == initial["exact_title_exclusions"]
    assert updated["synthetic_note"] == "preserve"
    assert updated["locations"] == [{"location": "Synthetic New City", "remote": True}]
    assert updated["queries"] == [{"query": "New synthetic role", "tier": 1}]
    saved_bytes = conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0]
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *_a, **_k: _registry(_LinkedIn)
    )
    execution = DiscoveryExecutionRef("local", "owned-wizard-retry", "owned-run")
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    result = runner.run_discovery_source_family(
        "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
        activity_attempt=1, activity_owner_token="wizard-retry-1",
    )
    assert result["status"] == "ok"
    assert [(r.search_term, r.location, r.is_remote, r.hours_old) for r in _LinkedIn.requests] == [
        ("New synthetic role", "Synthetic New City", True, 48),
    ]
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == saved_bytes


@pytest.mark.parametrize("filter_name", ["tiers", "location_labels"])
def test_wizard_filter_conflict_requires_confirmation_and_then_runs(owned_workspace, monkeypatch, filter_name):
    from typer.testing import CliRunner
    from jobctrl import cli

    conn = owned_workspace
    original = {
        "boards": ["linkedin"], "defaults": {"hours_old": 48, "country_indeed": "canada"},
        "queries": [{"query": "Old synthetic role", "tier": 2 if filter_name == "tiers" else 1}],
        "locations": [{"label": "Old synthetic label", "location": "Old synthetic city", "remote": False}],
        "tiers": [2] if filter_name == "tiers" else [1],
        "location_labels": [] if filter_name == "tiers" else ["Old synthetic label"],
        "synthetic_note": "preserve",
    }
    raw = json.dumps(original, indent=2)
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,))
    conn.commit()
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)
    monkeypatch.setattr(wizard, "run_wizard", wizard._setup_searches)
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *_a, **_k: _registry(_LinkedIn)
    )

    def inputs(accept):
        answers = iter(["New synthetic city", "0", "New synthetic role"])
        monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(answers))
        prompts = []
        monkeypatch.setattr(
            wizard.Confirm, "ask", lambda question, **kwargs: prompts.append((question, kwargs)) or accept,
        )
        return prompts

    prompts = inputs(False)
    declined = CliRunner().invoke(cli.app, ["init"])
    assert declined.exit_code == 1
    assert filter_name in declined.output and "unchanged" in declined.output.lower()
    assert json.dumps(original[filter_name]) in declined.output
    assert "traceback" not in declined.output.lower()
    assert len(prompts) == 1 and filter_name in prompts[0][0] and prompts[0][1].get("default") is False
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == raw

    prompts = inputs(True)
    accepted = CliRunner().invoke(cli.app, ["init"])
    assert accepted.exit_code == 0, accepted.output
    assert len(prompts) == 1 and filter_name in prompts[0][0]
    saved_bytes = conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0]
    updated = json.loads(saved_bytes)
    assert updated[filter_name] == []
    other = "location_labels" if filter_name == "tiers" else "tiers"
    assert updated[other] == original[other]
    assert updated["boards"] == original["boards"]
    assert updated["defaults"]["hours_old"] == 48 and updated["defaults"]["country_indeed"] == "canada"
    assert updated["synthetic_note"] == "preserve"

    execution = DiscoveryExecutionRef("local", f"owned-wizard-filter-{filter_name}", "owned-run")
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    for attempt in (1, 2):
        result = runner.run_discovery_source_family(
            "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
            activity_attempt=attempt, activity_owner_token=f"filter-{attempt}",
        )
        assert result["status"] == "ok"
        assert [(r.search_term, r.location, r.is_remote, r.hours_old) for r in _LinkedIn.requests] == [
            ("New synthetic role", "New synthetic city", True, 48),
        ]
        assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == saved_bytes


@pytest.mark.parametrize("change", ["filter", "board", "profile"])
def test_wizard_will_not_clear_a_filter_after_context_changes(owned_workspace, monkeypatch, change):
    from typer.testing import CliRunner
    from jobctrl import cli

    conn = owned_workspace
    original = '{ "boards": ["linkedin"], "defaults": {"hours_old": 48}, "tiers": [2] }'
    changed = (
        '{ "boards": ["linkedin", "zip_recruiter"], "defaults": {"hours_old": 48}, "tiers": [2] }'
        if change == "board" else
        '{ "boards": ["linkedin"], "defaults": {"hours_old": 48}, "tiers": [3], "synthetic_note": "new" }'
    )
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (original,))
    if change == "profile":
        conn.execute(
            "INSERT INTO candidate_profiles (tenant_id, profile_id, version, updated_at) "
            "VALUES ('local', 'default', 1, 'updated')"
        )
    conn.commit()
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)
    monkeypatch.setattr(wizard, "run_wizard", wizard._setup_searches)
    answers = iter(["New synthetic city", "0", "New synthetic role"])
    monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(answers))

    def approve_after_concurrent_change(_question, **_kwargs):
        if change == "profile":
            conn.execute("UPDATE candidate_profiles SET experience_target_role='New profile role', version=2")
        else:
            conn.execute("UPDATE discovery_settings SET search_config_json=?", (changed,))
        conn.commit()
        return True

    monkeypatch.setattr(wizard.Confirm, "ask", approve_after_concurrent_change)
    result = CliRunner().invoke(cli.app, ["init"])
    assert result.exit_code == 1
    assert "changed" in result.output.lower() and "retry" in result.output.lower()
    assert "traceback" not in result.output.lower()
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == (
        original if change == "profile" else changed
    )
    if change == "profile":
        assert tuple(conn.execute("SELECT experience_target_role, version FROM candidate_profiles").fetchone()) == (
            "New profile role", 2,
        )


@pytest.mark.parametrize("confirm_second", [False, True])
def test_wizard_conflicting_filters_commit_together(owned_workspace, monkeypatch, confirm_second):
    from typer.testing import CliRunner
    from jobctrl import cli

    conn = owned_workspace
    raw = '{ "boards": ["linkedin"], "defaults": {"hours_old": 48}, "tiers": [2], "location_labels": ["Old"] }'
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,))
    conn.commit()
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)
    monkeypatch.setattr(wizard, "run_wizard", wizard._setup_searches)
    answers = iter(["New synthetic city", "0", "New synthetic role"])
    decisions = iter([True, confirm_second])
    monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(answers))
    prompts = []
    monkeypatch.setattr(wizard.Confirm, "ask", lambda question, **_k: prompts.append(question) or next(decisions))
    result = CliRunner().invoke(cli.app, ["init"])
    assert len(prompts) == 2 and "tiers" in prompts[0] and "location_labels" in prompts[1]
    saved = conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0]
    if not confirm_second:
        assert result.exit_code == 1
        assert saved == raw
    else:
        assert result.exit_code == 0, result.output
        updated = json.loads(saved)
        assert updated["tiers"] == updated["location_labels"] == []


def test_wizard_filter_check_uses_profile_override(owned_workspace, monkeypatch):
    from typer.testing import CliRunner
    from jobctrl import cli

    conn = owned_workspace
    raw = '{ "boards": ["linkedin"], "defaults": {"hours_old": 48}, "tiers": [2] }'
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,))
    conn.execute(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, version, experience_target_role, updated_at) "
        "VALUES ('local', 'default', 1, 'Profile synthetic role', 'updated')"
    )
    conn.commit()
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)
    monkeypatch.setattr(wizard, "run_wizard", wizard._setup_searches)
    answers = iter(["New synthetic city", "0", "First role, Second role"])
    monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(answers))
    monkeypatch.setattr(wizard.Confirm, "ask", lambda *_a, **_k: False)
    result = CliRunner().invoke(cli.app, ["init"])
    assert result.exit_code == 1 and "tiers" in result.output
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == raw


def test_wizard_keeps_filters_that_match_effective_profile_targets(owned_workspace, monkeypatch):
    conn = owned_workspace
    original = {
        "boards": ["linkedin"], "defaults": {"hours_old": 48}, "tiers": [1],
        "location_labels": ["Synthetic City"],
    }
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (json.dumps(original),))
    conn.execute(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, version, experience_target_role, "
        "experience_target_locations, experience_target_work_models, updated_at) "
        "VALUES ('local', 'default', 1, 'Synthetic role', 'Synthetic City', 'remote', 'updated')"
    )
    conn.commit()
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)
    answers = iter(["Synthetic City", "0", "Synthetic role"])
    monkeypatch.setattr(wizard.Prompt, "ask", lambda *_a, **_k: next(answers))
    monkeypatch.setattr(wizard.Confirm, "ask", lambda *_a, **_k: pytest.fail("matching filters must be kept"))
    wizard._setup_searches()
    saved = json.loads(conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0])
    assert saved["tiers"] == [1] and saved["location_labels"] == ["Synthetic City"]
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *_a, **_k: _registry(_LinkedIn)
    )
    execution = DiscoveryExecutionRef("local", "owned-wizard-matching-filter", "owned-run")
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    result = runner.run_discovery_source_family(
        "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
        activity_attempt=1, activity_owner_token="matching-filter-1",
    )
    assert result["status"] == "ok"
    assert [(r.search_term, r.location, r.is_remote, r.hours_old) for r in _LinkedIn.requests] == [
        ("Synthetic role", "Synthetic City", True, 48),
    ]


def test_first_use_runs_supported_boards_and_reports_unsupported_board_on_retry(owned_workspace, monkeypatch):
    conn = owned_workspace
    execution = DiscoveryExecutionRef("local", "owned-first-use", "owned-run")
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry",
        lambda *_a, **_k: _registry(_Indeed, _LinkedIn, _ZipRecruiter),
    )

    defaults = config.load_search_config()
    assert conn.execute("SELECT count(*) FROM discovery_settings").fetchone()[0] == 0
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    snapshot = plan["next_run_settings"]
    assert snapshot["boards"] == defaults["boards"]
    assert snapshot["queries"] == defaults["queries"]
    assert snapshot["locations"] == defaults["locations"]
    assert snapshot["hours_old"] == defaults["defaults"]["hours_old"]

    repository = SqliteDiscoverySearchUnitRepository(conn)
    for attempt in (1, 2):
        with pytest.raises(ConfigurationError, match="Indeed.*lookback") as raised:
            runner.run_discovery_source_family(
                "jobspy", discovery_execution=execution, next_run_settings=snapshot,
                activity_attempt=attempt, activity_owner_token=f"first-use-{attempt}",
            )
        assert raised.value.code == "unsupported_remote_search"
        assert not _Indeed.requests
        for adapter in (_LinkedIn, _ZipRecruiter):
            assert [(r.search_term, r.location, r.is_remote, r.hours_old) for r in adapter.requests] == [
                ("Software Engineer", "Remote", True, 72),
            ]
        units = {unit.spec.sites[0]: unit for unit in repository.list_units(execution)}
        assert set(units) == {"indeed", "linkedin", "zip_recruiter"}
        assert units["indeed"].state == "failed"
        assert units["indeed"].last_error_code == "indeed:unsupported_remote_search"
        assert units["linkedin"].state == units["zip_recruiter"].state == "completed"
        assert conn.execute("SELECT count(*) FROM discovery_settings").fetchone()[0] == 0

    attempts = conn.execute(
        "SELECT source_id, outcome FROM operational_attempt_metrics "
        "WHERE attempt_kind = 'discovery_source' AND outcome IN ('succeeded', 'failed') ORDER BY metric_id"
    ).fetchall()
    assert {tuple(row) for row in attempts} == {
        ("jobspy:indeed", "failed"),
        ("jobspy:linkedin", "succeeded"),
        ("jobspy:zip-recruiter", "succeeded"),
    }
    events = conn.execute(
        "SELECT level, payload_json FROM job_events "
        "WHERE event_type = 'StageCompleted' AND message = 'Discovery source jobspy partial'"
    ).fetchall()
    assert len(events) == 2
    assert all(level == "warn" and json.loads(payload)["status"] == "partial" for level, payload in events)


def test_unsupported_adapter_capability_is_reported_after_healthy_units_and_retry(owned_workspace, monkeypatch):
    conn = owned_workspace
    _seed(conn, '["linkedin", "zip_recruiter"]')
    before = _saved_rows(conn)
    execution = DiscoveryExecutionRef("local", "owned-unsupported-capability", "owned-run")
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry",
        lambda *_a, **_k: _registry(_UnsupportedRemote, _ZipRecruiter),
    )
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    repository = SqliteDiscoverySearchUnitRepository(conn)

    for attempt in (1, 2):
        with pytest.raises(ConfigurationError, match="linkedin.*Remote") as raised:
            runner.run_discovery_source_family(
                "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
                activity_attempt=attempt, activity_owner_token=f"capability-{attempt}",
            )
        assert raised.value.code == "unsupported_remote_search"
        assert len(_ZipRecruiter.requests) == 4
        assert len(_UnsupportedRemote.requests) == 2
        assert all(not request.is_remote for request in _UnsupportedRemote.requests)
        units = repository.list_units(execution)
        blocked = [unit for unit in units if unit.last_error_type == "UnsupportedRemoteSearch"]
        assert len(blocked) == 2 and all(unit.state == "failed" for unit in blocked)
        assert _saved_rows(conn) == before

    outcomes = conn.execute(
        "SELECT source_id, outcome FROM operational_attempt_metrics "
        "WHERE attempt_kind = 'discovery_source' AND outcome IN ('succeeded', 'failed')"
    ).fetchall()
    assert {tuple(row) for row in outcomes} == {
        ("jobspy:linkedin", "failed"), ("jobspy:zip-recruiter", "succeeded"),
    }


def test_other_provider_errors_keep_existing_partial_result_behavior(owned_workspace, monkeypatch):
    conn = owned_workspace
    _seed(conn, '["linkedin", "zip_recruiter"]')
    before = _saved_rows(conn)
    execution = DiscoveryExecutionRef("local", "owned-other-provider-error", "owned-run")
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry",
        lambda *_a, **_k: _registry(_InvalidRequest, _ZipRecruiter),
    )
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    result = runner.run_discovery_source_family(
        "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
        activity_attempt=1, activity_owner_token="other-provider-1",
    )
    assert result["status"] == "ok"
    assert result["result"]["failed_source_ids"] == ["jobspy:linkedin"]
    assert "unsupported_remote_error" not in result["result"]
    assert len(_ZipRecruiter.requests) == 4
    assert _saved_rows(conn) == before


def test_only_unsupported_adapter_surfaces_typed_failure(owned_workspace, monkeypatch):
    conn = owned_workspace
    _seed(conn, '["linkedin"]')
    conn.execute(
        "UPDATE candidate_profiles SET experience_target_locations = '', experience_target_work_models = 'remote'"
    )
    conn.commit()
    before = _saved_rows(conn)
    execution = DiscoveryExecutionRef("local", "owned-only-unsupported", "owned-run")
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry",
        lambda *_a, **_k: _registry(_UnsupportedRemote),
    )
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    with pytest.raises(ConfigurationError, match="linkedin.*Remote") as raised:
        runner.run_discovery_source_family(
            "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
            activity_attempt=1, activity_owner_token="only-unsupported-1",
        )
    assert raised.value.code == "unsupported_remote_search"
    assert _UnsupportedRemote.requests == []
    units = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)
    assert len(units) == 1 and units[0].last_error_type == "UnsupportedRemoteSearch"
    assert units[0].state == "failed"
    assert _saved_rows(conn) == before


def test_saved_rows_reach_exact_requests_and_replay_without_rewriting_settings(owned_workspace):
    conn = owned_workspace
    raw = _seed(conn, '["linkedin", "zip_recruiter"]')
    before = _saved_rows(conn)
    assert before[0] == raw
    cfg = config.load_search_config()
    execution = DiscoveryExecutionRef("local", "discover-remote-owned", "remote-run")
    registry = _registry(_LinkedIn, _ZipRecruiter)

    result = jobspy.run_discovery(
        cfg=cfg, discovery_execution=execution, activity_attempt=1,
        activity_owner_token="owned-1", adapter_registry=registry,
    )

    assert result["errors"] == 0
    assert result["search_units"] == 8
    for adapter in (_LinkedIn, _ZipRecruiter):
        assert [(request.location, request.is_remote) for request in adapter.requests] == [
            ("Synthetic City", False),
            (None, True),
            ("Synthetic Coast, Region", False),
            ("Synthetic Coast, Region", True),
        ]
        assert all(request.search_term == "Synthetic role" and request.hours_old == 48 for request in adapter.requests)
        assert all(request.results_wanted == 10 for request in adapter.requests)

    repository = SqliteDiscoverySearchUnitRepository(conn)
    units = repository.list_units(execution)
    remote_units = [unit for unit in units if unit.spec.target_location == ""]
    assert len(remote_units) == 2
    assert all(unit.spec.provider_location == "" and unit.spec.remote_only for unit in remote_units)
    assert all(unit.spec.hours_old == 48 and unit.spec.from_json(unit.spec.to_json()) == unit.spec for unit in units)
    fingerprints = [(unit.unit_id, unit.request_fingerprint) for unit in units]
    assert _saved_rows(conn) == before

    retry = jobspy.run_discovery(
        cfg=cfg, discovery_execution=execution, activity_attempt=2,
        activity_owner_token="owned-2", adapter_registry=registry,
    )
    assert retry["errors"] == 0
    assert [len(adapter.requests) for adapter in (_LinkedIn, _ZipRecruiter)] == [4, 4]
    assert [(unit.unit_id, unit.request_fingerprint) for unit in repository.list_units(execution)] == fingerprints
    assert _saved_rows(conn) == before


def test_indeed_remote_and_lookback_conflict_rejects_only_unsupported_units(owned_workspace):
    conn = owned_workspace
    _seed(conn, '["linkedin", "indeed"]')
    before = _saved_rows(conn)
    cfg = config.load_search_config()
    execution = DiscoveryExecutionRef("local", "discover-remote-conflict", "remote-run")

    result = jobspy.run_discovery(
        cfg=cfg, discovery_execution=execution, activity_attempt=1,
        activity_owner_token="owned-1", adapter_registry=_registry(_LinkedIn, _Indeed),
    )

    assert "Indeed" in result["unsupported_remote_error"] and "lookback" in result["unsupported_remote_error"]
    assert result["failed_source_ids"] == ["jobspy:indeed"]
    assert len(_LinkedIn.requests) == 4
    assert len(_Indeed.requests) == 2 and all(not request.is_remote for request in _Indeed.requests)
    units = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)
    assert len(units) == 8
    assert all(unit.state == ("failed" if unit.spec.sites == ("indeed",) and unit.spec.remote_only else "completed")
               for unit in units)
    assert _saved_rows(conn) == before

    # The compatibility crawl must fail before it dispatches any earlier row.
    requests_before = list(_LinkedIn.requests), list(_Indeed.requests)
    with pytest.raises(ConfigurationError, match="Indeed.*lookback"):
        jobspy.run_discovery(cfg=cfg)
    assert (list(_LinkedIn.requests), list(_Indeed.requests)) == requests_before
    assert _saved_rows(conn) == before


def test_unsupported_adapter_is_rejected_before_its_scrape(owned_workspace):
    del owned_workspace
    spec = JobStreamingSearchSpec(
        sites=("linkedin",), query="Synthetic role", location="", results_per_site=10,
        hours_old=48, remote_only=True, country_indeed="spain",
    )
    result = JobStreamingGateway().collect(spec, registry=_registry(_UnsupportedRemote), max_retries=0)

    assert _UnsupportedRemote.requests == []
    assert [(failure.code, failure.error_type, failure.retryable) for failure in result.failures] == [
        ("invalid_request", "UnsupportedRemoteSearch", False),
    ]
    assert result.completed is False


def test_nonempty_indeed_request_identity_is_preserved_but_unsupported_scope_is_refused():
    spec = DiscoverySearchSpec(
        query="Synthetic role", provider_location="Synthetic City", target_location="Synthetic City",
        sites=("indeed",), results_per_site=10, hours_old=48, remote_only=True, country_indeed="spain",
    )
    request = JobStreamingGateway.build_request(jobspy._jobstreaming_spec(spec))
    assert (request.location, request.is_remote, request.hours_old) == ("Synthetic City", True, 48)
    with pytest.raises(ConfigurationError, match="Indeed.*lookback"):
        JobStreamingGateway().collect(jobspy._jobstreaming_spec(spec), registry=_registry(_Indeed), max_retries=0)
    assert _Indeed.requests == []
    with pytest.raises(ValueError, match="provider_location"):
        DiscoverySearchSpec(
            query="Synthetic role", provider_location="", target_location="", sites=("linkedin",),
            results_per_site=10, hours_old=48, remote_only=False, country_indeed="spain",
        )
    with pytest.raises(ValueError, match="location"):
        JobStreamingSearchSpec(
            sites=("linkedin",), query="Synthetic role", location="", results_per_site=10, remote_only=False,
        )


def test_compatibility_crawl_keeps_location_absent_for_all_selected_boards(monkeypatch):
    requests = []

    def fake_scrape(options, **_kwargs):
        requests.append(JobStreamingGateway.build_request(JobStreamingSearchSpec.from_legacy_options(options)))
        return pd.DataFrame()

    monkeypatch.setattr(jobspy, "_scrape_with_retry", fake_scrape)
    result = jobspy._run_one_search(
        {"query": "Synthetic role", "location": "", "remote": True},
        ["linkedin", "glassdoor"], 10, 48, None, {"country_indeed": "spain"}, 0,
        {"": "Must not be used"},
    )
    assert not result["all_sites_failed"]
    assert len(requests) == 2
    assert [(request.location, request.is_remote, request.hours_old) for request in requests] == [
        (None, True, 48), (None, True, 48),
    ]


def test_python_settings_writer_refuses_new_conflict_but_allows_unrelated_legacy_edits(owned_workspace):
    conn = owned_workspace
    raw = _seed(conn, '["linkedin"]')
    before = _saved_rows(conn)
    with pytest.raises(ConfigurationError, match="Indeed.*lookback") as raised:
        config._save_discovery_search_config_to_db({"boards": ["linkedin", "indeed"], "defaults": {"hours_old": 48}})
    assert raised.value.code == "unsupported_remote_search"
    assert _saved_rows(conn) == before

    # Existing incompatible bytes may be repaired, and do not block unrelated
    # automation settings. A newly changed lookback is still refused.
    legacy = raw.replace('["linkedin"]', '["linkedin", "indeed"]')
    conn.execute("UPDATE discovery_settings SET search_config_json = ?", (legacy,))
    conn.commit()
    config.save_discovery_automation_settings(auto_apply=False, apply_approval_required=True)
    after_unrelated = _saved_rows(conn)
    with pytest.raises(ConfigurationError, match="Indeed.*lookback"):
        config._save_discovery_search_config_to_db({"boards": ["linkedin", "indeed"], "defaults": {"hours_old": 24}})
    assert _saved_rows(conn) == after_unrelated
    config._save_discovery_search_config_to_db({"boards": ["linkedin"], "defaults": {"hours_old": 48}})
    assert config.resolve_jobspy_boards(config.load_search_config()) == ["linkedin"]


def test_python_profile_writer_rejects_new_conflict_before_save_and_remains_usable(owned_workspace):
    conn = owned_workspace
    _seed(conn, '["indeed"]')
    conn.execute(
        "UPDATE candidate_profiles SET experience_target_locations=?, experience_target_work_models=?",
        ("Synthetic City", "hybrid"),
    )
    conn.execute(
        "INSERT INTO candidate_profile_experience_entries "
        "(tenant_id, profile_id, entry_id, position_index, title, company) "
        "VALUES ('local', 'default', 'owned-role', 0, 'Synthetic role', 'Synthetic employer')"
    )
    conn.commit()
    before = _saved_rows(conn)
    published = []
    repository = SqliteProfileRepository(
        conn, publisher=SimpleNamespace(publish=published.append),
        candidate_interpreter=SimpleNamespace(interpret=lambda _snapshot: None),
    )
    source = repository.load(LOCAL_TENANT).to_dict()
    source["experience"].update({
        "target_role": "Synthetic role", "target_locations": "Synthetic City; ",
        "target_work_models": "hybrid; remote",
    })
    candidate = Profile.from_dict(LOCAL_TENANT, source)
    with pytest.raises(ConfigurationError, match="Indeed.*lookback"):
        repository.save(LOCAL_TENANT, candidate)
    assert _saved_rows(conn) == before
    assert published == []
    assert not conn.in_transaction

    conn.execute("UPDATE discovery_settings SET search_config_json=?", ('{"boards":["linkedin"]}',))
    conn.commit()
    mixed_source = deepcopy(source)
    mixed_source["experience"].update({"target_locations": "", "target_work_models": "remote, hybrid"})
    mixed = Profile.from_dict(LOCAL_TENANT, mixed_source)
    with pytest.raises(ConfigurationError, match="needs a location"):
        repository.save(LOCAL_TENANT, mixed)
    assert published == []
    repository.save(LOCAL_TENANT, candidate)
    assert _saved_rows(conn)[1][1:3] == ("Synthetic City; ", "hybrid; remote")
    assert len(published) == 1
    before_separate = _saved_rows(conn)
    separate = deepcopy(source)
    separate["experience"].update({
        "target_locations": "Synthetic City; ; ", "target_work_models": "hybrid; remote; hybrid",
    })
    with pytest.raises(ConfigurationError, match="needs a location"):
        repository.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, separate))
    assert _saved_rows(conn) == before_separate
    assert len(published) == 1

    # Clearing the Profile target exposes an older saved legacy Remote row.
    conn.execute(
        "UPDATE discovery_settings SET search_config_json=?",
        ('{"boards":["indeed"],"locations":[{"location":"","remote":true}]}',),
    )
    conn.commit()
    before_clear = _saved_rows(conn)
    cleared = deepcopy(source)
    cleared["experience"].update({"target_locations": "", "target_work_models": ""})
    with pytest.raises(ConfigurationError, match="Indeed.*lookback"):
        repository.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, cleared))
    assert _saved_rows(conn) == before_clear
    assert len(published) == 1


def test_python_settings_writer_checks_effective_legacy_remote_rows(owned_workspace):
    conn = owned_workspace
    _seed(conn, '["linkedin"]')
    legacy = '{ "boards": ["linkedin"], "defaults": {"hours_old": 48}, "locations": [{"location":"","remote":true}] }'
    conn.execute("UPDATE discovery_settings SET search_config_json=?", (legacy,))
    conn.execute("UPDATE candidate_profiles SET experience_target_locations='', experience_target_work_models=''")
    conn.commit()
    before = _saved_rows(conn)
    with pytest.raises(ConfigurationError, match="Indeed.*lookback"):
        config._save_discovery_search_config_to_db({
            "boards": ["linkedin", "indeed"], "defaults": {"hours_old": 48},
            "locations": [{"location": "", "remote": True}],
        })
    assert _saved_rows(conn) == before


def test_python_settings_writer_honors_location_labels_and_guards_newly_selected_rows(owned_workspace):
    conn = owned_workspace
    _seed(conn, '["linkedin"]')
    saved = {
        "boards": ["linkedin"], "defaults": {"hours_old": 48}, "location_labels": ["City"],
        "locations": [{"label": "Remote", "location": "", "remote": True},
                      {"label": "City", "location": "Synthetic City", "remote": False}],
    }
    conn.execute("UPDATE discovery_settings SET search_config_json=?", (json.dumps(saved),))
    conn.execute("UPDATE candidate_profiles SET experience_target_locations='', experience_target_work_models=''")
    conn.commit()
    with_indeed = {**saved, "boards": ["linkedin", "indeed"]}
    config._save_discovery_search_config_to_db(with_indeed)
    before = _saved_rows(conn)
    with pytest.raises(ConfigurationError, match="Indeed.*lookback"):
        config._save_discovery_search_config_to_db({**with_indeed, "location_labels": ["Remote"]})
    assert _saved_rows(conn) == before


def test_actual_source_uses_frozen_tiers_and_location_labels_after_settings_change(owned_workspace, monkeypatch):
    conn = owned_workspace
    original = {
        "boards": ["linkedin"], "defaults": {"hours_old": 48, "results_per_site": 10},
        "queries": [{"query": "Synthetic A", "tier": 1}, {"query": "Synthetic B", "tier": 2}],
        "locations": [{"label": "Remote", "location": "", "remote": True},
                      {"label": "City", "location": "Synthetic City", "remote": False}],
        "tiers": [1], "location_labels": ["Remote"],
    }
    raw = json.dumps(original)
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,))
    conn.commit()
    execution = DiscoveryExecutionRef("local", "owned-filtered-search", "owned-run")
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *_a, **_k: _registry(_LinkedIn)
    )
    plan = runner.plan_discovery_source_families(discovery_execution=execution)

    changed = {**original, "tiers": [2], "location_labels": ["City"]}
    updated = json.dumps(changed)
    conn.execute("UPDATE discovery_settings SET search_config_json=?", (updated,))
    conn.commit()
    for attempt in (1, 2):
        result = runner.run_discovery_source_family(
            "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
            activity_attempt=attempt, activity_owner_token=f"owned-{attempt}",
        )
        assert result["status"] == "ok"
        assert [(request.search_term, request.location, request.is_remote) for request in _LinkedIn.requests] == [
            ("Synthetic A", None, True),
        ]
        assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == updated
    assert plan["next_run_settings"]["tiers"] == [1]
    assert plan["next_run_settings"]["location_labels"] == ["Remote"]


def test_new_snapshot_freezes_absent_filters_and_old_snapshot_keeps_live_fallback():
    saved = runner._snapshot_discovery_next_run_settings({"boards": ["linkedin"]})
    current = {"tiers": [2], "location_labels": ["City"]}
    frozen = runner._apply_discovery_next_run_settings(current, saved)
    assert frozen["tiers"] is None and frozen["location_labels"] is None
    old = {key: value for key, value in saved.items() if key not in {"tiers", "location_labels"}}
    prior = runner._apply_discovery_next_run_settings(current, old)
    assert prior["tiers"] == [2] and prior["location_labels"] == ["City"]


@pytest.mark.parametrize("absent", ["locations", "queries"])
def test_empty_plan_remains_empty_after_profile_save_and_retry(owned_workspace, monkeypatch, absent):
    conn = owned_workspace
    original = {
        "boards": ["linkedin"], "defaults": {"hours_old": 48, "results_per_site": 10},
        "tiers": [1], "location_labels": ["Remote"],
    }
    if absent == "locations":
        original["queries"] = [{"query": "Synthetic role", "tier": 1}]
    else:
        original["locations"] = [{"label": "Remote", "location": "", "remote": True}]
    raw = json.dumps(original)
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,))
    conn.execute(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, version, updated_at) "
        "VALUES ('local', 'default', 1, 'updated')"
    )
    conn.execute(
        "INSERT INTO candidate_profile_experience_entries "
        "(tenant_id, profile_id, entry_id, position_index, title, company) "
        "VALUES ('local', 'default', 'owned-role', 0, 'Synthetic role', 'Synthetic employer')"
    )
    conn.commit()
    execution = DiscoveryExecutionRef("local", f"owned-empty-{absent}", "owned-run")
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *_a, **_k: _registry(_LinkedIn)
    )
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    repository = SqliteProfileRepository(
        conn, publisher=SimpleNamespace(publish=lambda _event: None),
        candidate_interpreter=SimpleNamespace(interpret=lambda _snapshot: None),
    )
    profile = repository.load(LOCAL_TENANT).to_dict()
    if absent == "locations":
        profile["experience"]["target_work_models"] = "remote"
    else:
        profile["experience"]["target_role"] = "Synthetic role"
    repository.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, profile))
    after_save = _saved_rows(conn)
    assert after_save[0] == raw

    for attempt in (1, 2):
        result = runner.run_discovery_source_family(
            "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
            activity_attempt=attempt, activity_owner_token=f"owned-{attempt}",
        )
        assert result["status"] == "ok"
        assert _LinkedIn.requests == []
        assert SqliteDiscoverySearchUnitRepository(conn).list_units(execution) == []
        assert _saved_rows(conn) == after_save
    assert plan["next_run_settings"][absent] == []
    assert plan["next_run_settings"]["tiers"] == [1]
    assert plan["next_run_settings"]["location_labels"] == ["Remote"]


def test_new_snapshot_freezes_empty_arrays_and_historical_none_retains_live_fallback():
    saved = runner._snapshot_discovery_next_run_settings({"boards": ["linkedin"]})
    assert saved["queries"] == []
    assert saved["locations"] == []
    current = {
        "queries": [{"query": "Synthetic role", "tier": 1}],
        "locations": [{"label": "Remote", "location": "", "remote": True}],
    }
    frozen = runner._apply_discovery_next_run_settings(current, saved)
    assert frozen["queries"] == [] and frozen["locations"] == []
    historical = {**saved, "queries": None, "locations": None}
    prior = runner._apply_discovery_next_run_settings(current, historical)
    assert prior["queries"] == current["queries"] and prior["locations"] == current["locations"]
    omitted = {key: value for key, value in saved.items() if key not in {"queries", "locations"}}
    prior_omitted = runner._apply_discovery_next_run_settings(current, omitted)
    assert prior_omitted["queries"] == current["queries"] and prior_omitted["locations"] == current["locations"]
