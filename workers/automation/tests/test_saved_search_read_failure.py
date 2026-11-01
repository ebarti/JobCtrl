"""Saved search authority is never replaced by first-use defaults on read failure."""

import json
import sqlite3

import pytest
from temporalio.exceptions import ApplicationError

from jobctrl import config, database
from jobctrl.discovery import activities, jobspy
from jobctrl.domain.errors import InvalidSavedSearchError, SavedSearchReadError
from jobctrl.pipeline import runner


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(tmp_path / "config.json"))
    monkeypatch.setattr(config, "load_sites_config", lambda: {})
    monkeypatch.setattr(config, "load_employers_config", lambda: {})
    monkeypatch.setattr(activities, "begin_pipeline_step_attempt", lambda _scope: None)
    conn = database.init_db(db_path)
    yield conn
    database.close_connection(db_path)


def _save_intent(conn):
    # Deliberate formatting lets the test prove exact persisted bytes survive.
    raw = '{ "boards": ["linkedin"], "defaults": {"results_per_site": 10} }'
    conn.execute(
        "INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,)
    )
    conn.execute(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, version, "
        "experience_target_role, experience_target_locations, experience_target_work_models, updated_at) "
        "VALUES ('local', 'default', 7, ?, ?, ?, 'updated')",
        ("Synthetic role A; Synthetic role B", "Synthetic city;", "hybrid;remote"),
    )
    conn.commit()
    return raw


def _saved_bytes(conn):
    return (
        conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0],
        tuple(conn.execute(
            "SELECT experience_target_role, experience_target_locations, "
            "experience_target_work_models, version FROM candidate_profiles"
        ).fetchone()),
    )


def test_first_use_absence_keeps_documented_defaults(tmp_path, monkeypatch, workspace):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "not-created.db")
    absent = config.load_search_config()
    assert absent["boards"] == list(config.DEFAULT_JOBSPY_BOARDS)
    assert absent["queries"] == config.DEFAULT_DISCOVERY_SEARCH_CONFIG["queries"]
    assert absent["confirmed_targets"]["roles"] == []
    sqlite3.connect(config.DB_PATH).close()
    assert config.load_search_config() == absent
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "jobctrl.db")
    assert config.load_search_config() == absent
    assert workspace.execute("SELECT count(*) FROM discovery_settings").fetchone()[0] == 0


@pytest.mark.parametrize("raw", [
    '{"private":"synthetic secret",',
    "",
    "null",
    "[]",
    '{"boards": null}',
    '{"boards": "synthetic secret"}',
    '{"queries": [null]}',
    '{"queries": [{}]}',
    '{"queries": [{"query": "Synthetic role", "tier": "synthetic secret"}]}',
    '{"locations": [{"location": "Synthetic city", "remote": "false"}]}',
    '{"defaults": 1}',
    '{"boards": ["linkedin"], "defaults": {"results_per_site": null}}',
    '{"defaults": {"results_per_site": "synthetic secret"}}',
    '{"defaults": {"hours_old": 0}}',
    '{"max_parallel_families": "synthetic secret"}',
    '{"automation": {"min_fit_score": "synthetic secret"}}',
    '{"automation": {"apply_approval_required": "synthetic secret"}}',
    '{"crawl_user_agent": {"use_browser_headers": "synthetic secret"}}',
    '{"exact_title_exclusions": "synthetic secret"}',
    '{"boards": ["linkedin", "synthetic secret"]}',
    '{"extra": NaN}',
    sqlite3.Binary(b"synthetic secret"),
])
def test_corrupt_saved_settings_refuse_planning_and_preserve_bytes(workspace, monkeypatch, raw):
    _save_intent(workspace)
    workspace.execute("UPDATE discovery_settings SET search_config_json=?", (raw,))
    workspace.commit()
    before = _saved_bytes(workspace)
    calls = []
    monkeypatch.setattr(jobspy, "run_discovery", lambda **kwargs: calls.append(kwargs))
    with pytest.raises(ApplicationError) as raised:
        activities.plan_discovery_sources(activities.PlanDiscoverySourcesInput(tenant_id="local"))
    assert raised.value.type == "invalid_saved_search"
    assert raised.value.non_retryable is True
    assert "restore a verified backup" in str(raised.value)
    assert "synthetic secret" not in str(raised.value)
    with pytest.raises(InvalidSavedSearchError):
        runner.run_discovery_source_family("jobspy")
    assert calls == []
    assert _saved_bytes(workspace) == before


@pytest.mark.parametrize("field", [
    "experience_target_role", "experience_target_locations", "experience_target_work_models",
])
def test_corrupt_profile_target_refuses_planning_and_preserves_bytes(workspace, field):
    _save_intent(workspace)
    workspace.execute(f"UPDATE candidate_profiles SET {field}=?", (sqlite3.Binary(b"synthetic secret"),))
    workspace.commit()
    before = _saved_bytes(workspace)
    with pytest.raises(InvalidSavedSearchError, match="Candidate Profile") as raised:
        config.load_search_config()
    assert "synthetic secret" not in str(raised.value)
    assert _saved_bytes(workspace) == before


@pytest.mark.parametrize("failed_query", ["discovery_settings", "candidate_profiles"])
def test_temporary_read_failure_blocks_provider_and_retry_retains_intent(workspace, monkeypatch, failed_query):
    _save_intent(workspace)
    before = _saved_bytes(workspace)
    calls = []
    monkeypatch.setattr(jobspy, "run_discovery", lambda **kwargs: calls.append(kwargs) or {"new": 0, "existing": 0})
    original_connect = sqlite3.connect

    class FailedRead:
        def __init__(self, conn):
            object.__setattr__(self, "conn", conn)

        def __setattr__(self, name, value):
            setattr(self.conn, name, value)

        def execute(self, sql, *args):
            if f"FROM {failed_query}" in sql:
                raise sqlite3.OperationalError("synthetic secret")
            return self.conn.execute(sql, *args)

        def close(self):
            self.conn.close()

    def connect(*args, **kwargs):
        conn = original_connect(*args, **kwargs)
        return FailedRead(conn) if kwargs.get("uri") else conn

    with monkeypatch.context() as failure:
        failure.setattr(config.sqlite3, "connect", connect)
        with pytest.raises(ApplicationError) as raised:
            activities.plan_discovery_sources(activities.PlanDiscoverySourcesInput(tenant_id="local"))
        assert raised.value.type == "saved_search_unavailable"
        assert raised.value.non_retryable is False
        assert "synthetic secret" not in str(raised.value)
        with pytest.raises(SavedSearchReadError):
            runner.run_discovery_source_family("jobspy")
        assert calls == []
        assert _saved_bytes(workspace) == before

    plan = runner.plan_discovery_source_families()
    assert "jobspy" in plan["families"]
    runner.run_discovery_source_family("jobspy")
    assert len(calls) == 1
    assert calls[0]["cfg"]["boards"] == ["linkedin"]
    assert calls[0]["cfg"]["queries"] == [
        {"query": "Synthetic role A", "tier": 1}, {"query": "Synthetic role B", "tier": 1},
    ]
    assert calls[0]["cfg"]["locations"] == [
        {"label": "Synthetic city", "location": "Synthetic city", "remote": False},
        {"label": "Remote", "location": "", "remote": True},
    ]
    assert _saved_bytes(workspace) == before


def test_legacy_board_selection_remains_frozen_across_settings_change_and_retry(workspace, monkeypatch):
    _save_intent(workspace)
    raw = '{ "sites": ["glassdoor"], "defaults": {"results_per_site": 10} }'
    workspace.execute("UPDATE discovery_settings SET search_config_json=?", (raw,))
    workspace.commit()
    calls = []
    monkeypatch.setattr(jobspy, "run_discovery", lambda **kwargs: calls.append(kwargs) or {"new": 0, "existing": 0})
    plan = runner.plan_discovery_source_families()
    updated = '{ "boards": ["linkedin"], "defaults": {"results_per_site": 20} }'
    workspace.execute("UPDATE discovery_settings SET search_config_json=?", (updated,))
    workspace.commit()
    before_retry = _saved_bytes(workspace)

    for _attempt in range(2):
        runner.run_discovery_source_family("jobspy", next_run_settings=plan["next_run_settings"])
        assert calls[-1]["cfg"]["boards"] == ["glassdoor"]
        assert [item["query"] for item in calls[-1]["cfg"]["queries"]] == ["Synthetic role A", "Synthetic role B"]
        assert calls[-1]["cfg"]["locations"][0]["location"] == "Synthetic city"
        assert _saved_bytes(workspace) == before_retry


@pytest.mark.parametrize("raw", [
    '{"boards": [], "sites": ["linkedin"]}',
    '{"boards": ["linkedin"], "sites": []}',
])
def test_legacy_empty_board_alias_keeps_the_selected_board(workspace, raw):
    _save_intent(workspace)
    workspace.execute("UPDATE discovery_settings SET search_config_json=?", (raw,))
    workspace.commit()
    before = _saved_bytes(workspace)
    cfg = config.load_search_config()
    assert config.resolve_jobspy_boards(cfg, warn=False) == ["linkedin"]
    assert runner.plan_discovery_source_families()["next_run_settings"]["boards"] == ["linkedin"]
    assert _saved_bytes(workspace) == before


def test_legacy_string_tier_executes_literally_without_rewriting_saved_bytes(workspace, monkeypatch):
    _save_intent(workspace)
    raw = ('{ "boards": ["linkedin"], "queries": [{"query":"Synthetic role","tier":"1"}], '
           '"locations": [{"location":"Synthetic city","remote":false}] }')
    workspace.execute("UPDATE discovery_settings SET search_config_json=?", (raw,))
    workspace.execute(
        "UPDATE candidate_profiles SET experience_target_role='', experience_target_locations='', "
        "experience_target_work_models=''"
    )
    workspace.commit()
    before = _saved_bytes(workspace)
    units = []

    def provider(*, cfg, **_kwargs):
        units.extend(jobspy._durable_search_specs(
            cfg, tiers=[1], locations=None, sites=cfg["boards"], results_per_site=10, hours_old=72,
        ))
        return {"new": 0, "existing": 0}

    monkeypatch.setattr(jobspy, "run_discovery", provider)
    plan = runner.plan_discovery_source_families()
    runner.run_discovery_source_family("jobspy", next_run_settings=plan["next_run_settings"])
    assert [(unit.query, unit.target_location, unit.sites) for unit in units] == [
        ("Synthetic role", "Synthetic city", ("linkedin",)),
    ]
    assert _saved_bytes(workspace) == before


def test_corrupt_criteria_never_fall_back_to_empty(tmp_path, workspace):
    _save_intent(workspace)
    settings = tmp_path / "config.json"
    settings.write_bytes(b'{"target_criteria":"synthetic secret"')
    before = _saved_bytes(workspace)
    with pytest.raises(InvalidSavedSearchError, match="search criteria") as raised:
        config.load_search_config()
    assert "synthetic secret" not in str(raised.value)
    assert settings.read_bytes() == b'{"target_criteria":"synthetic secret"'
    assert _saved_bytes(workspace) == before


def test_missing_profile_columns_cannot_be_treated_as_empty_targets(tmp_path, monkeypatch):
    path = tmp_path / "damaged.db"
    monkeypatch.setattr(config, "DB_PATH", path)
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE candidate_profiles (tenant_id TEXT, profile_id TEXT, version INTEGER)")
        conn.execute("INSERT INTO candidate_profiles VALUES ('local', 'default', 1)")
    with pytest.raises(InvalidSavedSearchError, match="Candidate Profile"):
        config._load_profile_target_search()


def test_python_automation_save_refuses_corrupt_settings(workspace):
    _save_intent(workspace)
    raw = '{"private":"synthetic secret",'
    workspace.execute("UPDATE discovery_settings SET search_config_json=?", (raw,))
    workspace.commit()
    before = _saved_bytes(workspace)
    with pytest.raises(InvalidSavedSearchError) as raised:
        config.save_discovery_automation_settings(auto_apply=False, apply_approval_required=True)
    assert "synthetic secret" not in str(raised.value)
    assert _saved_bytes(workspace) == before


def test_unrelated_crawler_identity_and_source_reads_do_not_require_profile_targets(workspace):
    from jobctrl.infrastructure.network.politeness import PolitenessGateway

    _save_intent(workspace)
    workspace.execute(
        "UPDATE candidate_profiles SET experience_target_role=?", (sqlite3.Binary(b"synthetic secret"),)
    )
    workspace.commit()
    with pytest.raises(InvalidSavedSearchError):
        config.load_search_config()
    assert PolitenessGateway().user_agent.startswith("JobCtrl/")
    assert config.load_discovery_control_settings()["boards"] == ["linkedin"]
    assert config.load_source_registry()


def test_crawler_identity_ignores_invalid_unrelated_discovery_controls(workspace):
    from jobctrl.infrastructure.network.politeness import PolitenessGateway

    _save_intent(workspace)
    raw = '{"defaults":{"results_per_site":"synthetic secret"},"crawl_user_agent":{"product":"SyntheticBot"}}'
    workspace.execute("UPDATE discovery_settings SET search_config_json=?", (raw,))
    workspace.commit()
    with pytest.raises(InvalidSavedSearchError):
        config.load_search_config()
    assert PolitenessGateway().user_agent.startswith("SyntheticBot/")
    assert workspace.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == raw


def test_scoring_uses_its_frozen_profile_without_rereading_broken_live_targets(workspace, monkeypatch):
    from types import SimpleNamespace
    from jobctrl.scoring import scorer

    _save_intent(workspace)
    workspace.execute(
        "UPDATE candidate_profiles SET experience_target_role=?", (sqlite3.Binary(b"synthetic secret"),)
    )
    workspace.commit()
    monkeypatch.setattr(scorer, "ScoreJobUseCase", lambda **kwargs: SimpleNamespace(**kwargs))
    use_case = scorer._build_use_case(
        repository=object(), determination_dependencies={"llm": None}, job_interpretation_reader=lambda _job: None,
    )
    snapshot = SimpleNamespace(version=7, experience={"target_role": "Frozen synthetic role"})
    criteria = SimpleNamespace(criteria_text="", target_criteria="")
    assert {source.source_id: source.text for source in use_case.confirmed_preferences_reader(snapshot, criteria)} == {
        "target:roles:0": "Frozen synthetic role"
    }
    with pytest.raises(InvalidSavedSearchError):
        config.load_search_config()


def test_python_automation_save_holds_lock_across_read_and_write(workspace, monkeypatch):
    _save_intent(workspace)
    original_read = config._read_discovery_search_config
    attempts = []

    def check_lock(conn):
        current = original_read(conn)
        with sqlite3.connect(config.DB_PATH, timeout=0.01) as competing:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                competing.execute("UPDATE discovery_settings SET search_config_json='corrupt'")
        attempts.append(True)
        return current

    monkeypatch.setattr(config, "_read_discovery_search_config", check_lock)
    config.save_discovery_automation_settings(auto_apply=False, apply_approval_required=True)
    assert attempts == [True]
    stored = json.loads(workspace.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0])
    assert stored["boards"] == ["linkedin"]
    assert stored["automation"]["apply_approval_required"] is True


def test_wizard_preflight_refuses_before_any_profile_or_search_write(workspace, monkeypatch):
    from jobctrl.wizard import init as wizard

    _save_intent(workspace)
    workspace.execute("UPDATE discovery_settings SET search_config_json=?", ('{"secret":"synthetic secret",',))
    workspace.commit()
    before = _saved_bytes(workspace)
    monkeypatch.setattr(wizard, "_setup_resume", lambda: pytest.fail("wizard must stop before modifying data"))
    monkeypatch.setattr(wizard, "_setup_profile", lambda: pytest.fail("wizard must stop before modifying data"))
    with pytest.raises(InvalidSavedSearchError) as raised:
        wizard.run_wizard()
    assert "synthetic secret" not in str(raised.value)
    assert _saved_bytes(workspace) == before


def test_wizard_search_write_rechecks_corrupt_settings_under_lock(workspace, monkeypatch):
    from jobctrl.wizard import init as wizard

    _save_intent(workspace)
    workspace.execute("UPDATE discovery_settings SET search_config_json=?", ('{"secret":"synthetic secret",',))
    workspace.commit()
    before = _saved_bytes(workspace)
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)
    answers = iter(["Synthetic city", "0", "Synthetic role"])
    monkeypatch.setattr(wizard.Prompt, "ask", lambda *_args, **_kwargs: next(answers))
    with pytest.raises(InvalidSavedSearchError) as raised:
        wizard._setup_searches()
    assert "synthetic secret" not in str(raised.value)
    assert _saved_bytes(workspace) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [InvalidSavedSearchError, SavedSearchReadError])
async def test_unreadable_schedule_leaves_existing_schedule_unchanged(workspace, monkeypatch, error):
    from jobctrl.cli import _reconcile_discovery_schedule

    def fail():
        raise error("Saved Discovery settings")

    class Client:
        def get_schedule_handle(self, _schedule_id):
            pytest.fail("unreadable settings must not access or replace the schedule")

        async def create_schedule(self, *_args):
            pytest.fail("unreadable settings must not create a schedule")

    monkeypatch.setattr(config, "load_discovery_schedule_settings", fail)
    await _reconcile_discovery_schedule(Client(), "synthetic-queue")
