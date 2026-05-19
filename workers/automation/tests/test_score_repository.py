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
    ScoreCorrection,
    ScoreTrace,
    ScoringCriteria,
)
from jobhunter.domain.scoring.use_cases import CorrectScoreUseCase
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.scoring import (
    SqliteScoreRepository,
    SqliteScoreStalenessRepository,
    SqliteScoringPolicyRepository,
)
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


def _build_score(
    url: str,
    version: int = 1,
    fit: int = 7,
    *,
    trace: ScoreTrace | None = None,
    correction: ScoreCorrection | None = None,
) -> JobScore:
    return JobScore(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        version=version,
        fit_score=FitScore.create(fit),
        breakdown=ScoreBreakdown(technical_fit=8, experience_fit=6, role_fit=7, reasoning="ok"),
        matched_keywords=MatchedKeywords.from_iterable(["python", "fastapi"]),
        scored_at=datetime.now(timezone.utc).isoformat(),
        trace=trace or ScoreTrace(),
        correction=correction,
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


def test_save_and_load_round_trips_criteria_and_trace(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    repo = SqliteScoreRepository(conn)
    score = JobScore.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        fit_score=FitScore.create(9),
        breakdown=ScoreBreakdown(
            technical_fit=9,
            experience_fit=8,
            role_fit=9,
            reasoning="excellent",
            fit_band="excellent",
            confidence="high",
            matched_signals=("Python",),
        ),
        matched_keywords=MatchedKeywords.from_iterable(["python"]),
        scored_at=datetime.now(timezone.utc).isoformat(),
        criteria=ScoringCriteria(
            min_fit_score=8,
            criteria_text="Security leadership.",
            target_criteria="Remote roles.",
            profile_preferences={"target_work_models": "remote"},
        ),
        trace=ScoreTrace(
            prompt_version="score-fit-assessment-v1",
            schema_version="score-fit-assessment-v1",
            model="fake-model",
            criteria_version="criteria-1",
            profile_snapshot_version=3,
            scoring_policy_id="local:scoring-policy-v2",
            scoring_policy_version=2,
            rubric_version="default-scoring-rubric-v1",
            raw_weighted_score=8.65,
            calibration_adjustment=0.0,
            anchor_ids=("anchor-a",),
            resolved_fit_band="excellent",
            resolution_reason="weighted_dimensions",
            resolved_dimensions=(
                {"name": "technical_fit", "value": 9, "weight": 0.45},
            ),
            fit_band_thresholds=(
                {"band": "excellent", "minimum_score": 9},
                {"band": "strong", "minimum_score": 7},
            ),
            policy_evidence={"confidence": "high", "eligibility_status": "eligible"},
            parser_warnings=("missing_confidence",),
        ),
    )
    repo.save(score)

    loaded = repo.load(LOCAL_TENANT, JobId(url))

    assert loaded is not None
    assert loaded.criteria.criteria_text == "Security leadership."
    assert loaded.criteria.profile_preferences["target_work_models"] == "remote"
    assert loaded.trace.model == "fake-model"
    assert loaded.trace.profile_snapshot_version == 3
    assert loaded.trace.scoring_policy_id == "local:scoring-policy-v2"
    assert loaded.trace.scoring_policy_version == 2
    assert loaded.trace.rubric_version == "default-scoring-rubric-v1"
    assert loaded.trace.raw_weighted_score == 8.65
    assert loaded.trace.calibration_adjustment == 0.0
    assert loaded.trace.anchor_ids == ("anchor-a",)
    assert loaded.trace.resolved_fit_band == "excellent"
    assert loaded.trace.resolution_reason == "weighted_dimensions"
    assert loaded.trace.resolved_dimensions == (
        {"name": "technical_fit", "value": 9, "weight": 0.45},
    )
    assert loaded.trace.fit_band_thresholds == (
        {"band": "excellent", "minimum_score": 9},
        {"band": "strong", "minimum_score": 7},
    )
    assert loaded.trace.policy_evidence == {
        "confidence": "high",
        "eligibility_status": "eligible",
    }
    assert loaded.trace.parser_warnings == ("missing_confidence",)


def test_load_legacy_trace_without_policy_metadata(conn: sqlite3.Connection) -> None:
    url = _seed_job(conn)
    conn.execute(
        """
        INSERT INTO job_scores (
            job_url, version, tenant_id, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, 1, ?, 7, ?, ?, ?, NULL, ?, ?)
        """,
        (
            url,
            str(LOCAL_TENANT),
            '{"technical_fit": 7, "experience_fit": 7, "role_fit": 7, "reasoning": "legacy"}',
            '["python"]',
            datetime.now(timezone.utc).isoformat(),
            "{}",
            '{"prompt_version": "legacy", "schema_version": "legacy", "model": "legacy"}',
        ),
    )
    conn.commit()

    loaded = SqliteScoreRepository(conn).load(LOCAL_TENANT, JobId(url))

    assert loaded is not None
    assert loaded.trace.prompt_version == "legacy"
    assert loaded.trace.scoring_policy_id == ""
    assert loaded.trace.scoring_policy_version == 0
    assert loaded.trace.rubric_version == ""
    assert loaded.trace.raw_weighted_score is None
    assert loaded.trace.calibration_adjustment == 0.0
    assert loaded.trace.anchor_ids == ()
    assert loaded.trace.resolved_fit_band == ""
    assert loaded.trace.resolution_reason == ""
    assert loaded.trace.resolved_dimensions == ()
    assert loaded.trace.fit_band_thresholds == ()
    assert loaded.trace.policy_evidence == {}


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
# Staleness markers
# ---------------------------------------------------------------------------


def test_score_correction_marks_comparable_uncorrected_scores_stale_and_resolve_on_rescore(
    conn: sqlite3.Connection,
) -> None:
    target_url = _seed_job(conn, url="https://example.com/job/corrected")
    comparable_url = _seed_job(conn, url="https://example.com/job/comparable")
    current_url = _seed_job(conn, url="https://example.com/job/current-policy")
    already_corrected_url = _seed_job(conn, url="https://example.com/job/already-corrected")
    policy_v1 = ScoreTrace(
        scoring_policy_id="local:scoring-policy-v1",
        scoring_policy_version=1,
    )
    policy_v2 = ScoreTrace(
        scoring_policy_id="local:scoring-policy-v2",
        scoring_policy_version=2,
    )
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(target_url, trace=policy_v1))
    repo.save(_build_score(comparable_url, trace=policy_v1))
    repo.save(_build_score(current_url, trace=policy_v2))
    already_corrected = _build_score(already_corrected_url, trace=policy_v1)
    repo.save(already_corrected)
    repo.save(
        already_corrected.with_correction(
            ScoreCorrection(
                corrected_fit_score=FitScore.create(8),
                rationale="Already reviewed.",
                corrected_by=LOCAL_TENANT,
                corrected_at="2024-01-01T00:01:00+00:00",
            )
        )
    )

    CorrectScoreUseCase(
        repository=repo,
        policy_repository=SqliteScoringPolicyRepository(conn),
        staleness_repository=SqliteScoreStalenessRepository(conn),
    ).execute(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(target_url),
        corrected_fit_score=FitScore.create(9),
        rationale="Manual review found stronger fit.",
        corrected_at="2024-01-02T00:00:00+00:00",
    )

    rows = conn.execute(
        """
        SELECT job_url, stale_reason, old_policy_version, new_policy_version, resolved
        FROM job_score_staleness
        ORDER BY job_url
        """
    ).fetchall()
    assert [row["job_url"] for row in rows] == [comparable_url]
    assert rows[0]["stale_reason"] == "scoring_policy_changed"
    assert rows[0]["old_policy_version"] == 1
    assert rows[0]["new_policy_version"] == 2
    assert rows[0]["resolved"] == 0
    stale_stage = conn.execute(
        "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'score'",
        (comparable_url,),
    ).fetchone()
    assert stale_stage["state"] == "stale"
    stale_event = conn.execute(
        "SELECT event_type FROM job_events WHERE job_url = ? ORDER BY event_id DESC LIMIT 1",
        (comparable_url,),
    ).fetchone()
    assert stale_event["event_type"] == "ScoreMarkedStale"

    repo.save(_build_score(comparable_url, version=2, fit=8, trace=policy_v2))

    resolved = conn.execute(
        """
        SELECT resolved, resolved_by_score_version
        FROM job_score_staleness
        WHERE job_url = ?
        """,
        (comparable_url,),
    ).fetchone()
    assert resolved["resolved"] == 1
    assert resolved["resolved_by_score_version"] == 2


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
