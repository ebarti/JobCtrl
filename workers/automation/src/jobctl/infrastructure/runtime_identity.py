"""Runtime identity and heartbeat helpers for local worker processes."""

from __future__ import annotations

import os
import socket
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from jobctl import config
from jobctl.infrastructure.temporal.concurrency import (
    activity_executor_max_workers,
    max_concurrent_activities_from_env,
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
) -> str:
    identity = current_runtime_identity()
    resolved_worker_id = worker_id or _default_worker_id()
    timestamp = (now or datetime.now(UTC)).isoformat()
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
              activity_executor_max_workers INTEGER
            )
            """
        )
        _ensure_heartbeat_runtime_columns(conn)
        max_concurrent_activities = max_concurrent_activities_from_env()
        executor_max_workers = activity_executor_max_workers(max_concurrent_activities)
        conn.execute(
            f"""
            INSERT INTO {WORKER_HEARTBEAT_TABLE}
              (worker_id, component, pid, hostname, app_dir, db_path, task_queue, started_at, last_seen_at,
               max_concurrent_activities, activity_executor_max_workers)
            VALUES (?, 'temporal-worker', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(worker_id) DO UPDATE SET
              component = excluded.component,
              pid = excluded.pid,
              hostname = excluded.hostname,
              app_dir = excluded.app_dir,
              db_path = excluded.db_path,
              task_queue = excluded.task_queue,
              last_seen_at = excluded.last_seen_at,
              max_concurrent_activities = excluded.max_concurrent_activities,
              activity_executor_max_workers = excluded.activity_executor_max_workers
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
                max_concurrent_activities,
                executor_max_workers,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return resolved_worker_id


def _default_worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


def _ensure_heartbeat_runtime_columns(conn: sqlite3.Connection) -> None:
    columns = {str(row[1]) for row in conn.execute(f"PRAGMA table_info({WORKER_HEARTBEAT_TABLE})")}
    if "max_concurrent_activities" not in columns:
        conn.execute(
            f"ALTER TABLE {WORKER_HEARTBEAT_TABLE} ADD COLUMN max_concurrent_activities INTEGER"
        )
    if "activity_executor_max_workers" not in columns:
        conn.execute(
            f"ALTER TABLE {WORKER_HEARTBEAT_TABLE} ADD COLUMN activity_executor_max_workers INTEGER"
        )


def _normalize(value: str | Path) -> str:
    return str(Path(value).expanduser().resolve())
