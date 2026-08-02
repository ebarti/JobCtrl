"""Phase 6 / S-20: queue selectors must read through the materials join.

Mirrors the Phase 5 ``test_score_queue_selectors`` pattern: after the
:class:`SqliteMaterialsRepository` saves a MaterialsSet, the
``get_jobs_by_stage`` selectors (which back the worker queues +
``pipeline.apply_jobs``) must reflect newly saved materials immediately,
without writing the deprecated path columns on ``jobs``.
"""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

from jobctrl.database import get_jobs_by_stage, get_stats, init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials import (
    Artifact,
    ArtifactType,
    JudgeVerdict,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials import SqliteMaterialsRepository
from jobctrl.state import ensure_job_stage_rows, set_stage_state


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jh.db")


def _seed_job(conn: sqlite3.Connection, url: str, fit_score: int = 9) -> str:
    job_id = _job_id(url)
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (LOCAL_TENANT, job_id, url, "Engineer", "Acme", "2024-01-01T00:00:00+00:00"),
    )
    conn.execute(
        "INSERT INTO job_enrichments "
        "(tenant_id, job_id, current_status, full_description, updated_at) "
        "VALUES (?, ?, 'enriched', 'desc', ?)",
        (LOCAL_TENANT, job_id, "2024-01-01T00:00:00+00:00"),
    )
    conn.execute(
        "INSERT INTO job_scores "
        "(tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at) "
        "VALUES (?, ?, 1, ?, '{}', '[]', ?)",
        (LOCAL_TENANT, job_id, fit_score, "2024-01-01T00:00:00+00:00"),
    )
    ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=LOCAL_TENANT,
        discovered_at="2024-01-01T00:00:00+00:00",
    )
    set_stage_state(
        conn,
        job_id,
        "score",
        "succeeded",
        tenant_id=LOCAL_TENANT,
        validate_transition=False,
    )
    conn.commit()
    return url


def _selector_job_id(name: str) -> JobId:
    return JobId(str(uuid.uuid5(uuid.NAMESPACE_URL, f"jobctrl-selector-test:{name}")))


def _job_id(url: str) -> JobId:
    return JobId(str(uuid.uuid5(uuid.NAMESPACE_URL, url)))


def _seed_selector_job(
    conn: sqlite3.Connection,
    name: str,
    fit_score: int = 9,
) -> JobId:
    url = f"https://example.com/{name}"
    _seed_job(conn, url, fit_score)
    return _job_id(url)


def _make_resume_artifact(path: str = "/tmp/r.txt") -> Artifact:
    return Artifact.create(
        type=ArtifactType.TAILORED_RESUME,
        path=path,
        created_at="2024-01-02T00:00:00+00:00",
        render_format=RenderFormat.TEXT,
    )


def _make_cover_artifact(path: str = "/tmp/c.txt") -> Artifact:
    return Artifact.create(
        type=ArtifactType.COVER_LETTER,
        path=path,
        created_at="2024-01-03T00:00:00+00:00",
        render_format=RenderFormat.TEXT,
    )


def _make_resume_pdf_artifact(path: str = "/tmp/r.pdf") -> Artifact:
    return Artifact.create(
        type=ArtifactType.RESUME_PDF,
        path=path,
        created_at="2024-01-02T01:00:00+00:00",
        render_format=RenderFormat.LATEX_PDF,
    )


# ---------------------------------------------------------------------------
# pending_tailor
# ---------------------------------------------------------------------------


def test_pending_tailor_excludes_jobs_with_approved_resume(conn: sqlite3.Connection) -> None:
    pending_job_id = _seed_selector_job(conn, "pending")
    done_job_id = _seed_selector_job(conn, "done")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=done_job_id,
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(materials)

    rows = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7, limit=0)
    job_ids = {row["job_id"] for row in rows}
    assert pending_job_id in job_ids
    assert done_job_id not in job_ids


def test_pending_tailor_with_retailor_includes_done_jobs(conn: sqlite3.Connection) -> None:
    done_job_id = _seed_selector_job(conn, "done")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=done_job_id,
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(materials)

    rows = get_jobs_by_stage(
        conn=conn, stage="pending_tailor", min_score=7, limit=0, retailor=True
    )
    assert done_job_id in {row["job_id"] for row in rows}


def test_tailored_selector_exposes_canonical_material_path(
    conn: sqlite3.Connection,
) -> None:
    """The tailored selector exposes the canonical resume path to consumers."""
    job_id = _seed_selector_job(conn, "done")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact("/tmp/specific-path.txt"),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(materials)

    rows = get_jobs_by_stage(conn=conn, stage="tailored")
    assert any(
        row["tenant_id"] == LOCAL_TENANT
        and row["job_id"] == job_id
        and row["tailored_resume_path"] == "/tmp/specific-path.txt"
        for row in rows
    )


# ---------------------------------------------------------------------------
# pending_cover
# ---------------------------------------------------------------------------


def test_pending_cover_returns_only_jobs_with_resume_no_cover(
    conn: sqlite3.Connection,
) -> None:
    resume_job_id = _seed_selector_job(conn, "resume-only")
    text_only_job_id = _seed_selector_job(conn, "text-only")
    full_job_id = _seed_selector_job(conn, "full")
    repo = SqliteMaterialsRepository(conn)
    base = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=resume_job_id,
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    ).with_resume_pdf(
        _make_resume_pdf_artifact(),
        updated_at="2024-01-02T01:00:00+00:00",
    )
    repo.save(base)
    text_only = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=text_only_job_id,
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact("/tmp/text-only-r.txt"),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(text_only)
    full = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=full_job_id,
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact("/tmp/full-r.txt"),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    ).with_resume_pdf(
        _make_resume_pdf_artifact("/tmp/full-r.pdf"),
        updated_at="2024-01-02T01:00:00+00:00",
    ).with_cover_letter(
        _make_cover_artifact("/tmp/full-c.txt"),
        validation=ValidationResult.success(),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    repo.save(full)

    rows = get_jobs_by_stage(conn=conn, stage="pending_cover", min_score=7, limit=0)
    job_ids = {row["job_id"] for row in rows}
    assert resume_job_id in job_ids
    assert text_only_job_id not in job_ids
    assert full_job_id not in job_ids


# ---------------------------------------------------------------------------
# pending_pdf
# ---------------------------------------------------------------------------


def test_pending_pdf_includes_jobs_with_text_but_missing_pdf(
    conn: sqlite3.Connection,
) -> None:
    job_id = _seed_selector_job(conn, "needs-pdf")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(materials)

    rows = get_jobs_by_stage(conn=conn, stage="pending_pdf", limit=0)
    assert job_id in {row["job_id"] for row in rows}


# ---------------------------------------------------------------------------
# Round-2 review B2: get_stats reads through the materials join
# ---------------------------------------------------------------------------


def test_get_stats_tailored_count_reflects_materials_writes(conn: sqlite3.Connection) -> None:
    """``stats['tailored']`` must reflect a freshly-saved MaterialsSet."""
    job_id = _seed_selector_job(conn, "job")
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=job_id,
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact(),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
    )
    stats = get_stats(conn)
    assert stats["tailored"] == 1
    deprecated_count = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE tailored_resume_path IS NOT NULL"
    ).fetchone()[0]
    assert deprecated_count == 0


def test_get_stats_with_cover_letter_count_reflects_materials_writes(
    conn: sqlite3.Connection,
) -> None:
    job_id = _seed_selector_job(conn, "job")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    ).with_cover_letter(
        _make_cover_artifact(),
        validation=ValidationResult.success(),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    repo.save(materials)
    stats = get_stats(conn)
    assert stats["with_cover_letter"] == 1


def test_get_stats_ready_to_apply_reflects_materials_writes(conn: sqlite3.Connection) -> None:
    """``ready_to_apply`` requires tailored text, resume PDF, and application_url."""
    job_id = _seed_selector_job(conn, "job")
    conn.execute(
        "UPDATE jobs SET application_url = 'https://example.com/apply' "
        "WHERE tenant_id = ? AND job_id = ?",
        (LOCAL_TENANT, job_id),
    )
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=job_id,
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact(),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        ).with_resume_pdf(
            _make_resume_pdf_artifact(),
            updated_at="2024-01-02T01:00:00+00:00",
        )
    )
    stats = get_stats(conn)
    assert stats["ready_to_apply"] == 1


def test_get_stats_ready_to_apply_excludes_text_only_tailored_materials(
    conn: sqlite3.Connection,
) -> None:
    job_id = _seed_selector_job(conn, "text-only")
    conn.execute(
        "UPDATE jobs SET application_url = 'https://example.com/apply' "
        "WHERE tenant_id = ? AND job_id = ?",
        (LOCAL_TENANT, job_id),
    )
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=job_id,
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact(),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
    )

    stats = get_stats(conn)

    assert stats["ready_to_apply"] == 0


def test_pipeline_count_pending_cover_excludes_text_only_tailored_materials(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import pipeline
    from jobctrl.pipeline import runner as pipeline_runner

    text_only_job_id = _seed_selector_job(conn, "text-only")
    with_pdf_job_id = _seed_selector_job(conn, "with-pdf")
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=text_only_job_id,
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact("/tmp/text-only-r.txt"),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
    )
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=with_pdf_job_id,
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact("/tmp/with-pdf-r.txt"),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        ).with_resume_pdf(
            _make_resume_pdf_artifact("/tmp/with-pdf-r.pdf"),
            updated_at="2024-01-02T01:00:00+00:00",
        )
    )
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert pipeline._count_pending("cover", min_score=7) == 1


def test_get_stats_untailored_eligible_excludes_materials_tailored(
    conn: sqlite3.Connection,
) -> None:
    """Once a job is tailored via materials, ``untailored_eligible`` drops it."""
    tailored_job_id = _seed_selector_job(conn, "tailored")
    _seed_selector_job(conn, "pending")
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=tailored_job_id,
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact(),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
    )
    stats = get_stats(conn)
    assert stats["untailored_eligible"] == 1


def test_get_stats_tailor_exhausted_reads_stage_state(conn: sqlite3.Connection) -> None:
    """``tailor_exhausted`` honours the new ``job_stage_states.state``."""
    job_id = _seed_selector_job(conn, "job")
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=LOCAL_TENANT,
        discovered_at="2024-01-01T00:00:00+00:00",
    )
    # Walk the state machine: pending → running → failed → exhausted.
    set_stage_state(
        conn,
        job_id,
        "tailor",
        "running",
        tenant_id=LOCAL_TENANT,
        started_at="2024-01-02T00:00:00+00:00",
    )
    set_stage_state(conn, job_id, "tailor", "failed", tenant_id=LOCAL_TENANT, attempt_count=4)
    set_stage_state(
        conn,
        job_id,
        "tailor",
        "exhausted",
        tenant_id=LOCAL_TENANT,
        attempt_count=5,
        max_attempts=5,
        finished_at="2024-01-02T00:00:00+00:00",
    )
    stats = get_stats(conn)
    assert stats["tailor_exhausted"] == 1


# ---------------------------------------------------------------------------
# Round-2 review H1: exhaustion gate via job_stage_states
# ---------------------------------------------------------------------------


def test_pending_tailor_excludes_exhausted_jobs_via_stage_state(
    conn: sqlite3.Connection,
) -> None:
    """A job whose ``job_stage_states.state == 'exhausted'`` for tailor
    must NOT appear in the pending_tailor selector."""
    job_id = _seed_selector_job(conn, "exhausted")
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=LOCAL_TENANT,
        discovered_at="2024-01-01T00:00:00+00:00",
    )
    # Walk the state machine: pending → running → failed → exhausted.
    set_stage_state(
        conn,
        job_id,
        "tailor",
        "running",
        tenant_id=LOCAL_TENANT,
        started_at="2024-01-02T00:00:00+00:00",
    )
    set_stage_state(conn, job_id, "tailor", "failed", tenant_id=LOCAL_TENANT, attempt_count=4)
    set_stage_state(
        conn,
        job_id,
        "tailor",
        "exhausted",
        tenant_id=LOCAL_TENANT,
        attempt_count=5,
        max_attempts=5,
        finished_at="2024-01-02T00:00:00+00:00",
    )
    rows = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7, limit=0)
    assert job_id not in {row["job_id"] for row in rows}


def test_pending_tailor_excludes_jobs_with_high_attempt_count(
    conn: sqlite3.Connection,
) -> None:
    """A job whose ``job_stage_states.attempt_count >= 5`` for tailor
    must NOT appear in pending_tailor — even when ``state`` isn't yet
    'exhausted'."""
    job_id = _seed_selector_job(conn, "many-attempts")
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=LOCAL_TENANT,
        discovered_at="2024-01-01T00:00:00+00:00",
    )
    set_stage_state(
        conn,
        job_id,
        "tailor",
        "running",
        tenant_id=LOCAL_TENANT,
        started_at="2024-01-02T00:00:00+00:00",
    )
    set_stage_state(
        conn,
        job_id,
        "tailor",
        "failed",
        tenant_id=LOCAL_TENANT,
        attempt_count=5,
        max_attempts=5,
        finished_at="2024-01-02T00:00:00+00:00",
    )
    rows = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7, limit=0)
    assert job_id not in {row["job_id"] for row in rows}


# ---------------------------------------------------------------------------
# Round-2 review B3: reset_job_stage clears materials
# ---------------------------------------------------------------------------


def test_reset_tailor_clears_rejected_attempt_artifacts(
    conn: sqlite3.Connection,
) -> None:
    """After a failed tailor reset, rejected artifacts are cleared for retry."""
    from jobctrl.state import ensure_job_stage_rows, reset_job_stage

    url = _seed_job(conn, "https://example.com/job")
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=_job_id(url),
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact(),
            validation=ValidationResult.failure(("unsupported claim",)),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
    )
    ensure_job_stage_rows(
        conn, _job_id(url), tenant_id=LOCAL_TENANT, discovered_at="2024-01-01T00:00:00+00:00"
    )

    reset_job_stage(conn, url, "tailor", tenant_id=LOCAL_TENANT)

    pending_after = {row["url"] for row in get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)}
    assert url in pending_after

    # Materials artifacts for the latest generation must be gone.
    artifact_count = conn.execute(
        "SELECT COUNT(*) FROM job_materials_artifacts WHERE tenant_id = ? AND job_id = ?",
        (LOCAL_TENANT, _job_id(url)),
    ).fetchone()[0]
    assert artifact_count == 0


def test_reset_tailor_preserves_approved_materials_until_replacement(
    conn: sqlite3.Connection,
) -> None:
    """Retry reset must not hide the last accepted tailored resume."""
    from jobctrl.state import ensure_job_stage_rows, reset_job_stage

    url = _seed_job(conn, "https://example.com/approved-job")
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=_job_id(url),
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact(),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
    )
    ensure_job_stage_rows(
        conn, _job_id(url), tenant_id=LOCAL_TENANT, discovered_at="2024-01-01T00:00:00+00:00"
    )

    reset_job_stage(conn, url, "tailor", tenant_id=LOCAL_TENANT)

    pending_after = {row["url"] for row in get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)}
    assert url not in pending_after
    artifact_count = conn.execute(
        "SELECT COUNT(*) FROM job_materials_artifacts WHERE tenant_id = ? AND job_id = ?",
        (LOCAL_TENANT, _job_id(url)),
    ).fetchone()[0]
    assert artifact_count == 1


def test_reset_cover_clears_only_failed_cover_artifacts(conn: sqlite3.Connection) -> None:
    """``reset_job_stage(stage='cover')`` keeps the approved tailored resume."""
    from jobctrl.state import ensure_job_stage_rows, reset_job_stage

    url = _seed_job(conn, "https://example.com/job")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=_job_id(url),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    ).with_cover_letter(
        _make_cover_artifact(),
        validation=ValidationResult.failure(("too generic",)),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    repo.save(materials)
    ensure_job_stage_rows(
        conn, _job_id(url), tenant_id=LOCAL_TENANT, discovered_at="2024-01-01T00:00:00+00:00"
    )

    reset_job_stage(conn, url, "cover", tenant_id=LOCAL_TENANT)

    rows = conn.execute(
        "SELECT artifact_type FROM job_materials_artifacts WHERE tenant_id = ? AND job_id = ?",
        (LOCAL_TENANT, _job_id(url)),
    ).fetchall()
    types = {row[0] for row in rows}
    assert "tailored_resume" in types
    assert "cover_letter" not in types


def test_reset_cover_preserves_approved_cover_until_replacement(
    conn: sqlite3.Connection,
) -> None:
    """Retry reset must not hide the last accepted cover letter."""
    from jobctrl.state import ensure_job_stage_rows, reset_job_stage

    url = _seed_job(conn, "https://example.com/approved-cover")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=_job_id(url),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    ).with_cover_letter(
        _make_cover_artifact(),
        validation=ValidationResult.success(),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    repo.save(materials)
    ensure_job_stage_rows(
        conn, _job_id(url), tenant_id=LOCAL_TENANT, discovered_at="2024-01-01T00:00:00+00:00"
    )

    reset_job_stage(conn, url, "cover", tenant_id=LOCAL_TENANT)

    rows = conn.execute(
        "SELECT artifact_type FROM job_materials_artifacts WHERE tenant_id = ? AND job_id = ?",
        (LOCAL_TENANT, _job_id(url)),
    ).fetchall()
    types = {row[0] for row in rows}
    assert "tailored_resume" in types
    assert "cover_letter" in types


# ---------------------------------------------------------------------------
# Round-2 review H2: apply launcher.acquire_job reads materials
# ---------------------------------------------------------------------------


def test_acquire_job_picks_up_materials_only_tailored_jobs(tmp_path) -> None:
    """``acquire_job`` must find a job whose tailored resume lives ONLY in
    ``job_materials_artifacts`` (no legacy ``jobs.tailored_resume_path``)."""
    from jobctrl.apply.launcher import acquire_job
    from jobctrl.database import close_connection, get_connection
    from jobctrl.domain.scoring import (
        FitScore,
        JobScore,
        MatchedKeywords,
        ScoreBreakdown,
    )
    from jobctrl.infrastructure.scoring import SqliteScoreRepository

    db_path = tmp_path / "apply.db"
    conn = init_db(db_path)
    try:
        url = "https://example.com/job"
        job_id = _job_id(url)
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                LOCAL_TENANT,
                job_id,
                url,
                "Engineer",
                "Acme",
                "2024-01-01T00:00:00+00:00",
            ),
        )
        conn.execute(
            "INSERT INTO job_enrichments "
            "(tenant_id, job_id, current_status, full_description, application_url, updated_at) "
            "VALUES (?, ?, 'enriched', 'desc', 'https://example.com/apply', ?)",
            (LOCAL_TENANT, job_id, "2024-01-01T00:00:00+00:00"),
        )
        conn.commit()
        # Score the job (apply requires fit_score >= min_score).
        SqliteScoreRepository(conn).save(
            JobScore.initial(
                tenant_id=LOCAL_TENANT,
                job_id=job_id,
                fit_score=FitScore.create(9),
                breakdown=ScoreBreakdown(reasoning="ok"),
                matched_keywords=MatchedKeywords.from_iterable(["python"]),
                scored_at="2024-01-02T00:00:00+00:00",
            )
        )
        # Tailor via materials (no legacy column write).
        SqliteMaterialsRepository(conn).save(
            MaterialsSetFactory.initial(
                tenant_id=LOCAL_TENANT,
                job_id=job_id,
                created_at="2024-01-01T00:00:00+00:00",
            ).with_resume_attempt(
                _make_resume_artifact("/tmp/materials-resume.txt"),
                validation=ValidationResult.success(),
                verdict=JudgeVerdict.passed(),
                updated_at="2024-01-02T00:00:00+00:00",
            ).with_resume_pdf(
                _make_resume_pdf_artifact("/tmp/materials-resume.pdf"),
                updated_at="2024-01-02T01:00:00+00:00",
            )
        )
        legacy_path = conn.execute(
            "SELECT tailored_resume_path FROM jobs WHERE tenant_id = ? AND job_id = ?",
            (LOCAL_TENANT, job_id),
        ).fetchone()[0]
        assert legacy_path is None  # confirm no legacy write happened

        # Patch the launcher's connection to point at our tmp DB.
        import jobctrl.apply.launcher as launcher_mod

        original = launcher_mod.get_connection
        launcher_mod.get_connection = lambda: get_connection(db_path)
        try:
            job = acquire_job(min_score=7, worker_id=1, approval_required=False)
            assert job is not None
            assert job["url"] == url
            assert job["tailored_resume_path"] == "/tmp/materials-resume.txt"
        finally:
            launcher_mod.get_connection = original
    finally:
        close_connection(db_path)


def test_acquire_job_excludes_materials_only_text_resume_without_pdf(tmp_path) -> None:
    from jobctrl.apply.launcher import acquire_job
    from jobctrl.database import close_connection, get_connection
    from jobctrl.domain.scoring import (
        FitScore,
        JobScore,
        MatchedKeywords,
        ScoreBreakdown,
    )
    from jobctrl.infrastructure.scoring import SqliteScoreRepository

    db_path = tmp_path / "apply.db"
    conn = init_db(db_path)
    try:
        url = "https://example.com/job"
        job_id = _job_id(url)
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                LOCAL_TENANT,
                job_id,
                url,
                "Engineer",
                "Acme",
                "2024-01-01T00:00:00+00:00",
            ),
        )
        conn.execute(
            "INSERT INTO job_enrichments "
            "(tenant_id, job_id, current_status, full_description, application_url, updated_at) "
            "VALUES (?, ?, 'enriched', 'desc', 'https://example.com/apply', ?)",
            (LOCAL_TENANT, job_id, "2024-01-01T00:00:00+00:00"),
        )
        conn.commit()
        SqliteScoreRepository(conn).save(
            JobScore.initial(
                tenant_id=LOCAL_TENANT,
                job_id=job_id,
                fit_score=FitScore.create(9),
                breakdown=ScoreBreakdown(reasoning="ok"),
                matched_keywords=MatchedKeywords.from_iterable(["python"]),
                scored_at="2024-01-02T00:00:00+00:00",
            )
        )
        SqliteMaterialsRepository(conn).save(
            MaterialsSetFactory.initial(
                tenant_id=LOCAL_TENANT,
                job_id=job_id,
                created_at="2024-01-01T00:00:00+00:00",
            ).with_resume_attempt(
                _make_resume_artifact("/tmp/materials-resume.txt"),
                validation=ValidationResult.success(),
                verdict=JudgeVerdict.passed(),
                updated_at="2024-01-02T00:00:00+00:00",
            )
        )

        import jobctrl.apply.launcher as launcher_mod

        original = launcher_mod.get_connection
        launcher_mod.get_connection = lambda: get_connection(db_path)
        try:
            assert acquire_job(min_score=7, worker_id=1) is None
        finally:
            launcher_mod.get_connection = original
    finally:
        close_connection(db_path)
