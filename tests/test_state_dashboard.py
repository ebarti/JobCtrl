from pathlib import Path

from typer.testing import CliRunner

from jobhunter.cli import app
from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.state import build_dashboard_data, derive_legacy_stage_states
from jobhunter.view import generate_dashboard


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


def test_dashboard_data_builds_triage_and_ready_queues(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    resume = Path(tmp_path) / "resume.txt"
    cover = Path(tmp_path) / "cover.txt"
    resume_pdf = Path(tmp_path) / "resume.pdf"
    cover_pdf = Path(tmp_path) / "cover.pdf"
    resume.write_text("tailored", encoding="utf-8")
    cover.write_text("cover", encoding="utf-8")
    resume_pdf.write_text("%PDF", encoding="utf-8")
    cover_pdf.write_text("%PDF", encoding="utf-8")

    try:
        _insert_job(conn, url="https://example.com/broken", detail_error="timeout")
        _insert_job(
            conn,
            url="https://example.com/ready",
            full_description="Build distributed systems.",
            application_url="https://example.com/apply",
            fit_score=9,
            tailored_resume_path=str(resume),
            cover_letter_path=str(cover),
        )

        data = build_dashboard_data(conn)

        assert data["schema_version"] == 2
        assert any(item["job_url"] == "https://example.com/broken" for item in data["jobs"])
        assert any(item["job_url"] == "https://example.com/ready" for item in data["jobs"])
        assert any(item["job_url"] == "https://example.com/ready" for item in data["artifacts"])
        assert any(item["job_url"] == "https://example.com/broken" for item in data["triage"])
        assert any(item["job_url"] == "https://example.com/ready" for item in data["ready"])
        assert {stage["stage"] for stage in data["funnel"]} >= {"discover", "enrich", "apply"}
    finally:
        close_connection(db_path)


def test_generate_dashboard_embeds_payload(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn, detail_error="timeout")

    try:
        monkeypatch.setattr("jobhunter.view.get_connection", lambda: get_connection(db_path))
        out = Path(tmp_path) / "dashboard.html"

        path = generate_dashboard(str(out))
        html = Path(path).read_text(encoding="utf-8")

        assert 'id="jobhunter-data"' in html
        assert "Needs attention" in html
        assert "Ready to apply" in html
        assert "<title>JobHunter</title>" in html
        assert "JobHunter Ops" not in html
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
