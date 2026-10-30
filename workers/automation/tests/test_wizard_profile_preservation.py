"""Full wizard Profile preservation in owned synthetic workspaces."""
from __future__ import annotations

import json
import socket
import sqlite3
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from jobctrl import cli, config, database
from jobctrl.discovery import jobspy
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository, _CHILD_TABLES
from jobctrl.pipeline import runner
from jobctrl.wizard import init as wizard
from tests.test_location_free_remote_discovery import _LinkedIn, _NoopLimiter, _ZipRecruiter, _registry


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
    monkeypatch.setattr(socket.socket, "connect", lambda *_a, **_k: pytest.fail("network access is forbidden"))
    _LinkedIn.requests = []
    _ZipRecruiter.requests = []
    yield conn
    database.close_connection(db_path)


def _profile(role="Canonical synthetic role"):
    return {
        "personal": {"full_name": "Owned candidate", "city": "Synthetic City"},
        "experience": {
            "target_role": role, "target_track": "Synthetic track", "target_seniority_floor": "Synthetic seniority",
            "target_functions": "Synthetic function", "target_specializations": "Synthetic specialization",
            "target_locations": "Synthetic City; ", "target_work_models": "hybrid; remote",
        },
        "resume": {
            "executive_profile": {"baseline_text": "Owned synthetic profile."},
            "experience_entries": [{
                "id": "owned-role", "title": "Synthetic role", "company": "Synthetic employer",
                "date_range": "2020 -- Present", "location": "Synthetic City", "bullets": ["Synthetic bullet."],
            }],
            "education_entries": [{"id": "owned-school", "degree": "Synthetic degree", "institution": "Owned school"}],
            "skill_categories": [{"id": "owned-skills", "label": "Synthetic skills", "items": ["Synthetic skill"]}],
            "tailoring_rules": {"required_experience_entry_ids": ["owned-role"], "required_skill_category_ids": ["owned-skills"]},
        },
    }


def _profile_rows(conn):
    return {
        table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
        for table in ("candidate_profiles", *_CHILD_TABLES)
    }


def _repository(conn):
    return SqliteProfileRepository(
        conn, publisher=SimpleNamespace(publish=lambda _event: None),
        candidate_interpreter=SimpleNamespace(interpret=lambda _snapshot: None),
    )


def _save_concurrent_profile(profile):
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _repository(conn).save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, profile))
    finally:
        conn.close()


def _prepare_wizard(monkeypatch, conn, *, accept_filter, before_search=None, real_steps=False):
    monkeypatch.setattr(wizard, "DB_PATH", config.DB_PATH)
    monkeypatch.setattr(wizard, "ensure_dirs", lambda: None)
    if not real_steps:
        monkeypatch.setattr(wizard, "_setup_resume", lambda: None)
        monkeypatch.setattr(wizard, "_setup_ai_features", lambda: None)
        monkeypatch.setattr(wizard, "_setup_auto_apply", lambda **_kwargs: None)
    monkeypatch.setattr(wizard, "get_profile_repository", lambda: _repository(conn))
    monkeypatch.setattr(config, "get_tier", lambda: 1)
    monkeypatch.setattr(runner, "_load_source_quality_snapshots", lambda: ())
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *_a, **_k: _registry(_LinkedIn),
    )
    triggered = False

    def ask(question, default=None, **_kwargs):
        nonlocal triggered
        if question.startswith("Target location (e.g."):
            if before_search is not None and not triggered:
                triggered = True
                before_search()
            return "Wizard synthetic city"
        if question.startswith("Search radius"):
            return "0"
        if question.startswith("Target job titles"):
            return "Wizard synthetic role"
        if question.startswith("Bullets"):
            return "Wizard synthetic bullet"
        if question.startswith("Items ("):
            return "Wizard synthetic skill"
        if default is not None and str(default).strip():
            return str(default)
        return "Wizard synthetic value"

    def confirm(question, **_kwargs):
        return accept_filter if question.startswith("Clear the saved") else False

    monkeypatch.setattr(wizard.Prompt, "ask", ask)
    monkeypatch.setattr(wizard.Confirm, "ask", confirm)


def _seed(conn):
    raw = (
        '{ "boards": ["linkedin"], "defaults": {"hours_old": 48, "country_indeed": "canada"}, '
        '"tiers": [2], "locations": [{"location": "Old city", "remote": false}], '
        '"queries": [{"query": "Old role", "tier": 2}], "synthetic_note": "preserve" }'
    )
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,))
    conn.commit()
    _repository(conn).save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, _profile()))
    return raw


@pytest.mark.parametrize("accept_filter", [False, True])
def test_full_wizard_retains_existing_profile_and_reports_target_precedence(owned_workspace, monkeypatch, accept_filter):
    conn = owned_workspace
    raw = _seed(conn)
    before = _profile_rows(conn)
    assert tuple(conn.execute(
        "SELECT experience_target_role, experience_target_track, experience_target_seniority_floor, "
        "experience_target_functions, experience_target_specializations, experience_target_locations, "
        "experience_target_work_models FROM candidate_profiles"
    ).fetchone()) == (
        "Canonical synthetic role", "Synthetic track", "Synthetic seniority", "Synthetic function",
        "Synthetic specialization", "Synthetic City; ", "hybrid; remote",
    )
    for table in (
        "candidate_profile_experience_entries", "candidate_profile_experience_bullets",
        "candidate_profile_education_entries", "candidate_profile_skill_categories", "candidate_profile_skill_items",
        "candidate_profile_required_experience_entries", "candidate_profile_required_skill_categories",
    ):
        assert before[table]
    _prepare_wizard(monkeypatch, conn, accept_filter=accept_filter)

    result = CliRunner().invoke(cli.app, ["init"])
    assert _profile_rows(conn) == before
    assert "profile" in result.output.lower() and "precedence" in result.output.lower()
    saved_bytes = conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0]
    if not accept_filter:
        assert result.exit_code == 1
        assert saved_bytes == raw
        return
    assert result.exit_code == 0, result.output
    saved = json.loads(saved_bytes)
    assert saved["tiers"] == [] and saved["synthetic_note"] == "preserve"
    assert saved["boards"] == ["linkedin"] and saved["defaults"]["hours_old"] == 48
    execution = DiscoveryExecutionRef("local", "owned-full-wizard", "owned-run")
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    source = runner.run_discovery_source_family(
        "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
        activity_attempt=1, activity_owner_token="owned-wizard-1",
    )
    assert source["status"] == "ok"
    assert [(request.search_term, request.location, request.is_remote, request.hours_old) for request in _LinkedIn.requests] == [
        ("Canonical synthetic role", "Synthetic City", False, 48),
        ("Canonical synthetic role", None, True, 48),
    ]
    assert _profile_rows(conn) == before
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == saved_bytes


@pytest.mark.parametrize("change_kind", ["versioned", "same_version"])
def test_full_wizard_refuses_search_save_after_profile_changes(owned_workspace, monkeypatch, change_kind):
    conn = owned_workspace
    raw = _seed(conn)
    after_concurrent = []

    def update_profile():
        if change_kind == "versioned":
            _save_concurrent_profile(_profile("Concurrent synthetic role"))
        else:
            other = sqlite3.connect(config.DB_PATH)
            try:
                other.execute("UPDATE candidate_profiles SET experience_target_role='Concurrent synthetic role'")
                other.commit()
            finally:
                other.close()
        after_concurrent.append(_profile_rows(conn))

    _prepare_wizard(monkeypatch, conn, accept_filter=True, before_search=update_profile)
    result = CliRunner().invoke(cli.app, ["init"])
    assert result.exit_code == 1
    assert "profile" in result.output.lower() and "changed" in result.output.lower()
    assert after_concurrent and _profile_rows(conn) == after_concurrent[0]
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == raw


def test_first_use_full_wizard_creates_profile_and_runs_exact_synthetic_search(owned_workspace, monkeypatch):
    conn = owned_workspace
    _prepare_wizard(monkeypatch, conn, accept_filter=False)
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry",
        lambda *_a, **_k: _registry(_LinkedIn, _ZipRecruiter),
    )
    result = CliRunner().invoke(cli.app, ["init"])
    assert result.exit_code == 0, result.output
    assert "precedence" in result.output.lower()
    profile_rows = _profile_rows(conn)
    assert len(profile_rows["candidate_profiles"]) == 1
    assert profile_rows["candidate_profile_experience_entries"]
    saved_bytes = conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0]
    assert json.loads(saved_bytes)["boards"] == ["linkedin", "zip_recruiter"]
    execution = DiscoveryExecutionRef("local", "owned-first-use-full-wizard", "owned-run")
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    source = runner.run_discovery_source_family(
        "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
        activity_attempt=1, activity_owner_token="owned-first-wizard-1",
    )
    assert source["status"] == "ok"
    for adapter in (_LinkedIn, _ZipRecruiter):
        assert [(r.search_term, r.location, r.is_remote, r.hours_old) for r in adapter.requests] == [
            ("Wizard synthetic value", "Wizard synthetic city", True, 72),
        ]
    assert _profile_rows(conn) == profile_rows
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == saved_bytes


def test_first_use_wizard_does_not_replace_profile_created_during_prompts(owned_workspace, monkeypatch):
    conn = owned_workspace
    raw = '{ "boards": ["linkedin"], "defaults": {"hours_old": 48}, "synthetic_note": "preserve" }'
    conn.execute("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')", (raw,))
    conn.commit()
    _prepare_wizard(monkeypatch, conn, accept_filter=False)
    original_ask = wizard.Prompt.ask
    concurrent_rows = []

    def ask_after_concurrent_create(question, **kwargs):
        if question == "Full name" and not concurrent_rows:
            _save_concurrent_profile(_profile("Concurrent synthetic role"))
            concurrent_rows.append(_profile_rows(conn))
        return original_ask(question, **kwargs)

    monkeypatch.setattr(wizard.Prompt, "ask", ask_after_concurrent_create)
    result = CliRunner().invoke(cli.app, ["init"])
    assert result.exit_code == 1
    text = " ".join(result.output.lower().split())
    assert "profile was created" in text and "not changed" in text
    assert concurrent_rows and _profile_rows(conn) == concurrent_rows[0]
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0] == raw
