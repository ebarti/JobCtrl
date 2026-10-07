"""Saved controls are authoritative; only posting judgments call the model."""

from copy import deepcopy
import json
import sqlite3
import pytest
from jobctrl import config
from jobctrl.discovery.target_queries import query_applies_to_source
from jobctrl.infrastructure.discovery.triage import triage_listings
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from tests.test_discovery_determinations import setup, CFG, Model, listings


@pytest.mark.parametrize("scope", ["jobspy", "ats_api", "workday", "smartextract"])
def test_query_source_scope_is_a_literal_code(scope):
    assert query_applies_to_source({"query": "Literal query", "source_scope": [scope]}, scope)
    assert not query_applies_to_source(
        {"query": "Literal query", "source_scope": ["ats_api" if scope != "ats_api" else "jobspy"]}, scope
    )


def test_saved_search_roles_execute_literally_without_a_second_approval():
    raw = {
        "queries": [{"query": "Old configured query", "tier": 2}],
        "locations": [{"location": "Saved board location", "remote": False}],
        "defaults": {"country_indeed": "saved-country-parameter"},
    }
    target = {"roles": ["Authored role A", "Authored role B"], "profile_version": 7}
    original = deepcopy(raw)
    result = config._apply_profile_target_search(raw, target)
    assert result["queries"] == [
        {"query": "Authored role A", "tier": 1},
        {"query": "Authored role B", "tier": 1},
    ]
    assert result["locations"] == raw["locations"]
    assert result["defaults"] == raw["defaults"]
    assert result["confirmed_targets"] == target
    assert raw == original


@pytest.mark.parametrize("verdict", ["admit", "reject"])
def test_saved_targets_go_directly_to_intake_without_interpretation_or_confirmation(verdict):
    model = Model(verdict)
    conn, deps = setup(model)
    cfg = {**CFG, "confirmed_targets": {"roles": ["Authored target"], "tracks": ["management"], "profile_version": 7}}
    assert triage_listings(conn, listings(1), search_cfg=cfg, dependencies=deps) == {"listing-0": verdict}
    assert len(model.calls) == 1
    sources = {source["source_id"]: source["text"] for source in model.calls[0]["sources"]}
    assert sources["target:roles:0"] == "Authored target"
    assert sources["target:tracks:0"] == "management"


def test_saved_config_loads_literal_queries_and_criteria_without_touching_the_profile(tmp_path, monkeypatch):
    db_path = tmp_path / "jobctrl.db"
    settings = tmp_path / "config.json"
    settings.write_text(
        json.dumps({"score_criteria": "Authored scoring criteria", "target_criteria": "Authored target criteria"})
    )
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings))
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    create_exact_v14_schema(conn)
    conn.execute(
        "INSERT INTO candidate_profiles(tenant_id,profile_id,version,experience_target_role,updated_at) VALUES('local','default',7,'Authored role','2026-10-07')"
    )
    conn.commit()
    before = dict(conn.execute("SELECT * FROM candidate_profiles").fetchone())
    result = config.load_search_config()
    assert result["queries"] == [{"query": "Authored role", "tier": 1}]
    assert result["confirmed_targets"]["profile_version"] == 7
    assert result["confirmed_targets"]["criteria"] == ["Authored scoring criteria", "Authored target criteria"]
    assert dict(conn.execute("SELECT * FROM candidate_profiles").fetchone()) == before
    assert conn.execute("SELECT count(*) FROM semantic_determinations").fetchone()[0] == 0
    conn.close()


def test_location_and_work_model_controls_execute_without_geography_inference():
    raw = {"defaults": {"country_indeed": "saved-board-parameter"}}
    target = {
        "locations": ["Authored location A", ""],
        "work_models": ["hybrid, onsite", "remote"],
    }
    result = config._apply_profile_target_search(raw, target)
    assert result["locations"] == [
        {"label": "Authored location A", "location": "Authored location A", "remote": False},
        {"label": "Remote", "location": "", "remote": True},
    ]
    assert result["defaults"] == raw["defaults"]
    assert result["confirmed_targets"] == target


def _saved_location_rows(tmp_path, monkeypatch, locations, models):
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = sqlite3.connect(db_path)
    create_exact_v14_schema(conn)
    conn.execute(
        "INSERT INTO candidate_profiles(tenant_id,profile_id,version,experience_target_locations,experience_target_work_models,updated_at) VALUES('local','default',7,?,?,'2026-10-07')",
        (locations, models),
    )
    conn.commit()
    conn.close()


def test_profile_editor_serialized_rows_become_their_own_board_parameters(tmp_path, monkeypatch):
    _saved_location_rows(tmp_path, monkeypatch, "Authored location A; Authored location B; ", "Hybrid; onsite; remote")
    assert config.load_search_config()["locations"] == [
        {"label": "Authored location A", "location": "Authored location A", "remote": False},
        {"label": "Authored location B", "location": "Authored location B", "remote": False},
        {"label": "Remote", "location": "", "remote": True},
    ]


def test_multiple_editor_choices_in_one_row_decode_exact_codes(tmp_path, monkeypatch):
    _saved_location_rows(tmp_path, monkeypatch, "Authored location", "remote, hybrid, onsite")
    assert config.load_search_config()["locations"] == [
        {"label": "Authored location", "location": "Authored location", "remote": True},
        {"label": "Authored location", "location": "Authored location", "remote": False},
    ]


def test_invalid_board_control_only_blocks_planning_and_keeps_raw_sources(tmp_path, monkeypatch):
    from jobctrl.discovery import activities
    from jobctrl.infrastructure.network.politeness import PolitenessGateway
    from temporalio.exceptions import ApplicationError

    _saved_location_rows(tmp_path, monkeypatch, "Authored location", "unsupported_saved_value")
    assert PolitenessGateway().user_agent.startswith("JobCtrl/")
    assert config.load_source_registry()
    assert config.load_saved_search_settings()["confirmed_targets"]["work_models"] == ["unsupported_saved_value"]
    monkeypatch.setattr(activities, "begin_pipeline_step_attempt", lambda _scope: None)
    with pytest.raises(ApplicationError) as raised:
        activities.plan_discovery_sources(activities.PlanDiscoverySourcesInput(tenant_id="local"))
    assert raised.value.type == "invalid_saved_work_model"
    assert raised.value.non_retryable
    assert "unsupported_saved_value" not in str(raised.value)


def test_scoring_reads_saved_sources_without_materializing_board_controls(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from jobctrl.scoring import scorer
    from jobctrl.domain.determinations import DeterminationFailure

    _saved_location_rows(tmp_path, monkeypatch, "Authored location", "unsupported_saved_value")
    monkeypatch.setattr(scorer, "ScoreJobUseCase", lambda **kwargs: SimpleNamespace(**kwargs))
    use_case = scorer._build_use_case(
        repository=object(),
        determination_dependencies={"llm": None},
        job_interpretation_reader=lambda _job: None,
    )
    criteria = SimpleNamespace(criteria_text="Authored criteria", target_criteria=None)
    sources = use_case.confirmed_preferences_reader(SimpleNamespace(version=7), criteria)
    assert {source.source_id: source.text for source in sources}["target:work_models:0"] == "unsupported_saved_value"
    with pytest.raises(DeterminationFailure) as raised:
        use_case.confirmed_preferences_reader(SimpleNamespace(version=8), criteria)
    assert raised.value.code == "stale_profile_version"


def test_unchanged_literal_settings_preserve_native_board_parameters():
    raw = {
        "queries": [{"query": "Authored query", "tier": 2, "source_scope": ["jobspy"]}],
        "locations": [{"location": "Authored location", "remote": True}],
        "defaults": {"country_indeed": "saved-board-parameter"},
    }
    result = config._apply_profile_target_search(raw, {"profile_version": 1})
    assert result == {**raw, "confirmed_targets": {"profile_version": 1}}


def test_intake_captures_saved_sources_for_each_settings_version():
    model = Model()
    conn, deps = setup(model)
    first = {**CFG, "confirmed_targets": {"roles": ["First saved target"], "profile_version": 7}}
    second = {**CFG, "confirmed_targets": {"roles": ["Second saved target"], "profile_version": 8}}
    triage_listings(conn, listings(1), search_cfg=first, dependencies=deps)
    triage_listings(conn, listings(1), search_cfg=second, dependencies=deps)
    captured = [
        json.loads(row[0]) for row in conn.execute("SELECT listing_json FROM posting_triage ORDER BY created_at")
    ]
    assert [row["profile_version"] for row in captured] == [7, 8]
    assert [row["target_sources"] for row in captured] == [
        [{"source_id": "target:roles:0", "text": "First saved target"}],
        [{"source_id": "target:roles:0", "text": "Second saved target"}],
    ]
    triage_listings(conn, listings(1), search_cfg=first, dependencies={**deps, "llm": None})
    assert len(model.calls) == 2
