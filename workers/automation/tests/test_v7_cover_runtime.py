"""Exact-v7 regression tests for single-job cover-letter execution."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials import (
    Artifact,
    ArtifactType,
    JudgeVerdict,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.scoring import JobScore
from jobctrl.domain.scoring.value_objects import (
    EligibilityAssessment,
    FitScore,
    MatchedKeywords,
    ScoreBreakdown,
)
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.materials import SqliteMaterialsRepository
from jobctrl.infrastructure.scoring import SqliteScoreRepository
from jobctrl.materials import activities as activities_module
from jobctrl.materials.activities import CoverLetterActivityInput
from jobctrl.scoring import cover_letter as cover_letter_module


_TENANT_A = TenantId("tenant-a")
_TENANT_B = TenantId("tenant-b")
_JOB_ID = canonical_job_id("30000000-0000-4000-8000-000000000003")
_POSTING_URL = "https://jobs.example.test/roles/platform-engineer"
_NOW = "2026-07-31T10:00:00+00:00"


class _CoverLlm:
    model = "test-model"

    def __init__(self) -> None:
        self.calls = 0

    def chat(self, *_args, **_kwargs) -> str:
        self.calls += 1
        return (
            "Dear Hiring Manager,\n\n"
            "I built Python platform services that map to this role.\n\n"
            "Candidate\nEND_OF_COVER_LETTER"
        )


class _PdfRenderer:
    def render_cover_letter_to_pdf(
        self,
        *,
        cover_letter_text: str,
        output_path: str,
        created_at: str,
    ) -> Artifact:
        assert cover_letter_text
        Path(output_path).write_bytes(b"%PDF-1.4\n")
        return Artifact.create(
            type=ArtifactType.COVER_LETTER_PDF,
            path=output_path,
            created_at=created_at,
            render_format=RenderFormat.HTML_PDF,
        )


class _FailingCoverLlm:
    model = "test-model"

    def __init__(self) -> None:
        self.calls = 0

    def chat(self, *_args, **_kwargs) -> str:
        self.calls += 1
        raise RuntimeError("LLM outage")


@pytest.fixture()
def conn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> sqlite3.Connection:
    connection = init_db(tmp_path / "jobctrl-v7.db")
    monkeypatch.setattr(cover_letter_module, "get_connection", lambda: connection)
    monkeypatch.setattr(cover_letter_module, "COVER_LETTER_DIR", tmp_path / "cover-letters")
    return connection


def _snapshot(tenant_id: TenantId) -> ProfileSnapshot:
    profile = Profile.from_dict(
        tenant_id,
        {
            "personal": {"full_name": "Candidate"},
            "resume": {
                "executive_profile": {"baseline_text": "Python platform engineer."},
                "experience_entries": [
                    {
                        "id": "platform",
                        "title": "Platform Engineer",
                        "company": "Previous Co",
                        "bullets": ["Built Python platform services."],
                    }
                ],
                "education_entries": [],
                "skill_categories": [],
            },
        },
    )
    return ProfileSnapshot.from_profile(profile)


def _seed_target(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId = _JOB_ID,
    posting_url: str = _POSTING_URL,
    current_locator: bool = True,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, location, site,
            strategy, discovered_at
        ) VALUES (?, ?, ?, 'Platform Engineer', 'Acme', 'Remote',
                  'example', 'search', ?)
        """,
        (str(tenant_id), str(job_id), posting_url, _NOW),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value, is_current,
            first_seen_at, last_seen_at
        ) VALUES (?, ?, 'posting_url', ?, ?, ?, ?)
        """,
        (str(tenant_id), str(job_id), posting_url, int(current_locator), _NOW, _NOW),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description,
            enriched_at, extraction_tier, updated_at
        ) VALUES (?, ?, 'enriched', 'Build Python platform services.', ?,
                  'high', ?)
        """,
        (str(tenant_id), str(job_id), _NOW, _NOW),
    )
    conn.commit()


def _seed_eligible_score(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId = _JOB_ID,
    fit_score: int = 8,
    eligibility: EligibilityAssessment | None = None,
) -> None:
    SqliteScoreRepository(conn).save(
        JobScore.initial(
            tenant_id=tenant_id,
            job_id=job_id,
            fit_score=FitScore(fit_score),
            breakdown=ScoreBreakdown(
                technical_fit=8,
                experience_fit=8,
                role_fit=8,
                reasoning="Strong fit.",
                fit_band="strong",
                confidence="high",
                eligibility=eligibility or EligibilityAssessment(status="eligible"),
            ),
            matched_keywords=MatchedKeywords.from_iterable(("python",)),
            scored_at=_NOW,
        )
    )


def _seed_approved_resume(
    conn: sqlite3.Connection,
    tmp_path: Path,
    *,
    tenant_id: TenantId,
    job_id: JobId = _JOB_ID,
) -> None:
    resume_path = tmp_path / f"{tenant_id}-{job_id}-resume.txt"
    resume_path.write_text("Python platform engineer", encoding="utf-8")
    materials = MaterialsSetFactory.initial(
        tenant_id=tenant_id,
        job_id=job_id,
        created_at=_NOW,
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(resume_path),
            created_at=_NOW,
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at=_NOW,
    ).with_resume_pdf(
        Artifact.create(
            type=ArtifactType.RESUME_PDF,
            path=str(tmp_path / f"{tenant_id}-{job_id}-resume.pdf"),
            created_at=_NOW,
            render_format=RenderFormat.HTML_PDF,
        ),
        updated_at=_NOW,
    )
    SqliteMaterialsRepository(conn).save(materials)


def _seed_stage_rows(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId = _JOB_ID,
) -> None:
    cover_letter_module.ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=tenant_id,
        discovered_at=_NOW,
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'succeeded'
        WHERE tenant_id = ? AND job_id = ? AND stage = 'score'
        """,
        (str(tenant_id), str(job_id)),
    )
    conn.commit()


def test_cover_by_id_persists_artifacts_and_isolates_same_job_id_across_tenants(
    conn: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_target(conn, tenant_id=_TENANT_B)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_B)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_B)
    llm = _CoverLlm()

    result = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        repository=SqliteMaterialsRepository(conn),
        llm_port=llm,
        pdf_renderer=_PdfRenderer(),
    )

    assert result["status"] == "ok"
    assert result["jobId"] == str(_JOB_ID)
    assert llm.calls == 1
    primary = SqliteMaterialsRepository(conn).load_current_approved(_TENANT_A, _JOB_ID)
    other = SqliteMaterialsRepository(conn).load_current_approved(_TENANT_B, _JOB_ID)
    assert primary is not None and primary.cover_letter is not None and primary.cover_letter_pdf is not None
    assert other is not None and other.cover_letter is None
    stages = conn.execute(
        "SELECT tenant_id, job_id, state FROM job_stage_states WHERE stage = 'cover'"
    ).fetchall()
    assert [tuple(row) for row in stages] == [(str(_TENANT_A), str(_JOB_ID), "succeeded")]
    event = conn.execute(
        "SELECT tenant_id, job_id FROM job_events WHERE event_type = 'StageCompleted' AND stage = 'cover'"
    ).fetchone()
    assert tuple(event) == (str(_TENANT_A), str(_JOB_ID))


def test_cover_by_id_skips_missing_approved_materials_before_llm_or_artifact_work(
    conn: sqlite3.Connection,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    llm = _CoverLlm()

    result = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        llm_port=llm,
    )

    assert result["status"] == "skipped"
    assert result["reason"] == "missing_approved_resume"
    assert llm.calls == 0
    assert SqliteMaterialsRepository(conn).load(_TENANT_A, _JOB_ID) is None


def test_cover_by_id_commits_completed_job_before_later_failure(
    conn: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    failed_job_id = canonical_job_id("60000000-0000-4000-8000-000000000006")
    for job_id in (_JOB_ID, failed_job_id):
        _seed_target(conn, tenant_id=_TENANT_A, job_id=job_id, posting_url=f"{_POSTING_URL}/{job_id}")
        _seed_eligible_score(conn, tenant_id=_TENANT_A, job_id=job_id)
        _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A, job_id=job_id)

    completed = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        repository=SqliteMaterialsRepository(conn),
        llm_port=_CoverLlm(),
        pdf_renderer=_PdfRenderer(),
    )
    failed = cover_letter_module.cover_letter_by_id(
        failed_job_id,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        repository=SqliteMaterialsRepository(conn),
        llm_port=_FailingCoverLlm(),
        pdf_renderer=_PdfRenderer(),
    )

    assert completed["status"] == "ok"
    assert failed["status"] == "error"
    assert SqliteMaterialsRepository(conn).load_current_approved(_TENANT_A, _JOB_ID).cover_letter is not None
    stages = conn.execute(
        "SELECT job_id, state FROM job_stage_states WHERE tenant_id = ? AND stage = 'cover' ORDER BY job_id",
        (str(_TENANT_A),),
    ).fetchall()
    assert [tuple(row) for row in stages] == [
        (str(_JOB_ID), "succeeded"),
        (str(failed_job_id), "failed"),
    ]


@pytest.mark.parametrize(
    ("fit_score", "eligibility", "reason"),
    (
        (6, EligibilityAssessment(status="eligible"), "below_min_score"),
        (
            8,
            EligibilityAssessment(status="blocked", hard_blockers=("Work authorization required.",)),
            "score_ineligible",
        ),
    ),
)
def test_cover_by_id_enforces_score_eligibility_before_llm_work(
    conn: sqlite3.Connection,
    fit_score: int,
    eligibility: EligibilityAssessment,
    reason: str,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(
        conn,
        tenant_id=_TENANT_A,
        fit_score=fit_score,
        eligibility=eligibility,
    )
    llm = _CoverLlm()

    result = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        llm_port=llm,
    )

    assert result["status"] == "skipped"
    assert result["reason"] == reason
    assert llm.calls == 0


def test_cover_by_id_generates_for_historical_salary_only_block(
    conn: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(
        conn,
        tenant_id=_TENANT_A,
        fit_score=9,
        eligibility=EligibilityAssessment(
            status="blocked",
            hard_blockers=("Posted salary is below the preferred compensation range.",),
        ),
    )
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    llm = _CoverLlm()

    result = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        repository=SqliteMaterialsRepository(conn),
        llm_port=llm,
        pdf_renderer=_PdfRenderer(),
    )

    assert result["status"] == "ok"
    assert llm.calls == 1


@pytest.mark.parametrize(
    ("score_state", "seed_staleness", "reason"),
    (
        ("stale", False, "score_not_current"),
        ("succeeded", True, "score_stale"),
    ),
)
def test_cover_by_id_rejects_noncurrent_or_stale_scores(
    conn: sqlite3.Connection,
    score_state: str,
    seed_staleness: bool,
    reason: str,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_stage_rows(conn, tenant_id=_TENANT_A)
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = ?
        WHERE tenant_id = ? AND job_id = ? AND stage = 'score'
        """,
        (score_state, str(_TENANT_A), str(_JOB_ID)),
    )
    if seed_staleness:
        conn.execute(
            """
            INSERT INTO job_score_staleness (
                tenant_id, job_id, stale_reason,
                old_policy_version, new_policy_version, marked_at
            ) VALUES (?, ?, 'policy_changed', 1, 2, ?)
            """,
            (str(_TENANT_A), str(_JOB_ID), _NOW),
        )
    conn.commit()
    llm = _CoverLlm()

    result = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        llm_port=llm,
    )

    assert result["reason"] == reason
    assert llm.calls == 0


@pytest.mark.parametrize(
    ("active_state", "confidence", "quarantine_reason", "reason"),
    (
        ("closed", "high", None, "posting_inactive"),
        ("active", "low", "content_too_short", "posting_quarantined"),
    ),
)
def test_cover_by_id_rejects_inactive_or_quarantined_postings(
    conn: sqlite3.Connection,
    active_state: str,
    confidence: str,
    quarantine_reason: str | None,
    reason: str,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
            latest_active_state, latest_confidence,
            latest_quarantine_reason, updated_at
        ) VALUES (?, ?, '{}', 1, ?, ?, ?, ?)
        """,
        (
            str(_TENANT_A),
            str(_JOB_ID),
            active_state,
            confidence,
            quarantine_reason,
            _NOW,
        ),
    )
    conn.commit()
    llm = _CoverLlm()

    result = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        llm_port=llm,
    )

    assert result["reason"] == reason
    assert llm.calls == 0


def test_cover_by_id_allows_explicit_low_confidence_override_state(
    conn: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
            latest_active_state, latest_confidence,
            latest_quarantine_reason, updated_at
        ) VALUES (?, ?, '{}', 1, 'active', 'low', 'none', ?)
        """,
        (str(_TENANT_A), str(_JOB_ID), _NOW),
    )
    conn.commit()
    llm = _CoverLlm()

    result = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        repository=SqliteMaterialsRepository(conn),
        llm_port=llm,
        pdf_renderer=_PdfRenderer(),
    )

    assert result["status"] == "ok"
    assert llm.calls == 1


@pytest.mark.parametrize(
    ("cover_state", "attempt_count"),
    (
        ("exhausted", 4),
        ("failed", 5),
    ),
)
def test_cover_by_id_rejects_exhausted_attempt_budget(
    conn: sqlite3.Connection,
    cover_state: str,
    attempt_count: int,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_stage_rows(conn, tenant_id=_TENANT_A)
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = ?, attempt_count = ?
        WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
        """,
        (cover_state, attempt_count, str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()

    result = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        llm_port=_CoverLlm(),
    )

    assert result["reason"] == "cover_exhausted"


def test_cover_by_id_marks_the_fifth_failed_attempt_exhausted(
    conn: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    _seed_stage_rows(conn, tenant_id=_TENANT_A)
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'failed', attempt_count = 4
        WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()

    result = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        repository=SqliteMaterialsRepository(conn),
        llm_port=_FailingCoverLlm(),
        pdf_renderer=_PdfRenderer(),
    )

    assert result["status"] == "error"
    state = conn.execute(
        """
        SELECT state, attempt_count, retryable, next_action
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == (
        "exhausted",
        5,
        0,
        f"jobctrl retry cover {_POSTING_URL} --reset-attempts",
    )


@pytest.mark.parametrize("retry_state", ("running", "failed", "stale"))
def test_cover_by_id_allows_retryable_stage_to_reenter_generation(
    conn: sqlite3.Connection,
    tmp_path: Path,
    retry_state: str,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    _seed_stage_rows(conn, tenant_id=_TENANT_A)
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = ?, attempt_count = 1
        WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
        """,
        (retry_state, str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    llm = _CoverLlm()

    result = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        repository=SqliteMaterialsRepository(conn),
        llm_port=llm,
        pdf_renderer=_PdfRenderer(),
    )

    assert result["status"] == "ok"
    assert llm.calls == 1
    state = conn.execute(
        """
        SELECT state, attempt_count
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == ("succeeded", 2)


def test_cover_by_id_rejects_tombstoned_and_url_shaped_ids_before_llm_work(
    conn: sqlite3.Connection,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    conn.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at, reason, restored_at)
        VALUES (?, ?, ?, 'duplicate', NULL)
        """,
        (str(_TENANT_A), str(_JOB_ID), _NOW),
    )
    conn.commit()
    llm = _CoverLlm()

    tombstoned = cover_letter_module.cover_letter_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=_snapshot(_TENANT_A),
        llm_port=llm,
    )

    assert tombstoned["status"] == "skipped"
    assert tombstoned["reason"] == "job_not_found"
    assert llm.calls == 0
    with pytest.raises(ValueError, match="canonical UUID"):
        cover_letter_module.cover_letter_by_id(
            _POSTING_URL,  # type: ignore[arg-type]
            tenant_id=_TENANT_A,
            llm_port=llm,
        )
    assert llm.calls == 0


def test_url_locator_adapter_requires_the_current_tenant_scoped_locator(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_target(conn, tenant_id=_TENANT_B, job_id=canonical_job_id("40000000-0000-4000-8000-000000000004"))
    called: list[JobId] = []

    def fake_cover_by_id(job_id: JobId, **_kwargs) -> dict:
        called.append(job_id)
        return {"status": "ok", "jobId": str(job_id)}

    monkeypatch.setattr(cover_letter_module, "cover_letter_by_id", fake_cover_by_id)
    result = cover_letter_module.cover_letter_by_url(_POSTING_URL, tenant_id=_TENANT_B)

    assert result["jobId"] == "40000000-0000-4000-8000-000000000004"
    assert called == [canonical_job_id("40000000-0000-4000-8000-000000000004")]
    conn.execute(
        "UPDATE job_locators SET is_current = 0 WHERE tenant_id = ?",
        (str(_TENANT_B),),
    )
    conn.commit()
    assert cover_letter_module.cover_letter_by_url(_POSTING_URL, tenant_id=_TENANT_B)["reason"] == "job_not_found"


def test_cover_activity_wires_the_canonical_job_id_entrypoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, object] = {}

    def fake_cover_by_id(job_id: JobId, **kwargs) -> dict:
        seen["job_id"] = job_id
        seen.update(kwargs)
        return {"status": "skipped", "reason": "missing_approved_resume"}

    monkeypatch.setattr(cover_letter_module, "cover_letter_by_id", fake_cover_by_id)
    payload = CoverLetterActivityInput(tenant_id=str(_TENANT_A), job_id=_JOB_ID)

    assert activities_module._cover_one_job(payload)["reason"] == "missing_approved_resume"
    assert seen["job_id"] == _JOB_ID
    assert seen["tenant_id"] == _TENANT_A
