"""Exact-v7 regressions for worker score queues and dashboard stats.

Worker queue selectors and stats must read canonical scores from
``job_scores`` by tenant-scoped JobId. Deprecated score columns on ``jobs``
are not a runtime fallback.

Without these fixes:

  * ``run_scoring`` re-picks the same job forever — every invocation
    bumps the version because ``pending_score`` keeps matching.
  * ``pending_tailor`` / ``pending_cover`` are starved — newly-scored
    jobs never appear because the predicate filters on bare
    ``jobs.fit_score``.
  * ``get_stats`` reports stale ``scored`` / ``unscored`` /
    ``score_distribution`` / ``untailored_eligible`` counts — dashboard
    funnel goes wrong.

Each test seeds exact-v7 canonical rows, scores through
``ScoreRepository.save``, and asserts the selector or stat reflects the score.
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
from jobctrl.domain.identifiers import JobId, generate_job_id
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


def _seed_enriched_job(conn: sqlite3.Connection, url: str) -> JobId:
    job_id = generate_job_id()
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            str(LOCAL_TENANT),
            str(job_id),
            url,
            "Engineer",
            "Acme",
            "2024-01-01T00:00:00+00:00",
        ),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description, updated_at
        ) VALUES (?, ?, 'enriched', 'Need Python.', ?)
        """,
        (str(LOCAL_TENANT), str(job_id), "2024-01-01T00:00:00+00:00"),
    )
    conn.commit()
    return job_id


def _mark_closed(
    conn: sqlite3.Connection,
    job_id: JobId,
    state: str = "removed",
) -> None:
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
            latest_active_state, updated_at
        ) VALUES (?, ?, '{}', 0, ?, ?)
        ON CONFLICT(tenant_id, job_id) DO UPDATE SET
            latest_active_state = excluded.latest_active_state,
            updated_at = excluded.updated_at
        """,
        (str(LOCAL_TENANT), str(job_id), state, utc_now()),
    )
    conn.commit()


def _save_score(
    conn: sqlite3.Connection,
    job_id: JobId,
    fit: int = 8,
    *,
    eligibility: EligibilityAssessment | None = None,
) -> None:
    """Save a canonical JobScore through the Scoring repository."""
    repo = SqliteScoreRepository(conn)
    repo.save(
        JobScore.initial(
            tenant_id=LOCAL_TENANT,
            job_id=job_id,
            fit_score=FitScore.create(fit),
            breakdown=ScoreBreakdown(reasoning="ok", eligibility=eligibility or EligibilityAssessment()),
            matched_keywords=MatchedKeywords.from_iterable(["python"]),
            scored_at=datetime.now(timezone.utc).isoformat(),
        )
    )


def _insert_active_score_staleness_marker(
    conn: sqlite3.Connection,
    job_id: JobId,
) -> None:
    conn.execute(
        """
        INSERT INTO job_score_staleness (
            tenant_id, job_id, stale_reason,
            old_policy_id, old_policy_version,
            new_policy_id, new_policy_version,
            marked_at, resolved, resolved_at, resolved_by_score_version
        ) VALUES (?, ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
                  'local:scoring-policy-v2', 2, ?, 0, NULL, NULL)
        """,
        (str(LOCAL_TENANT), str(job_id), datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()


def _seed_approved_tailored_resume(
    conn: sqlite3.Connection,
    job_id: JobId,
) -> None:
    created_at = "2024-01-02T00:00:00+00:00"
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES (?, ?, 1, 'approved', ?, ?)
        """,
        (str(LOCAL_TENANT), str(job_id), created_at, created_at),
    )
    conn.executemany(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id,
            status, path, render_format, created_at
        ) VALUES (?, ?, 1, ?, ?, 'approved', ?, ?, ?)
        """,
        [
            (
                str(LOCAL_TENANT),
                str(job_id),
                "tailored_resume",
                f"{job_id}:tailored-resume",
                f"/tmp/{job_id}-tailored.txt",
                "text",
                created_at,
            ),
            (
                str(LOCAL_TENANT),
                str(job_id),
                "resume_pdf",
                f"{job_id}:resume-pdf",
                f"/tmp/{job_id}-resume.pdf",
                "latex_pdf",
                created_at,
            ),
        ],
    )
    conn.commit()


# ---------------------------------------------------------------------------
# B1 — get_jobs_by_stage selectors
# ---------------------------------------------------------------------------


def test_pending_score_excludes_jobs_already_in_job_scores(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/scored"
    job_id = _seed_enriched_job(conn, url)

    # Pre-condition: the job is pending_score.
    pending_before = get_jobs_by_stage(conn=conn, stage="pending_score")
    assert {row["job_id"] for row in pending_before} == {job_id}

    # Action: persist a score through the new repository.
    _save_score(conn, job_id, fit=8)

    # Post-condition: the job is no longer pending_score.
    pending_after = get_jobs_by_stage(conn=conn, stage="pending_score")
    assert pending_after == []

    deprecated = conn.execute(
        "SELECT fit_score FROM jobs WHERE tenant_id = ? AND job_id = ?",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert deprecated["fit_score"] is None


def test_pending_score_excludes_jobs_at_attempt_cap(
    conn: sqlite3.Connection,
) -> None:
    """A job whose score stage has failed 5 times must drop out of
    pending_score — otherwise a permanently-failing job re-bills the LLM
    on every batch forever. Mirrors the tailor / cover ``< 5`` cap."""
    url = "https://example.com/job/score-capped"
    job_id = _seed_enriched_job(conn, url)
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(
        conn,
        job_id,
        "score",
        "running",
        started_at="2024-01-02T00:00:00+00:00",
        validate_transition=False,
    )
    set_stage_state(
        conn,
        job_id,
        "score",
        "failed",
        attempt_count=5,
        validate_transition=False,
    )

    assert get_jobs_by_stage(conn=conn, stage="pending_score") == []


def test_pending_score_includes_jobs_under_attempt_cap(
    conn: sqlite3.Connection,
) -> None:
    """A job with fewer than 5 score attempts is still eligible."""
    url = "https://example.com/job/score-under-cap"
    job_id = _seed_enriched_job(conn, url)
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(
        conn,
        job_id,
        "score",
        "running",
        started_at="2024-01-02T00:00:00+00:00",
        validate_transition=False,
    )
    set_stage_state(
        conn,
        job_id,
        "score",
        "failed",
        attempt_count=4,
        validate_transition=False,
    )

    job_ids = {row["job_id"] for row in get_jobs_by_stage(conn=conn, stage="pending_score")}
    assert job_id in job_ids


def test_count_pending_score_uses_same_attempt_cap_as_selector(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.pipeline import runner as pipeline_runner

    capped_url = "https://example.com/job/count-score-capped"
    eligible_url = "https://example.com/job/count-score-under-cap"
    for url, attempts in ((capped_url, 5), (eligible_url, 4)):
        job_id = _seed_enriched_job(conn, url)
        ensure_job_stage_rows(conn, job_id)
        set_stage_state(
            conn,
            job_id,
            "score",
            "running",
            started_at="2024-01-02T00:00:00+00:00",
            validate_transition=False,
        )
        set_stage_state(
            conn,
            job_id,
            "score",
            "failed",
            attempt_count=attempts,
            validate_transition=False,
        )

    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert pipeline_runner._count_pending("score") == 1


def test_closed_postings_are_excluded_from_score_and_tailor_queues(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl.pipeline import runner as pipeline_runner

    score_url = "https://example.com/job/closed-score"
    tailor_url = "https://example.com/job/closed-tailor"
    score_job_id = _seed_enriched_job(conn, score_url)
    tailor_job_id = _seed_enriched_job(conn, tailor_url)
    _save_score(conn, tailor_job_id, fit=8)
    _mark_closed(conn, score_job_id)
    _mark_closed(conn, tailor_job_id)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert get_jobs_by_stage(conn=conn, stage="pending_score") == []
    assert {
        row["job_id"]
        for row in get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)
    } == set()
    assert pipeline_runner._count_pending("score") == 0
    assert pipeline_runner._count_pending("tailor", min_score=7) == 0


def test_pending_tailor_includes_jobs_scored_through_repository(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/ready-to-tailor"
    job_id = _seed_enriched_job(conn, url)
    _save_score(conn, job_id, fit=8)

    pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)
    job_ids = {row["job_id"] for row in pending}
    assert job_id in job_ids


def test_pending_tailor_excludes_score_five_even_when_threshold_is_lowered(
    conn: sqlite3.Connection,
    ) -> None:
    low_url = "https://example.com/job/low-fit-tailor"
    ok_url = "https://example.com/job/minimum-fit-tailor"
    low_job_id = _seed_enriched_job(conn, low_url)
    ok_job_id = _seed_enriched_job(conn, ok_url)
    _save_score(conn, low_job_id, fit=5)
    _save_score(conn, ok_job_id, fit=6)

    pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=5)
    job_ids = {row["job_id"] for row in pending}

    assert low_job_id not in job_ids
    assert ok_job_id in job_ids


def test_pending_tailor_excludes_high_score_blocked_jobs(
    conn: sqlite3.Connection,
    ) -> None:
    url_allowed = "https://example.com/job/allowed-tailor"
    url_blocked = "https://example.com/job/blocked-tailor"
    allowed_job_id = _seed_enriched_job(conn, url_allowed)
    blocked_job_id = _seed_enriched_job(conn, url_blocked)
    _save_score(conn, allowed_job_id, fit=8)
    _save_score(
        conn,
        blocked_job_id,
        fit=9,
        eligibility=EligibilityAssessment(status="blocked", hard_blockers=("No sponsorship.",)),
    )

    pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)
    job_ids = {row["job_id"] for row in pending}
    assert allowed_job_id in job_ids
    assert blocked_job_id not in job_ids


@pytest.mark.parametrize(
    "advisory_reason",
    (
        "Posted salary is below the preferred range.",
        "Pay is below the candidate minimum.",
        "Expected earnings are below the target.",
        "The total cash package is under the preferred range.",
        "The salary range falls below the candidate's minimum expectation.",
        "Salary—below the preferred range.",
        "Expected “salary” is below target.",
        "Posted [salary] is below target.",
        "Pay is below the preferred range but negotiable.",
        "Salary is below target, although negotiable.",
        "Compensation is low; however it is open to negotiation.",
        (
            "posted compensation appears below profile minimum: $40,000 vs profile "
            "minimum $120,000 (source jobs.salary, period year)"
        ),
        (
            "posted compensation appears below profile minimum: $72,000 vs profile "
            "minimum $120,000 (source jobs.description, period month, Monthly amounts "
            "annualized by multiplying by 12.)"
        ),
        (
            "posted compensation appears below profile minimum: $83,200 vs profile "
            "minimum $120,000 (source jobs.salary, period hour, Hourly amounts "
            "annualized by multiplying by 2,080 work hours.)"
        ),
    ),
)
def test_pending_tailor_includes_historical_compensation_only_blocked_score(
    conn: sqlite3.Connection,
    advisory_reason: str,
) -> None:
    job_id = _seed_enriched_job(conn, "https://example.com/job/salary-advisory")
    _save_score(
        conn,
        job_id,
        fit=9,
        eligibility=EligibilityAssessment(
            status="blocked",
            hard_blockers=(advisory_reason,),
        ),
    )

    pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)

    assert job_id in {row["job_id"] for row in pending}


@pytest.mark.parametrize(
    "hard_blocker",
    (
        "Remote location is incompatible with the required work model.",
        "Posting matches excluded criterion: wagering companies.",
        "Candidate does not meet the required work hours and salary is below target.",
        (
            "posted compensation appears below profile minimum: $40,000 vs profile "
            "minimum $120,000 (source jobs.salary, period year, candidate lacks work "
            "authorization)"
        ),
    ),
)
def test_pending_tailor_does_not_mistake_non_compensation_words_for_advice(
    conn: sqlite3.Connection,
    hard_blocker: str,
) -> None:
    job_id = _seed_enriched_job(conn, "https://example.com/job/remote-blocked")
    _save_score(
        conn,
        job_id,
        fit=9,
        eligibility=EligibilityAssessment(
            status="blocked",
            hard_blockers=(hard_blocker,),
        ),
    )

    pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)

    assert job_id not in {row["job_id"] for row in pending}


@pytest.mark.parametrize(
    "mixed_reason",
    (
        "Salary is below target and German language is required.",
        "Compensation is below target and the candidate must speak German.",
    ),
)
def test_pending_tailor_does_not_trust_mixed_typed_compensation_blocker(
    conn: sqlite3.Connection,
    mixed_reason: str,
) -> None:
    job_id = _seed_enriched_job(conn, "https://example.com/job/typed-mixed-blocker")
    _save_score(
        conn,
        job_id,
        fit=9,
        eligibility=EligibilityAssessment(
            status="blocked",
            hard_blockers=(mixed_reason,),
            hard_blocker_categories=("compensation_preference",),
        ),
    )

    pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)

    assert job_id not in {row["job_id"] for row in pending}


def test_pending_tailor_accepts_arbitrary_typed_compensation_wording(
    conn: sqlite3.Connection,
) -> None:
    job_id = _seed_enriched_job(conn, "https://example.com/job/typed-salary-advice")
    _save_score(
        conn,
        job_id,
        fit=9,
        eligibility=EligibilityAssessment(
            status="blocked",
            hard_blockers=(
                "Compensation does not align with the candidate expectations.",
            ),
            hard_blocker_categories=("compensation_preference",),
        ),
    )

    pending = get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7)

    assert job_id in {row["job_id"] for row in pending}


def test_pending_cover_includes_jobs_scored_through_repository(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/ready-to-cover"
    job_id = _seed_enriched_job(conn, url)
    _save_score(conn, job_id, fit=9)
    _seed_approved_tailored_resume(conn, job_id)

    pending = get_jobs_by_stage(conn=conn, stage="pending_cover", min_score=7)
    job_ids = {row["job_id"] for row in pending}
    assert job_id in job_ids


def test_closed_postings_are_excluded_from_cover_queue(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl.pipeline import runner as pipeline_runner

    url = "https://example.com/job/closed-cover"
    job_id = _seed_enriched_job(conn, url)
    _save_score(conn, job_id, fit=9)
    _seed_approved_tailored_resume(conn, job_id)
    _mark_closed(conn, job_id)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    pending_cover = get_jobs_by_stage(conn=conn, stage="pending_cover", min_score=7)
    assert pending_cover == []
    assert pipeline_runner._count_pending("cover", min_score=7) == 0


def test_pending_cover_includes_high_score_salary_advisory_jobs(
    conn: sqlite3.Connection,
    ) -> None:
    url_allowed = "https://example.com/job/allowed-cover"
    url_blocked = "https://example.com/job/blocked-cover"
    allowed_job_id = _seed_enriched_job(conn, url_allowed)
    blocked_job_id = _seed_enriched_job(conn, url_blocked)
    _save_score(conn, allowed_job_id, fit=8)
    _save_score(
        conn,
        blocked_job_id,
        fit=9,
        eligibility=EligibilityAssessment(status="eligible", hard_blockers=("Below minimum salary.",)),
    )
    _seed_approved_tailored_resume(conn, allowed_job_id)
    _seed_approved_tailored_resume(conn, blocked_job_id)

    pending = get_jobs_by_stage(conn=conn, stage="pending_cover", min_score=7)
    job_ids = {row["job_id"] for row in pending}
    assert allowed_job_id in job_ids
    assert blocked_job_id in job_ids


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
    job_id = _seed_enriched_job(conn, url)
    _save_score(conn, job_id, fit=9)
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(conn, job_id, "score", score_state, validate_transition=False)
    if active_marker:
        _insert_active_score_staleness_marker(conn, job_id)
    if stage == "pending_cover":
        _seed_approved_tailored_resume(conn, job_id)

    pending = get_jobs_by_stage(conn=conn, stage=stage, min_score=7)
    job_ids = {row["job_id"] for row in pending}
    assert job_id not in job_ids


def test_get_jobs_by_stage_returns_canonical_score_in_dict(
    conn: sqlite3.Connection,
) -> None:
    """Returned selector records expose the canonical score value."""
    url = "https://example.com/job/dict"
    job_id = _seed_enriched_job(conn, url)
    _save_score(conn, job_id, fit=6)

    rows = get_jobs_by_stage(conn=conn, stage="enriched")
    matching = next(row for row in rows if row["job_id"] == job_id)
    assert matching["fit_score"] == 6


# ---------------------------------------------------------------------------
# B2 — get_stats counts
# ---------------------------------------------------------------------------


def test_get_stats_counts_repository_scores(conn: sqlite3.Connection) -> None:
    url_scored = "https://example.com/job/has-score"
    url_pending = "https://example.com/job/no-score"
    scored_job_id = _seed_enriched_job(conn, url_scored)
    _seed_enriched_job(conn, url_pending)
    _save_score(conn, scored_job_id, fit=8)

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
    job_id = _seed_enriched_job(conn, url)
    _save_score(conn, job_id, fit=9)

    stats = get_stats(conn)
    # Eligible = score >= 7, has description, no tailored resume.
    assert stats["untailored_eligible"] == 1


def test_get_stats_ignores_deprecated_jobs_score_columns(
    conn: sqlite3.Connection,
) -> None:
    """Exact-v7 runtime never treats deprecated job columns as score state."""
    url = "https://example.com/job/deprecated-score-column"
    job_id = _seed_enriched_job(conn, url)
    conn.execute(
        """
        UPDATE jobs
           SET fit_score = ?, scored_at = ?
         WHERE tenant_id = ? AND job_id = ?
        """,
        (5, "2023-01-01", str(LOCAL_TENANT), str(job_id)),
    )
    conn.commit()

    stats = get_stats(conn)
    assert stats["scored"] == 0
    assert stats["unscored"] == 1
    distribution = dict(stats["score_distribution"])
    assert 5 not in distribution


# ---------------------------------------------------------------------------
# Pipeline._count_pending mirror
# ---------------------------------------------------------------------------


def test_pipeline_count_pending_score_excludes_repository_rows(
    conn: sqlite3.Connection, monkeypatch
) -> None:
    """``pipeline_runner._count_pending('score')`` must mirror
    ``get_jobs_by_stage('pending_score')`` — the streaming runner's
    progress counter would otherwise be permanently off-by-N."""
    from jobctrl.pipeline import runner as pipeline_runner

    url = "https://example.com/job/pipeline"
    job_id = _seed_enriched_job(conn, url)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert pipeline_runner._count_pending("score") == 1
    _save_score(conn, job_id, fit=8)
    assert pipeline_runner._count_pending("score") == 0


def test_pipeline_count_pending_tailor_picks_repository_scores(
    conn: sqlite3.Connection, monkeypatch
) -> None:
    from jobctrl.pipeline import runner as pipeline_runner

    url = "https://example.com/job/pipeline-tailor"
    job_id = _seed_enriched_job(conn, url)
    _save_score(conn, job_id, fit=8)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert pipeline_runner._count_pending("tailor", min_score=7) == 1


def test_pipeline_count_pending_tailor_excludes_pending_rescore(
    conn: sqlite3.Connection, monkeypatch
) -> None:
    from jobctrl.pipeline import runner as pipeline_runner

    url = "https://example.com/job/pipeline-tailor-pending-rescore"
    job_id = _seed_enriched_job(conn, url)
    _save_score(conn, job_id, fit=8)
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(conn, job_id, "score", "pending", validate_transition=False)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert pipeline_runner._count_pending("tailor", min_score=7) == 0
