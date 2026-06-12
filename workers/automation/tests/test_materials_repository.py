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
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from jobhunter.database import (
    close_connection,
    ensure_materials_tables,
    get_connection,
    get_jobs_by_stage,
    get_stats,
    init_db,
)
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
from jobhunter.domain.materials.policy import TailoringPolicy
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.materials import (
    MaterialsGenerationConflict,
    SqliteMaterialsRepository,
    SqliteTailoringPolicyRepository,
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


def _approved_with_pdf(url: str) -> MaterialsSet:
    return _approved(url).with_resume_pdf(
        _make_artifact(
            ArtifactType.RESUME_PDF,
            path=f"/tmp/{url[-3:]}.pdf",
            render_format=RenderFormat.LATEX_PDF,
        ),
        updated_at="2024-01-02T01:00:00+00:00",
    )


def _rejected(url: str, *, generation: int = 2) -> MaterialsSet:
    return MaterialsSet(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        generation=generation,
        created_at="2024-01-03T00:00:00+00:00",
        updated_at="2024-01-03T00:00:00+00:00",
    ).with_resume_attempt(
        _make_artifact(ArtifactType.TAILORED_RESUME, path=f"/tmp/rejected-{generation}.txt"),
        validation=ValidationResult.failure(("unsupported claim",)),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-03T00:00:00+00:00",
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


def test_load_current_approved_ignores_newer_rejected_generation(
    conn: sqlite3.Connection,
) -> None:
    url = _seed_job(conn)
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved_with_pdf(url))
    repo.save(_rejected(url, generation=2))

    raw_latest = repo.load(LOCAL_TENANT, JobId(url))
    current = repo.load_current_approved(LOCAL_TENANT, JobId(url))

    assert raw_latest is not None and raw_latest.generation == 2
    assert current is not None
    assert current.generation == 1
    assert current.tailored_resume is not None
    assert current.tailored_resume.status is ArtifactStatus.APPROVED


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


def test_list_pending_tailor_excludes_score_five_by_default(conn: sqlite3.Connection) -> None:
    url_low = _seed_with_score(conn, "https://example.com/low-fit", fit_score=5)
    url_ok = _seed_with_score(conn, "https://example.com/min-fit", fit_score=6)
    repo = SqliteMaterialsRepository(conn)

    pending = repo.list_pending_tailor(LOCAL_TENANT, min_score=5)

    assert JobId(url_low) not in pending
    assert JobId(url_ok) in pending


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


def test_list_pending_tailor_excludes_prior_approved_when_latest_generation_rejected(
    conn: sqlite3.Connection,
) -> None:
    url_done = _seed_with_score(conn, "https://example.com/done-with-rejected-refresh")
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved_with_pdf(url_done))
    repo.save(_rejected(url_done, generation=2))

    pending = repo.list_pending_tailor(LOCAL_TENANT, min_score=7)

    assert JobId(url_done) not in pending


def test_list_pending_cover_returns_only_jobs_with_resume_no_cover(
    conn: sqlite3.Connection,
) -> None:
    url_resume_only = _seed_with_score(conn, "https://example.com/resume-only")
    url_text_only = _seed_with_score(conn, "https://example.com/text-only")
    url_complete = _seed_with_score(conn, "https://example.com/complete")
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved_with_pdf(url_resume_only))
    repo.save(_approved(url_text_only))
    full = _approved_with_pdf(url_complete).with_cover_letter(
        _make_artifact(ArtifactType.COVER_LETTER, path="/tmp/c.txt"),
        validation=ValidationResult.success(),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    repo.save(full)

    pending = repo.list_pending_cover(LOCAL_TENANT, min_score=7)
    assert pending == [JobId(url_resume_only)]


def test_list_pending_cover_uses_prior_approved_generation_when_latest_rejected(
    conn: sqlite3.Connection,
) -> None:
    url = _seed_with_score(conn, "https://example.com/cover-after-rejected-refresh")
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved_with_pdf(url))
    repo.save(_rejected(url, generation=2))

    pending = repo.list_pending_cover(LOCAL_TENANT, min_score=7)

    assert pending == [JobId(url)]


def test_list_pending_cover_excludes_score_five_by_default(conn: sqlite3.Connection) -> None:
    url_low = _seed_with_score(conn, "https://example.com/cover-low", fit_score=5)
    url_ok = _seed_with_score(conn, "https://example.com/cover-ok", fit_score=6)
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved_with_pdf(url_low))
    repo.save(_approved_with_pdf(url_ok))

    pending = repo.list_pending_cover(LOCAL_TENANT, min_score=5)

    assert JobId(url_low) not in pending
    assert JobId(url_ok) in pending


def test_list_pending_cover_excludes_blocked_scores(conn: sqlite3.Connection) -> None:
    url_allowed = _seed_with_score(conn, "https://example.com/cover-allowed")
    url_blocked = _seed_with_score(conn, "https://example.com/cover-blocked")
    _seed_blocked_latest_score(conn, url_blocked, fit_score=10)
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved_with_pdf(url_allowed))
    repo.save(_approved_with_pdf(url_blocked))

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


def test_suppress_active_artifacts_hides_without_deleting_history(conn: sqlite3.Connection) -> None:
    url = _seed_with_score(conn, "https://example.com/suppress")
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved_with_pdf(url))

    suppressed = repo.suppress_active_artifacts(
        LOCAL_TENANT,
        JobId(url),
        reason="threshold_raised",
        suppressed_at="2026-05-26T00:00:00+00:00",
    )

    assert suppressed is not None
    assert suppressed.tailored_resume is not None
    assert suppressed.tailored_resume.status is ArtifactStatus.SUPPRESSED
    assert suppressed.tailored_resume.metadata["suppression"]["reason"] == "threshold_raised"
    row_count = conn.execute(
        "SELECT COUNT(*) FROM job_materials_artifacts WHERE job_url = ?",
        (url,),
    ).fetchone()[0]
    assert row_count == 2
    assert repo.list_pending_tailor(LOCAL_TENANT, min_score=7) == [JobId(url)]


def test_suppress_backfilled_legacy_job_makes_selectors_treat_paths_inactive(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "legacy.db"
    conn = init_db(db_path)
    url = "https://example.com/backfilled-suppress"
    resume_path = str(tmp_path / "tailored.txt")
    cover_path = str(tmp_path / "cover.txt")
    (tmp_path / "tailored.txt").write_text("tailored", encoding="utf-8")
    (tmp_path / "cover.txt").write_text("cover", encoding="utf-8")
    conn.execute(
        "INSERT INTO jobs (url, title, full_description, fit_score, tailored_resume_path, "
        "tailored_at, cover_letter_path, cover_letter_at, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            url,
            "Engineer",
            "Description",
            9,
            resume_path,
            "2024-01-01T00:00:00+00:00",
            cover_path,
            "2024-01-01T01:00:00+00:00",
            "2024-01-01T00:00:00+00:00",
        ),
    )
    conn.execute("DROP TABLE job_materials_artifacts")
    conn.execute("DROP TABLE job_materials")
    conn.commit()
    ensure_materials_tables(conn)
    repo = SqliteMaterialsRepository(conn)

    repo.suppress_active_artifacts(
        LOCAL_TENANT,
        JobId(url),
        reason="threshold_raised",
        suppressed_at="2026-05-26T00:00:00+00:00",
    )

    stats = get_stats(conn)
    assert stats["tailored"] == 0
    assert stats["with_cover_letter"] == 0
    assert stats["untailored_eligible"] == 1
    pending_tailor = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7, limit=0)
    assert [row["url"] for row in pending_tailor] == [url]
    assert pending_tailor[0]["tailored_resume_path"] is None
    assert pending_tailor[0]["cover_letter_path"] is None
    tailored = get_jobs_by_stage(conn=conn, stage="tailored")
    assert url not in {row["url"] for row in tailored}


# ---------------------------------------------------------------------------
# Tailoring policy persistence
# ---------------------------------------------------------------------------


def _policy(*, fingerprint: str = "sha256:a", version: int = 1) -> TailoringPolicy:
    return TailoringPolicy(
        tenant_id=LOCAL_TENANT,
        version=version,
        prompt_version="tailor.v2.quality-gated",
        schema_version="tailored-resume.v1",
        judge_schema_version="tailor-judge.v1",
        prompt_fingerprint=fingerprint,
        config_fingerprint=fingerprint,
        profile_policy_fingerprint="sha256:profile",
        custom_prompt_fingerprint="sha256:custom",
        generator_settings={"candidate_models": ["local:draft"]},
        judge_settings={"judge_model": "local:judge", "min_score": 0.82},
        runtime_settings={"validation_mode": "normal"},
        created_at="2026-05-26T00:00:00+00:00",
    )


def test_tailoring_policy_repository_reuses_same_config(conn: sqlite3.Connection) -> None:
    repo = SqliteTailoringPolicyRepository(conn)

    first = repo.resolve_current(_policy(fingerprint="sha256:same"))
    second = repo.resolve_current(_policy(fingerprint="sha256:same"))

    assert first.version == 1
    assert second.version == 1
    assert repo.get_current(LOCAL_TENANT) == first
    count = conn.execute("SELECT COUNT(*) FROM tailoring_policies").fetchone()[0]
    assert count == 1


def test_tailoring_policy_repository_versions_changed_config(conn: sqlite3.Connection) -> None:
    repo = SqliteTailoringPolicyRepository(conn)

    first = repo.resolve_current(_policy(fingerprint="sha256:old"))
    second = repo.resolve_current(_policy(fingerprint="sha256:new"))

    assert first.version == 1
    assert second.version == 2
    assert second.config_fingerprint == "sha256:new"


@pytest.mark.parametrize(
    ("seed_fingerprint", "expected_version", "expected_count"),
    [
        (None, 1, 1),
        ("sha256:old", 2, 2),
    ],
)
def test_tailoring_policy_repository_resolves_current_concurrently(
    tmp_path: Path,
    seed_fingerprint: str | None,
    expected_version: int,
    expected_count: int,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    setup_conn = init_db(db_path)
    if seed_fingerprint is not None:
        SqliteTailoringPolicyRepository(setup_conn).resolve_current(
            _policy(fingerprint=seed_fingerprint)
        )
    close_connection(db_path)
    start = threading.Event()

    def resolve() -> TailoringPolicy:
        conn = get_connection(db_path)
        try:
            repo = SqliteTailoringPolicyRepository(conn)
            start.wait(timeout=5)
            return repo.resolve_current(_policy(fingerprint="sha256:parallel"))
        finally:
            close_connection(db_path)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(resolve) for _ in range(2)]
        start.set()
        policies = [future.result(timeout=10) for future in futures]

    assert [policy.version for policy in policies] == [expected_version, expected_version]
    check_conn = get_connection(db_path)
    try:
        count = check_conn.execute("SELECT COUNT(*) FROM tailoring_policies").fetchone()[0]
        assert count == expected_count
    finally:
        close_connection(db_path)


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
