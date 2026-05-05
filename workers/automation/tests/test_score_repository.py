"""Phase 5 / S-16: SqliteScoreRepository round-trip + backfill + version conflict.

Each test runs against a tmp SQLite database via the public ``init_db``
helper so the schema (including ``ensure_score_tables`` + backfill) is
exercised end-to-end. The legacy ``jobs.fit_score`` columns are written
directly by these tests to seed the backfill path.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from jobhunter.database import ensure_score_tables, init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.scoring import (
    FitScore,
    JobScore,
    MatchedKeywords,
    ScoreBreakdown,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.scoring import SqliteScoreRepository
from jobhunter.infrastructure.scoring.sqlite_repository import ScoreVersionConflict


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    db_path = tmp_path / "jobhunter.db"
    return init_db(db_path)


def _seed_job(conn: sqlite3.Connection, url: str = "https://example.com/job/1") -> str:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, discovered_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (url, "Engineer", "Acme", "Description body", datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    return url


def _build_score(url: str, version: int = 1, fit: int = 7) -> JobScore:
    return JobScore(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        version=version,
        fit_score=FitScore.create(fit),
        breakdown=ScoreBreakdown(technical_fit=8, experience_fit=6, role_fit=7, reasoning="ok"),
        matched_keywords=MatchedKeywords.from_iterable(["python", "fastapi"]),
        scored_at=datetime.now(timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


def test_save_and_load_round_trips(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(url))

    loaded = repo.load(LOCAL_TENANT, JobId(url))
    assert loaded is not None
    assert loaded.fit_score.value == 7
    assert loaded.matched_keywords.values == ("python", "fastapi")
    assert loaded.breakdown.technical_fit == 8


def test_load_returns_none_when_no_score(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    repo = SqliteScoreRepository(conn)
    assert repo.load(LOCAL_TENANT, JobId(url)) is None


# ---------------------------------------------------------------------------
# Versioning
# ---------------------------------------------------------------------------


def test_save_increments_version(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(url, version=1, fit=7))
    repo.save(_build_score(url, version=2, fit=9))

    latest = repo.load(LOCAL_TENANT, JobId(url))
    assert latest is not None
    assert latest.version == 2
    assert latest.fit_score.value == 9


def test_save_rejects_version_skip(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(url, version=1, fit=7))
    with pytest.raises(ScoreVersionConflict) as excinfo:
        repo.save(_build_score(url, version=3, fit=8))
    assert excinfo.value.expected == 2


def test_save_rejects_replay_of_existing_version(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(url, version=1, fit=7))
    with pytest.raises(ScoreVersionConflict):
        repo.save(_build_score(url, version=1, fit=8))


# ---------------------------------------------------------------------------
# List queries
# ---------------------------------------------------------------------------


def test_list_pending_returns_jobs_without_score(conn: sqlite3.Connection) -> None:
    url_scored = _seed_job(conn, url="https://example.com/job/scored")
    url_pending = _seed_job(conn, url="https://example.com/job/pending")
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(url_scored))

    pending = repo.list_pending(LOCAL_TENANT)
    assert pending == [JobId(url_pending)]


def test_list_pending_respects_limit(conn: sqlite3.Connection) -> None:
    for n in range(3):
        _seed_job(conn, url=f"https://example.com/job/{n}")
    repo = SqliteScoreRepository(conn)
    assert len(repo.list_pending(LOCAL_TENANT, limit=2)) == 2


def test_list_by_score_range_returns_only_latest_version_in_range(
    conn: sqlite3.Connection,
) -> None:
    url_a = _seed_job(conn, url="https://example.com/job/a")
    url_b = _seed_job(conn, url="https://example.com/job/b")
    url_c = _seed_job(conn, url="https://example.com/job/c")

    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(url_a, version=1, fit=4))
    repo.save(_build_score(url_a, version=2, fit=8))  # latest in range
    repo.save(_build_score(url_b, version=1, fit=6))  # in range
    repo.save(_build_score(url_c, version=1, fit=2))  # out of range

    matches = repo.list_by_score_range(LOCAL_TENANT, min_score=5, max_score=10)
    keys = sorted(int(score.fit_score.value) for score in matches)
    # Only the latest A version (8) and B (6) appear.
    assert keys == [6, 8]


def test_list_by_score_range_validates_inputs(conn: sqlite3.Connection) -> None:
    repo = SqliteScoreRepository(conn)
    with pytest.raises(ValueError):
        repo.list_by_score_range(LOCAL_TENANT, min_score=0)
    with pytest.raises(ValueError):
        repo.list_by_score_range(LOCAL_TENANT, min_score=8, max_score=4)


# ---------------------------------------------------------------------------
# Backfill
# ---------------------------------------------------------------------------


def test_backfill_copies_legacy_columns_into_job_scores(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy.db"
    conn = init_db(db_path)
    conn.execute(
        "INSERT INTO jobs (url, title, fit_score, score_reasoning, scored_at) "
        "VALUES (?, ?, ?, ?, ?)",
        ("https://example.com/legacy", "Engineer", 8, "Strong overlap", "2023-12-01T00:00:00+00:00"),
    )
    # Drop the existing table so the backfill is forced to fire again on
    # the seeded legacy row (init_db ran the migration before our INSERT).
    conn.execute("DROP TABLE job_scores")
    conn.commit()
    ensure_score_tables(conn)

    repo = SqliteScoreRepository(conn)
    loaded = repo.load(LOCAL_TENANT, JobId("https://example.com/legacy"))
    assert loaded is not None
    assert loaded.version == 1
    assert loaded.fit_score.value == 8
    assert "Strong overlap" in loaded.breakdown.reasoning


def test_backfill_is_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy.db"
    conn = init_db(db_path)
    conn.execute(
        "INSERT INTO jobs (url, fit_score, scored_at) VALUES (?, ?, ?)",
        ("https://example.com/legacy", 8, "2023-12-01T00:00:00+00:00"),
    )
    conn.execute("DROP TABLE job_scores")
    conn.commit()
    ensure_score_tables(conn)
    # Running again must not duplicate rows.
    ensure_score_tables(conn)

    count = conn.execute(
        "SELECT COUNT(*) FROM job_scores WHERE job_url = ?",
        ("https://example.com/legacy",),
    ).fetchone()[0]
    assert count == 1


def test_backfill_skips_invalid_legacy_scores(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy.db"
    conn = init_db(db_path)
    conn.execute(
        "INSERT INTO jobs (url, fit_score) VALUES (?, ?)",
        ("https://example.com/bogus", 0),
    )
    conn.execute("DROP TABLE job_scores")
    conn.commit()
    ensure_score_tables(conn)

    count = conn.execute("SELECT COUNT(*) FROM job_scores").fetchone()[0]
    assert count == 0
