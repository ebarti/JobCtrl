from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime

import pytest

from jobctrl.infrastructure import runtime_identity
from jobctrl.infrastructure.temporal.activity_runtime_telemetry import (
    ActiveActivityInventory,
)
from jobctrl.infrastructure.temporal.task_queue_observation import (
    TaskQueueObservation,
    TaskQueueStatsSnapshot,
)


def test_worker_heartbeat_writes_runtime_identity(monkeypatch, tmp_path):
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", db_path)
    (tmp_path / "config.json").write_text('{"worker_activity_slots": 8}', encoding="utf-8")

    worker_id = runtime_identity.write_worker_heartbeat(
        task_queue="jobctrl-default",
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
        "jobctrl-default",
        "2026-05-20T10:00:00+00:00",
        8,
        10,
    )


def test_worker_heartbeat_keeps_the_startup_concurrency_snapshot(monkeypatch, tmp_path):
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", db_path)

    runtime_identity.write_worker_heartbeat(
        task_queue="jobctrl-default",
        worker_id="worker-test",
        now=datetime(2026, 5, 20, 10, 0, tzinfo=UTC),
        max_concurrent_activities=8,
    )
    (tmp_path / "config.json").write_text(
        '{"worker_activity_slots": 13}',
        encoding="utf-8",
    )
    runtime_identity.write_worker_heartbeat(
        task_queue="jobctrl-default",
        worker_id="worker-test",
        now=datetime(2026, 5, 20, 10, 1, tzinfo=UTC),
        max_concurrent_activities=8,
    )

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT max_concurrent_activities, activity_executor_max_workers "
            "FROM worker_runtime_heartbeats WHERE worker_id = ?",
            ("worker-test",),
        ).fetchone()
    finally:
        conn.close()

    assert row == (8, 10)
    assert runtime_identity.latest_active_max_concurrent_activities() == 8


def test_worker_heartbeat_migrates_legacy_runtime_columns(monkeypatch, tmp_path):
    db_path = tmp_path / "jobctrl.db"
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
        task_queue="jobctrl-default",
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

    assert {
        "max_concurrent_activities",
        "activity_executor_max_workers",
        "active_activity_count",
        "active_activity_counts_json",
        "active_activity_details_json",
        "active_activity_details_total",
        "active_activity_details_truncated",
        "activity_duration_summary_json",
        "task_queue_observation_json",
        "heartbeat_schema_version",
    }.issubset(columns)
    assert row == (4, 6)


def test_worker_heartbeat_persists_only_safe_runtime_snapshot_fields(monkeypatch, tmp_path):
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", db_path)
    canaries = (
        "https://jobs.example/private-role",
        "description-profile-private",
        "prompt-provider-output-private",
        str(tmp_path / "private-resume.pdf"),
        "secret-api-key-private",
    )
    sensitive_identity = "|".join(canaries)
    inventory = ActiveActivityInventory()
    for index in range(3):
        inventory.start(
            activity_type="score_job",
            activity_id=f"{sensitive_identity}:{index}",
            workflow_id=sensitive_identity,
            workflow_run_id=sensitive_identity,
            attempt=1,
            started_at=datetime(2026, 7, 14, 9, index, tzinfo=UTC),
        )
    queue_stats = TaskQueueStatsSnapshot(
        poller_count=2,
        approximate_backlog_count=9,
        approximate_backlog_age_seconds=12.5,
        tasks_add_rate=3.0,
        tasks_dispatch_rate=2.5,
    )
    queue_observation = TaskQueueObservation.available(
        observed_at=datetime(2026, 7, 14, 10, 0, tzinfo=UTC),
        workflow=queue_stats,
        activity=queue_stats,
    )

    runtime_identity.write_worker_heartbeat(
        task_queue="jobctrl-default",
        worker_id="worker-test",
        now=datetime(2026, 7, 14, 10, 0, tzinfo=UTC),
        max_concurrent_activities=8,
        activity_snapshot=inventory.snapshot(),
        task_queue_observation=queue_observation,
    )

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT active_activity_count, active_activity_counts_json, "
            "active_activity_details_json, active_activity_details_total, "
            "active_activity_details_truncated, activity_duration_summary_json, "
            "task_queue_observation_json, heartbeat_schema_version "
            "FROM worker_runtime_heartbeats WHERE worker_id = ?",
            ("worker-test",),
        ).fetchone()
    finally:
        conn.close()

    assert row is not None
    assert row[0] == 3
    assert json.loads(row[1]) == {"score_job": 3}
    assert len(json.loads(row[2])) == 3
    assert row[3:5] == (3, 0)
    assert json.loads(row[5]) == {}
    assert json.loads(row[6]) == {
        "activity": {
            "approximateBacklogAgeSeconds": 12.5,
            "approximateBacklogCount": 9,
            "pollerCount": 2,
            "tasksAddRate": 3.0,
            "tasksDispatchRate": 2.5,
        },
        "observedAt": "2026-07-14T10:00:00+00:00",
        "status": "available",
        "workflow": {
            "approximateBacklogAgeSeconds": 12.5,
            "approximateBacklogCount": 9,
            "pollerCount": 2,
            "tasksAddRate": 3.0,
            "tasksDispatchRate": 2.5,
        },
    }
    assert row[7] == 2
    serialized_row = "|".join(str(value) for value in row)
    for canary in canaries:
        assert canary not in serialized_row


def test_runtime_identity_mismatch_fails_before_worker_writes(monkeypatch, tmp_path):
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", db_path)

    with pytest.raises(runtime_identity.RuntimeIdentityMismatch, match="API expected DB"):
        runtime_identity.assert_expected_runtime(
            expected_app_dir=str(tmp_path),
            expected_db_path=str(tmp_path / "other.db"),
        )
