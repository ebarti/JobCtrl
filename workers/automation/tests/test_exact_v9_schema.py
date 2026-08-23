from __future__ import annotations

import sqlite3

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V8_MANIFEST,
    EXACT_V9_MANIFEST,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v8 import create_exact_v8_schema
from jobctrl.infrastructure.migrations.schema_v9 import (
    create_exact_v9_schema,
    create_unstamped_exact_v9_candidate,
    upgrade_exact_v8_schema_to_v9,
)


def _experience_columns(conn: sqlite3.Connection) -> dict[str, tuple[object, ...]]:
    return {
        str(row[1]): tuple(row)
        for row in conn.execute("PRAGMA table_info(candidate_profile_experience_entries)")
    }


def test_fresh_exact_v9_schema_has_optional_position_summary() -> None:
    conn = sqlite3.connect(":memory:")
    try:
        create_exact_v9_schema(conn)

        assert conn.execute("PRAGMA user_version").fetchone() == (9,)
        assert_exact_manifest(conn, EXACT_V9_MANIFEST)
        summary = _experience_columns(conn)["summary"]
        assert summary[2] == "TEXT"
        assert summary[3] == 1
        assert summary[4] == "''"
    finally:
        conn.close()


def test_unstamped_exact_v9_candidate_keeps_version_zero() -> None:
    conn = sqlite3.connect(":memory:")
    try:
        create_unstamped_exact_v9_candidate(conn)

        assert conn.execute("PRAGMA user_version").fetchone() == (0,)
        assert_exact_manifest(conn, EXACT_V9_MANIFEST)
    finally:
        conn.close()


def test_exact_v8_to_v9_upgrade_is_additive_and_defaults_existing_rows() -> None:
    conn = sqlite3.connect(":memory:")
    try:
        create_exact_v8_schema(conn)
        conn.execute(
            "INSERT INTO candidate_profiles (tenant_id, profile_id, updated_at) "
            "VALUES ('local', 'default', '2026-08-20T00:00:00Z')"
        )
        conn.execute(
            """
            INSERT INTO candidate_profile_experience_entries (
                tenant_id, profile_id, entry_id, position_index,
                date_range, title, company, location
            ) VALUES (
                'local', 'default', 'role-1', 0,
                '2024 - Present', 'Director', 'Example', 'Remote'
            )
            """
        )
        conn.commit()
        original_schema = schema_dump(conn)
        original_row = conn.execute(
            "SELECT tenant_id, profile_id, entry_id, position_index, "
            "date_range, title, company, location "
            "FROM candidate_profile_experience_entries"
        ).fetchone()

        upgrade_exact_v8_schema_to_v9(conn)

        assert conn.execute("PRAGMA user_version").fetchone() == (9,)
        assert_exact_manifest(conn, EXACT_V9_MANIFEST)
        assert conn.execute(
            "SELECT tenant_id, profile_id, entry_id, position_index, "
            "date_range, title, company, location "
            "FROM candidate_profile_experience_entries"
        ).fetchone() == original_row
        assert conn.execute(
            "SELECT summary FROM candidate_profile_experience_entries"
        ).fetchone() == ("",)
        assert tuple(item for item in schema_dump(conn) if item in original_schema) == tuple(
            item for item in original_schema if item[1] != "candidate_profile_experience_entries"
        )
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        conn.close()


def test_exact_v8_to_v9_fault_rolls_back_to_exact_v8() -> None:
    conn = sqlite3.connect(":memory:")
    create_exact_v8_schema(conn)
    before = schema_dump(conn)

    def fail_before_addition(_statement: str) -> object:
        raise RuntimeError("synthetic v9 schema failure")

    try:
        with pytest.raises(RuntimeError, match="synthetic v9 schema failure"):
            upgrade_exact_v8_schema_to_v9(conn, _execute=fail_before_addition)

        assert conn.execute("PRAGMA user_version").fetchone() == (8,)
        assert schema_dump(conn) == before
        assert_exact_manifest(conn, EXACT_V8_MANIFEST)
    finally:
        conn.close()
