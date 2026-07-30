"""Phase 6 / S-20: queue selectors must read through the materials join.

Mirrors the Phase 5 ``test_score_queue_selectors`` pattern: after the
:class:`SqliteMaterialsRepository` saves a MaterialsSet, the
``get_jobs_by_stage`` selectors (which back the worker queues +
``pipeline.apply_jobs``) must reflect the new materials immediately —
the legacy ``jobs.tailored_resume_path`` / ``jobs.cover_letter_path``
columns stay empty on the new write path, so the LEFT JOIN is what
keeps the pipeline observable.
"""

from __future__ import annotations

import sqlite3
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


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jh.db")


def _seed_job(conn: sqlite3.Connection, url: str, fit_score: int = 9) -> str:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, fit_score, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (url, "Engineer", "Acme", "desc", fit_score, "2024-01-01T00:00:00+00:00"),
    )
    conn.commit()
    return url


def _stable_job_id(conn: sqlite3.Connection, url: str) -> str:
    row = conn.execute(
        "SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?",
        (url,),
    ).fetchone()
    assert row is not None
    return str(row[0])


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
    url_pending = _seed_job(conn, "https://example.com/pending")
    url_done = _seed_job(conn, "https://example.com/done")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url_done),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(materials)

    rows = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7, limit=0)
    urls = {row["url"] for row in rows}
    assert url_pending in urls
    assert url_done not in urls


def test_pending_tailor_with_retailor_includes_done_jobs(conn: sqlite3.Connection) -> None:
    url_done = _seed_job(conn, "https://example.com/done")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url_done),
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
    assert url_done in {row["url"] for row in rows}


def test_pending_tailor_promotes_jm_path_into_legacy_dict_slot(
    conn: sqlite3.Connection,
) -> None:
    """The dict surfaced to legacy callers carries the joined materials path
    in the ``tailored_resume_path`` slot so untouched consumers (apply
    launcher) keep working."""
    url = _seed_job(conn, "https://example.com/done")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
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
        row["url"] == url and row.get("tailored_resume_path") == "/tmp/specific-path.txt"
        for row in rows
    )


# ---------------------------------------------------------------------------
# pending_cover
# ---------------------------------------------------------------------------


def test_pending_cover_returns_only_jobs_with_resume_no_cover(
    conn: sqlite3.Connection,
) -> None:
    url_resume = _seed_job(conn, "https://example.com/resume-only")
    url_text_only = _seed_job(conn, "https://example.com/text-only")
    url_full = _seed_job(conn, "https://example.com/full")
    repo = SqliteMaterialsRepository(conn)
    base = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url_resume),
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
        job_id=JobId(url_text_only),
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
        job_id=JobId(url_full),
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
    urls = {row["url"] for row in rows}
    assert url_resume in urls
    assert url_text_only not in urls
    assert url_full not in urls


# ---------------------------------------------------------------------------
# pending_pdf
# ---------------------------------------------------------------------------


def test_pending_pdf_includes_jobs_with_text_but_missing_pdf(
    conn: sqlite3.Connection,
) -> None:
    url = _seed_job(conn, "https://example.com/needs-pdf")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(materials)

    rows = get_jobs_by_stage(conn=conn, stage="pending_pdf", limit=0)
    assert url in {row["url"] for row in rows}


# ---------------------------------------------------------------------------
# Round-2 review B2: get_stats reads through the materials join
# ---------------------------------------------------------------------------


def test_get_stats_tailored_count_reflects_materials_writes(conn: sqlite3.Connection) -> None:
    """``stats['tailored']`` must reflect a freshly-saved MaterialsSet
    even though new code never writes ``jobs.tailored_resume_path``."""
    url = _seed_job(conn, "https://example.com/job")
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
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
    # Legacy column stays NULL on the new path.
    legacy_count = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE tailored_resume_path IS NOT NULL"
    ).fetchone()[0]
    assert legacy_count == 0


def test_get_stats_with_cover_letter_count_reflects_materials_writes(
    conn: sqlite3.Connection,
) -> None:
    url = _seed_job(conn, "https://example.com/job")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
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
    url = _seed_job(conn, "https://example.com/job")
    conn.execute(
        "UPDATE jobs SET application_url = 'https://example.com/apply' WHERE url = ?",
        (url,),
    )
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
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
    url = _seed_job(conn, "https://example.com/text-only")
    conn.execute(
        "UPDATE jobs SET application_url = 'https://example.com/apply' WHERE url = ?",
        (url,),
    )
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
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

    url_text_only = _seed_job(conn, "https://example.com/text-only")
    url_with_pdf = _seed_job(conn, "https://example.com/with-pdf")
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url_text_only),
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
            job_id=JobId(url_with_pdf),
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
    url_tailored = _seed_job(conn, "https://example.com/tailored")
    url_pending = _seed_job(conn, "https://example.com/pending")
    repo = SqliteMaterialsRepository(conn)
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url_tailored),
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact(),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
    )
    # Need a score row so the score-side filter is satisfied for both jobs.
    from jobctrl.domain.scoring import (
        FitScore,
        JobScore,
        MatchedKeywords,
        ScoreBreakdown,
    )
    from jobctrl.infrastructure.scoring import SqliteScoreRepository

    score_repo = SqliteScoreRepository(conn)
    for url in (url_tailored, url_pending):
        score_repo.save(
            JobScore.initial(
                tenant_id=LOCAL_TENANT,
                job_id=JobId(url),
                fit_score=FitScore.create(9),
                breakdown=ScoreBreakdown(reasoning="ok"),
                matched_keywords=MatchedKeywords.from_iterable(["python"]),
                scored_at="2024-01-02T00:00:00+00:00",
            )
        )

    stats = get_stats(conn)
    assert stats["untailored_eligible"] == 1


def test_get_stats_tailor_exhausted_reads_stage_state(conn: sqlite3.Connection) -> None:
    """``tailor_exhausted`` honours the new ``job_stage_states.state``."""
    url = _seed_job(conn, "https://example.com/job")
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    ensure_job_stage_rows(conn, url, discovered_at="2024-01-01T00:00:00+00:00")
    # Walk the state machine: pending → running → failed → exhausted.
    set_stage_state(conn, url, "tailor", "running", started_at="2024-01-02T00:00:00+00:00")
    set_stage_state(conn, url, "tailor", "failed", attempt_count=4)
    set_stage_state(
        conn,
        url,
        "tailor",
        "exhausted",
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
    url = _seed_job(conn, "https://example.com/exhausted")
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    ensure_job_stage_rows(conn, url, discovered_at="2024-01-01T00:00:00+00:00")
    # Walk the state machine: pending → running → failed → exhausted.
    set_stage_state(conn, url, "tailor", "running", started_at="2024-01-02T00:00:00+00:00")
    set_stage_state(conn, url, "tailor", "failed", attempt_count=4)
    set_stage_state(
        conn,
        url,
        "tailor",
        "exhausted",
        attempt_count=5,
        max_attempts=5,
        finished_at="2024-01-02T00:00:00+00:00",
    )
    rows = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7, limit=0)
    assert url not in {row["url"] for row in rows}


def test_pending_tailor_excludes_jobs_with_high_attempt_count(
    conn: sqlite3.Connection,
) -> None:
    """A job whose ``job_stage_states.attempt_count >= 5`` for tailor
    must NOT appear in pending_tailor — even when ``state`` isn't yet
    'exhausted'."""
    url = _seed_job(conn, "https://example.com/many-attempts")
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    ensure_job_stage_rows(conn, url, discovered_at="2024-01-01T00:00:00+00:00")
    set_stage_state(conn, url, "tailor", "running", started_at="2024-01-02T00:00:00+00:00")
    set_stage_state(
        conn,
        url,
        "tailor",
        "failed",
        attempt_count=5,
        max_attempts=5,
        finished_at="2024-01-02T00:00:00+00:00",
    )
    rows = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7, limit=0)
    assert url not in {row["url"] for row in rows}


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
            job_id=JobId(url),
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact(),
            validation=ValidationResult.failure(("unsupported claim",)),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
    )
    ensure_job_stage_rows(conn, url, discovered_at="2024-01-01T00:00:00+00:00")

    reset_job_stage(conn, url, "tailor")

    pending_after = {row["url"] for row in get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)}
    assert url in pending_after

    # Materials artifacts for the latest generation must be gone.
    artifact_count = conn.execute(
        """
        SELECT COUNT(*) FROM job_materials_artifacts
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (_stable_job_id(conn, url),),
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
            job_id=JobId(url),
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            _make_resume_artifact(),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
    )
    ensure_job_stage_rows(conn, url, discovered_at="2024-01-01T00:00:00+00:00")

    reset_job_stage(conn, url, "tailor")

    pending_after = {row["url"] for row in get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)}
    assert url not in pending_after
    artifact_count = conn.execute(
        """
        SELECT COUNT(*) FROM job_materials_artifacts
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (_stable_job_id(conn, url),),
    ).fetchone()[0]
    assert artifact_count == 1


def test_reset_cover_clears_only_failed_cover_artifacts(conn: sqlite3.Connection) -> None:
    """``reset_job_stage(stage='cover')`` keeps the approved tailored resume."""
    from jobctrl.state import ensure_job_stage_rows, reset_job_stage

    url = _seed_job(conn, "https://example.com/job")
    repo = SqliteMaterialsRepository(conn)
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
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
    ensure_job_stage_rows(conn, url, discovered_at="2024-01-01T00:00:00+00:00")

    reset_job_stage(conn, url, "cover")

    rows = conn.execute(
        """
        SELECT artifact_type FROM job_materials_artifacts
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (_stable_job_id(conn, url),),
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
        job_id=JobId(url),
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
    ensure_job_stage_rows(conn, url, discovered_at="2024-01-01T00:00:00+00:00")

    reset_job_stage(conn, url, "cover")

    rows = conn.execute(
        """
        SELECT artifact_type FROM job_materials_artifacts
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (_stable_job_id(conn, url),),
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
        conn.execute(
            "INSERT INTO jobs (url, title, site, application_url, "
            "full_description, discovered_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                url,
                "Engineer",
                "Acme",
                "https://example.com/apply",
                "desc",
                "2024-01-01T00:00:00+00:00",
            ),
        )
        conn.commit()
        # Score the job (apply requires fit_score >= min_score).
        SqliteScoreRepository(conn).save(
            JobScore.initial(
                tenant_id=LOCAL_TENANT,
                job_id=JobId(url),
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
                job_id=JobId(url),
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
            "SELECT tailored_resume_path FROM jobs WHERE url = ?", (url,)
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
        conn.execute(
            "INSERT INTO jobs (url, title, site, application_url, "
            "full_description, discovered_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                url,
                "Engineer",
                "Acme",
                "https://example.com/apply",
                "desc",
                "2024-01-01T00:00:00+00:00",
            ),
        )
        conn.commit()
        SqliteScoreRepository(conn).save(
            JobScore.initial(
                tenant_id=LOCAL_TENANT,
                job_id=JobId(url),
                fit_score=FitScore.create(9),
                breakdown=ScoreBreakdown(reasoning="ok"),
                matched_keywords=MatchedKeywords.from_iterable(["python"]),
                scored_at="2024-01-02T00:00:00+00:00",
            )
        )
        SqliteMaterialsRepository(conn).save(
            MaterialsSetFactory.initial(
                tenant_id=LOCAL_TENANT,
                job_id=JobId(url),
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
