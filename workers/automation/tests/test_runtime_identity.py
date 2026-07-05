from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

import pytest

from jobhunter.infrastructure import runtime_identity


def test_worker_heartbeat_writes_runtime_identity(monkeypatch, tmp_path):
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", db_path)
    monkeypatch.setenv("JOBHUNTER_MAX_CONCURRENT_ACTIVITIES", "8")

    worker_id = runtime_identity.write_worker_heartbeat(
        task_queue="jobhunter-default",
        worker_id="worker-test",
        now=datetime(2026, 5, 20, 10, 0, tzinfo=UTC),
    )

    assert worker_id == "worker-test"
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT worker_id, component, app_dir, db_path, task_queue, last_seen_at, "
            "max_concurrent_activities, activity_executor_max_workers "
            "FROM worker_runtime_heartbeats"
        ).fetchone()
    finally:
        conn.close()
    assert row == (
        "worker-test",
        "temporal-worker",
        str(tmp_path.resolve()),
        str(db_path.resolve()),
        "jobhunter-default",
        "2026-05-20T10:00:00+00:00",
        8,
        10,
    )


def test_worker_heartbeat_migrates_legacy_runtime_columns(monkeypatch, tmp_path):
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE worker_runtime_heartbeats (
              worker_id TEXT PRIMARY KEY,
              component TEXT NOT NULL,
              pid INTEGER NOT NULL,
              hostname TEXT NOT NULL,
              app_dir TEXT NOT NULL,
              db_path TEXT NOT NULL,
              task_queue TEXT NOT NULL,
              started_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()

    runtime_identity.write_worker_heartbeat(
        task_queue="jobhunter-default",
        worker_id="worker-test",
        now=datetime(2026, 5, 20, 10, 0, tzinfo=UTC),
    )

    conn = sqlite3.connect(db_path)
    try:
        columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(worker_runtime_heartbeats)")}
        row = conn.execute(
            "SELECT max_concurrent_activities, activity_executor_max_workers "
            "FROM worker_runtime_heartbeats WHERE worker_id = ?",
            ("worker-test",),
        ).fetchone()
    finally:
        conn.close()

    assert {"max_concurrent_activities", "activity_executor_max_workers"}.issubset(columns)
    assert row == (4, 6)


def test_runtime_identity_mismatch_fails_before_worker_writes(monkeypatch, tmp_path):
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", db_path)

    with pytest.raises(runtime_identity.RuntimeIdentityMismatch, match="API expected DB"):
        runtime_identity.assert_expected_runtime(
            expected_app_dir=str(tmp_path),
            expected_db_path=str(tmp_path / "other.db"),
        )
