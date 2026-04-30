"""Persistent telemetry helpers for apply-agent observability.

The apply launcher can use these helpers to create a stable run record,
append structured events, and inspect recent runs without parsing raw logs.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import threading

from jobhunter.database import ensure_observability_tables, get_connection


_BOOL_FIELDS = {"dry_run", "headless"}
_PATH_FIELDS = {
    "prompt_path",
    "mcp_config_path",
    "log_path",
    "output_path",
    "resume_path",
    "cover_letter_path",
}

_SCHEMA_LOCK = threading.Lock()
_READY_CONNECTIONS: set[str] = set()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_conn(conn: sqlite3.Connection | None = None) -> sqlite3.Connection:
    """Return a connection and make sure the telemetry tables exist."""
    if conn is None:
        conn = get_connection()
    key = _connection_key(conn)
    if key not in _READY_CONNECTIONS:
        with _SCHEMA_LOCK:
            if key not in _READY_CONNECTIONS:
                ensure_observability_tables(conn)
                _READY_CONNECTIONS.add(key)
    return conn


def _connection_key(conn: sqlite3.Connection) -> str:
    """Return a stable cache key for a SQLite connection."""
    try:
        row = conn.execute("PRAGMA database_list").fetchone()
        if row and row[2]:
            return str(row[2])
    except sqlite3.Error:
        pass
    return f"id:{id(conn)}"


def _json_text(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _normalize_value(field: str, value: Any) -> Any:
    if value is None:
        return None
    if field in _BOOL_FIELDS:
        return int(bool(value))
    if field in _PATH_FIELDS:
        return str(value)
    if field in {"extra_json", "payload_json"}:
        if isinstance(value, str):
            return value
        return _json_text(value)
    return value


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key in ("extra_json", "payload_json"):
        raw = data.get(key)
        if raw:
            try:
                data[key[:-5]] = json.loads(raw)
            except json.JSONDecodeError:
                data[key[:-5]] = raw
    return data


_RUN_COLUMNS = {
    "run_id",
    "job_url",
    "site",
    "title",
    "application_url",
    "worker_id",
    "worker_name",
    "model",
    "pid",
    "chrome_pid",
    "status",
    "result",
    "error",
    "dry_run",
    "headless",
    "attempts",
    "started_at",
    "updated_at",
    "finished_at",
    "duration_ms",
    "prompt_path",
    "mcp_config_path",
    "log_path",
    "output_path",
    "resume_path",
    "cover_letter_path",
    "task_id",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_create_tokens",
    "cost_usd",
    "extra_json",
}

_RUN_FIELD_ALIASES = {
    "job_title": "title",
    "claude_pid": "pid",
    "mcp_config": "mcp_config_path",
    "worker_log": "log_path",
    "job_log": "output_path",
}


def _normalize_run_fields(fields: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Split flexible launcher payloads into run columns plus extra JSON."""
    normalized: dict[str, Any] = {}
    extra: dict[str, Any] = {}

    for key, value in fields.items():
        if value is None:
            continue
        target = _RUN_FIELD_ALIASES.get(key, key)
        if target == "extra":
            if isinstance(value, Mapping):
                extra.update(dict(value))
            else:
                extra["extra"] = value
            continue
        if target in _RUN_COLUMNS:
            normalized[target] = value
        else:
            extra[target] = value

    return normalized, extra


def create_run(
    *,
    job_url: str,
    site: str | None = None,
    title: str | None = None,
    application_url: str | None = None,
    worker_id: int | None = None,
    worker_name: str | None = None,
    model: str | None = None,
    pid: int | None = None,
    chrome_pid: int | None = None,
    status: str = "starting",
    result: str | None = None,
    error: str | None = None,
    dry_run: bool = False,
    headless: bool = False,
    attempts: int = 1,
    started_at: str | None = None,
    updated_at: str | None = None,
    finished_at: str | None = None,
    duration_ms: int | None = None,
    prompt_path: str | Path | None = None,
    mcp_config_path: str | Path | None = None,
    log_path: str | Path | None = None,
    output_path: str | Path | None = None,
    resume_path: str | Path | None = None,
    cover_letter_path: str | Path | None = None,
    task_id: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cache_read_tokens: int | None = None,
    cache_create_tokens: int | None = None,
    cost_usd: float | None = None,
    extra: Mapping[str, Any] | None = None,
    run_id: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> str:
    """Create or refresh a run record and return its stable run_id."""
    conn = _ensure_conn(conn)
    run_id = run_id or uuid.uuid4().hex
    started_at = started_at or _now()
    updated_at = updated_at or started_at

    record: dict[str, Any] = {
        "run_id": run_id,
        "job_url": job_url,
        "site": site,
        "title": title,
        "application_url": application_url,
        "worker_id": worker_id,
        "worker_name": worker_name,
        "model": model,
        "pid": pid,
        "chrome_pid": chrome_pid,
        "status": status,
        "result": result,
        "error": error,
        "dry_run": _normalize_value("dry_run", dry_run),
        "headless": _normalize_value("headless", headless),
        "attempts": attempts,
        "started_at": started_at,
        "updated_at": updated_at,
        "finished_at": finished_at,
        "duration_ms": duration_ms,
        "prompt_path": _normalize_value("prompt_path", prompt_path),
        "mcp_config_path": _normalize_value("mcp_config_path", mcp_config_path),
        "log_path": _normalize_value("log_path", log_path),
        "output_path": _normalize_value("output_path", output_path),
        "resume_path": _normalize_value("resume_path", resume_path),
        "cover_letter_path": _normalize_value("cover_letter_path", cover_letter_path),
        "task_id": task_id,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_create_tokens": cache_create_tokens,
        "cost_usd": cost_usd,
        "extra_json": _json_text(extra) if extra is not None else None,
    }

    columns = list(record.keys())
    values = [record[col] for col in columns]
    insert_cols = ", ".join(columns)
    placeholders = ", ".join("?" for _ in columns)
    update_cols = ", ".join(
        f"{col} = excluded.{col}"
        for col in columns
        if col not in {"run_id", "started_at"}
    )

    conn.execute(
        f"""
        INSERT INTO apply_runs ({insert_cols})
        VALUES ({placeholders})
        ON CONFLICT(run_id) DO UPDATE SET
            {update_cols}
        """,
        values,
    )
    conn.commit()
    return run_id


def start_run(conn: sqlite3.Connection | None = None, **fields: Any) -> str:
    """Create a run row from flexible launcher payloads."""
    started_at = fields.get("started_at") or fields.get("acquired_at")
    updated_at = fields.get("updated_at") or started_at
    normalized, extra = _normalize_run_fields(fields)

    job_url = normalized.pop("job_url", None)
    if not job_url:
        raise ValueError("start_run requires job_url")

    run_id = normalized.pop("run_id", None)
    normalized.pop("started_at", None)
    normalized.pop("updated_at", None)

    return create_run(
        run_id=run_id,
        job_url=job_url,
        started_at=started_at,
        updated_at=updated_at,
        extra=extra or None,
        conn=conn,
        **normalized,
    )


def update_run(
    run_id: str,
    conn: sqlite3.Connection | None = None,
    **fields: Any,
) -> int:
    """Update fields on a run row and refresh updated_at."""
    if not fields:
        return 0

    conn = _ensure_conn(conn)
    assignments: list[str] = []
    values: list[Any] = []

    for field, value in fields.items():
        if field == "extra":
            field = "extra_json"
        elif field == "payload":
            field = "extra_json"
        value = _normalize_value(field, value)
        assignments.append(f"{field} = ?")
        values.append(value)

    assignments.append("updated_at = ?")
    values.append(_now())
    values.append(run_id)

    cur = conn.execute(
        f"UPDATE apply_runs SET {', '.join(assignments)} WHERE run_id = ?",
        values,
    )
    conn.commit()
    return cur.rowcount


def finish_run(run_id: str, conn: sqlite3.Connection | None = None, **fields: Any) -> int:
    """Finish or refresh a run row from flexible launcher payloads."""
    final_status = fields.get("final_status")
    result_reason = fields.get("result_reason")
    finished_at = fields.get("finished_at") or _now()
    normalized, extra = _normalize_run_fields(fields)

    if final_status is not None:
        normalized.setdefault("status", final_status)
    normalized.setdefault("finished_at", finished_at)

    if result_reason:
        if normalized.get("status") == "failed":
            normalized.setdefault("error", result_reason)
        normalized.setdefault("result", result_reason)
    elif normalized.get("status") and normalized.get("status") != "in_progress":
        normalized.setdefault("result", normalized["status"])

    if extra:
        current = get_run(run_id, conn=conn) or {}
        merged_extra: dict[str, Any] = {}
        if isinstance(current.get("extra"), Mapping):
            merged_extra.update(current["extra"])
        merged_extra.update(extra)
        normalized["extra"] = merged_extra

    return update_run(run_id, conn=conn, **normalized)


def append_event(
    run_id: str,
    event_type: str,
    *,
    message: str | None = None,
    level: str = "info",
    worker_id: int | None = None,
    payload: Mapping[str, Any] | None = None,
    occurred_at: str | None = None,
    conn: sqlite3.Connection | None = None,
    **extra: Any,
) -> int:
    """Append a structured event to the run timeline."""
    conn = _ensure_conn(conn)
    occurred_at = occurred_at or _now()

    payload_data: dict[str, Any] = {}
    if payload is not None:
        payload_data.update(dict(payload))
    if extra:
        payload_data.update(extra)

    payload_json = _json_text(payload_data) if payload_data else None

    cur = conn.execute(
        """
        INSERT INTO apply_run_events (
            run_id, occurred_at, worker_id, event_type, level, message, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            occurred_at,
            worker_id,
            event_type,
            level,
            message,
            payload_json,
        ),
    )
    conn.execute(
        "UPDATE apply_runs SET updated_at = ? WHERE run_id = ?",
        (occurred_at, run_id),
    )
    conn.commit()
    return cur.lastrowid


def get_run(run_id: str, conn: sqlite3.Connection | None = None) -> dict[str, Any] | None:
    """Fetch a single run record by run_id."""
    conn = _ensure_conn(conn)
    row = conn.execute(
        """
        SELECT r.*,
               COALESCE((SELECT COUNT(*) FROM apply_run_events e WHERE e.run_id = r.run_id), 0) AS event_count,
               (SELECT e.occurred_at
                FROM apply_run_events e
                WHERE e.run_id = r.run_id
                ORDER BY e.event_id DESC
                LIMIT 1) AS last_event_at
        FROM apply_runs r
        WHERE r.run_id = ?
        """,
        (run_id,),
    ).fetchone()
    return _row_to_dict(row)


def get_recent_runs(
    limit: int = 50,
    *,
    worker_id: int | None = None,
    status: str | Sequence[str] | None = None,
    job_url: str | None = None,
    failed_only: bool = False,
    conn: sqlite3.Connection | None = None,
) -> list[dict[str, Any]]:
    """Return the newest runs, optionally filtered by worker, status, or job URL."""
    conn = _ensure_conn(conn)
    where: list[str] = []
    params: list[Any] = []

    if worker_id is not None:
        where.append("r.worker_id = ?")
        params.append(worker_id)

    if status is not None:
        if isinstance(status, str):
            where.append("r.status = ?")
            params.append(status)
        else:
            values = list(status)
            if values:
                where.append(f"r.status IN ({', '.join('?' for _ in values)})")
                params.extend(values)

    if job_url is not None:
        where.append("r.job_url = ?")
        params.append(job_url)

    if failed_only:
        where.append("r.status IN ('failed', 'error')")

    query = """
        SELECT r.*,
               COALESCE((SELECT COUNT(*) FROM apply_run_events e WHERE e.run_id = r.run_id), 0) AS event_count,
               (SELECT e.occurred_at
                FROM apply_run_events e
                WHERE e.run_id = r.run_id
                ORDER BY e.event_id DESC
                LIMIT 1) AS last_event_at,
               (SELECT COALESCE(e.message, e.payload_json, '')
                FROM apply_run_events e
                WHERE e.run_id = r.run_id
                ORDER BY e.event_id DESC
                LIMIT 1) AS last_event,
               (SELECT e.event_type
                FROM apply_run_events e
                WHERE e.run_id = r.run_id
                ORDER BY e.event_id DESC
                LIMIT 1) AS last_event_type
        FROM apply_runs r
    """
    if where:
        query += " WHERE " + " AND ".join(where)
    query += " ORDER BY r.started_at DESC, r.run_id DESC"
    if limit > 0:
        query += " LIMIT ?"
        params.append(limit)

    rows = conn.execute(query, params).fetchall()
    return [_row_to_dict(row) for row in rows if row is not None]


def get_recent_events(
    limit: int = 100,
    *,
    run_id: str | None = None,
    event_type: str | None = None,
    worker_id: int | None = None,
    conn: sqlite3.Connection | None = None,
) -> list[dict[str, Any]]:
    """Return the newest events, optionally filtered by run or event type."""
    conn = _ensure_conn(conn)
    where: list[str] = []
    params: list[Any] = []

    if run_id is not None:
        where.append("e.run_id = ?")
        params.append(run_id)
    if event_type is not None:
        where.append("e.event_type = ?")
        params.append(event_type)
    if worker_id is not None:
        where.append("e.worker_id = ?")
        params.append(worker_id)

    query = """
        SELECT e.*,
               r.job_url,
               r.site,
               r.title,
               r.status AS run_status,
               r.model,
               r.worker_name
        FROM apply_run_events e
        LEFT JOIN apply_runs r ON r.run_id = e.run_id
    """
    if where:
        query += " WHERE " + " AND ".join(where)
    query += " ORDER BY e.event_id DESC"
    if limit > 0:
        query += " LIMIT ?"
        params.append(limit)

    rows = conn.execute(query, params).fetchall()
    return [_row_to_dict(row) for row in rows if row is not None]


def get_run_events(
    run_id: str,
    *,
    limit: int = 500,
    conn: sqlite3.Connection | None = None,
) -> list[dict[str, Any]]:
    """Return a run's full event timeline in chronological order."""
    conn = _ensure_conn(conn)
    if limit > 0:
        rows = conn.execute(
            """
            SELECT * FROM (
                SELECT e.*,
                       r.job_url,
                       r.site,
                       r.title,
                       r.status AS run_status,
                       r.model,
                       r.worker_name
                FROM apply_run_events e
                LEFT JOIN apply_runs r ON r.run_id = e.run_id
                WHERE e.run_id = ?
                ORDER BY e.event_id DESC
                LIMIT ?
            )
            ORDER BY event_id ASC
            """,
            (run_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT e.*,
                   r.job_url,
                   r.site,
                   r.title,
                   r.status AS run_status,
                   r.model,
                   r.worker_name
            FROM apply_run_events e
            LEFT JOIN apply_runs r ON r.run_id = e.run_id
            WHERE e.run_id = ?
            ORDER BY e.event_id ASC
            """,
            (run_id,),
        ).fetchall()
    return [_row_to_dict(row) for row in rows if row is not None]


fetch_recent_runs = get_recent_runs
fetch_recent_events = get_recent_events
fetch_run_events = get_run_events
record_event = append_event
start_apply_run = start_run
finish_apply_run = finish_run


__all__ = [
    "append_event",
    "create_run",
    "finish_apply_run",
    "finish_run",
    "fetch_recent_events",
    "fetch_recent_runs",
    "fetch_run_events",
    "get_recent_events",
    "get_recent_runs",
    "get_run",
    "get_run_events",
    "record_event",
    "start_apply_run",
    "start_run",
    "update_run",
]
