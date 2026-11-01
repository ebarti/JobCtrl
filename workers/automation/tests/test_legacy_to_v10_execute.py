from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import legacy_to_v10_execute as migration
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V10_MANIFEST, assert_exact_manifest
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.schema_v8 import create_exact_v8_schema
from tests.v6_migration_fixture import create_shipped_v6_database


def _source(path: Path, version: int) -> None:
    if version == 6:
        create_shipped_v6_database(path)
        return
    with sqlite3.connect(path) as conn:
        (create_exact_v7_schema if version == 7 else create_exact_v8_schema)(conn)
        conn.execute(
            "INSERT INTO jobs(tenant_id,job_id,url,title,application_url) VALUES('local','11111111-1111-4111-8111-111111111111','https://post/legacy','Retained title','https://apply/shared')"
        )


@pytest.mark.parametrize("version", [6, 7, 8])
def test_all_legacy_routes_make_exact_v10_and_remove_every_nested_intermediate(tmp_path: Path, version: int) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source, version)
    before = source.read_bytes()
    result = migration.execute_legacy_to_v10_candidate(
        source,
        candidate,
        source_version=version,
        migration_at="2026-08-20T00:00:00+00:00" if version == 6 else None,
    )
    assert result.user_version == 10 and result.source_data_digest == result.candidate_data_digest
    assert source.read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["candidate.db", "source.db"]
    with sqlite3.connect(candidate) as conn:
        assert_exact_manifest(conn, EXACT_V10_MANIFEST)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        if version != 6:
            assert conn.execute("SELECT title FROM jobs").fetchone() == ("Retained title",)
            assert conn.execute("SELECT application_url,current_status FROM job_enrichments").fetchone() == (
                "https://apply/shared",
                "pending",
            )


@pytest.mark.parametrize("version", [6, 7, 8])
def test_downstream_failure_removes_private_v9_and_all_nested_files(
    tmp_path: Path, version: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source, version)
    before = source.read_bytes()

    def fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("injected downstream failure")

    monkeypatch.setattr(migration, "execute_v9_to_v10_candidate", fail)
    with pytest.raises(migration.CandidateExecutionError):
        migration.execute_legacy_to_v10_candidate(
            source,
            candidate,
            source_version=version,
            migration_at="2026-08-20T00:00:00+00:00" if version == 6 else None,
        )
    assert source.read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.db"]


@pytest.mark.parametrize(
    "suffix",
    [
        "",
        ".exact-v9-intermediate",
        ".exact-v9-intermediate.exact-v8-intermediate",
        ".exact-v9-intermediate.exact-v8-intermediate.exact-v7-intermediate",
    ],
)
def test_existing_destination_and_nested_intermediates_are_preserved(tmp_path: Path, suffix: str) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source, 6)
    protected = Path(f"{candidate}{suffix}")
    protected.write_bytes(b"preexisting owned data")
    before = source.read_bytes()
    with pytest.raises(migration.CandidateExecutionError):
        migration.execute_legacy_to_v10_candidate(
            source, candidate, source_version=6, migration_at="2026-08-20T00:00:00+00:00"
        )
    assert protected.read_bytes() == b"preexisting owned data"
    assert source.read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(["source.db", protected.name])


def test_intermediate_cleanup_failure_never_publishes_final_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source, 8)
    before = source.read_bytes()
    original = migration._remove_created_candidate
    attempts = 0

    def fail_once(path: Path, identity: tuple[int, int]) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("synthetic cleanup failure")
        original(path, identity)

    monkeypatch.setattr(migration, "_remove_created_candidate", fail_once)
    with pytest.raises(migration.CandidateExecutionError):
        migration.execute_legacy_to_v10_candidate(source, candidate, source_version=8)
    assert source.read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.db"]
