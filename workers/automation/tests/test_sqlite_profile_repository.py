"""Tests for the SQLite-backed Candidate Profile repository."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import ensure_profile_tables
from jobhunter.domain.events.base import DomainEvent
from jobhunter.domain.profile.aggregate import InvalidProfileError, Profile
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus
from jobhunter.infrastructure.profile.sqlite_repository import SqliteProfileRepository


def _valid_profile() -> dict:
    return {
        "personal": {"full_name": "Jordan Candidate", "email": "jordan@example.com"},
        "work_authorization": {"legally_authorized_to_work": "Yes"},
        "compensation": {"salary_expectation": "120000", "salary_currency": "USD"},
        "experience": {"years_of_experience_total": "5", "target_role": "Platform"},
        "availability": {"earliest_start_date": "Immediately"},
        "eeo_voluntary": {"gender": "Decline to self-identify"},
        "resume": {
            "executive_profile": {"baseline_text": "Backend engineer."},
            "experience_entries": [
                {
                    "id": "role_1",
                    "title": "Software Engineer",
                    "company": "Acme",
                    "date_range": "2022 -- Present",
                    "location": "Remote",
                    "bullets": ["Built APIs.", "Reduced incidents 40%."],
                }
            ],
            "education_entries": [
                {
                    "id": "edu_1",
                    "degree": "BS CS",
                    "institution": "State U",
                    "location": "Springfield",
                    "date": "2019",
                }
            ],
            "skill_categories": [
                {"id": "lang", "label": "Languages", "items": ["Python", "Go"]}
            ],
            "tailoring_rules": {
                "required_experience_entry_ids": ["role_1"],
                "required_education_entry_ids": ["edu_1"],
                "required_skill_category_ids": ["lang"],
                "required_bullets_by_experience_id": {"role_1": ["Built APIs."]},
                "required_skills_by_category_id": {"lang": ["Python"]},
                "max_experience_bullets": 3,
                "tailoring_policy": {"mode": "balanced"},
                "writing_style": {"tone": "technical"},
            },
        },
        "resume_constraints": {"real_metrics": ["40%"]},
    }


def _new_repo(tmp_path: Path) -> tuple[SqliteProfileRepository, sqlite3.Connection, list[DomainEvent]]:
    conn = sqlite3.connect(tmp_path / "jobhunter.db")
    conn.row_factory = sqlite3.Row
    ensure_profile_tables(conn)
    bus = InProcessEventBus()
    events: list[DomainEvent] = []
    bus.subscribe(None, events.append)
    repo = SqliteProfileRepository(
        conn,
        legacy_profile_path=tmp_path / "profile.json",
        legacy_style_path=tmp_path / "resume_style.json",
        legacy_template_path=tmp_path / "resume_template.tex",
        publisher=bus,
    )
    return repo, conn, events


def test_profile_schema_is_normalized_without_profile_json_escape_hatch(tmp_path):
    _, conn, _ = _new_repo(tmp_path)

    tables = {
        row["name"]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'candidate_profile%'"
        )
    }
    assert {
        "candidate_profiles",
        "candidate_profile_experience_entries",
        "candidate_profile_experience_bullets",
        "candidate_profile_achievement_evidence",
        "candidate_profile_education_entries",
        "candidate_profile_skill_categories",
        "candidate_profile_skill_items",
        "candidate_profile_required_experience_entries",
        "candidate_profile_required_education_entries",
        "candidate_profile_required_skill_categories",
        "candidate_profile_required_bullets",
        "candidate_profile_required_skills",
        "candidate_profile_resume_constraint_metrics",
    }.issubset(tables)

    root_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(candidate_profiles)")
    }
    forbidden = {"profile_json", "style_json", "json_blob", "payload_json"}
    assert root_columns.isdisjoint(forbidden)


def test_save_and_load_round_trips_profile_through_relational_rows(tmp_path):
    repo, conn, events = _new_repo(tmp_path)

    snapshot = repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, _valid_profile()))

    assert snapshot.personal["full_name"] == "Jordan Candidate"
    assert conn.execute("SELECT COUNT(*) FROM candidate_profiles").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM candidate_profile_experience_entries").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM candidate_profile_experience_bullets").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM candidate_profile_skill_items").fetchone()[0] == 2
    root = conn.execute(
        "SELECT writing_tone, max_experience_bullets FROM candidate_profiles"
    ).fetchone()
    assert root["writing_tone"] == "technical"
    assert root["max_experience_bullets"] == 3

    loaded = repo.load(LOCAL_TENANT)
    assert loaded is not None
    assert loaded.to_dict() == Profile.from_dict(LOCAL_TENANT, _valid_profile()).to_dict()
    assert [event.event_type for event in events] == ["ProfileUpdated"]


def test_save_and_load_preserves_achievement_evidence_and_tailoring_controls(tmp_path):
    repo, conn, _ = _new_repo(tmp_path)
    raw = _valid_profile()
    raw["resume"]["experience_entries"][0]["achievement_evidence"] = [
        {
            "id": "ev_role_1_latency",
            "source_text": "Reduced API latency 35% by replacing synchronous enrichment calls.",
            "scope": "owned service",
            "action": "replaced synchronous enrichment calls",
            "tools": ["Python", "PostgreSQL"],
            "metrics": ["35% latency reduction"],
            "outcome": "faster API responses",
            "seniority_signal": "technical ownership",
            "evidence_strength": "verified",
            "claim_confidence": 0.95,
            "user_confirmed": True,
            "tags": ["latency", "backend", "performance"],
        }
    ]
    raw["resume"]["tailoring_rules"]["tailoring_policy"] = {
        "mode": "aggressive",
        "claim_mode": "draft_requires_confirmation",
        "auto_approvable_claim_modes": ["verified_only", "draft_requires_confirmation"],
        "allow_adjacent_achievement_drafts": True,
    }

    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, raw))

    assert conn.execute("SELECT COUNT(*) FROM candidate_profile_achievement_evidence").fetchone()[0] == 1
    root = conn.execute(
        "SELECT tailoring_claim_mode, tailoring_auto_approvable_claim_modes_json, "
        "tailoring_allow_adjacent_achievement_drafts FROM candidate_profiles"
    ).fetchone()
    assert root["tailoring_claim_mode"] == "draft_requires_confirmation"
    assert json.loads(root["tailoring_auto_approvable_claim_modes_json"]) == ["verified_only"]
    assert root["tailoring_allow_adjacent_achievement_drafts"] == 1

    loaded = repo.load(LOCAL_TENANT)
    assert loaded is not None
    loaded_entry = loaded.to_dict()["resume"]["experience_entries"][0]
    assert loaded_entry["achievement_evidence"] == raw["resume"]["experience_entries"][0]["achievement_evidence"]
    assert loaded.to_dict()["resume"]["tailoring_rules"]["tailoring_policy"][
        "auto_approvable_claim_modes"
    ] == ["verified_only"]


def test_legacy_profile_json_seeds_sqlite_once_and_writes_stay_in_sqlite(tmp_path):
    repo, conn, _ = _new_repo(tmp_path)
    legacy_profile = tmp_path / "profile.json"
    legacy_profile.write_text(json.dumps(_valid_profile()), encoding="utf-8")
    (tmp_path / "resume_style.json").write_text(
        json.dumps({"moderncv_style": "classic", "moderncv_color": "blue"}),
        encoding="utf-8",
    )
    (tmp_path / "resume_template.tex").write_text("\\documentclass{moderncv}", encoding="utf-8")

    loaded = repo.load(LOCAL_TENANT)
    assert loaded is not None
    assert loaded.personal.full_name == "Jordan Candidate"
    assert conn.execute("SELECT COUNT(*) FROM candidate_profiles").fetchone()[0] == 1
    rendering = repo.load_rendering_settings(LOCAL_TENANT)
    assert rendering["style"]["moderncv_style"] == "classic"
    assert rendering["style"]["moderncv_color"] == "blue"
    assert rendering["template_text"] == "\\documentclass{moderncv}"

    changed_legacy = _valid_profile()
    changed_legacy["personal"]["full_name"] = "Legacy File Changed"
    legacy_profile.write_text(json.dumps(changed_legacy), encoding="utf-8")

    loaded_again = repo.load(LOCAL_TENANT)
    assert loaded_again is not None
    assert loaded_again.personal.full_name == "Jordan Candidate"

    updated = _valid_profile()
    updated["personal"]["full_name"] = "SQLite Updated"
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, updated))

    assert json.loads(legacy_profile.read_text(encoding="utf-8"))["personal"]["full_name"] == "Legacy File Changed"
    assert repo.load(LOCAL_TENANT).personal.full_name == "SQLite Updated"  # type: ignore[union-attr]
    assert repo.load_rendering_settings(LOCAL_TENANT)["template_text"] == "\\documentclass{moderncv}"


def test_save_rejects_unsupported_top_level_profile_fields(tmp_path):
    repo, conn, _ = _new_repo(tmp_path)
    raw = _valid_profile()
    raw["custom_section"] = {"future": "thing"}

    with pytest.raises(InvalidProfileError, match="unsupported top-level profile field\\(s\\): custom_section"):
        repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, raw))

    assert conn.execute("SELECT COUNT(*) FROM candidate_profiles").fetchone()[0] == 0


def test_legacy_profile_rejects_unsupported_top_level_fields_before_import(tmp_path):
    repo, conn, _ = _new_repo(tmp_path)
    legacy = _valid_profile()
    legacy["custom_section"] = {"future": "thing"}
    (tmp_path / "profile.json").write_text(json.dumps(legacy), encoding="utf-8")

    with pytest.raises(InvalidProfileError, match="unsupported top-level profile field\\(s\\): custom_section"):
        repo.load(LOCAL_TENANT)

    assert conn.execute("SELECT COUNT(*) FROM candidate_profiles").fetchone()[0] == 0
