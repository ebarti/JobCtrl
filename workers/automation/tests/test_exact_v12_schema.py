from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V11_MANIFEST,
    EXACT_V12_MANIFEST,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v11 import create_exact_v11_schema
from jobctrl.infrastructure.migrations.schema_v12 import create_exact_v12_schema, upgrade_exact_v11_schema_to_v12
from jobctrl.infrastructure.migrations.v11_to_v12_execute import (
    CandidateExecutionError,
    execute_v11_to_v12_candidate,
    main,
)


def _source(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        create_exact_v11_schema(conn)
        conn.execute("INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','j','https://post','Retained')")
        conn.execute(
            "INSERT INTO job_interview_prep(tenant_id,job_id,generation,status,generated_at,gate_status) VALUES('local','j',1,'accepted','2026-10-01','passed')"
        )
        conn.execute(
            "INSERT INTO job_interview_prep_items(tenant_id,job_id,generation,item_id,kind,title,generated_text) VALUES('local','j',1,'i','star_draft','Prior','Retained outline')"
        )
        conn.execute("INSERT INTO llm_spend(day,lane,input_tokens) VALUES('2026-10-01','legacy',11)")
        conn.execute(
            "INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('other','j','https://other/post','Other tenant retained')"
        )
        conn.execute(
            "INSERT INTO application_outcomes(tenant_id,outcome_id,job_id,kind,source,note,occurred_at,recorded_at,interview_prep_generation) VALUES('local','reflection','j','interview','manual','Synthetic reflection','2026-10-01','2026-10-01',1)"
        )
        conn.execute(
            "INSERT INTO candidate_profiles(tenant_id,profile_id,personal_full_name,version,updated_at) VALUES('local','synthetic','Synthetic Candidate',3,'2026-10-01')"
        )
        conn.execute(
            "INSERT INTO discovery_settings(tenant_id,search_config_json,created_at,updated_at) VALUES('local','{\"synthetic\":true}','2026-10-01','2026-10-01')"
        )
        conn.execute(
            "INSERT INTO job_events(tenant_id,job_id,identity_version,event_type,occurred_at,payload_json) VALUES('local','j',1,'SyntheticControl','2026-10-01','{\"retained\":true}')"
        )


def test_fresh_and_upgraded_v12_are_identical() -> None:
    with sqlite3.connect(":memory:") as fresh, sqlite3.connect(":memory:") as upgraded:
        create_exact_v12_schema(fresh)
        create_exact_v11_schema(upgraded)
        upgrade_exact_v11_schema_to_v12(upgraded)
        assert schema_dump(fresh) == schema_dump(upgraded)
        assert_exact_manifest(fresh, EXACT_V12_MANIFEST)
        assert_exact_manifest(upgraded, EXACT_V12_MANIFEST)


def test_failed_schema_upgrade_rolls_back_ddl_and_stamp() -> None:
    with sqlite3.connect(":memory:") as conn:
        create_exact_v11_schema(conn)
        before = tuple(conn.iterdump())

        def fail(sql: str) -> object:
            result = conn.execute(sql)
            if "CREATE TABLE job_interview_notes" in sql:
                raise RuntimeError("synthetic failure")
            return result

        with pytest.raises(RuntimeError):
            upgrade_exact_v11_schema_to_v12(conn, _execute=fail)
        assert tuple(conn.iterdump()) == before
        assert_exact_manifest(conn, EXACT_V11_MANIFEST)


def test_independent_private_candidate_preserves_every_old_cell(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    config = tmp_path / "config.json"
    config.write_text('{"synthetic": true, "unchanged": "exact bytes"}\n')
    config_before = config.read_bytes()
    before = source.read_bytes()
    result = execute_v11_to_v12_candidate(source, candidate)
    assert source.read_bytes() == before
    assert config.read_bytes() == config_before
    assert candidate.stat().st_mode & 0o077 == 0
    assert candidate.stat().st_ino != source.stat().st_ino
    assert result.user_version == 12 and result.status == "ready"
    assert result.source_data_digest == result.candidate_data_digest
    assert result.candidate_sha256 == hashlib.sha256(candidate.read_bytes()).hexdigest()
    with sqlite3.connect(source) as old, sqlite3.connect(candidate) as new:
        assert_exact_manifest(old, EXACT_V11_MANIFEST)
        assert_exact_manifest(new, EXACT_V12_MANIFEST)
        for (table,) in old.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            cols = [row[1] for row in old.execute(f'PRAGMA table_info("{table}")')]
            selected = ",".join(f'"{column}"' for column in cols)
            assert (
                new.execute(f'SELECT {selected} FROM "{table}" ORDER BY {selected}').fetchall()
                == old.execute(f'SELECT {selected} FROM "{table}" ORDER BY {selected}').fetchall()
            )
        assert new.execute("SELECT generation_context_json FROM job_interview_prep").fetchone() == (None,)
        assert new.execute("SELECT question_metadata_json FROM job_interview_prep_items").fetchone() == (None,)


@pytest.mark.parametrize("failure", ["drift", "live_writer", "symlink", "corrupt_retained"])
def test_rejected_candidate_leaves_source_and_no_output(tmp_path: Path, failure: str) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    writer = None
    callback = None
    if failure == "drift":
        with sqlite3.connect(source) as conn:
            conn.execute("CREATE TABLE unexpected(v)")
    elif failure == "live_writer":
        writer = sqlite3.connect(source)
        writer.execute("BEGIN IMMEDIATE")
    elif failure == "symlink":
        link = tmp_path / "link.db"
        link.symlink_to(source)
        source = link
    elif failure == "corrupt_retained":

        def corrupt() -> None:
            with sqlite3.connect(candidate) as conn:
                conn.execute("UPDATE job_interview_prep_items SET generated_text='corrupted'")

        callback = corrupt
    before = source.read_bytes()
    try:
        with pytest.raises(CandidateExecutionError):
            execute_v11_to_v12_candidate(source, candidate, _after_stamp=callback)
        assert source.read_bytes() == before
        assert not candidate.exists()
    finally:
        if writer:
            writer.rollback()
            writer.close()


def test_private_cli_receipt_and_argument_errors_contain_no_paths(tmp_path: Path, capsys) -> None:
    source, candidate = tmp_path / "private-source.db", tmp_path / "private-candidate.db"
    _source(source)
    assert main(["--source", str(source), "--candidate", str(candidate)]) == 0
    assert json.loads(capsys.readouterr().out)["user_version"] == 12
    assert main(["--source", str(source)]) == 1
    assert str(source) not in capsys.readouterr().err
