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

from jobctrl.database import (
    get_jobs_by_stage,
    get_stats,
    init_db,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.scoring import (
    EligibilityAssessment,
    FitScore,
    JobScore,
    MatchedKeywords,
    ScoreBreakdown,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.scoring import SqliteScoreRepository
from jobctrl.state import ensure_job_stage_rows, set_stage_state, utc_now


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def _seed_enriched_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, discovered_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (url, "Engineer", "Acme", "Need Python.", "2024-01-01T00:00:00+00:00"),
    )
    conn.commit()


def _mark_closed(conn: sqlite3.Connection, url: str, state: str = "removed") -> None:
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_url, snapshot_set_json, latest_snapshot_version,
            latest_active_state, updated_at
        ) VALUES (?, ?, '{}', 0, ?, ?)
        ON CONFLICT(tenant_id, job_url) DO UPDATE SET
            latest_active_state = excluded.latest_active_state,
            updated_at = excluded.updated_at
        """,
        (str(LOCAL_TENANT), url, state, utc_now()),
    )
    conn.commit()


def _save_score(
    conn: sqlite3.Connection,
    url: str,
    fit: int = 8,
    *,
    eligibility: EligibilityAssessment | None = None,
) -> None:
    """Save a JobScore through the new repository — leaves jobs.fit_score NULL."""
    repo = SqliteScoreRepository(conn)
    repo.save(
        JobScore.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            fit_score=FitScore.create(fit),
            breakdown=ScoreBreakdown(reasoning="ok", eligibility=eligibility or EligibilityAssessment()),
            matched_keywords=MatchedKeywords.from_iterable(["python"]),
            scored_at=datetime.now(timezone.utc).isoformat(),
        )
    )


def _insert_active_score_staleness_marker(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        """
        INSERT INTO job_score_staleness (
            tenant_id, job_url, stale_reason,
            old_policy_id, old_policy_version,
            new_policy_id, new_policy_version,
            marked_at, resolved, resolved_at, resolved_by_score_version
        ) VALUES (?, ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
                  'local:scoring-policy-v2', 2, ?, 0, NULL, NULL)
        """,
        (str(LOCAL_TENANT), url, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()


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


def test_pending_score_excludes_jobs_at_attempt_cap(
    conn: sqlite3.Connection,
) -> None:
    """A job whose score stage has failed 5 times must drop out of
    pending_score — otherwise a permanently-failing job re-bills the LLM
    on every batch forever. Mirrors the tailor / cover ``< 5`` cap."""
    url = "https://example.com/job/score-capped"
    _seed_enriched_job(conn, url)
    ensure_job_stage_rows(conn, url)
    set_stage_state(
        conn, url, "score", "running",
        started_at="2024-01-02T00:00:00+00:00", validate_transition=False,
    )
    set_stage_state(
        conn, url, "score", "failed", attempt_count=5, validate_transition=False,
    )

    assert get_jobs_by_stage(conn=conn, stage="pending_score") == []


def test_pending_score_includes_jobs_under_attempt_cap(
    conn: sqlite3.Connection,
) -> None:
    """A job with fewer than 5 score attempts is still eligible."""
    url = "https://example.com/job/score-under-cap"
    _seed_enriched_job(conn, url)
    ensure_job_stage_rows(conn, url)
    set_stage_state(
        conn, url, "score", "running",
        started_at="2024-01-02T00:00:00+00:00", validate_transition=False,
    )
    set_stage_state(
        conn, url, "score", "failed", attempt_count=4, validate_transition=False,
    )

    urls = {row["url"] for row in get_jobs_by_stage(conn=conn, stage="pending_score")}
    assert url in urls


def test_count_pending_score_uses_same_attempt_cap_as_selector(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.pipeline import runner as pipeline_runner

    capped_url = "https://example.com/job/count-score-capped"
    eligible_url = "https://example.com/job/count-score-under-cap"
    for url, attempts in ((capped_url, 5), (eligible_url, 4)):
        _seed_enriched_job(conn, url)
        ensure_job_stage_rows(conn, url)
        set_stage_state(
            conn, url, "score", "running",
            started_at="2024-01-02T00:00:00+00:00", validate_transition=False,
        )
        set_stage_state(
            conn, url, "score", "failed", attempt_count=attempts, validate_transition=False,
        )

    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert pipeline_runner._count_pending("score") == 1


def test_closed_postings_are_excluded_from_score_and_tailor_queues(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import pipeline
    from jobctrl.pipeline import runner as pipeline_runner

    score_url = "https://example.com/job/closed-score"
    tailor_url = "https://example.com/job/closed-tailor"
    _seed_enriched_job(conn, score_url)
    _seed_enriched_job(conn, tailor_url)
    _save_score(conn, tailor_url, fit=8)
    _mark_closed(conn, score_url)
    _mark_closed(conn, tailor_url)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert {row["url"] for row in get_jobs_by_stage(conn=conn, stage="pending_score")} == set()
    assert {
        row["url"] for row in get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)
    } == set()
    assert pipeline._count_pending("score") == 0
    assert pipeline._count_pending("tailor", min_score=7) == 0


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


def test_pending_tailor_excludes_score_five_even_when_threshold_is_lowered(
    conn: sqlite3.Connection,
) -> None:
    low_url = "https://example.com/job/low-fit-tailor"
    ok_url = "https://example.com/job/minimum-fit-tailor"
    _seed_enriched_job(conn, low_url)
    _seed_enriched_job(conn, ok_url)
    _save_score(conn, low_url, fit=5)
    _save_score(conn, ok_url, fit=6)

    pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=5)
    urls = {row["url"] for row in pending}

    assert low_url not in urls
    assert ok_url in urls


def test_pending_tailor_excludes_high_score_blocked_jobs(
    conn: sqlite3.Connection,
) -> None:
    url_allowed = "https://example.com/job/allowed-tailor"
    url_blocked = "https://example.com/job/blocked-tailor"
    _seed_enriched_job(conn, url_allowed)
    _seed_enriched_job(conn, url_blocked)
    _save_score(conn, url_allowed, fit=8)
    _save_score(
        conn,
        url_blocked,
        fit=9,
        eligibility=EligibilityAssessment(status="blocked", hard_blockers=("No sponsorship.",)),
    )

    pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)
    urls = {row["url"] for row in pending}
    assert url_allowed in urls
    assert url_blocked not in urls


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


def test_closed_postings_are_excluded_from_cover_queue(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import pipeline
    from jobctrl.pipeline import runner as pipeline_runner

    url = "https://example.com/job/closed-cover"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=9)
    conn.execute(
        "UPDATE jobs SET tailored_resume_path=?, tailored_at=? WHERE url=?",
        ("/tmp/tailored.txt", "2024-01-02T00:00:00+00:00", url),
    )
    _mark_closed(conn, url)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    pending_cover = get_jobs_by_stage(conn=conn, stage="pending_cover", min_score=7)
    assert {row["url"] for row in pending_cover} == set()
    assert pipeline._count_pending("cover", min_score=7) == 0


def test_pending_cover_excludes_high_score_blocked_jobs(
    conn: sqlite3.Connection,
) -> None:
    url_allowed = "https://example.com/job/allowed-cover"
    url_blocked = "https://example.com/job/blocked-cover"
    _seed_enriched_job(conn, url_allowed)
    _seed_enriched_job(conn, url_blocked)
    _save_score(conn, url_allowed, fit=8)
    _save_score(
        conn,
        url_blocked,
        fit=9,
        eligibility=EligibilityAssessment(status="eligible", hard_blockers=("Below minimum salary.",)),
    )
    conn.executemany(
        "UPDATE jobs SET tailored_resume_path=?, tailored_at=? WHERE url=?",
        [
            ("/tmp/allowed-tailored.txt", "2024-01-02T00:00:00+00:00", url_allowed),
            ("/tmp/blocked-tailored.txt", "2024-01-02T00:00:00+00:00", url_blocked),
        ],
    )
    conn.commit()

    pending = get_jobs_by_stage(conn=conn, stage="pending_cover", min_score=7)
    urls = {row["url"] for row in pending}
    assert url_allowed in urls
    assert url_blocked not in urls


@pytest.mark.parametrize("stage", ["pending_tailor", "pending_cover"])
@pytest.mark.parametrize(
    ("score_state", "active_marker"),
    [
        ("stale", True),
        ("pending", False),
        ("succeeded", True),
    ],
)
def test_downstream_materials_selectors_exclude_non_current_scores(
    conn: sqlite3.Connection,
    stage: str,
    score_state: str,
    active_marker: bool,
) -> None:
    url = f"https://example.com/job/non-current-{stage}-{score_state}-{active_marker}"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=9)
    ensure_job_stage_rows(conn, url)
    set_stage_state(conn, url, "score", score_state, validate_transition=False)
    if active_marker:
        _insert_active_score_staleness_marker(conn, url)
    if stage == "pending_cover":
        conn.execute(
            "UPDATE jobs SET tailored_resume_path=?, tailored_at=? WHERE url=?",
            ("/tmp/tailored.txt", "2024-01-02T00:00:00+00:00", url),
        )
        conn.commit()

    pending = get_jobs_by_stage(conn=conn, stage=stage, min_score=7)
    urls = {row["url"] for row in pending}
    assert url not in urls


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
    from jobctrl import pipeline
    from jobctrl.pipeline import runner as pipeline_runner

    url = "https://example.com/job/pipeline"
    _seed_enriched_job(conn, url)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert pipeline._count_pending("score") == 1
    _save_score(conn, url, fit=8)
    assert pipeline._count_pending("score") == 0


def test_pipeline_count_pending_tailor_picks_repository_scores(
    conn: sqlite3.Connection, monkeypatch
) -> None:
    from jobctrl import pipeline
    from jobctrl.pipeline import runner as pipeline_runner

    url = "https://example.com/job/pipeline-tailor"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=8)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert pipeline._count_pending("tailor", min_score=7) == 1


def test_pipeline_count_pending_tailor_excludes_pending_rescore(
    conn: sqlite3.Connection, monkeypatch
) -> None:
    from jobctrl import pipeline
    from jobctrl.pipeline import runner as pipeline_runner

    url = "https://example.com/job/pipeline-tailor-pending-rescore"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=8)
    ensure_job_stage_rows(conn, url)
    set_stage_state(conn, url, "score", "pending", validate_transition=False)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert pipeline._count_pending("tailor", min_score=7) == 0
