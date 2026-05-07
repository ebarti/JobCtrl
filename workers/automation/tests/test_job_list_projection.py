"""JobListProjection tests — full pipeline from discovery to apply."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.state import record_job_event, set_stage_state, utc_now


@pytest.fixture
def conn(tmp_path: Path) -> sqlite3.Connection:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def _seed_job(conn: sqlite3.Connection, url: str, *, title: str = "Engineer", site: str = "ExampleCo") -> None:
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, strategy, location, salary,
                          discovered_at, application_url, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            title,
            site,
            "jobspy",
            "Remote",
            "$$$",
            "2026-05-04T12:00:00+00:00",
            url,
            "Short job description",
        ),
    )
    conn.commit()


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


def test_discovered_job_appears_in_projection(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/1"
    _seed_job(conn, url)
    record_job_event(conn, url, "discover", "JobDiscovered", message="discovered")
    conn.commit()

    builder = ProjectionBuilder(conn)
    refreshed = builder.refresh()

    assert refreshed >= 1
    row = conn.execute(
        "SELECT * FROM job_list_projections WHERE job_id = ?", (url,)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "title") == "Engineer"
    assert _row_value(row, "source") == "ExampleCo"
    assert _row_value(row, "current_stage") == "discover"
    assert _row_value(row, "current_state") == "pending"


def test_pipeline_progress_advances_current_stage(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/2"
    _seed_job(conn, url, title="Platform Engineer")
    builder = ProjectionBuilder(conn)

    set_stage_state(conn, url, "discover", "succeeded", finished_at=utc_now())
    record_job_event(conn, url, "discover", "StageCompleted")
    conn.commit()
    builder.refresh()

    set_stage_state(conn, url, "enrich", "succeeded", finished_at=utc_now())
    record_job_event(conn, url, "enrich", "StageCompleted")
    conn.commit()
    builder.refresh()

    row = conn.execute(
        "SELECT current_stage, current_state FROM job_list_projections WHERE job_id = ?",
        (url,),
    ).fetchone()
    assert _row_value(row, "current_stage") == "score"
    assert _row_value(row, "current_state") == "pending"


def test_score_event_populates_fit_score(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/3"
    _seed_job(conn, url)
    conn.execute(
        """
        INSERT INTO job_scores (job_url, version, tenant_id, fit_score,
                                breakdown_json, keywords_json, scored_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            1,
            "local",
            8,
            json.dumps({"reasoning": "Strong fit"}),
            json.dumps([]),
            utc_now(),
        ),
    )
    record_job_event(conn, url, "score", "JobScored")
    conn.commit()

    ProjectionBuilder(conn).refresh()

    row = conn.execute(
        "SELECT fit_score, score_reasoning FROM job_list_projections WHERE job_id = ?",
        (url,),
    ).fetchone()
    assert _row_value(row, "fit_score") == 8
    assert _row_value(row, "score_reasoning") == "Strong fit"


def test_apply_run_succeeded_marks_applied(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/4"
    _seed_job(conn, url)
    started = "2026-05-04T13:00:00+00:00"
    finished = "2026-05-04T13:05:00+00:00"
    record_job_event(
        conn,
        url,
        "apply",
        "ApplyRunStarted",
        payload={"run_id": "run-1", "started_at": started},
    )
    record_job_event(
        conn,
        url,
        "apply",
        "ApplicationSubmitted",
        payload={"run_id": "run-1", "finished_at": finished, "result": "applied"},
    )
    conn.commit()

    ProjectionBuilder(conn).refresh()

    row = conn.execute(
        "SELECT apply_status, applied_at FROM job_list_projections WHERE job_id = ?",
        (url,),
    ).fetchone()
    assert _row_value(row, "apply_status") == "applied"
    assert _row_value(row, "applied_at") == finished


def test_soft_deleted_job_carries_deleted_at(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/5"
    _seed_job(conn, url)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jobhunter_deleted_jobs (
            job_url     TEXT PRIMARY KEY,
            deleted_at  TEXT NOT NULL,
            reason      TEXT,
            restored_at TEXT
        )
        """
    )
    deleted_at = "2026-05-04T14:00:00+00:00"
    conn.execute(
        "INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at, reason, restored_at) "
        "VALUES (?, ?, ?, NULL)",
        (url, deleted_at, "test"),
    )
    record_job_event(conn, url, "discover", "JobDeleted")
    conn.commit()

    ProjectionBuilder(conn).refresh()

    row = conn.execute(
        "SELECT deleted_at FROM job_list_projections WHERE job_id = ?", (url,)
    ).fetchone()
    assert _row_value(row, "deleted_at") == deleted_at


def test_initial_backfill_picks_up_pre_event_history(conn: sqlite3.Connection) -> None:
    """Even when no events exist yet, jobs in the table get projected.

    Round-trip: seed a job WITHOUT any matching ``job_events`` row, then
    refresh — the row should appear in the projection so the dashboard
    isn't blank for legacy databases that pre-date event-driven writes.
    """
    url = "https://example.com/jobs/legacy"
    _seed_job(conn, url, title="Legacy Engineer")
    # No record_job_event call — pure backfill path.

    ProjectionBuilder(conn).refresh()

    row = conn.execute(
        "SELECT title FROM job_list_projections WHERE job_id = ?", (url,)
    ).fetchone()
    assert _row_value(row, "title") == "Legacy Engineer"


def test_refresh_is_idempotent(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/6"
    _seed_job(conn, url)
    record_job_event(conn, url, "discover", "JobDiscovered")
    conn.commit()

    builder = ProjectionBuilder(conn)
    builder.refresh()
    builder.refresh()
    builder.refresh()

    rows = conn.execute(
        "SELECT COUNT(*) FROM job_list_projections WHERE job_id = ?", (url,)
    ).fetchone()
    assert rows[0] == 1
