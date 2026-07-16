"""Runtime identity and heartbeat helpers for local worker processes."""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from jobctrl import config
from jobctrl.infrastructure.temporal.activity_runtime_telemetry import (
    ActivityInventorySnapshot,
)
from jobctrl.infrastructure.temporal.concurrency import (
    activity_executor_max_workers,
    resolve_max_concurrent_activities,
)
from jobctrl.infrastructure.temporal.task_queue_observation import (
    TaskQueueObservation,
)

WORKER_HEARTBEAT_TABLE = "worker_runtime_heartbeats"


class RuntimeIdentityMismatch(RuntimeError):
    """Raised when a worker is about to write to a DB different from the API DB."""


@dataclass(frozen=True)
class RuntimeIdentity:
    app_dir: str
    db_path: str


def current_runtime_identity() -> RuntimeIdentity:
    return RuntimeIdentity(
        app_dir=_normalize(config.APP_DIR),
        db_path=_normalize(config.DB_PATH),
    )


def assert_expected_runtime(
    *,
    expected_app_dir: str | None = None,
    expected_db_path: str | None = None,
) -> None:
    current = current_runtime_identity()
    mismatches: list[str] = []
    if expected_app_dir and _normalize(expected_app_dir) != current.app_dir:
        mismatches.append(
            f"API expected app dir {_normalize(expected_app_dir)}, worker is using {current.app_dir}"
        )
    if expected_db_path and _normalize(expected_db_path) != current.db_path:
        mismatches.append(
            f"API expected DB {_normalize(expected_db_path)}, worker is using {current.db_path}"
        )
    if mismatches:
        raise RuntimeIdentityMismatch("Worker runtime mismatch: " + "; ".join(mismatches))


def write_worker_heartbeat(
    *,
    task_queue: str,
    worker_id: str | None = None,
    now: datetime | None = None,
    max_concurrent_activities: int | None = None,
    activity_snapshot: ActivityInventorySnapshot | None = None,
    task_queue_observation: TaskQueueObservation | None = None,
) -> str:
    identity = current_runtime_identity()
    resolved_worker_id = worker_id or _default_worker_id()
    observed_now = now or datetime.now(UTC)
    timestamp = observed_now.isoformat()
    snapshot = activity_snapshot or ActivityInventorySnapshot.empty()
    queue_observation = task_queue_observation or TaskQueueObservation.unavailable(
        observed_at=observed_now,
        reason_code="not_sampled",
    )
    db_path = Path(identity.db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {WORKER_HEARTBEAT_TABLE} (
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
              active_activity_counts_json TEXT NOT NULL DEFAULT '{{}}',
              active_activity_details_json TEXT NOT NULL DEFAULT '[]',
              active_activity_details_total INTEGER NOT NULL DEFAULT 0,
              active_activity_details_truncated INTEGER NOT NULL DEFAULT 0,
              activity_duration_summary_json TEXT NOT NULL DEFAULT '{{}}',
              task_queue_observation_json TEXT,
              heartbeat_schema_version INTEGER NOT NULL DEFAULT 2
            )
            """
        )
        _ensure_heartbeat_runtime_columns(conn)
        active_max_concurrent_activities = (
            max_concurrent_activities
            if max_concurrent_activities is not None
            else resolve_max_concurrent_activities().value
        )
        executor_max_workers = activity_executor_max_workers(active_max_concurrent_activities)
        conn.execute(
            f"""
            INSERT INTO {WORKER_HEARTBEAT_TABLE}
              (worker_id, component, pid, hostname, app_dir, db_path, task_queue, started_at, last_seen_at,
               max_concurrent_activities, activity_executor_max_workers, active_activity_count,
               active_activity_counts_json, active_activity_details_json, active_activity_details_total,
               active_activity_details_truncated, activity_duration_summary_json,
               task_queue_observation_json, heartbeat_schema_version)
            VALUES (?, 'temporal-worker', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)
            ON CONFLICT(worker_id) DO UPDATE SET
              component = excluded.component,
              pid = excluded.pid,
              hostname = excluded.hostname,
              app_dir = excluded.app_dir,
              db_path = excluded.db_path,
              task_queue = excluded.task_queue,
              last_seen_at = excluded.last_seen_at,
              max_concurrent_activities = excluded.max_concurrent_activities,
              activity_executor_max_workers = excluded.activity_executor_max_workers,
              active_activity_count = excluded.active_activity_count,
              active_activity_counts_json = excluded.active_activity_counts_json,
              active_activity_details_json = excluded.active_activity_details_json,
              active_activity_details_total = excluded.active_activity_details_total,
              active_activity_details_truncated = excluded.active_activity_details_truncated,
              activity_duration_summary_json = excluded.activity_duration_summary_json,
              task_queue_observation_json = excluded.task_queue_observation_json,
              heartbeat_schema_version = excluded.heartbeat_schema_version
            """,
            (
                resolved_worker_id,
                os.getpid(),
                socket.gethostname(),
                identity.app_dir,
                identity.db_path,
                task_queue,
                timestamp,
                timestamp,
                active_max_concurrent_activities,
                executor_max_workers,
                snapshot.active_activity_count,
                _json_dumps(snapshot.counts_json_dict()),
                _json_dumps(snapshot.details_json_list()),
                snapshot.active_details_total,
                int(snapshot.active_details_truncated),
                _json_dumps(snapshot.durations_json_dict()),
                _json_dumps(queue_observation.to_json_dict()),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return resolved_worker_id


def latest_active_max_concurrent_activities() -> int | None:
    """Return the latest worker-reported active activity limit, when available."""
    identity = current_runtime_identity()
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(identity.db_path)
        row = conn.execute(
            f"SELECT max_concurrent_activities FROM {WORKER_HEARTBEAT_TABLE} "
            "WHERE max_concurrent_activities IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1"
        ).fetchone()
    except sqlite3.Error:
        return None
    finally:
        if conn is not None:
            conn.close()
    if row is None:
        return None
    try:
        return max(1, int(row[0]))
    except (TypeError, ValueError):
        return None


def _default_worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


def _ensure_heartbeat_runtime_columns(conn: sqlite3.Connection) -> None:
    columns = {str(row[1]) for row in conn.execute(f"PRAGMA table_info({WORKER_HEARTBEAT_TABLE})")}
    additions = {
        "max_concurrent_activities": "INTEGER",
        "activity_executor_max_workers": "INTEGER",
        "active_activity_count": "INTEGER NOT NULL DEFAULT 0",
        "active_activity_counts_json": "TEXT NOT NULL DEFAULT '{}'",
        "active_activity_details_json": "TEXT NOT NULL DEFAULT '[]'",
        "active_activity_details_total": "INTEGER NOT NULL DEFAULT 0",
        "active_activity_details_truncated": "INTEGER NOT NULL DEFAULT 0",
        "activity_duration_summary_json": "TEXT NOT NULL DEFAULT '{}'",
        "task_queue_observation_json": "TEXT",
        "heartbeat_schema_version": "INTEGER NOT NULL DEFAULT 1",
    }
    for column, declaration in additions.items():
        if column not in columns:
            conn.execute(
                f"ALTER TABLE {WORKER_HEARTBEAT_TABLE} ADD COLUMN {column} {declaration}"
            )


def _json_dumps(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _normalize(value: str | Path) -> str:
    return str(Path(value).expanduser().resolve())
