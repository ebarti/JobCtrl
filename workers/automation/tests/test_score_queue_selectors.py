"""Round-1 review B1 + B2 regression: worker queue selectors and stats
must read the canonical fit score from ``job_scores`` (the new write
target) and not from the legacy ``jobs.fit_score`` column (which is left
NULL on the new path).

Without these fixes:

  * ``run_scoring`` re-picks the same job forever — every invocation
    bumps the version because ``pending_score`` keeps matching.
  * ``pending_tailor`` / ``pending_cover`` are starved — newly-scored
    jobs never appear because the predicate filters on bare
    ``jobs.fit_score``.
  * ``get_stats`` reports stale ``scored`` / ``unscored`` /
    ``score_distribution`` / ``untailored_eligible`` counts — dashboard
    funnel goes wrong.

Each test seeds a job, scores it through ``ScoreRepository.save`` (so the
legacy column stays NULL), and asserts the selector / stat reflects the
new score.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from jobhunter.database import (
    get_jobs_by_stage,
    get_stats,
    init_db,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.scoring import (
    FitScore,
    JobScore,
    MatchedKeywords,
    ScoreBreakdown,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.scoring import SqliteScoreRepository


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


def _seed_enriched_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, discovered_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (url, "Engineer", "Acme", "Need Python.", "2024-01-01T00:00:00+00:00"),
    )
    conn.commit()


def _save_score(conn: sqlite3.Connection, url: str, fit: int = 8) -> None:
    """Save a JobScore through the new repository — leaves jobs.fit_score NULL."""
    repo = SqliteScoreRepository(conn)
    repo.save(
        JobScore.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            fit_score=FitScore.create(fit),
            breakdown=ScoreBreakdown(reasoning="ok"),
            matched_keywords=MatchedKeywords.from_iterable(["python"]),
            scored_at=datetime.now(timezone.utc).isoformat(),
        )
    )


# ---------------------------------------------------------------------------
# B1 — get_jobs_by_stage selectors
# ---------------------------------------------------------------------------


def test_pending_score_excludes_jobs_already_in_job_scores(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/scored"
    _seed_enriched_job(conn, url)

    # Pre-condition: the job is pending_score.
    pending_before = get_jobs_by_stage(conn=conn, stage="pending_score")
    assert {row["url"] for row in pending_before} == {url}

    # Action: persist a score through the new repository.
    _save_score(conn, url, fit=8)

    # Post-condition: the job is no longer pending_score.
    pending_after = get_jobs_by_stage(conn=conn, stage="pending_score")
    assert pending_after == []

    # And the legacy column is still NULL — proves the selector is
    # reading the canonical job_scores row, not jobs.fit_score.
    legacy = conn.execute("SELECT fit_score FROM jobs WHERE url=?", (url,)).fetchone()
    assert legacy["fit_score"] is None


def test_pending_tailor_includes_jobs_scored_through_repository(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/ready-to-tailor"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=8)

    # The new selector must find the job under pending_tailor even though
    # jobs.fit_score is NULL — the COALESCE picks up the canonical
    # job_scores row.
    pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)
    urls = {row["url"] for row in pending}
    assert url in urls


def test_pending_cover_includes_jobs_scored_through_repository(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/ready-to-cover"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=9)
    # Cover stage requires a tailored resume.
    conn.execute(
        "UPDATE jobs SET tailored_resume_path=?, tailored_at=? WHERE url=?",
        ("/tmp/tailored.txt", "2024-01-02T00:00:00+00:00", url),
    )
    conn.commit()

    pending = get_jobs_by_stage(conn=conn, stage="pending_cover", min_score=7)
    urls = {row["url"] for row in pending}
    assert url in urls


def test_get_jobs_by_stage_returns_canonical_score_in_dict(
    conn: sqlite3.Connection,
) -> None:
    """Returned dicts surface the canonical fit_score so legacy callers
    that read ``job["fit_score"]`` see the new value (not NULL)."""
    url = "https://example.com/job/dict"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=6)

    rows = get_jobs_by_stage(conn=conn, stage="enriched")
    matching = next(row for row in rows if row["url"] == url)
    assert matching["fit_score"] == 6


# ---------------------------------------------------------------------------
# B2 — get_stats counts
# ---------------------------------------------------------------------------


def test_get_stats_counts_repository_scores(conn: sqlite3.Connection) -> None:
    url_scored = "https://example.com/job/has-score"
    url_pending = "https://example.com/job/no-score"
    _seed_enriched_job(conn, url_scored)
    _seed_enriched_job(conn, url_pending)
    _save_score(conn, url_scored, fit=8)

    stats = get_stats(conn)
    assert stats["scored"] == 1
    assert stats["unscored"] == 1
    # Score distribution — canonical row shows up at fit_score=8.
    distribution = dict(stats["score_distribution"])
    assert distribution.get(8) == 1


def test_get_stats_untailored_eligible_uses_canonical_score(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/eligible"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=9)

    stats = get_stats(conn)
    # Eligible = score >= 7, has description, no tailored resume.
    assert stats["untailored_eligible"] == 1


def test_get_stats_falls_back_to_legacy_column(conn: sqlite3.Connection) -> None:
    """Pre-Phase-5 rows that only exist in ``jobs.fit_score`` should
    still be counted (the COALESCE picks them up)."""
    url = "https://example.com/job/legacy"
    _seed_enriched_job(conn, url)
    conn.execute("UPDATE jobs SET fit_score=?, scored_at=? WHERE url=?", (5, "2023-01-01", url))
    conn.commit()

    stats = get_stats(conn)
    assert stats["scored"] == 1
    distribution = dict(stats["score_distribution"])
    assert distribution.get(5) == 1


# ---------------------------------------------------------------------------
# Pipeline._count_pending mirror
# ---------------------------------------------------------------------------


def test_pipeline_count_pending_score_excludes_repository_rows(
    conn: sqlite3.Connection, monkeypatch
) -> None:
    """``pipeline._count_pending('score')`` must mirror
    ``get_jobs_by_stage('pending_score')`` — the streaming runner's
    progress counter would otherwise be permanently off-by-N."""
    from jobhunter import pipeline

    url = "https://example.com/job/pipeline"
    _seed_enriched_job(conn, url)
    monkeypatch.setattr(pipeline, "get_connection", lambda: conn)

    assert pipeline._count_pending("score") == 1
    _save_score(conn, url, fit=8)
    assert pipeline._count_pending("score") == 0


def test_pipeline_count_pending_tailor_picks_repository_scores(
    conn: sqlite3.Connection, monkeypatch
) -> None:
    from jobhunter import pipeline

    url = "https://example.com/job/pipeline-tailor"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=8)
    monkeypatch.setattr(pipeline, "get_connection", lambda: conn)

    assert pipeline._count_pending("tailor", min_score=7) == 1
