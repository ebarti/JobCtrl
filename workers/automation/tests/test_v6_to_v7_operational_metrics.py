"""Focused v6-to-v7 operational metric reference migration tests."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import (
    v6_to_v7_operational_metrics as metrics,
)
from jobctrl.infrastructure.migrations.v6_to_v7_identity import transform_v6_root_identity
from jobctrl.infrastructure.migrations.v6_to_v7_operational_metrics import (
    migrate_v6_operational_attempt_metrics,
)
from tests.v6_migration_fixture import create_shipped_v6_database


def test_operational_metrics_keep_their_job_association_as_job_id(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        job_url = "https://jobs.example/shipped-v6"
        conn.execute(
            """
            INSERT INTO operational_attempt_metrics (
                occurred_at, stage, attempt_kind, outcome, job_url
            ) VALUES (?, ?, ?, ?, ?)
            """,
            ("2026-07-30T10:00:00+00:00", "discover", "crawl", "success", job_url),
        )
        transform_v6_root_identity(conn)
        expected_job_id = str(conn.execute("SELECT job_id FROM jobs").fetchone()[0])

        migrate_v6_operational_attempt_metrics(conn)

        assert conn.execute(
            "SELECT job_id FROM operational_attempt_metrics"
        ).fetchone()[0] == expected_job_id
        assert "job_url" not in {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(operational_attempt_metrics)")
        }
    finally:
        conn.close()


def test_operational_metrics_reject_an_unresolved_job_locator(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO operational_attempt_metrics (
                occurred_at, stage, attempt_kind, outcome, job_url
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                "2026-07-30T10:00:00+00:00",
                "discover",
                "crawl",
                "success",
                "https://jobs.example/unresolved",
            ),
        )
        transform_v6_root_identity(conn)

        with pytest.raises(RuntimeError, match="unresolved job locator"):
            migrate_v6_operational_attempt_metrics(conn)

        assert "job_url" in {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(operational_attempt_metrics)")
        }
    finally:
        conn.close()


def test_operational_metrics_rebuild_rolls_back_on_verification_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        transform_v6_root_identity(conn)
        before_schema = tuple(
            conn.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()
        )
        monkeypatch.setattr(
            metrics,
            "verify_v7_operational_attempt_metrics",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("fault")),
        )

        with pytest.raises(RuntimeError, match="fault"):
            migrate_v6_operational_attempt_metrics(conn)

        assert tuple(
            conn.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()
        ) == before_schema
    finally:
        conn.close()
