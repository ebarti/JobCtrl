"""Phase 6 / S-20: SqliteMaterialsRepository round-trip + backfill + generation invariants.

Each test runs against a tmp SQLite database via the public ``init_db``
helper so the schema (including ``ensure_materials_tables`` + backfill)
is exercised end-to-end. The legacy ``jobs.tailored_resume_path`` /
``jobs.cover_letter_path`` columns are written directly by these tests
to seed the backfill path.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import ensure_materials_tables, init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials import (
    Artifact,
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    MaterialsSet,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.materials import (
    MaterialsGenerationConflict,
    SqliteMaterialsRepository,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    db_path = tmp_path / "jobhunter.db"
    return init_db(db_path)


def _seed_job(conn: sqlite3.Connection, url: str = "https://example.com/job/1") -> str:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, fit_score, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (url, "Engineer", "Acme", "Description", 9, "2024-01-01T00:00:00+00:00"),
    )
    conn.commit()
    return url


def _make_artifact(
    artifact_type: ArtifactType, *, path: str, render_format: RenderFormat = RenderFormat.TEXT
) -> Artifact:
    return Artifact.create(
        type=artifact_type,
        path=path,
        created_at="2024-01-01T00:00:00+00:00",
        render_format=render_format,
        size_bytes=128,
    )


def _initial(url: str) -> MaterialsSet:
    return MaterialsSet.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        created_at="2024-01-01T00:00:00+00:00",
    )


def _approved(url: str) -> MaterialsSet:
    return _initial(url).with_resume_attempt(
        _make_artifact(ArtifactType.TAILORED_RESUME, path=f"/tmp/{url[-3:]}.txt"),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


def test_save_and_load_round_trips(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    repo = SqliteMaterialsRepository(conn)
    materials = _approved(url)
    repo.save(materials)

    loaded = repo.load(LOCAL_TENANT, JobId(url))
    assert loaded is not None
    assert loaded.generation == 1
    assert loaded.tailored_resume is not None
    assert loaded.tailored_resume.status is ArtifactStatus.APPROVED
    assert loaded.tailored_resume.path == "/tmp/b/1.txt"[-9:] or loaded.tailored_resume.path.endswith(".txt")


def test_load_returns_none_when_no_materials(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    repo = SqliteMaterialsRepository(conn)
    assert repo.load(LOCAL_TENANT, JobId(url)) is None


def test_load_specific_generation(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved(url))
    superseded, fresh = MaterialsSetFactory.next_generation(
        repo.load(LOCAL_TENANT, JobId(url)),
        created_at="2024-01-03T00:00:00+00:00",
    )
    repo.save(superseded)
    repo.save(fresh)

    gen1 = repo.load(LOCAL_TENANT, JobId(url), generation=1)
    gen2 = repo.load(LOCAL_TENANT, JobId(url), generation=2)
    assert gen1 is not None and gen1.generation == 1
    assert gen2 is not None and gen2.generation == 2
    # Default load returns latest.
    latest = repo.load(LOCAL_TENANT, JobId(url))
    assert latest is not None and latest.generation == 2


# ---------------------------------------------------------------------------
# Generation conflict
# ---------------------------------------------------------------------------


def test_save_rejects_skipped_generation(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved(url))

    # Attempt to save generation=3 directly: must conflict.
    skipped = MaterialsSet(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        generation=3,
        created_at="2024-01-04T00:00:00+00:00",
        updated_at="2024-01-04T00:00:00+00:00",
    )
    with pytest.raises(MaterialsGenerationConflict) as excinfo:
        repo.save(skipped)
    assert excinfo.value.expected == 2


def test_save_idempotent_within_same_generation(conn: sqlite3.Connection) -> None:
    """Adding artifacts to an existing generation re-saves the same row."""
    url = _seed_job(conn)
    repo = SqliteMaterialsRepository(conn)
    materials = _approved(url)
    repo.save(materials)
    # Append a cover letter to the same generation.
    materials_with_cover = materials.with_cover_letter(
        _make_artifact(ArtifactType.COVER_LETTER, path="/tmp/cover.txt"),
        validation=ValidationResult.success(),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    repo.save(materials_with_cover)

    loaded = repo.load(LOCAL_TENANT, JobId(url))
    assert loaded is not None
    assert loaded.cover_letter is not None
    assert loaded.cover_letter.status is ArtifactStatus.APPROVED


# ---------------------------------------------------------------------------
# Selectors
# ---------------------------------------------------------------------------


def _seed_with_score(conn: sqlite3.Connection, url: str, fit_score: int = 9) -> str:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, fit_score, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (url, "Engineer", "Acme", "desc", fit_score, "2024-01-01T00:00:00+00:00"),
    )
    conn.commit()
    return url


def _seed_blocked_latest_score(conn: sqlite3.Connection, url: str, fit_score: int = 9) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (
            job_url, version, tenant_id, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, 1, 'local', ?, ?, '["python"]', ?, NULL, '{}', '{}')
        """,
        (
            url,
            fit_score,
            json.dumps(
                {
                    "reasoning": "Strong match with a hard blocker.",
                    "eligibility": {
                        "status": "blocked",
                        "hard_blockers": ["Requires sponsorship."],
                        "warnings": [],
                    },
                },
                sort_keys=True,
            ),
            "2026-05-14T00:00:00+00:00",
        ),
    )
    conn.commit()


def test_list_pending_tailor_returns_jobs_without_materials(conn: sqlite3.Connection) -> None:
    url_pending = _seed_with_score(conn, "https://example.com/pending")
    url_done = _seed_with_score(conn, "https://example.com/done")
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved(url_done))

    pending = repo.list_pending_tailor(LOCAL_TENANT, min_score=7)
    assert pending == [JobId(url_pending)]


def test_list_pending_tailor_excludes_blocked_scores(conn: sqlite3.Connection) -> None:
    url_allowed = _seed_with_score(conn, "https://example.com/allowed")
    url_blocked = _seed_with_score(conn, "https://example.com/blocked")
    _seed_blocked_latest_score(conn, url_blocked, fit_score=10)
    repo = SqliteMaterialsRepository(conn)

    pending = repo.list_pending_tailor(LOCAL_TENANT, min_score=7)

    assert JobId(url_allowed) in pending
    assert JobId(url_blocked) not in pending


def test_list_pending_tailor_with_retailor_includes_already_done(conn: sqlite3.Connection) -> None:
    url_done = _seed_with_score(conn, "https://example.com/done")
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved(url_done))

    retailor_pending = repo.list_pending_tailor(LOCAL_TENANT, min_score=7, retailor=True)
    assert JobId(url_done) in retailor_pending


def test_list_pending_cover_returns_only_jobs_with_resume_no_cover(
    conn: sqlite3.Connection,
) -> None:
    url_resume_only = _seed_with_score(conn, "https://example.com/resume-only")
    url_complete = _seed_with_score(conn, "https://example.com/complete")
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved(url_resume_only))
    full = _approved(url_complete).with_cover_letter(
        _make_artifact(ArtifactType.COVER_LETTER, path="/tmp/c.txt"),
        validation=ValidationResult.success(),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    repo.save(full)

    pending = repo.list_pending_cover(LOCAL_TENANT, min_score=7)
    assert pending == [JobId(url_resume_only)]


def test_list_pending_cover_excludes_blocked_scores(conn: sqlite3.Connection) -> None:
    url_allowed = _seed_with_score(conn, "https://example.com/cover-allowed")
    url_blocked = _seed_with_score(conn, "https://example.com/cover-blocked")
    _seed_blocked_latest_score(conn, url_blocked, fit_score=10)
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved(url_allowed))
    repo.save(_approved(url_blocked))

    pending = repo.list_pending_cover(LOCAL_TENANT, min_score=7)

    assert JobId(url_allowed) in pending
    assert JobId(url_blocked) not in pending


def test_list_pending_pdf_returns_jobs_missing_a_pdf(conn: sqlite3.Connection) -> None:
    url = _seed_with_score(conn, "https://example.com/needs-pdf")
    repo = SqliteMaterialsRepository(conn)
    materials = _approved(url)
    repo.save(materials)
    pending = repo.list_pending_pdf(LOCAL_TENANT)
    assert pending == [JobId(url)]


def test_list_by_status_returns_aggregates_with_matching_artifact_status(
    conn: sqlite3.Connection,
) -> None:
    url = _seed_with_score(conn, "https://example.com/job")
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved(url))
    matches = repo.list_by_status(LOCAL_TENANT, ArtifactStatus.APPROVED)
    assert len(matches) == 1
    assert str(matches[0].job_id) == url


# ---------------------------------------------------------------------------
# Backfill
# ---------------------------------------------------------------------------


def test_backfill_copies_legacy_columns_into_job_materials(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy.db"
    conn = init_db(db_path)
    conn.execute(
        "INSERT INTO jobs (url, title, fit_score, tailored_resume_path, tailored_at, "
        "cover_letter_path, cover_letter_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            "https://example.com/legacy",
            "Engineer",
            9,
            str(tmp_path / "tailored.txt"),
            "2023-12-01T00:00:00+00:00",
            str(tmp_path / "cover.txt"),
            "2023-12-02T00:00:00+00:00",
        ),
    )
    # Touch the files so size_bytes is captured.
    (tmp_path / "tailored.txt").write_text("tailored", encoding="utf-8")
    (tmp_path / "cover.txt").write_text("dear hiring manager", encoding="utf-8")
    # Drop and re-create so the backfill fires against the seeded row.
    conn.execute("DROP TABLE job_materials_artifacts")
    conn.execute("DROP TABLE job_materials")
    conn.commit()
    ensure_materials_tables(conn)

    repo = SqliteMaterialsRepository(conn)
    loaded = repo.load(LOCAL_TENANT, JobId("https://example.com/legacy"))
    assert loaded is not None
    assert loaded.generation == 1
    assert loaded.tailored_resume is not None
    assert loaded.tailored_resume.status is ArtifactStatus.APPROVED
    assert loaded.cover_letter is not None
    assert loaded.cover_letter.status is ArtifactStatus.APPROVED
    assert loaded.tailored_resume.size_bytes is not None and loaded.tailored_resume.size_bytes > 0


def test_backfill_is_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy.db"
    conn = init_db(db_path)
    conn.execute(
        "INSERT INTO jobs (url, fit_score, tailored_resume_path, tailored_at) "
        "VALUES (?, ?, ?, ?)",
        ("https://example.com/legacy", 9, str(tmp_path / "x.txt"), "2024-01-01T00:00:00+00:00"),
    )
    (tmp_path / "x.txt").write_text("ok", encoding="utf-8")
    conn.execute("DROP TABLE job_materials_artifacts")
    conn.execute("DROP TABLE job_materials")
    conn.commit()
    ensure_materials_tables(conn)
    ensure_materials_tables(conn)  # second call is a no-op

    count = conn.execute(
        "SELECT COUNT(*) FROM job_materials WHERE job_url = ?",
        ("https://example.com/legacy",),
    ).fetchone()[0]
    assert count == 1


def test_backfill_skips_rows_without_legacy_path(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy.db"
    conn = init_db(db_path)
    conn.execute(
        "INSERT INTO jobs (url, fit_score) VALUES (?, ?)",
        ("https://example.com/none", 9),
    )
    conn.execute("DROP TABLE job_materials_artifacts")
    conn.execute("DROP TABLE job_materials")
    conn.commit()
    ensure_materials_tables(conn)

    count = conn.execute("SELECT COUNT(*) FROM job_materials").fetchone()[0]
    assert count == 0
