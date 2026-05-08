"""Tests for re-tailoring selection and CLI flag wiring."""

from pathlib import Path

from typer.testing import CliRunner

from jobhunter.cli import app
from jobhunter.database import close_connection, get_connection, get_jobs_by_stage, init_db
from jobhunter.domain.profile.aggregate import Profile
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.pipeline import _count_pending
from jobhunter.scoring.tailor import _build_master_tailor_prompt


def _insert_job(conn, *, url: str, fit_score: int = 9, tailored_resume_path=None, tailor_attempts: int = 0) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, full_description, fit_score, tailored_resume_path, tailor_attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            "Backend Engineer",
            "Acme",
            "Build APIs and distributed systems.",
            fit_score,
            tailored_resume_path,
            tailor_attempts,
        ),
    )
    conn.commit()


def test_get_jobs_by_stage_retailor_includes_already_tailored_jobs(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        _insert_job(conn, url="https://example.com/new")
        _insert_job(
            conn,
            url="https://example.com/existing",
            tailored_resume_path="/tmp/existing.txt",
            tailor_attempts=7,
        )
        _insert_job(
            conn,
            url="https://example.com/exhausted",
            tailored_resume_path=None,
            tailor_attempts=5,
        )

        pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7, limit=0)
        retailor_pending = get_jobs_by_stage(
            conn=conn,
            stage="pending_tailor",
            min_score=7,
            limit=0,
            retailor=True,
        )

        assert {job["url"] for job in pending} == {"https://example.com/new"}
        assert {job["url"] for job in retailor_pending} == {
            "https://example.com/new",
            "https://example.com/existing",
        }
    finally:
        close_connection(db_path)


def test_count_pending_retailor_includes_already_tailored_jobs(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        _insert_job(conn, url="https://example.com/new")
        _insert_job(
            conn,
            url="https://example.com/existing",
            tailored_resume_path="/tmp/existing.txt",
            tailor_attempts=9,
        )

        monkeypatch.setattr("jobhunter.pipeline.runner.get_connection", lambda: get_connection(db_path))

        assert _count_pending("tailor", min_score=7) == 1
        assert _count_pending("tailor", min_score=7, retailor=True) == 2
    finally:
        close_connection(db_path)


def test_tailor_cli_passes_retailor_flag(monkeypatch):
    runner = CliRunner()
    captured = {}

    def fake_run_stage_command(stage: str, **kwargs):
        captured["stage"] = stage
        captured["kwargs"] = kwargs

    monkeypatch.setattr("jobhunter.cli._run_stage_command", fake_run_stage_command)

    result = runner.invoke(app, ["tailor", "--retailor"])

    assert result.exit_code == 0
    assert captured["stage"] == "tailor"
    assert captured["kwargs"]["retailor"] is True


def test_tailor_prompt_includes_writing_style_and_custom_guidance():
    profile = {
        "personal": {"full_name": "Jordan Candidate", "email": "jordan@example.com"},
        "resume": {
            "executive_profile": {"baseline_text": "Platform engineer."},
            "experience_entries": [
                {
                    "id": "platform_engineer",
                    "date_range": "2024 -- Present",
                    "title": "Platform Engineer",
                    "company": "Example",
                    "location": "Remote",
                    "bullets": ["Reduced deployment time by 35%."],
                }
            ],
            "education_entries": [],
            "skill_categories": [{"id": "platform", "label": "Platform", "items": ["Python", "Kubernetes"]}],
            "tailoring_rules": {
                "required_experience_entry_ids": ["platform_engineer"],
                "required_skill_category_ids": ["platform"],
                "required_bullets_by_experience_id": {},
                "max_experience_bullets": 4,
                "writing_style": {
                    "tone": "technical",
                    "bullet_style": "impact",
                    "verbosity": "concise",
                    "keyword_density": "moderate",
                    "avoid_first_person": True,
                },
                "custom_tailoring_prompt": "Use concise platform leadership language.",
            },
        },
        "resume_constraints": {"real_metrics": ["35%"]},
    }

    snapshot = ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, profile))
    prompt = _build_master_tailor_prompt(snapshot)

    assert "WRITING STYLE:" in prompt
    assert "- Tone: technical" in prompt
    assert "- Bullet style: impact" in prompt
    assert "USER ADDITIONAL TAILORING PROMPT:" in prompt
    assert "Use concise platform leadership language." in prompt
