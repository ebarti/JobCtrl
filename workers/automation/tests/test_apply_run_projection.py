"""ApplyRunProjection — telemetry projection."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.state import record_job_event, utc_now


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def _seed_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, strategy, location, salary,
                          discovered_at, application_url, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (url, "Eng", "ExampleCo", "jobspy", "Remote", "", utc_now(), url, "x"),
    )


def _row_value(row, key, default=None):
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return value if value is not None else default


def test_apply_run_with_succeeded_status(conn: sqlite3.Connection) -> None:
    url = "https://example.com/apply-1"
    _seed_job(conn, url)
    started = "2026-05-04T13:00:00+00:00"
    finished = "2026-05-04T13:05:00+00:00"
    conn.execute(
        """
        INSERT INTO apply_runs (run_id, job_url, title, site, status, result,
                                worker_id, model, dry_run, started_at,
                                updated_at, finished_at, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("run-apply-1", url, "Eng", "ExampleCo", "succeeded", "applied", 1, "haiku", 0, started, started, finished, 300_000),
    )
    record_job_event(conn, url, "apply", "ApplicationSubmitted")
    conn.commit()

    ProjectionBuilder(conn).refresh()

    row = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?", ("run-apply-1",)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "succeeded"
    assert _row_value(row, "job_id") == url
    assert _row_value(row, "started_at") == started
    assert _row_value(row, "finished_at") == finished
    assert _row_value(row, "duration_ms") == 300_000
    assert _row_value(row, "model") == "haiku"


def test_apply_run_event_timeline(conn: sqlite3.Connection) -> None:
    url = "https://example.com/apply-2"
    _seed_job(conn, url)
    started = "2026-05-04T13:00:00+00:00"
    conn.execute(
        """
        INSERT INTO apply_runs (run_id, job_url, status, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("run-apply-2", url, "in_progress", started, started),
    )
    conn.execute(
        """
        INSERT INTO apply_run_events (run_id, occurred_at, event_type, message, payload_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("run-apply-2", started, "started", "Apply started", json.dumps({})),
    )
    conn.execute(
        """
        INSERT INTO apply_run_events (run_id, occurred_at, event_type, message, payload_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("run-apply-2", started, "form_filled", "Filled form", json.dumps({"field": "email"})),
    )
    record_job_event(conn, url, "apply", "ApplyRunStarted")
    conn.commit()

    ProjectionBuilder(conn).refresh()

    row = conn.execute(
        "SELECT events_json FROM apply_run_projections WHERE run_id = ?",
        ("run-apply-2",),
    ).fetchone()
    events = json.loads(_row_value(row, "events_json", "[]"))
    assert len(events) == 2
    event_types = [event.get("event_type") for event in events]
    assert event_types == ["started", "form_filled"]


def test_dry_run_flag_propagates(conn: sqlite3.Connection) -> None:
    url = "https://example.com/apply-3"
    _seed_job(conn, url)
    conn.execute(
        """
        INSERT INTO apply_runs (run_id, job_url, status, started_at, updated_at, dry_run)
        VALUES (?, ?, 'dry_run_complete', ?, ?, 1)
        """,
        ("run-apply-3", url, utc_now(), utc_now()),
    )
    record_job_event(conn, url, "apply", "DryRunCompleted")
    conn.commit()

    ProjectionBuilder(conn).refresh()

    row = conn.execute(
        "SELECT dry_run, status FROM apply_run_projections WHERE run_id = ?",
        ("run-apply-3",),
    ).fetchone()
    assert _row_value(row, "dry_run") == 1
    assert _row_value(row, "status") == "dry_run_complete"
