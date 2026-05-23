from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from jobhunter.database import close_connection, init_db
from jobhunter.state import (
    ensure_job_stage_rows,
    recover_orphaned_running_stages,
    set_stage_state,
)


def _insert_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, full_description, discovered_at)
        VALUES (?, 'Engineer', 'ExampleCo', 'Build reliable systems.', ?)
        """,
        (url, "2026-05-21T20:00:00+00:00"),
    )
    ensure_job_stage_rows(conn, url)
    conn.commit()


def _mark_running_at(conn: sqlite3.Connection, url: str, stage: str, timestamp: str) -> None:
    set_stage_state(
        conn,
        url,
        stage,
        "running",
        started_at=timestamp,
        validate_transition=False,
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET updated_at = ?
        WHERE job_url = ? AND stage = ?
        """,
        (timestamp, url, stage),
    )
    conn.commit()


def test_recover_orphaned_running_stages_marks_only_stale_non_apply_runs_failed(tmp_path: Path) -> None:
    db_path = tmp_path / "jobhunter.db"
    conn = init_db(db_path)
    old_score_url = "https://example.com/jobs/orphaned-score"
    fresh_score_url = "https://example.com/jobs/fresh-score"
    apply_url = "https://example.com/jobs/apply-run"
    missing_job_url = "https://example.com/jobs/missing-parent"

    try:
        _insert_job(conn, old_score_url)
        _insert_job(conn, fresh_score_url)
        _insert_job(conn, apply_url)
        _mark_running_at(conn, old_score_url, "score", "2026-05-21T20:00:00+00:00")
        _mark_running_at(conn, fresh_score_url, "score", "2026-05-21T20:09:00+00:00")
        _mark_running_at(conn, apply_url, "apply", "2026-05-21T20:00:00+00:00")
        conn.execute(
            """
            INSERT INTO job_stage_states (job_url, stage, state, updated_at)
            VALUES (?, 'tailor', 'running', ?)
            """,
            (missing_job_url, "2026-05-21T20:00:00+00:00"),
        )
        conn.commit()

        recovered = recover_orphaned_running_stages(
            conn,
            now=datetime(2026, 5, 21, 20, 10, 0, tzinfo=timezone.utc),
            stale_after_seconds=150,
        )

        assert recovered == 1
        recovered_row = conn.execute(
            """
            SELECT state, attempt_count, error_code, error_message, retryable, next_action
            FROM job_stage_states
            WHERE job_url = ? AND stage = 'score'
            """,
            (old_score_url,),
        ).fetchone()
        assert recovered_row["state"] == "failed"
        assert recovered_row["attempt_count"] == 1
        assert recovered_row["error_code"] == "ORPHANED_STAGE_RUN"
        assert recovered_row["retryable"] == 1
        assert old_score_url in recovered_row["next_action"]
        assert "left running by a prior worker" in recovered_row["error_message"]

        fresh_row = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'score'",
            (fresh_score_url,),
        ).fetchone()
        assert fresh_row["state"] == "running"

        apply_row = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (apply_url,),
        ).fetchone()
        assert apply_row["state"] == "running"

        missing_job_event_count = conn.execute(
            "SELECT COUNT(*) AS count FROM job_events WHERE job_url = ?",
            (missing_job_url,),
        ).fetchone()
        assert missing_job_event_count["count"] == 0

        event = conn.execute(
            """
            SELECT event_type, level, message, payload_json
            FROM job_events
            WHERE job_url = ? AND stage = 'score'
            ORDER BY event_id DESC LIMIT 1
            """,
            (old_score_url,),
        ).fetchone()
        assert event["event_type"] == "StageFailed"
        assert event["level"] == "error"
        assert "marked failed for retry" in event["message"]
        assert "ORPHANED_STAGE_RUN" in event["payload_json"]

        metric = conn.execute(
            """
            SELECT stage, attempt_kind, outcome, failure_category,
                   is_operational_failure, is_scrape_failure, is_retryable,
                   job_url, error_class
            FROM operational_attempt_metrics
            WHERE job_url = ? AND stage = 'score'
            ORDER BY metric_id DESC LIMIT 1
            """,
            (old_score_url,),
        ).fetchone()
        assert metric["attempt_kind"] == "orphan_recovery"
        assert metric["outcome"] == "failed"
        assert metric["failure_category"] == "orphaned_stage_run"
        assert metric["is_operational_failure"] == 1
        assert metric["is_scrape_failure"] == 0
        assert metric["is_retryable"] == 1
        assert metric["error_class"] == "ORPHANED_STAGE_RUN"
    finally:
        close_connection(db_path)
