"""Tests for re-tailoring selection and CLI flag wiring."""

import json
from pathlib import Path
from types import SimpleNamespace
from uuid import NAMESPACE_URL, uuid5

from typer.testing import CliRunner

from jobctrl.cli import app
from jobctrl.database import close_connection, get_connection, get_jobs_by_stage, init_db
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials import (
    Artifact,
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobctrl.domain.materials.policy import LearnedTailoringRules, TailoringPolicy
from jobctrl.domain.materials.use_cases import TailorOutcome, build_master_tailor_prompt
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials import SqliteTailoringPolicyRepository
from jobctrl.pipeline import _count_pending
from jobctrl.pipeline.current_policy_selectors import tailoring_current_policy_job_ids
from jobctrl.state import ensure_job_stage_rows, set_stage_state
from jobctrl.scoring.tailor import (
    _build_pdf_renderer,
    _build_llm_policy,
    _build_master_tailor_prompt,
    _tailor_one_job,
    tailor_job_by_url,
)
from jobctrl.infrastructure.materials import HtmlResumePdfAdapter

_JOB_ID = canonical_job_id("80000000-0000-4000-8000-000000000001")


def _job_id_for_url(url: str):
    return canonical_job_id(str(uuid5(NAMESPACE_URL, url)))


def _insert_job(
    conn,
    *,
    url: str,
    fit_score: int = 9,
    material_path: str | None = None,
    material_metadata: dict | None = None,
):
    job_id = _job_id_for_url(url)
    timestamp = "2026-06-01T00:00:00+00:00"
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            str(job_id),
            url,
            "Backend Engineer",
            "Acme",
            timestamp,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value,
            is_current, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?)
        """,
        (str(LOCAL_TENANT), str(job_id), url, timestamp, timestamp),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description, updated_at
        ) VALUES (?, ?, 'enriched', ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            str(job_id),
            "Build APIs and distributed systems.",
            timestamp,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at
        ) VALUES (?, ?, 1, ?, '{}', '[]', ?)
        """,
        (str(LOCAL_TENANT), str(job_id), fit_score, timestamp),
    )
    if material_path is not None:
        conn.execute(
            """
            INSERT INTO job_materials (
                tenant_id, job_id, generation, status, created_at, updated_at
            ) VALUES (?, ?, 1, 'approved', ?, ?)
            """,
            (str(LOCAL_TENANT), str(job_id), timestamp, timestamp),
        )
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id,
                status, path, render_format, metadata_json, created_at
            ) VALUES (?, ?, 1, 'tailored_resume', ?, 'approved', ?, 'text', ?, ?)
            """,
            (
                str(LOCAL_TENANT),
                str(job_id),
                f"{job_id}:tailored_resume",
                material_path,
                json.dumps(material_metadata or {}, sort_keys=True),
                timestamp,
            ),
        )
    conn.commit()
    return job_id


def _tailoring_policy(
    *,
    profile_snapshot_fingerprint: str = "sha256:profile-v1",
) -> TailoringPolicy:
    return TailoringPolicy.from_runtime(
        tenant_id=LOCAL_TENANT,
        version=1,
        prompt_version="tailor.v2.quality-gated",
        schema_version="tailored-resume.v1",
        judge_schema_version="tailor-judge.v1",
        prompt_text="stable global control prompt",
        profile_policy={"claim_mode": "verified_only"},
        custom_prompt="",
        generator_settings={"candidate_models": ["local:draft"]},
        judge_settings={"judge_model": "local:judge", "min_score": 0.82},
        runtime_settings={
            "validation_mode": "normal",
            "profile_snapshot_fingerprint": profile_snapshot_fingerprint,
        },
        created_at="2026-06-01T00:00:00+00:00",
    )


def _insert_blocked_score(conn, *, url: str, blocker: str = "No sponsorship.") -> None:
    job_id = _job_id_for_url(url)
    conn.execute(
        """
        UPDATE job_scores
        SET fit_score = ?, breakdown_json = ?
        WHERE tenant_id = ? AND job_id = ?
        """,
        (
            10,
            json.dumps(
                {
                    "reasoning": "Strong match but blocked.",
                    "fit_band": "excellent",
                    "eligibility": {
                        "status": "blocked",
                        "hard_blockers": [blocker],
                        "warnings": [],
                    },
                },
                sort_keys=True,
            ),
            str(LOCAL_TENANT),
            str(job_id),
        ),
    )
    conn.commit()


def test_get_jobs_by_stage_retailor_includes_already_tailored_jobs(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        new_job_id = _insert_job(conn, url="https://example.com/new")
        existing_job_id = _insert_job(
            conn,
            url="https://example.com/existing",
            material_path="/tmp/existing.txt",
        )
        exhausted_job_id = _insert_job(
            conn,
            url="https://example.com/exhausted",
        )
        ensure_job_stage_rows(conn, exhausted_job_id)
        set_stage_state(
            conn,
            exhausted_job_id,
            "tailor",
            "exhausted",
            attempt_count=5,
            validate_transition=False,
        )
        conn.commit()

        pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7, limit=0)
        retailor_pending = get_jobs_by_stage(
            conn=conn,
            stage="pending_tailor",
            min_score=7,
            limit=0,
            retailor=True,
        )

        assert {job["job_id"] for job in pending} == {str(new_job_id)}
        assert {job["job_id"] for job in retailor_pending} == {
            str(new_job_id),
            str(existing_job_id),
        }
    finally:
        close_connection(db_path)


def test_parallel_job_prompts_share_global_policy_until_profile_revision(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        policy_repository = SqliteTailoringPolicyRepository(conn)
        current = policy_repository.resolve_current(_tailoring_policy())
        first_job_id = _insert_job(
            conn,
            url="https://example.com/policy-job-a",
            material_path="/tmp/policy-job-a.txt",
            material_metadata={
                "tailoring_policy_version": current.version,
                "job_prompt_fingerprint": "sha256:job-a-prompt",
            },
        )
        second_job_id = _insert_job(
            conn,
            url="https://example.com/policy-job-b",
            material_path="/tmp/policy-job-b.txt",
            material_metadata={
                "tailoring_policy_version": current.version,
                "job_prompt_fingerprint": "sha256:job-b-prompt",
            },
        )

        assert tailoring_current_policy_job_ids(
            conn,
            tenant_id=str(LOCAL_TENANT),
        ) == ()

        revised = policy_repository.resolve_current(
            _tailoring_policy(profile_snapshot_fingerprint="sha256:profile-v2"),
            expected_current_version=current.version,
        )
        assert revised.version == current.version + 1
        assert set(
            tailoring_current_policy_job_ids(
                conn,
                tenant_id=str(LOCAL_TENANT),
            )
        ) == {first_job_id, second_job_id}
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
            material_path="/tmp/existing.txt",
        )

        monkeypatch.setattr("jobctrl.pipeline.runner.get_connection", lambda: get_connection(db_path))

        assert _count_pending("tailor", min_score=7) == 1
        assert _count_pending("tailor", min_score=7, retailor=True) == 2
    finally:
        close_connection(db_path)


def test_tailor_job_by_url_does_not_enumerate_unrelated_pending_jobs(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    target_url = "https://example.com/target"
    unrelated_url = "https://example.com/unrelated"
    calls: list[str] = []

    try:
        _insert_job(conn, url=target_url, fit_score=8)
        unrelated_job_id = _insert_job(conn, url=unrelated_url, fit_score=10)

        def forbidden_batch_selector(*_args, **_kwargs):
            raise AssertionError("single-job tailoring must not call get_jobs_by_stage")

        def fake_tailor_one_job(job, *_args, **_kwargs):
            calls.append(job["url"])
            return {
                "url": job["url"],
                "title": job["title"],
                "site": job.get("site"),
                "status": "approved",
                "attempts": 1,
                "path": "/tmp/target.txt",
                "pdf_path": None,
                "materials": SimpleNamespace(generation=1),
            }

        monkeypatch.setattr("jobctrl.scoring.tailor.get_connection", lambda: conn)
        monkeypatch.setattr("jobctrl.scoring.tailor.get_jobs_by_stage", forbidden_batch_selector)
        monkeypatch.setattr("jobctrl.scoring.tailor._build_pdf_renderer", lambda: object())
        monkeypatch.setattr("jobctrl.scoring.tailor._tailor_one_job", fake_tailor_one_job)

        result = tailor_job_by_url(
            target_url,
            min_score=7,
            snapshot=SimpleNamespace(),
            llm_model=None,
        )

        assert result["status"] == "approved"
        assert calls == [target_url]
        unrelated_stage = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (str(LOCAL_TENANT), str(unrelated_job_id)),
        ).fetchone()
        assert unrelated_stage is None
    finally:
        close_connection(db_path)


def test_build_pdf_renderer_uses_html_resume_renderer() -> None:
    renderer = _build_pdf_renderer()

    assert isinstance(renderer, HtmlResumePdfAdapter)


def test_tailor_job_by_url_resets_stale_cover_success_after_new_resume(
    tmp_path,
    monkeypatch,
):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    target_url = "https://example.com/stale-cover"

    try:
        target_job_id = _insert_job(conn, url=target_url, fit_score=8)
        ensure_job_stage_rows(
            conn,
            target_job_id,
            discovered_at="2026-06-01T00:00:00+00:00",
        )
        set_stage_state(
            conn,
            target_job_id,
            "score",
            "succeeded",
            attempt_count=1,
            validate_transition=False,
        )
        set_stage_state(
            conn,
            target_job_id,
            "tailor",
            "succeeded",
            attempt_count=1,
            finished_at="2026-06-01T00:01:00+00:00",
            validate_transition=False,
        )
        set_stage_state(
            conn,
            target_job_id,
            "cover",
            "succeeded",
            attempt_count=2,
            started_at="2026-06-01T00:02:00+00:00",
            finished_at="2026-06-01T00:03:00+00:00",
            error_code="OLD_ERROR",
            error_message="old failure",
            validate_transition=False,
        )
        conn.commit()

        def fake_tailor_one_job(job, *_args, **_kwargs):
            return {
                "url": job["url"],
                "title": job["title"],
                "site": job.get("site"),
                "status": "approved",
                "attempts": 1,
                "path": "/tmp/stale-cover.txt",
                "pdf_path": "/tmp/stale-cover.pdf",
                "materials": SimpleNamespace(generation=2),
            }

        monkeypatch.setattr("jobctrl.scoring.tailor.get_connection", lambda: conn)
        monkeypatch.setattr("jobctrl.scoring.tailor._build_pdf_renderer", lambda: object())
        monkeypatch.setattr("jobctrl.scoring.tailor._tailor_one_job", fake_tailor_one_job)

        result = tailor_job_by_url(
            target_url,
            min_score=7,
            retailor=True,
            snapshot=SimpleNamespace(),
            llm_model=None,
        )

        assert result["status"] == "approved"
        cover = conn.execute(
            """
            SELECT state, attempt_count, started_at, finished_at, duration_ms,
                   error_code, error_message, next_action
            FROM job_stage_states
            WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
            """,
            (str(LOCAL_TENANT), str(target_job_id)),
        ).fetchone()
        assert dict(cover) == {
            "state": "pending",
            "attempt_count": 0,
            "started_at": None,
            "finished_at": None,
            "duration_ms": None,
            "error_code": None,
            "error_message": None,
            "next_action": None,
        }
        event = conn.execute(
            """
            SELECT event_type, message
            FROM job_events
            WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
            ORDER BY rowid DESC
            LIMIT 1
            """,
            (str(LOCAL_TENANT), str(target_job_id)),
        ).fetchone()
        assert event["event_type"] == "StageReset"
        assert event["message"] == "Cover stage reset after tailored resume generation"
    finally:
        close_connection(db_path)


def test_tailor_job_by_url_skips_score_five_by_default(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    target_url = "https://example.com/low-fit"

    try:
        target_job_id = _insert_job(conn, url=target_url, fit_score=5)

        def fail_tailor_one_job(*_args, **_kwargs):
            raise AssertionError("score-five jobs must not tailor by default")

        monkeypatch.setattr("jobctrl.scoring.tailor.get_connection", lambda: conn)
        monkeypatch.setattr("jobctrl.scoring.tailor._tailor_one_job", fail_tailor_one_job)

        result = tailor_job_by_url(
            target_url,
            min_score=5,
            snapshot=SimpleNamespace(),
            llm_model=None,
        )

        assert result == {
            "url": target_url,
            "job_id": str(target_job_id),
            "status": "skipped",
            "reason": "not_eligible",
        }
    finally:
        close_connection(db_path)


def test_tailor_job_by_url_allows_low_fit_manual_override(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    target_url = "https://example.com/manual-low-fit"
    calls: list[str] = []

    try:
        _insert_job(conn, url=target_url, fit_score=5)

        def fake_tailor_one_job(job, *_args, **_kwargs):
            calls.append(job["url"])
            return {
                "url": job["url"],
                "title": job["title"],
                "site": job.get("site"),
                "status": "approved",
                "attempts": 1,
                "path": "/tmp/manual-low-fit.txt",
                "pdf_path": None,
                "materials": SimpleNamespace(generation=1),
            }

        monkeypatch.setattr("jobctrl.scoring.tailor.get_connection", lambda: conn)
        monkeypatch.setattr("jobctrl.scoring.tailor._build_pdf_renderer", lambda: object())
        monkeypatch.setattr("jobctrl.scoring.tailor._tailor_one_job", fake_tailor_one_job)

        result = tailor_job_by_url(
            target_url,
            min_score=7,
            allow_low_fit_override=True,
            snapshot=SimpleNamespace(),
            llm_model=None,
        )

        assert result["status"] == "approved"
        assert calls == [target_url]
    finally:
        close_connection(db_path)


def test_tailor_job_by_url_surfaces_blocked_score_eligibility(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    target_url = "https://example.com/blocked"

    try:
        target_job_id = _insert_job(conn, url=target_url, fit_score=10)
        _insert_blocked_score(conn, url=target_url)

        def fail_tailor_one_job(*_args, **_kwargs):
            raise AssertionError("blocked score must not tailor")

        monkeypatch.setattr("jobctrl.scoring.tailor.get_connection", lambda: conn)
        monkeypatch.setattr("jobctrl.scoring.tailor._tailor_one_job", fail_tailor_one_job)

        result = tailor_job_by_url(
            target_url,
            min_score=7,
            retailor=True,
            snapshot=SimpleNamespace(),
            llm_model=None,
        )

        assert result == {
            "url": target_url,
            "job_id": str(target_job_id),
            "status": "skipped",
            "reason": "score_eligibility_blocked",
        }
        rows = conn.execute(
            """
            SELECT stage, state, error_code, error_message, blocked_by_json, next_action
            FROM job_stage_states
            WHERE tenant_id = ? AND job_id = ?
              AND stage IN ('tailor', 'cover', 'apply')
            ORDER BY stage
            """,
            (str(LOCAL_TENANT), str(target_job_id)),
        ).fetchall()
        assert {row["stage"]: row["state"] for row in rows} == {
            "apply": "blocked",
            "cover": "blocked",
            "tailor": "blocked",
        }
        assert {row["error_code"] for row in rows} == {"SCORE_ELIGIBILITY_BLOCKED"}
        assert all("No sponsorship." in row["error_message"] for row in rows)
        assert {row["blocked_by_json"] for row in rows} == {'["score"]'}
        assert {row["next_action"] for row in rows} == {"review score hard blockers"}
    finally:
        close_connection(db_path)


def test_tailor_cli_passes_retailor_flag(monkeypatch):
    runner = CliRunner()
    captured = {}

    def fake_run_stage_command(stage: str, **kwargs):
        captured["stage"] = stage
        captured["kwargs"] = kwargs

    monkeypatch.setattr("jobctrl.cli._run_stage_command", fake_run_stage_command)

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

    monkeypatch.setattr("jobctrl.cli._run_stage_command", fake_run_stage_command)

    result = runner.invoke(
        app,
        [
            "tailor",
            "--tailor-models",
            "local:draft-a,gemini:draft-b",
            "--tailor-judge-model",
            "google:judge-c",
            "--tailor-judge-min-score",
            "0.9",
        ],
    )

    assert result.exit_code == 0
    assert captured["stage"] == "tailor"
    assert captured["kwargs"]["tailor_models"] == ("local:draft-a", "gemini:draft-b")
    assert captured["kwargs"]["tailor_judge_model"] == "google:judge-c"
    assert captured["kwargs"]["tailor_judge_min_score"] == 0.9


def test_tailor_cli_preserves_omitted_judge_min_score_for_saved_default(monkeypatch):
    runner = CliRunner()
    captured = {}

    def fake_run_stage_command(stage: str, **kwargs):
        captured["stage"] = stage
        captured["kwargs"] = kwargs

    monkeypatch.setattr("jobctrl.cli._run_stage_command", fake_run_stage_command)

    result = runner.invoke(
        app,
        [
            "tailor",
            "--tailor-models",
            "local:draft-a",
            "--tailor-judge-model",
            "google:judge-c",
        ],
    )

    assert result.exit_code == 0
    assert captured["stage"] == "tailor"
    assert captured["kwargs"]["tailor_models"] == ("local:draft-a",)
    assert captured["kwargs"]["tailor_judge_model"] == "google:judge-c"
    assert captured["kwargs"]["tailor_judge_min_score"] is None


def test_tailor_policy_prefers_explicit_judge_min_score_over_legacy_environment(monkeypatch):
    monkeypatch.setenv("TAILORING_JUDGE_MIN_SCORE", "0.3")

    policy = _build_llm_policy(tailor_judge_min_score=0.9)

    assert policy.judge_min_score == 0.9


def test_tailor_policy_uses_saved_judge_min_score_when_omitted(monkeypatch, tmp_path):
    settings_path = tmp_path / "config.json"
    settings_path.write_text('{"tailoring_judge_min_score": 0.77}', encoding="utf-8")
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings_path))
    monkeypatch.setenv("TAILORING_JUDGE_MIN_SCORE", "0.3")

    policy = _build_llm_policy(tailor_judge_min_score=None)

    assert policy.judge_min_score == 0.77


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


def test_tailor_one_job_surfaces_use_case_pdf_path(tmp_path):
    # The use case owns PDF rendering (it renders the approved resume before
    # superseding the prior generation). The runner only surfaces the outcome.
    job = {
        "job_id": str(_JOB_ID),
        "url": "https://example.com/pdf-job",
        "title": "Platform Engineer",
        "site": "example",
        "full_description": "Build Python platforms.",
    }
    text_path = tmp_path / "tailored.txt"
    text_path.write_text("tailored resume", encoding="utf-8")
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=_JOB_ID,
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
    pdf_path = str(text_path.with_suffix(".pdf"))
    outcome = TailorOutcome(
        materials=materials,
        status="approved",
        attempts=1,
        text_path=str(text_path),
        pdf_path=pdf_path,
    )

    result = _tailor_one_job(
        job, "", SimpleNamespace(), "normal", use_case=_FakeTailorUseCase(outcome)
    )

    assert result["status"] == "approved"
    assert result["pdf_path"] == pdf_path
    assert result["materials"] is materials
    assert result["error"] == ""


def test_tailor_one_job_surfaces_use_case_pdf_failure(tmp_path):
    # A PDF render failure is handled inside the use case (it demotes the new
    # generation and returns an error outcome); the runner passes it through.
    job = {
        "job_id": str(_JOB_ID),
        "url": "https://example.com/pdf-job",
        "title": "Platform Engineer",
        "site": "example",
        "full_description": "Build Python platforms.",
    }
    text_path = tmp_path / "tailored.txt"
    text_path.write_text("tailored resume", encoding="utf-8")
    rejected = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=_JOB_ID,
        created_at="2026-05-25T00:00:00+00:00",
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(text_path),
            created_at="2026-05-25T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.failure(("PDF render failed: latex failed",)),
        verdict=JudgeVerdict.passed(score=0.93),
        updated_at="2026-05-25T00:00:00+00:00",
    )
    outcome = TailorOutcome(
        materials=rejected,
        status="error",
        attempts=1,
        text_path=str(text_path),
        pdf_path=None,
        error="PDF render failed: latex failed",
    )

    result = _tailor_one_job(
        job, "", SimpleNamespace(), "normal", use_case=_FakeTailorUseCase(outcome)
    )

    assert result["status"] == "error"
    assert result["pdf_path"] is None
    assert result["error"] == "PDF render failed: latex failed"
    assert result["materials"].tailored_resume is not None
    assert result["materials"].tailored_resume.status is ArtifactStatus.REJECTED


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
    prompt = build_master_tailor_prompt(
        snapshot,
        learned_tailoring_rules=LearnedTailoringRules.from_mapping(
            {
                "style_guidance": "preserve_user_edit_pattern",
                "fact_handling": "require_source_match",
                "claim_policy": "omit_unsupported_claims",
                "keyword_strategy": "use_supported_terms_only",
                "provenance_policy": "require_direct_evidence",
            }
        ),
    )

    assert "WRITING STYLE:" in prompt
    assert "- Tone: technical" in prompt
    assert "- Bullet standards: impact, technical_depth, leadership" in prompt
    assert "USER ADDITIONAL TAILORING PROMPT:" in prompt
    assert "Use concise platform leadership language." in prompt
    assert "ACCEPTED LEARNING RULES FOR FUTURE MATERIALS:" in prompt
    assert "style_guidance=preserve_user_edit_pattern" in prompt
    assert "fact_handling=require_source_match" in prompt
    assert "claim_policy=omit_unsupported_claims" in prompt
    assert "keyword_strategy=use_supported_terms_only" in prompt
    assert "provenance_policy=require_direct_evidence" in prompt


def test_tailor_prompt_treats_target_job_as_context_not_evidence():
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
                    "bullets": ["Built distributed systems."],
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
        "resume_constraints": {"real_metrics": []},
    }

    snapshot = ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, profile))
    prompt = _build_master_tailor_prompt(snapshot)

    assert "TARGET JOB text is context only" in prompt
    assert "Do NOT copy target-job technologies" in prompt
    assert "same fact appears in the master" in prompt
    assert "evidence above" in prompt
    assert "adjacent" in prompt
    assert "grounded experience instead" in prompt
