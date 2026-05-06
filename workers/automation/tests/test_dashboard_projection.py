"""DashboardProjection — aggregate counts after every event type."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.state import record_job_event, set_stage_state, utc_now


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def _seed_job(conn: sqlite3.Connection, url: str, *, site: str = "ExampleCo") -> None:
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, strategy, location, salary,
                          discovered_at, application_url, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (url, "Engineer", site, "jobspy", "Remote", "", "2026-05-04T12:00:00+00:00", url, "desc"),
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


def _dashboard(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM dashboard_projections WHERE tenant_id = 'local'"
    ).fetchone()


def test_dashboard_starts_empty(conn: sqlite3.Connection) -> None:
    ProjectionBuilder(conn).refresh()
    row = _dashboard(conn)
    assert row is not None
    assert _row_value(row, "total_jobs", 0) == 0


def test_total_jobs_reflects_active_jobs(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/a")
    _seed_job(conn, "https://example.com/b")
    record_job_event(conn, "https://example.com/a", "discover", "JobDiscovered")
    record_job_event(conn, "https://example.com/b", "discover", "JobDiscovered")
    conn.commit()
    ProjectionBuilder(conn).refresh()
    row = _dashboard(conn)
    assert _row_value(row, "total_jobs") == 2


def test_failures_count_includes_failed_and_exhausted(conn: sqlite3.Connection) -> None:
    url = "https://example.com/c"
    _seed_job(conn, url)
    set_stage_state(conn, url, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "score", "failed", validate_transition=False)
    record_job_event(conn, url, "score", "StageFailed")
    conn.commit()
    ProjectionBuilder(conn).refresh()
    row = _dashboard(conn)
    assert _row_value(row, "failures") == 1


def test_blocked_count(conn: sqlite3.Connection) -> None:
    url = "https://example.com/d"
    _seed_job(conn, url)
    set_stage_state(conn, url, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "score", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "tailor", "blocked", validate_transition=False)
    record_job_event(conn, url, "tailor", "StageBlocked")
    conn.commit()
    ProjectionBuilder(conn).refresh()
    row = _dashboard(conn)
    assert _row_value(row, "blocked") == 1


def test_applied_count_via_apply_status(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/e")
    conn.execute(
        """
        INSERT INTO apply_runs (run_id, job_url, status, started_at,
                                updated_at, finished_at)
        VALUES (?, ?, 'succeeded', ?, ?, ?)
        """,
        ("run-e", "https://example.com/e", utc_now(), utc_now(), utc_now()),
    )
    record_job_event(conn, "https://example.com/e", "apply", "ApplicationSubmitted")
    conn.commit()
    ProjectionBuilder(conn).refresh()
    row = _dashboard(conn)
    assert _row_value(row, "applied") == 1


def test_score_distribution_groups_by_score(conn: sqlite3.Connection) -> None:
    for url, score in [
        ("https://example.com/s8", 8),
        ("https://example.com/s8b", 8),
        ("https://example.com/s5", 5),
    ]:
        _seed_job(conn, url)
        conn.execute(
            """
            INSERT INTO job_scores (job_url, version, tenant_id, fit_score,
                                    breakdown_json, keywords_json, scored_at)
            VALUES (?, 1, 'local', ?, ?, ?, ?)
            """,
            (url, score, json.dumps({}), json.dumps([]), utc_now()),
        )
        record_job_event(conn, url, "score", "JobScored")
    conn.commit()
    ProjectionBuilder(conn).refresh()
    row = _dashboard(conn)
    distribution = json.loads(_row_value(row, "score_distribution_json", "[]"))
    distribution_by_score = {entry[0]: entry[1] for entry in distribution}
    assert distribution_by_score[8] == 2
    assert distribution_by_score[5] == 1


def test_funnel_counts_per_stage(conn: sqlite3.Connection) -> None:
    url = "https://example.com/funnel"
    _seed_job(conn, url)
    set_stage_state(conn, url, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "score", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "tailor", "running")
    record_job_event(conn, url, "tailor", "StageStarted")
    conn.commit()
    ProjectionBuilder(conn).refresh()

    row = _dashboard(conn)
    funnel = json.loads(_row_value(row, "funnel_json", "[]"))
    by_stage = {entry["stage"]: entry for entry in funnel}
    assert by_stage["discover"]["succeeded"] == 1
    assert by_stage["enrich"]["succeeded"] == 1
    assert by_stage["score"]["succeeded"] == 1
    assert by_stage["tailor"]["running"] == 1
    assert by_stage["cover"]["pending"] == 1


def test_by_source_counts(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/x", site="OneCo")
    _seed_job(conn, "https://example.com/y", site="OneCo")
    _seed_job(conn, "https://example.com/z", site="TwoCo")
    for url in ("https://example.com/x", "https://example.com/y", "https://example.com/z"):
        record_job_event(conn, url, "discover", "JobDiscovered")
    conn.commit()
    ProjectionBuilder(conn).refresh()

    row = _dashboard(conn)
    by_source = json.loads(_row_value(row, "by_source_json", "[]"))
    counts = {entry[0]: entry[1] for entry in by_source}
    assert counts["OneCo"] == 2
    assert counts["TwoCo"] == 1
