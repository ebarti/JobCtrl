"""JobListProjection tests — full pipeline from discovery to apply."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import close_connection, ensure_projection_tables_in_db, init_db
from jobhunter.infrastructure.events.watermark import SqliteEventWatermarkRepository
from jobhunter.infrastructure.projections.projection_builder import (
    PROJECTION_NAME,
    ProjectionBuilder,
)
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


def _replace_score_evidence_projection_schema_with_legacy_shape(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE job_list_projections")
    conn.execute(
        """
        CREATE TABLE job_list_projections (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            title                  TEXT NOT NULL DEFAULT '',
            employer               TEXT NOT NULL DEFAULT '',
            source                 TEXT NOT NULL DEFAULT '',
            strategy               TEXT NOT NULL DEFAULT '',
            location               TEXT NOT NULL DEFAULT '',
            salary                 TEXT NOT NULL DEFAULT '',
            application_url        TEXT,
            discovered_at          TEXT,
            description            TEXT NOT NULL DEFAULT '',
            full_description       TEXT NOT NULL DEFAULT '',
            fit_score              INTEGER,
            score_reasoning        TEXT NOT NULL DEFAULT '',
            current_stage          TEXT NOT NULL DEFAULT 'discover',
            current_substage       TEXT NOT NULL DEFAULT 'discover',
            current_state          TEXT NOT NULL DEFAULT 'pending',
            current_error_code     TEXT,
            current_error_message  TEXT,
            current_next_action    TEXT,
            has_resume             INTEGER NOT NULL DEFAULT 0,
            has_cover_letter       INTEGER NOT NULL DEFAULT 0,
            has_pdf                INTEGER NOT NULL DEFAULT 0,
            apply_status           TEXT,
            applied_at             TEXT,
            artifact_count         INTEGER NOT NULL DEFAULT 0,
            deleted_at             TEXT,
            last_updated_at        TEXT,
            PRIMARY KEY (tenant_id, job_id)
        )
        """
    )
    conn.execute("DROP TABLE job_detail_projections")
    conn.execute(
        """
        CREATE TABLE job_detail_projections (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            description_preview    TEXT NOT NULL DEFAULT '',
            score_reasoning        TEXT NOT NULL DEFAULT '',
            stages_json            TEXT NOT NULL DEFAULT '[]',
            last_updated_at        TEXT,
            PRIMARY KEY (tenant_id, job_id)
        )
        """
    )


def test_discovered_job_appears_in_projection(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/1"
    _seed_job(conn, url)
    record_job_event(conn, url, "discover", "JobDiscovered", message="discovered")
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    refreshed = builder.refresh()

    assert refreshed >= 1
    row = conn.execute(
        "SELECT * FROM job_list_projections WHERE job_id = ?", (url,)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "title") == "Engineer"
    assert _row_value(row, "source") == "ExampleCo"
    assert _row_value(row, "current_stage") == "discover"
    assert _row_value(row, "current_substage") == "discover"
    assert _row_value(row, "current_state") == "pending"


def test_pipeline_progress_keeps_internal_preparation_inside_discover_list_stage(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/2"
    _seed_job(conn, url, title="Platform Engineer")
    builder = ProjectionBuilder(conn_factory=lambda: conn)

    set_stage_state(conn, url, "discover", "succeeded", finished_at=utc_now())
    record_job_event(conn, url, "discover", "StageCompleted")
    conn.commit()
    builder.refresh()

    set_stage_state(conn, url, "enrich", "succeeded", finished_at=utc_now())
    record_job_event(conn, url, "enrich", "StageCompleted")
    conn.commit()
    builder.refresh()

    row = conn.execute(
        "SELECT current_stage, current_substage, current_state FROM job_list_projections WHERE job_id = ?",
        (url,),
    ).fetchone()
    assert _row_value(row, "current_stage") == "discover"
    assert _row_value(row, "current_substage") == "score"
    assert _row_value(row, "current_state") == "pending"

    detail = conn.execute(
        "SELECT stages_json FROM job_detail_projections WHERE job_id = ?",
        (url,),
    ).fetchone()
    stages = json.loads(_row_value(detail, "stages_json", "[]"))
    score_stage = next(stage for stage in stages if stage["stage"] == "score")
    assert score_stage["state"] == "pending"


def test_stage_projection_preserves_non_retryable_failures(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/non-retryable"
    _seed_job(conn, url, title="Closed Posting")

    set_stage_state(conn, url, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(
        conn,
        url,
        "enrich",
        "failed",
        attempt_count=1,
        error_code="POSTING_INACTIVE",
        error_message="posting removed",
        retryable=False,
        validate_transition=False,
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    detail = conn.execute(
        "SELECT stages_json FROM job_detail_projections WHERE job_id = ?",
        (url,),
    ).fetchone()
    stages = json.loads(_row_value(detail, "stages_json", "[]"))
    enrich_stage = next(stage for stage in stages if stage["stage"] == "enrich")
    assert enrich_stage["state"] == "failed"
    assert enrich_stage["retryable"] is False


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
            json.dumps(
                {
                    "technical_fit": 9,
                    "experience_fit": 7,
                    "role_fit": 8,
                    "reasoning": "Strong fit",
                }
            ),
            json.dumps(["python", "fastapi"]),
            utc_now(),
        ),
    )
    record_job_event(conn, url, "score", "JobScored")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        """
        SELECT fit_score, score_breakdown_json, score_keywords_json,
               score_reasoning, score_version, scored_at
        FROM job_list_projections WHERE job_id = ?
        """,
        (url,),
    ).fetchone()
    assert _row_value(row, "fit_score") == 8
    assert _row_value(row, "score_reasoning") == "Strong fit"
    assert json.loads(_row_value(row, "score_breakdown_json")) == {
        "technicalFit": 9,
        "experienceFit": 7,
        "roleFit": 8,
        "reasoning": "Strong fit",
        "fitBand": "plausible",
        "confidence": "medium",
        "eligibility": {"status": "unknown", "hardBlockers": [], "warnings": []},
        "matchedSignals": [],
        "missingSignals": [],
        "transferableSignals": [],
    }
    assert json.loads(_row_value(row, "score_keywords_json")) == ["python", "fastapi"]
    assert _row_value(row, "score_version") == 1
    assert _row_value(row, "scored_at")

    detail = conn.execute(
        """
        SELECT score_breakdown_json, score_keywords_json, score_version, scored_at
        FROM job_detail_projections WHERE job_id = ?
        """,
        (url,),
    ).fetchone()
    assert json.loads(_row_value(detail, "score_breakdown_json"))["technicalFit"] == 9
    assert json.loads(_row_value(detail, "score_keywords_json")) == ["python", "fastapi"]
    assert _row_value(detail, "score_version") == 1
    assert _row_value(detail, "scored_at")


def test_score_evidence_schema_migration_backfills_existing_projection(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/jobs/scored-before-migration"
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
            9,
            json.dumps(
                {
                    "technical_fit": 8,
                    "experience_fit": 9,
                    "role_fit": 10,
                    "reasoning": "Evidence should be projected",
                    "fit_band": "excellent",
                    "confidence": "high",
                    "eligibility": {
                        "status": "blocked",
                        "hard_blockers": ["candidate requires sponsorship"],
                        "warnings": ["location needs review"],
                    },
                    "matched_signals": ["python"],
                    "missing_signals": ["scale"],
                    "transferable_signals": ["platform ownership"],
                }
            ),
            json.dumps(["python", "sqlite"]),
            "2026-05-05T10:00:00+00:00",
        ),
    )
    record_job_event(conn, url, "score", "JobScored")
    latest_event_id = conn.execute("SELECT MAX(event_id) FROM job_events").fetchone()[0]
    _replace_score_evidence_projection_schema_with_legacy_shape(conn)
    conn.execute(
        """
        INSERT INTO job_list_projections (
            tenant_id, job_id, title, employer, fit_score, score_reasoning
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        ("local", url, "Engineer", "ExampleCo", 9, "Legacy reasoning"),
    )
    conn.execute(
        """
        INSERT INTO job_detail_projections (
            tenant_id, job_id, description_preview, score_reasoning
        ) VALUES (?, ?, ?, ?)
        """,
        ("local", url, "Short job description", "Legacy reasoning"),
    )
    conn.execute(
        "INSERT INTO dashboard_projections (tenant_id, generated_at) VALUES (?, ?)",
        ("local", "2026-05-05T09:00:00+00:00"),
    )
    conn.commit()
    SqliteEventWatermarkRepository(conn).set(PROJECTION_NAME, int(latest_event_id))

    ensure_projection_tables_in_db(conn)
    processed = ProjectionBuilder(conn_factory=lambda: conn).refresh()

    assert processed == 1
    row = conn.execute(
        """
        SELECT score_breakdown_json, score_keywords_json, score_version, scored_at
        FROM job_list_projections WHERE job_id = ?
        """,
        (url,),
    ).fetchone()
    assert json.loads(_row_value(row, "score_breakdown_json")) == {
        "technicalFit": 8,
        "experienceFit": 9,
        "roleFit": 10,
        "reasoning": "Evidence should be projected",
        "fitBand": "excellent",
        "confidence": "high",
        "eligibility": {
            "status": "blocked",
            "hardBlockers": ["candidate requires sponsorship"],
            "warnings": ["location needs review"],
        },
        "matchedSignals": ["python"],
        "missingSignals": ["scale"],
        "transferableSignals": ["platform ownership"],
    }
    assert json.loads(_row_value(row, "score_keywords_json")) == ["python", "sqlite"]
    assert _row_value(row, "score_version") == 1
    assert _row_value(row, "scored_at") == "2026-05-05T10:00:00+00:00"


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

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

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

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT deleted_at FROM job_list_projections WHERE job_id = ?", (url,)
    ).fetchone()
    assert _row_value(row, "deleted_at") == deleted_at


def test_stale_restore_before_delete_still_carries_deleted_at(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/stale-restore"
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
    deleted_at = "2026-05-25T23:10:33.870522+00:00"
    conn.execute(
        "INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at, reason, restored_at) "
        "VALUES (?, ?, ?, ?)",
        (url, deleted_at, "discovery hygiene rejected source", "2026-05-25T21:35:55.879345+00:00"),
    )
    record_job_event(conn, url, "discover", "JobDeleted")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

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

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT title FROM job_list_projections WHERE job_id = ?", (url,)
    ).fetchone()
    assert _row_value(row, "title") == "Legacy Engineer"


def test_refresh_is_idempotent(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/6"
    _seed_job(conn, url)
    record_job_event(conn, url, "discover", "JobDiscovered")
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()
    builder.refresh()
    builder.refresh()

    rows = conn.execute(
        "SELECT COUNT(*) FROM job_list_projections WHERE job_id = ?", (url,)
    ).fetchone()
    assert rows[0] == 1
