"""PR 4: ``apply_run_projections`` is sourced from ``job_events`` after
the ``apply_runs`` table is dropped.

The projector watches for the apply lifecycle events the launcher /
``SubmitApplicationUseCase`` emit:

  * ``ApplyRunStarted``       — opens a row (status="starting").
  * ``ApplyRunInProgress``    — flips to ``in_progress``.
  * ``ApplicationSubmitted``  — terminal, status="succeeded".
  * ``ApplicationFailed``     — terminal, status="failed" (or the
                                specific submission_result kind).
  * ``DryRunCompleted``       — terminal, status="dry_run_complete".

Every event payload includes a ``run_id`` so the projector can key
multiple events under one row.
"""

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


def test_started_event_opens_row(conn: sqlite3.Connection) -> None:
    url = "https://example.com/job"
    _seed_job(conn, url)
    record_job_event(
        conn,
        url,
        "apply",
        "ApplyRunStarted",
        payload={
            "run_id": "run-1",
            "model": "haiku",
            "dry_run": False,
            "worker_id": 7,
            "started_at": "2026-05-04T13:00:00+00:00",
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?", ("run-1",)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "starting"
    assert _row_value(row, "job_id") == url
    assert _row_value(row, "model") == "haiku"
    assert _row_value(row, "worker_id") == 7
    assert _row_value(row, "started_at") == "2026-05-04T13:00:00+00:00"


def test_submitted_event_terminates_row_as_succeeded(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job-applied"
    _seed_job(conn, url)
    record_job_event(
        conn,
        url,
        "apply",
        "ApplyRunStarted",
        payload={
            "run_id": "run-2",
            "model": "haiku",
            "dry_run": False,
            "worker_id": 1,
            "started_at": "2026-05-04T13:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        url,
        "apply",
        "ApplicationSubmitted",
        payload={
            "run_id": "run-2",
            "finished_at": "2026-05-04T13:05:00+00:00",
            "duration_ms": 300_000,
            "result": "applied",
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?", ("run-2",)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "succeeded"
    assert _row_value(row, "result") == "applied"
    assert _row_value(row, "finished_at") == "2026-05-04T13:05:00+00:00"
    assert _row_value(row, "duration_ms") == 300_000


def test_failed_event_terminates_row_as_failed(conn: sqlite3.Connection) -> None:
    url = "https://example.com/job-failed"
    _seed_job(conn, url)
    record_job_event(
        conn,
        url,
        "apply",
        "ApplyRunStarted",
        payload={
            "run_id": "run-3",
            "started_at": "2026-05-04T13:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        url,
        "apply",
        "ApplicationFailed",
        payload={
            "run_id": "run-3",
            "finished_at": "2026-05-04T13:02:00+00:00",
            "result": "failed",
            "error": "boom",
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?", ("run-3",)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "failed"
    assert _row_value(row, "result") == "failed"
    assert _row_value(row, "finished_at") == "2026-05-04T13:02:00+00:00"


def test_dry_run_completed_event_terminates_row(conn: sqlite3.Connection) -> None:
    url = "https://example.com/job-dry"
    _seed_job(conn, url)
    record_job_event(
        conn,
        url,
        "apply",
        "ApplyRunStarted",
        payload={
            "run_id": "run-4",
            "dry_run": True,
            "started_at": "2026-05-04T13:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        url,
        "apply",
        "DryRunCompleted",
        payload={
            "run_id": "run-4",
            "finished_at": "2026-05-04T13:01:00+00:00",
            "result": "dry_run_complete",
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?", ("run-4",)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "dry_run_complete"
    assert _row_value(row, "dry_run") == 1


def test_event_timeline_collected_per_run(conn: sqlite3.Connection) -> None:
    url = "https://example.com/job-events"
    _seed_job(conn, url)
    record_job_event(
        conn,
        url,
        "apply",
        "ApplyRunStarted",
        payload={"run_id": "run-5", "started_at": "t0"},
    )
    record_job_event(
        conn,
        url,
        "apply",
        "ApplyRunEvent",
        payload={"run_id": "run-5", "step": "form_filled"},
        message="Filled application form",
    )
    record_job_event(
        conn,
        url,
        "apply",
        "ApplicationSubmitted",
        payload={
            "run_id": "run-5",
            "finished_at": "t9",
            "result": "applied",
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT events_json FROM apply_run_projections WHERE run_id = ?",
        ("run-5",),
    ).fetchone()
    assert row is not None
    events = json.loads(_row_value(row, "events_json", "[]"))
    # All three apply-stage events are surfaced in chronological order.
    types = [event.get("event_type") for event in events]
    assert types == ["ApplyRunStarted", "ApplyRunEvent", "ApplicationSubmitted"]


def test_projection_rebuild_is_deterministic(conn: sqlite3.Connection) -> None:
    """Running the projector twice produces the same row state — no
    duplicates, no churn."""
    url = "https://example.com/job-deterministic"
    _seed_job(conn, url)
    record_job_event(
        conn,
        url,
        "apply",
        "ApplyRunStarted",
        payload={
            "run_id": "run-6",
            "started_at": "2026-05-04T13:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        url,
        "apply",
        "ApplicationSubmitted",
        payload={
            "run_id": "run-6",
            "finished_at": "2026-05-04T13:05:00+00:00",
            "result": "applied",
        },
    )
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()
    row_first = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?",
        ("run-6",),
    ).fetchone()
    assert row_first is not None
    builder.refresh()
    rows_after = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?",
        ("run-6",),
    ).fetchall()
    assert len(rows_after) == 1
    # Status / result identical across refreshes.
    assert _row_value(rows_after[0], "status") == _row_value(row_first, "status")
    assert _row_value(rows_after[0], "finished_at") == _row_value(
        row_first, "finished_at"
    )
