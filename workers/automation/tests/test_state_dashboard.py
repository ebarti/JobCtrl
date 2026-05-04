from pathlib import Path

from typer.testing import CliRunner

from jobhunter.cli import app
from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.state import (
    derive_legacy_stage_states,
    ensure_job_stage_rows,
    get_job_stage_states,
    initialize_missing_state_rows,
    set_stage_state,
)


def _insert_job(conn, **overrides):
    data = {
        "url": "https://example.com/job",
        "title": "Platform Engineer",
        "site": "ExampleCo",
        "strategy": "test",
        "discovered_at": "2026-04-29T10:00:00+00:00",
        "full_description": None,
        "application_url": None,
        "detail_error": None,
        "fit_score": None,
        "tailored_resume_path": None,
        "tailor_attempts": 0,
        "cover_letter_path": None,
        "cover_attempts": 0,
        "apply_status": None,
        "applied_at": None,
    }
    data.update(overrides)
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, strategy, discovered_at, full_description,
            application_url, detail_error, fit_score, tailored_resume_path,
            tailor_attempts, cover_letter_path, cover_attempts, apply_status,
            applied_at
        ) VALUES (
            :url, :title, :site, :strategy, :discovered_at, :full_description,
            :application_url, :detail_error, :fit_score, :tailored_resume_path,
            :tailor_attempts, :cover_letter_path, :cover_attempts, :apply_status,
            :applied_at
        )
        """,
        data,
    )
    conn.commit()
    return data


def test_legacy_state_marks_enrichment_failure_retryable():
    states = derive_legacy_stage_states(
        {
            "url": "https://example.com/job",
            "discovered_at": "2026-04-29T10:00:00+00:00",
            "detail_error": "timeout",
            "full_description": None,
            "fit_score": None,
            "tailor_attempts": 0,
            "cover_attempts": 0,
            "apply_status": None,
        }
    )

    enrich = next(state for state in states if state["stage"] == "enrich")
    score = next(state for state in states if state["stage"] == "score")

    assert enrich["state"] == "failed"
    assert enrich["retryable"] is True
    assert enrich["error_message"] == "timeout"
    assert score["state"] == "blocked"
    assert score["blocked_by"] == ["enrich"]


def test_explicit_stage_state_overrides_legacy_success(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    resume = Path(tmp_path) / "resume.txt"
    cover = Path(tmp_path) / "cover.txt"
    resume.with_suffix(".pdf").write_text("%PDF", encoding="utf-8")
    cover.with_suffix(".pdf").write_text("%PDF", encoding="utf-8")
    resume.write_text("tailored", encoding="utf-8")
    cover.write_text("cover", encoding="utf-8")

    try:
        job = _insert_job(
            conn,
            full_description="Build distributed systems.",
            application_url="https://example.com/apply",
            fit_score=9,
            tailored_resume_path=str(resume),
            cover_letter_path=str(cover),
        )
        set_stage_state(
            conn,
            job["url"],
            "score",
            "failed",
            error_code="LLM_ERROR",
            error_message="score failed",
            next_action=f"jobhunter retry score {job['url']}",
        )

        states = get_job_stage_states(conn, job)
        score = next(item for item in states if item["stage"] == "score")

        assert score["state"] == "failed"
        assert score["error_code"] == "LLM_ERROR"
        assert score["error_message"] == "score failed"
    finally:
        close_connection(db_path)


def test_placeholder_stage_rows_are_upgraded_from_legacy_columns(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    resume = Path(tmp_path) / "resume.txt"
    cover = Path(tmp_path) / "cover.txt"
    resume.write_text("tailored", encoding="utf-8")
    cover.write_text("cover", encoding="utf-8")
    resume.with_suffix(".pdf").write_text("%PDF", encoding="utf-8")
    cover.with_suffix(".pdf").write_text("%PDF", encoding="utf-8")

    try:
        job = _insert_job(
            conn,
            full_description="Build distributed systems.",
            application_url="https://example.com/apply",
            fit_score=9,
            tailored_resume_path=str(resume),
            cover_letter_path=str(cover),
        )
        ensure_job_stage_rows(conn, job["url"], discovered_at=job["discovered_at"])
        conn.commit()

        before = get_job_stage_states(conn, job)
        assert next(item for item in before if item["stage"] == "score")["state"] == "succeeded"
        assert next(item for item in before if item["stage"] == "apply")["next_action"] == f"jobhunter apply --url {job['url']}"

        updated = initialize_missing_state_rows(conn)
        after = get_job_stage_states(conn, job)

        assert updated == 1
        assert next(item for item in after if item["stage"] == "score")["state"] == "succeeded"
        assert next(item for item in after if item["stage"] == "tailor")["state"] == "succeeded"
        assert initialize_missing_state_rows(conn) == 0
    finally:
        close_connection(db_path)


def test_old_discover_placeholder_with_timestamp_is_upgraded(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(conn, job["url"], discovered_at=job["discovered_at"])
        conn.execute(
            """
            UPDATE job_stage_states
            SET attempt_count = 0, started_at = ?, finished_at = ?
            WHERE job_url = ? AND stage = 'discover'
            """,
            (job["discovered_at"], job["discovered_at"], job["url"]),
        )
        conn.commit()

        assert initialize_missing_state_rows(conn) == 1

        discover = conn.execute(
            "SELECT attempt_count, started_at, finished_at FROM job_stage_states WHERE job_url = ? AND stage = 'discover'",
            (job["url"],),
        ).fetchone()
        assert discover["attempt_count"] == 1
        assert discover["started_at"] == job["discovered_at"]
        assert discover["finished_at"] == job["discovered_at"]
    finally:
        close_connection(db_path)


def test_retry_command_resets_stage_state(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn, detail_error="timeout")

    try:
        monkeypatch.setattr("jobhunter.cli.get_connection", lambda: get_connection(db_path), raising=False)
        monkeypatch.setattr("jobhunter.database.DB_PATH", db_path)
        monkeypatch.setattr("jobhunter.config.DB_PATH", db_path)

        result = CliRunner().invoke(app, ["retry", "enrich", "https://example.com/job"])

        row = conn.execute(
            "SELECT detail_error, detail_scraped_at FROM jobs WHERE url = ?",
            ("https://example.com/job",),
        ).fetchone()
        state = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'enrich'",
            ("https://example.com/job",),
        ).fetchone()
        assert result.exit_code == 0
        assert row["detail_error"] is None
        assert row["detail_scraped_at"] is None
        assert state["state"] == "pending"
    finally:
        close_connection(db_path)
