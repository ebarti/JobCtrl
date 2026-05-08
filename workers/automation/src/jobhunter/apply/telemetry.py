"""Read-only apply-run views for the CLI dashboard.

PR 4 of the Temporal stack collapsed the bespoke ``apply_runs`` table.
``apply_run_projections`` (sourced from ``job_events`` by the projection
builder) is now the single source of truth for the apply lifecycle. The
CLI's run-history widgets call into this module via duck-typed lookups
(``fetch_recent_runs`` / ``fetch_run_events``); this implementation
points those lookups at the projection table.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobhunter.database import get_connection


def fetch_recent_runs(
    limit: int = 8, failed_only: bool = False, **_: Any
) -> list[dict[str, Any]]:
    """Return the latest apply-run projection rows as plain dicts."""
    conn = get_connection()
    where = "WHERE status NOT IN ('succeeded', 'starting', 'in_progress', 'dry_run_complete')" if failed_only else ""
    rows = conn.execute(
        f"""
        SELECT run_id, job_id, job_title, job_employer, status, result,
               dry_run, worker_id, model, started_at, finished_at,
               duration_ms, events_json
        FROM apply_run_projections
        {where}
        ORDER BY COALESCE(started_at, '') DESC
        LIMIT ?
        """,
        (max(int(limit), 0),),
    ).fetchall()
    return [_row_to_run_dict(row) for row in rows]


def fetch_run_events(
    run_id: str, limit: int = 8, **_: Any
) -> list[dict[str, Any]]:
    """Return the per-event timeline for one apply run from the projection."""
    conn = get_connection()
    row = conn.execute(
        "SELECT events_json FROM apply_run_projections WHERE run_id = ?",
        (run_id,),
    ).fetchone()
    if row is None:
        return []
    raw = row["events_json"] if isinstance(row, sqlite3.Row) else row[0]
    try:
        events = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(events, list):
        return []
    out: list[dict[str, Any]] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        out.append(event)
    return out[: max(int(limit), 0)]


# Aliases preserved for cli.py duck-typed lookups.
get_recent_runs = fetch_recent_runs
list_recent_runs = fetch_recent_runs
get_run_events = fetch_run_events
list_run_events = fetch_run_events
fetch_recent_events = fetch_run_events
get_recent_events = fetch_run_events


def _row_to_run_dict(row: sqlite3.Row) -> dict[str, Any]:
    data: dict[str, Any] = dict(row)
    duration_ms = data.get("duration_ms")
    if isinstance(duration_ms, (int, float)):
        data["duration_ms"] = int(duration_ms)
    events_raw = data.pop("events_json", None) or "[]"
    try:
        events = json.loads(events_raw)
    except json.JSONDecodeError:
        events = []
    if isinstance(events, list) and events:
        last = events[-1]
        if isinstance(last, dict):
            message = last.get("message")
            if message:
                data.setdefault("last_event", str(message))
            payload = last.get("payload")
            if isinstance(payload, dict):
                if not data.get("last_event") and payload.get("error"):
                    data["last_event"] = str(payload["error"])
                if not data.get("error") and payload.get("error"):
                    data["error"] = str(payload["error"])
    return data


__all__ = [
    "fetch_recent_runs",
    "fetch_run_events",
    "get_recent_runs",
    "get_run_events",
    "list_recent_runs",
    "list_run_events",
    "fetch_recent_events",
    "get_recent_events",
]
