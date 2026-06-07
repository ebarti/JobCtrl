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


def _mark_closed(conn: sqlite3.Connection, url: str, state: str = "removed") -> None:
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_url, snapshot_set_json, latest_snapshot_version,
            latest_active_state, updated_at
        ) VALUES ('local', ?, '{}', 0, ?, ?)
        ON CONFLICT(tenant_id, job_url) DO UPDATE SET
            latest_active_state = excluded.latest_active_state,
            updated_at = excluded.updated_at
        """,
        (url, state, utc_now()),
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
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    assert row is not None
    assert _row_value(row, "total_jobs", 0) == 0


def test_total_jobs_reflects_active_jobs(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/a")
    _seed_job(conn, "https://example.com/b")
    record_job_event(conn, "https://example.com/a", "discover", "JobDiscovered")
    record_job_event(conn, "https://example.com/b", "discover", "JobDiscovered")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    assert _row_value(row, "total_jobs") == 2


def test_dashboard_excludes_closed_jobs_from_active_counts(conn: sqlite3.Connection) -> None:
    active_url = "https://example.com/active"
    closed_url = "https://example.com/closed"
    _seed_job(conn, active_url)
    _seed_job(conn, closed_url)
    set_stage_state(conn, active_url, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, active_url, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, active_url, "score", "succeeded", finished_at=utc_now())
    set_stage_state(conn, active_url, "tailor", "blocked", validate_transition=False)
    set_stage_state(conn, closed_url, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, closed_url, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, closed_url, "score", "failed", validate_transition=False)
    record_job_event(conn, active_url, "tailor", "StageBlocked")
    record_job_event(conn, closed_url, "score", "StageFailed")
    _mark_closed(conn, closed_url)
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)

    assert _row_value(row, "total_jobs") == 1
    assert _row_value(row, "blocked") == 1
    assert _row_value(row, "failures") == 0


def test_failures_count_includes_failed_and_exhausted(conn: sqlite3.Connection) -> None:
    url = "https://example.com/c"
    _seed_job(conn, url)
    set_stage_state(conn, url, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "score", "failed", validate_transition=False)
    record_job_event(conn, url, "score", "StageFailed")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
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
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    assert _row_value(row, "blocked") == 1


def test_applied_count_via_apply_status(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/e")
    started = utc_now()
    finished = utc_now()
    record_job_event(
        conn,
        "https://example.com/e",
        "apply",
        "ApplyRunStarted",
        payload={"run_id": "run-e", "started_at": started},
    )
    record_job_event(
        conn,
        "https://example.com/e",
        "apply",
        "ApplicationSubmitted",
        payload={"run_id": "run-e", "finished_at": finished, "result": "applied"},
    )
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
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
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    distribution = json.loads(_row_value(row, "score_distribution_json", "[]"))
    distribution_by_score = {entry[0]: entry[1] for entry in distribution}
    assert distribution_by_score[8] == 2
    assert distribution_by_score[5] == 1


def test_artifact_projection_preserves_material_metadata(conn: sqlite3.Connection) -> None:
    url = "https://example.com/materials-metadata"
    _seed_job(conn, url)
    metadata = {"quality_plan": {"target_seniority": "executive"}}
    conn.execute(
        """
        INSERT INTO job_materials (
            job_url, generation, tenant_id, status, created_at, updated_at, metadata_json
        ) VALUES (?, 1, 'local', 'resume_approved', ?, ?, '{}')
        """,
        (url, utc_now(), utc_now()),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            job_url, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, 1, 'tailored_resume', 'artifact-1', 'approved', ?, 'text', 12, ?, ?)
        """,
        (url, "/tmp/resume.txt", json.dumps(metadata), utc_now()),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            job_url, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, 1, 'resume_pdf', 'artifact-pdf', 'approved', ?, 'pdf', 120, '{}', ?)
        """,
        (url, "/tmp/resume.pdf", utc_now()),
    )
    record_job_event(conn, url, "tailor", "MaterialsGenerated")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = conn.execute(
        """
        SELECT metadata_json
        FROM artifact_list_projections
        WHERE tenant_id = 'local' AND artifact_id = 'artifact-1'
        """
    ).fetchone()

    assert json.loads(_row_value(row, "metadata_json", "{}")) == metadata
    synthetic_pdf = conn.execute(
        """
        SELECT metadata_json
        FROM artifact_list_projections
        WHERE tenant_id = 'local' AND artifact_type = 'tailored_resume_pdf'
        """
    ).fetchone()

    assert json.loads(_row_value(synthetic_pdf, "metadata_json", "{}")) == metadata


def test_funnel_counts_per_stage(conn: sqlite3.Connection) -> None:
    url = "https://example.com/funnel"
    _seed_job(conn, url)
    set_stage_state(conn, url, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "score", "succeeded", finished_at=utc_now())
    set_stage_state(conn, url, "tailor", "running")
    record_job_event(conn, url, "tailor", "StageStarted")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

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
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = _dashboard(conn)
    by_source = json.loads(_row_value(row, "by_source_json", "[]"))
    counts = {entry[0]: entry[1] for entry in by_source}
    assert counts["OneCo"] == 2
    assert counts["TwoCo"] == 1
