from __future__ import annotations

import sqlite3
from pathlib import Path

from jobctrl.infrastructure.migrations.legacy_to_v9_execute import (
    execute_legacy_to_v9_candidate,
)
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    EXACT_V9_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from tests.v6_migration_fixture import create_shipped_v6_database

_MIGRATION_AT = "2026-08-20T00:00:00+00:00"


def _create_v7_source(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        create_exact_v7_schema(conn)
        conn.execute(
            """
            INSERT INTO jobs (tenant_id, job_id, url, title, company, location)
            VALUES (
                'local', '11111111-1111-4111-8111-111111111111',
                'https://jobs.example/1', 'Director', 'Example', 'Remote'
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def test_composite_preserves_v7_source_and_removes_private_v8_intermediate(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source-v7.db"
    candidate = tmp_path / "candidate-v9.db"
    _create_v7_source(source)

    result = execute_legacy_to_v9_candidate(
        source,
        candidate,
        source_version=7,
    )

    assert result.user_version == 9
    assert result.source_data_digest == result.candidate_data_digest
    assert not Path(f"{candidate}.exact-v8-intermediate").exists()
    with sqlite3.connect(source) as source_conn:
        assert_exact_manifest(source_conn, EXACT_V7_MANIFEST)
    with sqlite3.connect(candidate) as candidate_conn:
        assert_exact_manifest(candidate_conn, EXACT_V9_MANIFEST)
        assert candidate_conn.execute("SELECT title FROM jobs").fetchone() == ("Director",)


def test_composite_carries_v6_through_private_v8_and_v9_steps(tmp_path: Path) -> None:
    source = tmp_path / "source-v6.db"
    candidate = tmp_path / "candidate-v9.db"
    create_shipped_v6_database(source)

    result = execute_legacy_to_v9_candidate(
        source,
        candidate,
        source_version=6,
        migration_at=_MIGRATION_AT,
    )

    assert result.user_version == 9
    assert result.source_data_digest == result.candidate_data_digest
    assert not Path(f"{candidate}.exact-v8-intermediate").exists()
    assert not Path(f"{candidate}.exact-v8-intermediate.exact-v7-intermediate").exists()
    with sqlite3.connect(source) as source_conn:
        assert source_conn.execute("PRAGMA user_version").fetchone() == (6,)
    with sqlite3.connect(candidate) as candidate_conn:
        assert_exact_manifest(candidate_conn, EXACT_V9_MANIFEST)
        assert candidate_conn.execute("SELECT COUNT(*) FROM jobs").fetchone() == (1,)
