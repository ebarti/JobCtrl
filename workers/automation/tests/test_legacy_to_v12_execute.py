from __future__ import annotations

import importlib
import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import legacy_to_v12_execute as migration
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V12_MANIFEST, assert_exact_manifest
from tests.v6_migration_fixture import create_shipped_v6_database


def _source(path: Path, version: int) -> None:
    if version == 6:
        create_shipped_v6_database(path)
    else:
        with sqlite3.connect(path) as conn:
            module = importlib.import_module(f"jobctrl.infrastructure.migrations.schema_v{version}")
            getattr(module, f"create_exact_v{version}_schema")(conn)
            conn.execute(
                "INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','11111111-1111-4111-8111-111111111111','https://post/legacy','Retained title')"
            )


@pytest.mark.parametrize("version", [6, 7, 8, 9, 10, 11])
def test_all_supported_legacy_sources_produce_only_private_exact_v12(tmp_path: Path, version: int) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source, version)
    before = source.read_bytes()
    result = migration.execute_legacy_to_v12_candidate(
        source, candidate, source_version=version, migration_at="2026-08-20T00:00:00+00:00" if version == 6 else None
    )
    assert result.user_version == 12 and result.status == "ready"
    assert source.read_bytes() == before
    assert candidate.stat().st_mode & 0o077 == 0
    assert sorted(p.name for p in tmp_path.iterdir()) == ["candidate.db", "source.db"]
    with sqlite3.connect(candidate) as conn:
        assert_exact_manifest(conn, EXACT_V12_MANIFEST)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("SELECT COUNT(*) FROM job_interview_notes").fetchone() == (0,)


@pytest.mark.parametrize("version", [6, 7, 8, 9, 10])
def test_downstream_failure_removes_every_created_intermediate(
    tmp_path: Path, version: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source, version)
    before = source.read_bytes()

    def fail(*_args, **_kwargs):
        raise RuntimeError("synthetic final-stage failure")

    monkeypatch.setattr(migration, "execute_v11_to_v12_candidate", fail)
    with pytest.raises(migration.CandidateExecutionError):
        migration.execute_legacy_to_v12_candidate(
            source,
            candidate,
            source_version=version,
            migration_at="2026-08-20T00:00:00+00:00" if version == 6 else None,
        )
    assert source.read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.db"]


@pytest.mark.parametrize("version", [6, 7, 8, 9, 10])
def test_live_legacy_writer_is_refused_before_any_candidate(tmp_path: Path, version: int) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source, version)
    before = source.read_bytes()
    writer = sqlite3.connect(source)
    try:
        writer.execute("BEGIN IMMEDIATE")
        with pytest.raises(migration.CandidateExecutionError):
            migration.execute_legacy_to_v12_candidate(
                source,
                candidate,
                source_version=version,
                migration_at="2026-08-20T00:00:00+00:00" if version == 6 else None,
            )
        assert source.read_bytes() == before
        assert sorted(p.name for p in tmp_path.iterdir()) == ["source.db"]
    finally:
        writer.rollback()
        writer.close()
