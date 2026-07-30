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
from tests.v6_migration_fixture import create_shipped_v6_database


def test_self_contained_shipped_v6_fixture_passes_preflight(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
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
            conn.execute(variants[0])
        assert_v6_migration_preflight(conn)

        conn.execute("DROP TABLE worker_runtime_heartbeats")
        conn.execute(
            """CREATE TABLE worker_runtime_heartbeats (
              worker_id TEXT PRIMARY KEY,
              component TEXT NOT NULL,
              pid INTEGER NOT NULL,
              hostname TEXT NOT NULL,
              app_dir TEXT NOT NULL,
              db_path TEXT NOT NULL,
              task_queue TEXT NOT NULL,
              started_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              max_concurrent_activities INTEGER,
              activity_executor_max_workers INTEGER,
              active_activity_count INTEGER NOT NULL DEFAULT 0,
              active_activity_counts_json TEXT NOT NULL DEFAULT '{}',
              active_activity_details_json TEXT NOT NULL DEFAULT '[]',
              active_activity_details_total INTEGER NOT NULL DEFAULT 0,
              active_activity_details_truncated INTEGER NOT NULL DEFAULT 0,
              activity_duration_summary_json TEXT NOT NULL DEFAULT '{}',
              task_queue_observation_json TEXT,
              heartbeat_schema_version INTEGER NOT NULL DEFAULT 1
            )"""
        )
        with pytest.raises(V6MigrationPreflightError):
            assert_v6_migration_preflight(conn)
    finally:
        conn.close()
