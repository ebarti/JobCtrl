"""Focused admission tests for the exact shipped-v6 migration boundary."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    V6MigrationPreflightError,
    _V6_AUXILIARY_DDL,
    _V6_AUXILIARY_TABLE_VARIANTS,
    assert_v6_migration_preflight,
)
from tests.v6_migration_fixture import (
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)


def test_self_contained_shipped_v6_fixture_passes_preflight(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_supported_v1_3_to_v2_0_8_upgrade_history_passes_preflight(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "upgraded-v6.db"
    create_supported_upgrade_history_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_preflight_admits_only_exact_named_optional_v6_tables(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        for ddl in _V6_AUXILIARY_DDL:
            conn.execute(ddl)
        assert_v6_migration_preflight(conn)

        for table_name, variants in _V6_AUXILIARY_TABLE_VARIANTS.items():
            conn.execute(f'DROP TABLE "{table_name}"')
            for variant in variants:
                conn.execute(variant)
                assert_v6_migration_preflight(conn)
                conn.execute(f'DROP TABLE "{table_name}"')
            conn.execute(variants[-1])

        assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_preflight_rejects_unknown_object_with_allowlisted_index_name(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "trigger-collision.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TRIGGER idx_resume_review_drafts_job
            AFTER INSERT ON jobs
            BEGIN
                UPDATE jobs SET title = 'unexpected' WHERE rowid = NEW.rowid;
            END
            """
        )
        with pytest.raises(V6MigrationPreflightError, match="shipped v6"):
            assert_v6_migration_preflight(conn)
    finally:
        conn.close()
