"""Owned synthetic migration checks for the lifecycle revision schema."""
from __future__ import annotations

import importlib
import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import legacy_to_v15_execute as composite
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V15_MANIFEST, assert_exact_manifest
from jobctrl.infrastructure.migrations.v14_to_v15_execute import CandidateExecutionError, execute_v14_to_v15_candidate
from tests.v6_migration_fixture import create_shipped_v6_database

JOB_ID = "11111111-1111-4111-8111-111111111111"


def make_source(path: Path, version: int) -> None:
    if version == 6:
        create_shipped_v6_database(path)
        return
    with sqlite3.connect(path) as conn:
        module = importlib.import_module(f"jobctrl.infrastructure.migrations.schema_v{version}")
        getattr(module, f"create_exact_v{version}_schema")(conn)
        conn.execute(
            "INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local',?,?,?)",
            (JOB_ID, "https://example.test/role", "Synthetic title"),
        )
        conn.execute(
            "INSERT INTO jobctrl_deleted_jobs(tenant_id,job_id,deleted_at,reason) VALUES('local',?,?,?)",
            (JOB_ID, "2026-10-20T00:00:00Z", "synthetic"),
        )


@pytest.mark.parametrize("version", range(6, 15))
def test_all_supported_sources_produce_verified_v15_without_mutating_source(tmp_path: Path, version: int) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    make_source(source, version)
    original = source.read_bytes()
    result = composite.execute_legacy_to_v15_candidate(
        source, candidate, source_version=version,
        migration_at="2026-08-20T00:00:00+00:00" if version == 6 else None,
    )
    assert result.status == "ready" and result.user_version == 15
    assert result.source_data_digest == result.candidate_data_digest
    assert source.read_bytes() == original
    assert candidate.stat().st_mode & 0o077 == 0
    assert sorted(p.name for p in tmp_path.iterdir()) == ["candidate.db", "source.db"]
    with sqlite3.connect(candidate) as conn:
        assert_exact_manifest(conn, EXACT_V15_MANIFEST)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        if version != 6:
            assert conn.execute("SELECT title FROM jobs WHERE tenant_id='local' AND job_id=?", (JOB_ID,)).fetchone() == ("Synthetic title",)
            assert conn.execute("SELECT reason FROM jobctrl_deleted_jobs WHERE tenant_id='local' AND job_id=?", (JOB_ID,)).fetchone() == ("synthetic",)


def test_candidate_corruption_refuses_and_cleans_owned_candidate(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    make_source(source, 14)
    original = source.read_bytes()

    def corrupt() -> None:
        with sqlite3.connect(candidate) as conn:
            conn.execute("UPDATE jobs SET title='Unexpected change' WHERE job_id=?", (JOB_ID,))

    with pytest.raises(CandidateExecutionError):
        execute_v14_to_v15_candidate(source, candidate, _after_stamp=corrupt)
    assert source.read_bytes() == original
    assert not candidate.exists()


def test_active_writer_and_existing_destination_refuse_without_overwriting(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    make_source(source, 14)
    before = source.read_bytes()
    writer = sqlite3.connect(source)
    try:
        writer.execute("BEGIN IMMEDIATE")
        with pytest.raises(CandidateExecutionError):
            execute_v14_to_v15_candidate(source, candidate)
    finally:
        writer.rollback()
        writer.close()
    assert source.read_bytes() == before
    assert not candidate.exists()
    candidate.write_bytes(b"owned previous candidate")
    with pytest.raises(CandidateExecutionError):
        execute_v14_to_v15_candidate(source, candidate)
    assert candidate.read_bytes() == b"owned previous candidate"
    assert source.read_bytes() == before


def test_failed_final_step_removes_only_owned_intermediate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    make_source(source, 13)
    before = source.read_bytes()

    def fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("synthetic final-stage failure")

    monkeypatch.setattr(composite, "execute_v14_to_v15_candidate", fail)
    with pytest.raises(composite.CandidateExecutionError):
        composite.execute_legacy_to_v15_candidate(source, candidate, source_version=13)
    assert source.read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.db"]


def test_source_writer_is_excluded_through_candidate_verification(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    make_source(source, 14)
    before = source.read_bytes()
    attempted = False

    def competing_write() -> None:
        nonlocal attempted
        with sqlite3.connect(source, timeout=0) as writer:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                writer.execute("UPDATE jobs SET title='unexpected' WHERE job_id=?", (JOB_ID,))
            attempted = True

    execute_v14_to_v15_candidate(source, candidate, _after_stamp=competing_write)
    assert attempted
    assert source.read_bytes() == before
    with sqlite3.connect(candidate) as conn:
        assert conn.execute("SELECT title FROM jobs WHERE job_id=?", (JOB_ID,)).fetchone() == ("Synthetic title",)


def test_refuses_symlinked_source_without_touching_target(tmp_path: Path) -> None:
    source, target, candidate = tmp_path / "source.db", tmp_path / "target.db", tmp_path / "candidate.db"
    make_source(target, 14)
    before = target.read_bytes()
    source.symlink_to(target)
    with pytest.raises(CandidateExecutionError):
        execute_v14_to_v15_candidate(source, candidate)
    assert source.is_symlink() and target.read_bytes() == before
    assert not candidate.exists()
