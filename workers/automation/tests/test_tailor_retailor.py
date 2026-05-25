"""Tests for re-tailoring selection and CLI flag wiring."""

from pathlib import Path

from typer.testing import CliRunner

from jobhunter.cli import app
from jobhunter.database import close_connection, get_connection, get_jobs_by_stage, init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials import (
    Artifact,
    ArtifactType,
    JudgeVerdict,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.materials.use_cases import TailorOutcome
from jobhunter.domain.profile.aggregate import Profile
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.pipeline import _count_pending
from jobhunter.scoring.tailor import _build_master_tailor_prompt, _tailor_one_job


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


def test_tailor_cli_passes_tailoring_model_controls(monkeypatch):
    runner = CliRunner()
    captured = {}

    def fake_run_stage_command(stage: str, **kwargs):
        captured["stage"] = stage
        captured["kwargs"] = kwargs

    monkeypatch.setattr("jobhunter.cli._run_stage_command", fake_run_stage_command)

    result = runner.invoke(
        app,
        [
            "tailor",
            "--tailor-models",
            "local:draft-a,gemini:draft-b",
            "--tailor-judge-model",
            "openai:judge-c",
            "--tailor-judge-min-score",
            "0.9",
        ],
    )

    assert result.exit_code == 0
    assert captured["stage"] == "tailor"
    assert captured["kwargs"]["tailor_models"] == ("local:draft-a", "gemini:draft-b")
    assert captured["kwargs"]["tailor_judge_model"] == "openai:judge-c"
    assert captured["kwargs"]["tailor_judge_min_score"] == 0.9


class _RecordingRepository:
    def __init__(self) -> None:
        self.saved = []

    def save(self, materials) -> None:
        self.saved.append(materials)


class _FakeTailorUseCase:
    def __init__(self, outcome: TailorOutcome) -> None:
        self._repository = _RecordingRepository()
        self._outcome = outcome

    def execute(self, **kwargs) -> TailorOutcome:
        return self._outcome


class _RecordingPdfRenderer:
    def __init__(self) -> None:
        self.calls = []

    def render_resume_to_pdf(self, *, tailored_payload, profile_dict, output_path, created_at):
        self.calls.append(
            {
                "tailored_payload": tailored_payload,
                "profile_dict": profile_dict,
                "output_path": output_path,
                "created_at": created_at,
            }
        )
        Path(output_path).write_bytes(b"%PDF-tailored")
        return Artifact.create(
            type=ArtifactType.RESUME_PDF,
            path=output_path,
            created_at=created_at,
            render_format=RenderFormat.LATEX_PDF,
            size_bytes=len(b"%PDF-tailored"),
        )

    def render_cover_letter_to_pdf(self, *, cover_letter_text, output_path, created_at):
        raise AssertionError("tailor runner should not render cover letters")


def test_tailor_one_job_renders_pdf_from_selected_candidate_payload(tmp_path):
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
            "skill_categories": [{"id": "platform", "label": "Platform", "items": ["Python"]}],
            "tailoring_rules": {
                "required_experience_entry_ids": ["platform_engineer"],
                "required_skill_category_ids": ["platform"],
                "max_experience_bullets": 4,
            },
        },
    }
    snapshot = ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, profile))
    job = {
        "url": "https://example.com/pdf-job",
        "title": "Platform Engineer",
        "site": "example",
        "full_description": "Build Python platforms.",
    }
    text_path = tmp_path / "tailored.txt"
    text_path.write_text("tailored resume", encoding="utf-8")
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["url"]),
        created_at="2026-05-25T00:00:00+00:00",
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(text_path),
            created_at="2026-05-25T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(score=0.93),
        updated_at="2026-05-25T00:00:00+00:00",
    )
    selected_payload = {
        "executive_profile": "Platform engineer.",
        "experience_updates": [{"id": "platform_engineer", "bullets": ["Built Python platforms."]}],
        "skill_category_updates": [{"id": "platform", "items": ["Python"]}],
    }
    outcome = TailorOutcome(
        materials=materials,
        status="approved",
        attempts=1,
        text_path=str(text_path),
        report={
            "selected_candidate": "candidate-good",
            "attempt_history": [
                {
                    "candidates": [
                        {
                            "candidate_id": "candidate-bad",
                            "status": "judge_rejected",
                            "parsed_json": {"executive_profile": "bad"},
                        },
                        {
                            "candidate_id": "candidate-good",
                            "status": "approved",
                            "parsed_json": selected_payload,
                        },
                    ]
                }
            ],
        },
    )
    use_case = _FakeTailorUseCase(outcome)
    renderer = _RecordingPdfRenderer()

    result = _tailor_one_job(
        job,
        "",
        snapshot,
        "normal",
        use_case=use_case,
        pdf_renderer=renderer,
    )

    assert result["pdf_path"] == str(text_path.with_suffix(".pdf"))
    assert renderer.calls[0]["tailored_payload"] == selected_payload
    assert use_case._repository.saved[-1].resume_pdf is not None


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
