from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V8_MANIFEST,
    EXACT_V9_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.schema_v8 import create_exact_v8_schema
from jobctrl.infrastructure.migrations.v8_to_v9_execute import (
    CandidateExecutionError,
    execute_v8_to_v9_candidate,
)


def _source_v8(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        create_exact_v8_schema(conn)
        conn.execute(
            "INSERT INTO candidate_profiles (tenant_id, profile_id, updated_at) "
            "VALUES ('local', 'default', '2026-08-20T00:00:00Z')"
        )
        conn.execute(
            """
            INSERT INTO candidate_profile_experience_entries (
                tenant_id, profile_id, entry_id, position_index, title, company
            ) VALUES ('local', 'default', 'role-1', 0, 'Director', 'Example')
            """
        )
        conn.commit()
    finally:
        conn.close()


def test_executor_builds_owner_private_exact_v9_without_mutating_source(tmp_path: Path) -> None:
    source = tmp_path / "source-v8.db"
    candidate = tmp_path / "candidate-v9.db"
    _source_v8(source)

    result = execute_v8_to_v9_candidate(source, candidate)

    assert result.user_version == 9
    assert result.source_data_digest == result.candidate_data_digest
    assert candidate.stat().st_mode & 0o077 == 0
    with sqlite3.connect(source) as source_conn:
        assert source_conn.execute("PRAGMA user_version").fetchone() == (8,)
        assert_exact_manifest(source_conn, EXACT_V8_MANIFEST)
    with sqlite3.connect(candidate) as candidate_conn:
        assert candidate_conn.execute("PRAGMA user_version").fetchone() == (9,)
        assert_exact_manifest(candidate_conn, EXACT_V9_MANIFEST)
        assert candidate_conn.execute(
            "SELECT summary FROM candidate_profile_experience_entries"
        ).fetchone() == ("",)


def test_executor_failure_removes_partial_candidate_and_preserves_source(tmp_path: Path) -> None:
    source = tmp_path / "source-v8.db"
    candidate = tmp_path / "candidate-v9.db"
    _source_v8(source)

    with pytest.raises(CandidateExecutionError, match="v8-to-v9 candidate migration failed"):
        execute_v8_to_v9_candidate(
            source,
            candidate,
            _after_stamp=lambda: (_ for _ in ()).throw(RuntimeError("synthetic crash")),
        )

    assert not candidate.exists()
    assert not Path(f"{candidate}-wal").exists()
    assert not Path(f"{candidate}-shm").exists()
    with sqlite3.connect(source) as source_conn:
        assert source_conn.execute("PRAGMA user_version").fetchone() == (8,)
        assert_exact_manifest(source_conn, EXACT_V8_MANIFEST)
