"""Exact-v7 SQLite scoring repository persistence tests."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.scoring import (
    FitScore,
    JobScore,
    MatchedKeywords,
    RequirementArtifactCoverage,
    RequirementFitAssessment,
    RequirementFitReport,
    RequirementFitStatus,
    RequirementFitSummary,
    RequirementScoreContribution,
    RequirementTailoringDirective,
    ScoreBreakdown,
    ScoreCorrection,
    ScoreTrace,
    ScoringCriteria,
)
from jobctrl.domain.scoring.use_cases import CorrectScoreUseCase
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.scoring import (
    SqliteRequirementFitReportRepository,
    SqliteScoreRepository,
    SqliteScoreStalenessRepository,
    SqliteScoringPolicyRepository,
)
from jobctrl.infrastructure.scoring.keyword_normalization import canonicalize_keywords
from jobctrl.infrastructure.scoring.sqlite_repository import ScoreVersionConflict


def _job_id(seed: int) -> JobId:
    return canonical_job_id(f"00000000-0000-4000-8000-{seed:012d}")


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    connection = init_db(tmp_path / "jobctrl.db")
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _seed_job(
    conn: sqlite3.Connection,
    *,
    job_id: JobId,
    url: str,
    tenant_id: TenantId = LOCAL_TENANT,
    full_description: str | None = "Description body",
) -> JobId:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(tenant_id),
            str(job_id),
            url,
            "Engineer",
            "Acme",
            full_description,
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    conn.commit()
    return job_id


def _seed_enrichment(
    conn: sqlite3.Connection,
    *,
    job_id: JobId,
    tenant_id: TenantId = LOCAL_TENANT,
    full_description: str = "Canonical enriched description.",
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description, enriched_at,
            extraction_tier, updated_at
        ) VALUES (?, ?, 'enriched', ?, ?, 'json_ld', ?)
        """,
        (str(tenant_id), str(job_id), full_description, now, now),
    )
    conn.commit()


def _build_score(
    job_id: JobId,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    version: int = 1,
    fit: int = 7,
    keywords: tuple[str, ...] = ("python", "fastapi"),
    trace: ScoreTrace | None = None,
    correction: ScoreCorrection | None = None,
) -> JobScore:
    return JobScore(
        tenant_id=tenant_id,
        job_id=job_id,
        version=version,
        fit_score=FitScore.create(fit),
        breakdown=ScoreBreakdown(technical_fit=8, experience_fit=6, role_fit=7, reasoning="ok"),
        matched_keywords=MatchedKeywords(values=keywords),
        scored_at=datetime.now(timezone.utc).isoformat(),
        trace=trace or ScoreTrace(),
        correction=correction,
    )


def _score_keyword_rows(conn: sqlite3.Connection) -> list[tuple[object, ...]]:
    return [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, job_id, score_version, normalized_keyword,
                   display_keyword, position
            FROM job_score_keywords
            ORDER BY tenant_id, job_id, score_version, position
            """
        ).fetchall()
    ]


def _requirement_assessment(
    requirement_id: str = "r1",
    *,
    status: str = "matched",
    action: str = "double_down",
) -> RequirementFitAssessment:
    if status == "matched":
        fit = RequirementFitStatus(
            kind="matched",
            evidence_ids=(f"ev-{requirement_id}",),
            strength="direct",
        )
        awarded = 8.0
    elif status == "transferable":
        fit = RequirementFitStatus(
            kind="transferable",
            evidence_ids=(f"ev-{requirement_id}",),
            gap="No direct platform ownership",
            bridge="Related incident ownership evidence applies",
        )
        awarded = 5.0
    else:
        fit = RequirementFitStatus(kind="missing", reason="No profile evidence")
        awarded = 0.0
    return RequirementFitAssessment(
        requirement_id=requirement_id,
        requirement_text=f"Requirement {requirement_id}",
        tier="must_have",
        weight=0.8,
        job_evidence_span=f"Requirement {requirement_id}",
        fit=fit,
        contribution=RequirementScoreContribution(
            max_points=8.0,
            awarded_points=awarded,
            weighted_impact=0.4,
            rationale="Requirement contribution rationale.",
        ),
        tailoring=RequirementTailoringDirective(
            action=action,
            priority=0.8,
            allowed_evidence_ids=(f"ev-{requirement_id}",) if status != "missing" else (),
            target_keywords=(f"keyword-{requirement_id}",),
            prohibited_claims=("unsupported claim",) if status == "missing" else (),
            instruction="Use the allowed evidence without inventing claims.",
        ),
        artifact_coverage=RequirementArtifactCoverage(
            state="covered" if status != "missing" else "not_recorded",
            bullet_count=1 if status != "missing" else 0,
            examples=("Generated requirement evidence.",) if status != "missing" else (),
        ),
    )


def _requirement_report(
    job_id: JobId,
    *,
    score_version: int = 1,
    fit: int = 8,
    assessments: tuple[RequirementFitAssessment, ...] | None = None,
) -> RequirementFitReport:
    return RequirementFitReport(
        job_id=job_id,
        score_version=score_version,
        employer_analysis_generation=2,
        profile_snapshot_version=3,
        scoring_policy_version=4,
        formula_version="requirement-fit-v1",
        resolved_fit_score=FitScore.create(fit),
        fit_band="strong",
        confidence="high",
        summary=RequirementFitSummary(
            weighted_fit=0.78,
            must_have_coverage=0.8,
            blocker_count=0,
            missing_high_weight_count=0,
        ),
        assessments=assessments or (_requirement_assessment(),),
    )


def test_converted_repositories_do_not_initialize_schema_at_runtime() -> None:
    connection = sqlite3.connect(":memory:")

    SqliteScoreRepository(connection)
    SqliteScoreStalenessRepository(connection)
    SqliteRequirementFitReportRepository(connection)

    tables = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    assert not {
        "job_scores",
        "job_score_staleness",
        "job_requirement_fit_reports",
        "job_requirement_fit_items",
    } & tables


def test_score_round_trip_uses_canonical_job_id_distinct_from_posting_url(
    conn: sqlite3.Connection,
) -> None:
    job_id = _seed_job(
        conn,
        job_id=_job_id(1),
        url="https://example.com/jobs/score-round-trip",
    )
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(job_id))

    loaded = repo.load(LOCAL_TENANT, job_id)

    assert loaded is not None
    assert loaded.job_id == job_id
    assert loaded.fit_score.value == 7
    assert loaded.matched_keywords.values == ("python", "fastapi")
    assert loaded.breakdown.technical_fit == 8
    row = conn.execute(
        "SELECT tenant_id, job_id FROM job_scores"
    ).fetchone()
    assert tuple(row) == (str(LOCAL_TENANT), str(job_id))


def test_canonicalize_score_keywords_preserves_first_display_and_positions() -> None:
    assert canonicalize_keywords(
        (
            "  Python  ",
            "\u3000Ｐｙｔｈｏｎ\t",
            "Data   Science",
            " data science ",
            "\u00a0",
            "\t",
            "Straße",
            "STRASSE",
        )
    ) == (
        ("python", "Python", 0),
        ("data science", "Data Science", 1),
        ("strasse", "Straße", 2),
    )


def test_save_writes_complete_normalized_keyword_rows(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(
        conn,
        job_id=_job_id(20),
        url="https://example.com/jobs/keyword-rows",
    )

    SqliteScoreRepository(conn).save(
        _build_score(
            job_id,
            keywords=(
                "  Python  ",
                "\u3000Ｐｙｔｈｏｎ\t",
                "Data   Science",
                "data science",
                "Straße",
                "STRASSE",
            ),
        )
    )

    assert _score_keyword_rows(conn) == [
        (str(LOCAL_TENANT), str(job_id), 1, "python", "Python", 0),
        (str(LOCAL_TENANT), str(job_id), 1, "data science", "Data Science", 1),
        (str(LOCAL_TENANT), str(job_id), 1, "strasse", "Straße", 2),
    ]


def test_score_round_trip_preserves_criteria_and_trace(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(
        conn,
        job_id=_job_id(2),
        url="https://example.com/jobs/criteria-and-trace",
    )
    score = JobScore.initial(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
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
    repo = SqliteScoreRepository(conn)
    repo.save(score)

    loaded = repo.load(LOCAL_TENANT, job_id)

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


def test_score_repository_rejects_url_shaped_job_ids(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/not-an-id"
    repo = SqliteScoreRepository(conn)

    with pytest.raises(ValueError, match="JobId must be a canonical UUID"):
        repo.load(LOCAL_TENANT, JobId(url))
    with pytest.raises(ValueError, match="JobId must be a canonical UUID"):
        repo.save(_build_score(JobId(url)))

    assert conn.execute("SELECT COUNT(*) FROM job_scores").fetchone()[0] == 0


def test_score_repository_scopes_same_job_id_by_tenant(conn: sqlite3.Connection) -> None:
    job_id = _job_id(3)
    other_tenant = TenantId("other")
    _seed_job(
        conn,
        job_id=job_id,
        url="https://example.com/jobs/local-score",
    )
    _seed_job(
        conn,
        tenant_id=other_tenant,
        job_id=job_id,
        url="https://example.com/jobs/other-score",
    )
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(job_id, fit=7))
    repo.save(_build_score(job_id, tenant_id=other_tenant, fit=9))

    local_score = repo.load(LOCAL_TENANT, job_id)
    other_score = repo.load(other_tenant, job_id)
    local_range = repo.list_by_score_range(LOCAL_TENANT, min_score=1)

    assert local_score is not None
    assert other_score is not None
    assert local_score.fit_score.value == 7
    assert other_score.fit_score.value == 9
    assert [(score.tenant_id, score.job_id) for score in local_range] == [
        (LOCAL_TENANT, job_id)
    ]
    assert _score_keyword_rows(conn) == [
        (str(LOCAL_TENANT), str(job_id), 1, "python", "python", 0),
        (str(LOCAL_TENANT), str(job_id), 1, "fastapi", "fastapi", 1),
        (str(other_tenant), str(job_id), 1, "python", "python", 0),
        (str(other_tenant), str(job_id), 1, "fastapi", "fastapi", 1),
    ]


def test_load_returns_none_when_no_score(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(
        conn,
        job_id=_job_id(4),
        url="https://example.com/jobs/no-score",
    )

    assert SqliteScoreRepository(conn).load(LOCAL_TENANT, job_id) is None


def test_requirement_fit_report_round_trips_with_canonical_job_id(
    conn: sqlite3.Connection,
) -> None:
    job_id = _seed_job(
        conn,
        job_id=_job_id(5),
        url="https://example.com/jobs/requirement-round-trip",
    )
    SqliteScoreRepository(conn).save(_build_score(job_id, fit=8))
    report = _requirement_report(job_id)
    repo = SqliteRequirementFitReportRepository(conn)
    repo.save(LOCAL_TENANT, report)

    loaded = repo.load(LOCAL_TENANT, job_id, score_version=1)

    assert loaded == report
    assert loaded is not None
    assert loaded.job_id == job_id
    assert loaded.assessments[0].fit.kind == "matched"
    assert loaded.assessments[0].tailoring.action == "double_down"
    assert loaded.assessments[0].artifact_coverage is not None
    assert loaded.assessments[0].artifact_coverage.state == "covered"


def test_requirement_fit_report_replaces_item_rows(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(
        conn,
        job_id=_job_id(6),
        url="https://example.com/jobs/requirement-replace",
    )
    SqliteScoreRepository(conn).save(_build_score(job_id, fit=8))
    repo = SqliteRequirementFitReportRepository(conn)
    repo.save(
        LOCAL_TENANT,
        _requirement_report(
            job_id,
            assessments=(
                _requirement_assessment("r1"),
                _requirement_assessment("r2", status="transferable", action="bridge_gap"),
            ),
        ),
    )
    repo.save(
        LOCAL_TENANT,
        _requirement_report(
            job_id,
            assessments=(
                _requirement_assessment("r1", status="missing", action="avoid_claim"),
            ),
        ),
    )

    loaded = repo.load(LOCAL_TENANT, job_id, score_version=1)

    assert loaded is not None
    assert [item.requirement_id for item in loaded.assessments] == ["r1"]
    assert loaded.assessments[0].fit.kind == "missing"
    assert loaded.assessments[0].tailoring.action == "avoid_claim"


def test_requirement_fit_report_loads_latest_score_version(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(
        conn,
        job_id=_job_id(7),
        url="https://example.com/jobs/requirement-versions",
    )
    score_repo = SqliteScoreRepository(conn)
    score_repo.save(_build_score(job_id, version=1, fit=7))
    score_repo.save(_build_score(job_id, version=2, fit=9))
    report_repo = SqliteRequirementFitReportRepository(conn)
    report_repo.save(LOCAL_TENANT, _requirement_report(job_id, score_version=1, fit=7))
    report_repo.save(
        LOCAL_TENANT,
        _requirement_report(
            job_id,
            score_version=2,
            fit=9,
            assessments=(_requirement_assessment("r9"),),
        ),
    )

    latest = report_repo.load(LOCAL_TENANT, job_id)
    first = report_repo.load(LOCAL_TENANT, job_id, score_version=1)

    assert latest is not None
    assert latest.score_version == 2
    assert latest.resolved_fit_score == FitScore.create(9)
    assert latest.assessments[0].requirement_id == "r9"
    assert first is not None
    assert first.score_version == 1


def test_requirement_fit_report_scopes_same_job_id_by_tenant(conn: sqlite3.Connection) -> None:
    job_id = _job_id(8)
    other_tenant = TenantId("other")
    _seed_job(
        conn,
        job_id=job_id,
        url="https://example.com/jobs/local-requirement",
    )
    _seed_job(
        conn,
        tenant_id=other_tenant,
        job_id=job_id,
        url="https://example.com/jobs/other-requirement",
    )
    score_repo = SqliteScoreRepository(conn)
    score_repo.save(_build_score(job_id, fit=7))
    score_repo.save(_build_score(job_id, tenant_id=other_tenant, fit=9))
    report_repo = SqliteRequirementFitReportRepository(conn)
    report_repo.save(LOCAL_TENANT, _requirement_report(job_id, fit=7))
    report_repo.save(other_tenant, _requirement_report(job_id, fit=9))

    local_report = report_repo.load(LOCAL_TENANT, job_id)
    other_report = report_repo.load(other_tenant, job_id)

    assert local_report is not None
    assert other_report is not None
    assert local_report.resolved_fit_score == FitScore.create(7)
    assert other_report.resolved_fit_score == FitScore.create(9)


def test_requirement_fit_repository_rejects_url_shaped_job_ids(conn: sqlite3.Connection) -> None:
    url = "https://example.com/jobs/not-an-requirement-id"
    repo = SqliteRequirementFitReportRepository(conn)

    with pytest.raises(ValueError, match="JobId must be a canonical UUID"):
        repo.load(LOCAL_TENANT, JobId(url))
    with pytest.raises(ValueError, match="JobId must be a canonical UUID"):
        repo.save(LOCAL_TENANT, _requirement_report(JobId(url)))

    assert conn.execute("SELECT COUNT(*) FROM job_requirement_fit_reports").fetchone()[0] == 0


def test_save_increments_version(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(
        conn,
        job_id=_job_id(9),
        url="https://example.com/jobs/versioning",
    )
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(job_id, version=1, fit=7, keywords=("Python",)))
    repo.save(_build_score(job_id, version=2, fit=9, keywords=("FastAPI",)))

    latest = repo.load(LOCAL_TENANT, job_id)

    assert latest is not None
    assert latest.version == 2
    assert latest.fit_score.value == 9
    assert _score_keyword_rows(conn) == [
        (str(LOCAL_TENANT), str(job_id), 1, "python", "Python", 0),
        (str(LOCAL_TENANT), str(job_id), 2, "fastapi", "FastAPI", 0),
    ]


def test_save_rejects_version_skip_and_replay(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(
        conn,
        job_id=_job_id(10),
        url="https://example.com/jobs/version-conflict",
    )
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(job_id, version=1, fit=7))
    before_scores = conn.execute(
        "SELECT tenant_id, job_id, version, fit_score FROM job_scores"
    ).fetchall()
    before_keywords = _score_keyword_rows(conn)

    with pytest.raises(ScoreVersionConflict) as excinfo:
        repo.save(_build_score(job_id, version=3, fit=8))
    with pytest.raises(ScoreVersionConflict):
        repo.save(_build_score(job_id, version=1, fit=8))

    assert excinfo.value.expected == 2
    assert conn.execute(
        "SELECT tenant_id, job_id, version, fit_score FROM job_scores"
    ).fetchall() == before_scores
    assert _score_keyword_rows(conn) == before_keywords


def test_save_rolls_back_score_and_keyword_rows_after_downstream_failure(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = _seed_job(
        conn,
        job_id=_job_id(21),
        url="https://example.com/jobs/keyword-rollback",
    )
    repo = SqliteScoreRepository(conn)

    def fail_after_score_write(_: JobScore, *, commit: bool) -> int:
        raise RuntimeError("forced score downstream failure")

    monkeypatch.setattr(repo._staleness, "resolve_for_score", fail_after_score_write)

    with pytest.raises(RuntimeError, match="forced score downstream failure"):
        repo.save(_build_score(job_id))

    assert conn.execute("SELECT COUNT(*) FROM job_scores").fetchone()[0] == 0
    assert _score_keyword_rows(conn) == []


def test_list_pending_reads_canonical_enrichment_content_with_tenant_isolation(
    conn: sqlite3.Connection,
) -> None:
    scored_job_id = _seed_job(
        conn,
        job_id=_job_id(11),
        url="https://example.com/jobs/scored",
        full_description=None,
    )
    pending_job_id = _seed_job(
        conn,
        job_id=_job_id(12),
        url="https://example.com/jobs/pending",
        full_description=None,
    )
    legacy_only_job_id = _seed_job(
        conn,
        job_id=_job_id(13),
        url="https://example.com/jobs/legacy-only",
    )
    other_tenant = TenantId("other")
    other_pending_job_id = _seed_job(
        conn,
        tenant_id=other_tenant,
        job_id=_job_id(14),
        url="https://example.com/jobs/other-pending",
        full_description=None,
    )
    _seed_enrichment(conn, job_id=scored_job_id)
    _seed_enrichment(conn, job_id=pending_job_id)
    _seed_enrichment(conn, tenant_id=other_tenant, job_id=other_pending_job_id)
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(scored_job_id))

    assert repo.list_pending(LOCAL_TENANT) == [pending_job_id]
    assert repo.list_pending(other_tenant) == [other_pending_job_id]
    assert legacy_only_job_id not in repo.list_pending(LOCAL_TENANT)


def test_list_pending_respects_limit(conn: sqlite3.Connection) -> None:
    for seed in range(13, 16):
        job_id = _seed_job(
            conn,
            job_id=_job_id(seed),
            url=f"https://example.com/jobs/pending-{seed}",
        )
        _seed_enrichment(conn, job_id=job_id)

    assert len(SqliteScoreRepository(conn).list_pending(LOCAL_TENANT, limit=2)) == 2


def test_list_by_score_range_returns_latest_versions_for_current_tenant(
    conn: sqlite3.Connection,
) -> None:
    job_a = _seed_job(conn, job_id=_job_id(16), url="https://example.com/jobs/a")
    job_b = _seed_job(conn, job_id=_job_id(17), url="https://example.com/jobs/b")
    job_c = _seed_job(conn, job_id=_job_id(18), url="https://example.com/jobs/c")
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(job_a, version=1, fit=4))
    repo.save(_build_score(job_a, version=2, fit=8))
    repo.save(_build_score(job_b, version=1, fit=6))
    repo.save(_build_score(job_c, version=1, fit=2))

    matches = repo.list_by_score_range(LOCAL_TENANT, min_score=5, max_score=10)

    assert {(score.job_id, score.fit_score.value) for score in matches} == {
        (job_a, 8),
        (job_b, 6),
    }


def test_list_by_score_range_validates_inputs(conn: sqlite3.Connection) -> None:
    repo = SqliteScoreRepository(conn)

    with pytest.raises(ValueError):
        repo.list_by_score_range(LOCAL_TENANT, min_score=0)
    with pytest.raises(ValueError):
        repo.list_by_score_range(LOCAL_TENANT, min_score=8, max_score=4)


def test_score_correction_marks_and_resolves_only_tenant_scoped_staleness(
    conn: sqlite3.Connection,
) -> None:
    target_job_id = _seed_job(
        conn,
        job_id=_job_id(19),
        url="https://example.com/jobs/corrected",
    )
    comparable_job_id = _seed_job(
        conn,
        job_id=_job_id(20),
        url="https://example.com/jobs/comparable",
    )
    other_tenant = TenantId("other")
    _seed_job(
        conn,
        tenant_id=other_tenant,
        job_id=comparable_job_id,
        url="https://example.com/jobs/other-comparable",
    )
    policy_v1 = ScoreTrace(
        scoring_policy_id="local:scoring-policy-v1",
        scoring_policy_version=1,
    )
    policy_v2 = ScoreTrace(
        scoring_policy_id="local:scoring-policy-v2",
        scoring_policy_version=2,
    )
    repo = SqliteScoreRepository(conn)
    repo.save(_build_score(target_job_id, trace=policy_v1))
    repo.save(_build_score(comparable_job_id, trace=policy_v1))
    repo.save(_build_score(comparable_job_id, tenant_id=other_tenant, trace=policy_v1))

    CorrectScoreUseCase(
        repository=repo,
        policy_repository=SqliteScoringPolicyRepository(conn),
        staleness_repository=SqliteScoreStalenessRepository(conn),
    ).execute(
        tenant_id=LOCAL_TENANT,
        job_id=target_job_id,
        corrected_fit_score=FitScore.create(9),
        rationale="Manual review found stronger fit.",
        corrected_at="2026-07-31T00:00:00+00:00",
    )

    rows = conn.execute(
        """
        SELECT tenant_id, job_id, stale_reason, old_policy_version, new_policy_version, resolved
        FROM job_score_staleness
        ORDER BY tenant_id, job_id
        """
    ).fetchall()
    assert [tuple(row) for row in rows] == [
        (str(LOCAL_TENANT), str(comparable_job_id), "scoring_policy_changed", 1, 2, 0)
    ]
    stale_stage = conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'score'
        """,
        (str(LOCAL_TENANT), str(comparable_job_id)),
    ).fetchone()
    assert stale_stage["state"] == "stale"
    stale_event = conn.execute(
        """
        SELECT event_type FROM job_events
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY event_id DESC LIMIT 1
        """,
        (str(LOCAL_TENANT), str(comparable_job_id)),
    ).fetchone()
    assert stale_event["event_type"] == "ScoreMarkedStale"

    repo.save(_build_score(comparable_job_id, version=2, fit=8, trace=policy_v2))

    resolved = conn.execute(
        """
        SELECT resolved, resolved_by_score_version
        FROM job_score_staleness
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(comparable_job_id)),
    ).fetchone()
    assert tuple(resolved) == (1, 2)
