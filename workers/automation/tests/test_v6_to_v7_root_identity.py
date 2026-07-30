"""Focused v6-to-v7 root JobId, locator, and runtime-table migration tests."""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v6_to_v7_identity as identity
from tests.v6_migration_fixture import create_shipped_v6_database


def _create_v6_lifecycle_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE jobctrl_hidden_jobs (
                job_url TEXT PRIMARY KEY,
                hidden_at TEXT NOT NULL,
                reason TEXT,
                unhidden_at TEXT
            )"""
    )
    conn.execute(
        """CREATE TABLE jobctrl_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT,
                restored_at TEXT
            )"""
    )


def test_root_identity_generates_and_preserves_job_ids_and_locators(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        identity.transform_v6_root_identity(conn)
        generated_job_id = str(
            conn.execute("SELECT job_id FROM jobs").fetchone()[0]
        )
        assert str(uuid.UUID(generated_job_id)) == generated_job_id

        preserved_job_id = "1ba4c8f3-5d6b-4f49-9c8e-b37667751bc9"
        conn.execute("UPDATE jobs SET job_id = ?", (preserved_job_id,))
        conn.execute(
            "UPDATE job_identity_aliases SET job_id = ?",
            (preserved_job_id,),
        )
        identity.transform_v6_root_identity(conn)
        assert conn.execute("SELECT job_id FROM jobs").fetchone()[0] == preserved_job_id

        historical_url = "https://jobs.example/historical-v6"
        conn.execute(
            """
            INSERT INTO job_identity_aliases (
                tenant_id, alias_kind, alias_value, job_id, created_at, retired_at
            ) VALUES ('local', 'posting_url', ?, ?, ?, ?)
            """,
            (
                historical_url,
                preserved_job_id,
                "2026-07-01T00:00:00+00:00",
                "2026-07-15T00:00:00+00:00",
            ),
        )
        identity.rebuild_v7_jobs_and_locators(conn)

        locators = conn.execute(
            """
            SELECT locator_value, is_current, retired_at
            FROM job_locators
            WHERE job_id = ?
            ORDER BY locator_value
            """,
            (preserved_job_id,),
        ).fetchall()
        assert locators == [
            (historical_url, 0, "2026-07-15T00:00:00+00:00"),
            ("https://jobs.example/shipped-v6", 1, None),
        ]
    finally:
        conn.close()


def test_optional_lifecycle_rows_are_migrated_to_job_ids(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        _create_v6_lifecycle_tables(conn)
        conn.execute(
            """
            INSERT INTO jobctrl_hidden_jobs (job_url, hidden_at, reason, unhidden_at)
            VALUES (?, ?, ?, NULL)
            """,
            (
                "https://jobs.example/shipped-v6",
                "2026-07-30T10:00:00+00:00",
                "test hide",
            ),
        )
        conn.execute(
            """
            INSERT INTO jobctrl_deleted_jobs (job_url, deleted_at, reason, restored_at)
            VALUES (?, ?, ?, NULL)
            """,
            (
                "https://jobs.example/shipped-v6",
                "2026-07-30T10:05:00+00:00",
                "test delete",
            ),
        )
        identity.transform_v6_root_identity(conn)
        expected_job_id = str(conn.execute("SELECT job_id FROM jobs").fetchone()[0])
        identity.migrate_v6_lifecycle_rows(conn)
        assert conn.execute(
            """
            SELECT tenant_id, job_id, hidden_at, reason, unhidden_at
            FROM jobctrl_hidden_jobs
            """
        ).fetchone() == (
            "local",
            expected_job_id,
            "2026-07-30T10:00:00+00:00",
            "test hide",
            None,
        )
        assert conn.execute(
            """
            SELECT tenant_id, job_id, deleted_at, reason, restored_at
            FROM jobctrl_deleted_jobs
            """
        ).fetchone() == (
            "local",
            expected_job_id,
            "2026-07-30T10:05:00+00:00",
            "test delete",
            None,
        )
    finally:
        conn.close()


def test_root_identity_rolls_back_when_generation_faults(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        before_columns = conn.execute("PRAGMA table_info(jobs)").fetchall()
        monkeypatch.setattr(
            identity.uuid,
            "uuid4",
            lambda: (_ for _ in ()).throw(RuntimeError("fault")),
        )

        with pytest.raises(RuntimeError, match="fault"):
            identity.transform_v6_root_identity(conn)

        assert conn.execute("PRAGMA table_info(jobs)").fetchall() == before_columns
        assert conn.execute(
            "SELECT name FROM sqlite_master WHERE name = 'job_identity_aliases'"
        ).fetchone() is None
    finally:
        conn.close()
