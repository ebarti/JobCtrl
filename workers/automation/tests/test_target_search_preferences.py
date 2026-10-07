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
        "locations": ["Authored location A", "Authored location B"],
        "work_models": ["On-site", "Hybrid", "Remote"],
    }
    result = config._apply_profile_target_search(raw, target)
    assert result["locations"] == [
        {"label": place, "location": place, "remote": remote}
        for place in target["locations"]
        for remote in (False, True)
    ]
    assert result["defaults"] == raw["defaults"]
    assert result["confirmed_targets"] == target


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
