from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

import pytest

from jobhunter.infrastructure import runtime_identity


def test_worker_heartbeat_writes_runtime_identity(monkeypatch, tmp_path):
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", db_path)

    worker_id = runtime_identity.write_worker_heartbeat(
        task_queue="jobhunter-default",
        worker_id="worker-test",
        now=datetime(2026, 5, 20, 10, 0, tzinfo=UTC),
    )

    assert worker_id == "worker-test"
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT worker_id, component, app_dir, db_path, task_queue, last_seen_at "
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
    )


def test_runtime_identity_mismatch_fails_before_worker_writes(monkeypatch, tmp_path):
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", db_path)

    with pytest.raises(runtime_identity.RuntimeIdentityMismatch, match="API expected DB"):
        runtime_identity.assert_expected_runtime(
            expected_app_dir=str(tmp_path),
            expected_db_path=str(tmp_path / "other.db"),
        )
