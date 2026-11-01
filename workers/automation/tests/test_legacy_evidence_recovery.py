"""Review-bound recovery uses synthetic native paired backup metadata only."""

from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys

import pytest
from typer.testing import CliRunner

from jobctrl.infrastructure.migrations.legacy_to_v15_execute import execute_legacy_to_v15_candidate
from jobctrl.infrastructure.migrations.schema_v12 import create_exact_v12_schema
from jobctrl.infrastructure.profile.legacy_evidence import (
    LegacyEvidenceReviewError, decide_review, evidence_rows, prepare_review, requires_review,
)
from jobctrl.infrastructure.profile.legacy_evidence_recovery import inventory_recovery
from tests.test_legacy_evidence_preservation import seed_evidence


def paired_workspace(tmp_path):
    pair = tmp_path / "pair-owned"
    pair.mkdir(mode=0o700)
    source = pair / "jobctrl.db"
    with sqlite3.connect(source) as conn:
        create_exact_v12_schema(conn)
        seed_evidence(conn)
    with sqlite3.connect(pair / "temporal.db") as conn:
        conn.execute("CREATE TABLE owned_history (value TEXT)")
        conn.execute("INSERT INTO owned_history VALUES ('synthetic history retained')")
    files = []
    for name, version in [("jobctrl.db", 12), ("temporal.db", 0)]:
        path = pair / name
        path.chmod(0o600)
        raw = path.read_bytes()
        files.append(dict(name=name, sha256=hashlib.sha256(raw).hexdigest(), sizeBytes=len(raw), sqliteUserVersion=version))
    (pair / "pair.json").write_text(json.dumps(dict(schemaVersion=1, id=pair.name, files=files)))
    (pair / "pair.json").chmod(0o600)
    live = tmp_path / "jobctrl.db"
    execute_legacy_to_v15_candidate(source, live, source_version=12)
    # Simulate the previous shipped v13 transform, retaining all other data.
    with sqlite3.connect(live) as conn:
        conn.execute("DELETE FROM job_events WHERE event_type='LegacyEvidenceReviewRecorded'")
        conn.execute("UPDATE candidate_profile_achievement_evidence SET evidence_strength='draft',claim_confidence=0,user_confirmed=0 WHERE evidence_id='role_bullet_1'")
    return pair, live


def pair_bytes(pair):
    return {path.name: path.read_bytes() for path in pair.iterdir()}


def test_recovery_retains_original_confirmation_history_and_never_auto_confirms(tmp_path):
    pair, live = paired_workspace(tmp_path)
    before = pair_bytes(pair)
    with sqlite3.connect(live) as conn:
        current = evidence_rows(conn)
        inventory_recovery(conn, pair)
        assert evidence_rows(conn) == current
        item = prepare_review(conn, tenant_id="local", profile_id="default")[0]
        assert item["original"]["user_confirmed"] == 1 and item["current"]["user_confirmed"] == 0
        assert item["original"]["scope"] == item["current"]["scope"] == "Authored  scope\t"
        assert item["original"]["_paired_backup_manifest_sha256"]
        events = conn.execute("SELECT * FROM job_events").fetchall()
        inventory_recovery(conn, pair)
        assert conn.execute("SELECT * FROM job_events").fetchall() == events
        event_id = decide_review(conn, tenant_id="local", profile_id="default", entry_id="role", evidence_id="role_bullet_1", token=item["token"], decision="confirm")
        assert event_id > 0
        changed = evidence_rows(conn)[0]
        assert changed == {**current[0], "user_confirmed": 1}
        assert len(conn.execute("SELECT * FROM job_events").fetchall()) == len(events) + 1
    assert pair_bytes(pair) == before


def test_backup_zero_does_not_authorize_current_confirmation_without_bound_human_review(tmp_path):
    pair, live = paired_workspace(tmp_path)
    before_pair = pair_bytes(pair)
    with sqlite3.connect(live) as conn:
        conn.execute("UPDATE candidate_profile_achievement_evidence SET user_confirmed=1 WHERE evidence_id='unconfirmed-control'")
        conn.commit()
        current = evidence_rows(conn)
        inventory_recovery(conn, pair)
        assert evidence_rows(conn) == current
        assert requires_review(conn, "local", "default", "role", "unconfirmed-control") is True
        item = next(item for item in prepare_review(conn, tenant_id="local", profile_id="default") if item["current"]["evidence_id"] == "unconfirmed-control")
        assert item["original"]["user_confirmed"] == 0
        assert item["current"]["user_confirmed"] == 1
        assert item["reason"] == "confirmation_authority_changed"
        stale_token = item["token"]
        conn.execute("UPDATE candidate_profiles SET version=version+1")
        conn.commit()
        with pytest.raises(LegacyEvidenceReviewError):
            decide_review(conn, tenant_id="local", profile_id="default", entry_id="role", evidence_id="unconfirmed-control", token=stale_token, decision="confirm")
        item = next(item for item in prepare_review(conn, tenant_id="local", profile_id="default") if item["current"]["evidence_id"] == "unconfirmed-control")
        decide_review(conn, tenant_id="local", profile_id="default", entry_id="role", evidence_id="unconfirmed-control", token=item["token"], decision="confirm")
        assert requires_review(conn, "local", "default", "role", "unconfirmed-control") is False
        assert evidence_rows(conn) == current
        inventory_recovery(conn, pair)
        assert requires_review(conn, "local", "default", "role", "unconfirmed-control") is False
    assert pair_bytes(pair) == before_pair


@pytest.mark.parametrize("mutation", ["edit", "delete", "duplicate"])
def test_recovery_exposes_conflicts_and_refuses_to_replace_current_edits(tmp_path, mutation):
    pair, live = paired_workspace(tmp_path)
    with sqlite3.connect(live) as conn:
        if mutation == "edit":
            conn.execute("UPDATE candidate_profile_achievement_evidence SET scope='current independently authored scope' WHERE evidence_id='role_bullet_1'")
        elif mutation == "delete":
            conn.execute("DELETE FROM candidate_profile_achievement_evidence WHERE evidence_id='role_bullet_1'")
        else:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(candidate_profile_achievement_evidence)")]
            selected = ["99" if column == "evidence_index" else column for column in columns]
            conn.execute(f"INSERT INTO candidate_profile_achievement_evidence SELECT {','.join(selected)} FROM candidate_profile_achievement_evidence WHERE evidence_id='role_bullet_1'")
        conn.commit()
        before = evidence_rows(conn)
        inventory_recovery(conn, pair)
        item = next(item for item in prepare_review(conn, tenant_id="local", profile_id="default") if item["original"]["evidence_id"] == "role_bullet_1")
        assert item["conflict"] is True
        with pytest.raises(LegacyEvidenceReviewError):
            decide_review(conn, tenant_id="local", profile_id="default", entry_id="role", evidence_id="role_bullet_1", token=item["token"] or "", decision="confirm")
        assert evidence_rows(conn) == before


@pytest.mark.parametrize("fault", ["missing_temporal", "changed_backup", "unpaired_captures", "symlink"])
def test_untrusted_or_unpaired_backup_refuses_without_changing_current(tmp_path, fault):
    pair, live = paired_workspace(tmp_path)
    if fault == "missing_temporal":
        (pair / "temporal.db").unlink()
    elif fault == "changed_backup":
        with sqlite3.connect(pair / "jobctrl.db") as conn:
            conn.execute("UPDATE candidate_profile_achievement_evidence SET scope='late writer'")
    elif fault == "unpaired_captures":
        (pair / "pair.json").unlink()
    else:
        copy = tmp_path / "outside-owned.db"
        shutil.copy2(pair / "jobctrl.db", copy)
        (pair / "jobctrl.db").unlink()
        (pair / "jobctrl.db").symlink_to(copy)
    before = live.read_bytes()
    with sqlite3.connect(live) as conn, pytest.raises((LegacyEvidenceReviewError, OSError)):
        inventory_recovery(conn, pair)
    assert live.read_bytes() == before


def test_writer_and_interrupted_inventory_preserve_current_backup_and_files(tmp_path, monkeypatch):
    pair, live = paired_workspace(tmp_path)
    artifact = tmp_path / "accepted.txt"
    artifact.write_bytes(b"owned accepted artifact bytes\n")
    before = pair_bytes(pair)
    with sqlite3.connect(live, timeout=0) as conn, sqlite3.connect(live, timeout=0) as writer:
        writer.execute("BEGIN IMMEDIATE")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            inventory_recovery(conn, pair)
        writer.rollback()
        from jobctrl.infrastructure.profile import legacy_evidence_recovery

        record = legacy_evidence_recovery.record_legacy_inventory
        def interrupted(*args):
            record(*args)
            raise KeyboardInterrupt
        monkeypatch.setattr(legacy_evidence_recovery, "record_legacy_inventory", interrupted)
        current = evidence_rows(conn)
        events = conn.execute("SELECT * FROM job_events").fetchall()
        with pytest.raises(KeyboardInterrupt):
            inventory_recovery(conn, pair)
        assert evidence_rows(conn) == current
        assert conn.execute("SELECT * FROM job_events").fetchall() == events
    assert artifact.read_bytes() == b"owned accepted artifact bytes\n"
    assert pair_bytes(pair) == before


def test_actual_cli_missing_authority_requires_visible_review_and_one_bound_decision(tmp_path, monkeypatch):
    from jobctrl import config
    from jobctrl.legacy_evidence_cli import app

    _, live = paired_workspace(tmp_path)
    monkeypatch.setattr(config, "DB_PATH", live)
    monkeypatch.setattr(config, "load_env", lambda: None)
    runner = CliRunner()
    refused = runner.invoke(app, ["recover", "--authority-unavailable"])
    assert refused.exit_code == 1
    recovered = runner.invoke(app, ["recover", "--authority-unavailable", "--stopped-runtime"])
    assert recovered.exit_code == 0, recovered.output
    records = json.loads(recovered.output)["records"]
    assert len(records) == 4
    item = records[0]
    reviewed = runner.invoke(app, ["decide", "--entry-id", "role", "--evidence-id", "role_bullet_1", "--decision", "confirm", "--token", item["token"], "--stopped-runtime"])
    assert reviewed.exit_code == 0, reviewed.output
    assert json.loads(reviewed.output)["eventId"] > 0
    repeated = runner.invoke(app, ["decide", "--entry-id", "role", "--evidence-id", "role_bullet_1", "--decision", "confirm", "--token", item["token"], "--stopped-runtime"])
    assert repeated.exit_code == 1
    assert "Authored" not in repeated.output


def test_process_interruption_before_inventory_commit_recovers_without_source_loss(tmp_path):
    pair, live = paired_workspace(tmp_path)
    original_pair = pair_bytes(pair)
    with sqlite3.connect(live) as conn:
        before_rows = evidence_rows(conn)
        before_events = conn.execute("SELECT * FROM job_events").fetchall()
    code = """
import os,sqlite3,sys
from pathlib import Path
from jobctrl.infrastructure.profile import legacy_evidence_recovery as recovery
record = recovery.record_legacy_inventory
def interrupt(*args):
    record(*args)
    os._exit(73)
recovery.record_legacy_inventory = interrupt
with sqlite3.connect(sys.argv[1]) as conn:
    recovery.inventory_recovery(conn, Path(sys.argv[2]))
"""
    interrupted = subprocess.run([sys.executable, "-c", code, str(live), str(pair)], capture_output=True, timeout=30)
    assert interrupted.returncode == 73
    with sqlite3.connect(live) as conn:
        assert evidence_rows(conn) == before_rows
        assert conn.execute("SELECT * FROM job_events").fetchall() == before_events
        inventory_recovery(conn, pair)
        assert len(prepare_review(conn, tenant_id="local", profile_id="default")) == 3
    assert pair_bytes(pair) == original_pair
