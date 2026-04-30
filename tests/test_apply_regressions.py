from pathlib import Path

from jobhunter.apply.launcher import acquire_job, mark_result
from jobhunter.database import close_connection, get_connection, init_db


def _insert_ready_job(conn, *, url: str = "https://example.com/job") -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, full_description, application_url,
            fit_score, tailored_resume_path, cover_letter_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            "Platform Engineer",
            "ExampleCo",
            "Build distributed systems.",
            "https://example.com/apply",
            9,
            "/tmp/resume.txt",
            "/tmp/cover.txt",
        ),
    )
    conn.commit()


def test_targeted_apply_acquires_job_with_null_apply_status(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path))

        job = acquire_job(target_url="https://example.com/job", worker_id=1)

        assert job is not None
        assert job["url"] == "https://example.com/job"
        row = conn.execute("SELECT apply_status FROM jobs WHERE url = ?", (job["url"],)).fetchone()
        assert row["apply_status"] == "in_progress"
    finally:
        close_connection(db_path)


def test_dry_run_result_does_not_mark_job_applied(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path))

        mark_result("https://example.com/job", "dry_run", duration_ms=123, task_id="run-test")

        row = conn.execute(
            "SELECT apply_status, applied_at, apply_task_id FROM jobs WHERE url = ?",
            ("https://example.com/job",),
        ).fetchone()
        state = conn.execute(
            "SELECT state, error_code FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            ("https://example.com/job",),
        ).fetchone()

        assert row["apply_status"] == "dry_run"
        assert row["applied_at"] is None
        assert row["apply_task_id"] == "run-test"
        assert state["state"] == "skipped"
        assert state["error_code"] == "DRY_RUN"
    finally:
        close_connection(db_path)
