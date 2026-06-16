"""Phase 1: Python projection builder serves the canonical employer analysis.

The Python half of the cross-runtime projection parity (the TS half lives in
``apps/api/test/projections.test.ts``). Seeds canonical ``job_employer_analysis``
rows via the repository, runs the projection builder, and asserts the
``job_detail_projections.employer_analysis_json`` equals the canonical
``EmployerAnalysis.to_read_model()`` — proving the projection owner serves the
canonical record verbatim (D-09) and that "load latest" supersedes prior
generations (D-13).
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.analysis import (
    AnalysisAgreement,
    AnalysisFailure,
    EmployerAnalysis,
    JobAnalysis,
    JobAnalysisDraft,
    ReasonedKeyword,
    Requirement,
    compute_snapshot_hash,
)
from jobhunter.domain.scoring import (
    FitScore,
    RequirementArtifactCoverage,
    RequirementFitAssessment,
    RequirementFitReport,
    RequirementFitStatus,
    RequirementFitSummary,
    RequirementScoreContribution,
    RequirementTailoringDirective,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.materials import SqliteEmployerAnalysisRepository
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.infrastructure.scoring import SqliteRequirementFitReportRepository

JOB_URL = "https://example.com/jobs/event-driven"
JD = "Senior Event Engineer. Requires 5+ years Python. Kafka is a plus."


@pytest.fixture()
def conn(tmp_path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    connection = init_db(db_path)
    connection.execute(
        "INSERT INTO jobs (url, title, site) VALUES (?, ?, ?)",
        (JOB_URL, "Senior Event Engineer", "example"),
    )
    connection.commit()
    yield connection
    close_connection()


def _analysis(generation: int) -> EmployerAnalysis:
    canonical = JobAnalysis(
        role_framing="Own the event platform.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A hands-on platform owner.",
        requirements=[
            Requirement(
                id="r1",
                text="5+ years Python",
                tier="must_have",
                weight=0.9,
                evidence_span="5+ years Python",
            )
        ],
        keywords=[
            ReasonedKeyword(keyword="Python", evidence_span="5+ years Python", requirement_ref="r1")
        ],
    )
    return EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(JOB_URL),
        generation=generation,
        snapshot_hash=compute_snapshot_hash(JD),
        canonical=canonical,
        sub_analyses=(JobAnalysisDraft(model_id="claude-opus-4-8", **canonical.model_dump()),),
        failures=(AnalysisFailure(model_id="gpt-5.4", error="codex timeout"),),
        agreement=AnalysisAgreement(score=0.8, flagged_keywords=("kafka",)),
        legs_attempted=2,
    )


def _requirement_fit_report(score_version: int) -> RequirementFitReport:
    assessment = RequirementFitAssessment(
        requirement_id="r1",
        requirement_text="5+ years Python",
        tier="must_have",
        weight=0.9,
        job_evidence_span="5+ years Python",
        fit=RequirementFitStatus(
            kind="matched",
            evidence_ids=("ev-python",),
            strength="direct",
        ),
        contribution=RequirementScoreContribution(
            max_points=1.125,
            awarded_points=1.125,
            weighted_impact=1.125,
            rationale="Direct Python evidence covers r1.",
        ),
        tailoring=RequirementTailoringDirective(
            action="double_down",
            priority=0.9,
            allowed_evidence_ids=("ev-python",),
            target_keywords=("Python",),
            instruction="Keep Python evidence prominent.",
        ),
        artifact_coverage=RequirementArtifactCoverage(
            state="covered",
            bullet_count=1,
            examples=("Built Python event services.",),
        ),
    )
    return RequirementFitReport(
        job_id=JOB_URL,
        score_version=score_version,
        employer_analysis_generation=2,
        profile_snapshot_version=3,
        scoring_policy_version=4,
        formula_version="requirement-fit-v1",
        resolved_fit_score=FitScore.create(8),
        fit_band="strong",
        confidence="high",
        summary=RequirementFitSummary(
            weighted_fit=0.82,
            must_have_coverage=1.0,
            blocker_count=0,
            missing_high_weight_count=0,
        ),
        assessments=(assessment,),
    )


def test_projection_serves_latest_canonical_analysis_read_model(conn: sqlite3.Connection) -> None:
    repo = SqliteEmployerAnalysisRepository(conn)
    repo.save(_analysis(generation=1))
    latest = _analysis(generation=2)
    repo.save(latest)

    # Force a projection rebuild for the job.
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    conn.execute(
        """
        INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
        VALUES (?, 'tailor', 'EmployerAnalyzed', 'info', 'analyzed', ?, '{}')
        """,
        (JOB_URL, latest.created_at),
    )
    conn.commit()
    builder.refresh()

    row = conn.execute(
        "SELECT employer_analysis_json FROM job_detail_projections WHERE job_id = ?",
        (JOB_URL,),
    ).fetchone()
    assert row is not None
    served = json.loads(row["employer_analysis_json"])

    # The projection serves the LATEST generation's canonical read model verbatim.
    assert served == latest.to_read_model()
    assert served["generation"] == 2
    assert served["ensemble_completeness"] == "1/2"
    assert served["is_degraded"] is True
    assert served["requirements"][0]["tier"] == "must_have"
    assert served["failures"][0]["model_id"] == "gpt-5.4"


def test_projection_analysis_is_null_when_no_analysis_exists(conn: sqlite3.Connection) -> None:
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    conn.execute(
        """
        INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
        VALUES (?, 'score', 'JobScored', 'info', 'scored', '2026-05-04T12:00:00+00:00', '{}')
        """,
        (JOB_URL,),
    )
    conn.commit()
    builder.refresh()

    row = conn.execute(
        "SELECT employer_analysis_json FROM job_detail_projections WHERE job_id = ?",
        (JOB_URL,),
    ).fetchone()
    assert row is not None
    assert row["employer_analysis_json"] is None


def test_projection_serves_latest_requirement_fit_report_read_model(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteRequirementFitReportRepository(conn)
    repo.save(LOCAL_TENANT, _requirement_fit_report(score_version=1))
    latest = _requirement_fit_report(score_version=2)
    repo.save(LOCAL_TENANT, latest)

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    conn.execute(
        """
        INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
        VALUES (?, 'score', 'JobScored', 'info', 'scored', '2026-05-04T12:00:00+00:00', '{}')
        """,
        (JOB_URL,),
    )
    conn.commit()
    builder.refresh()

    row = conn.execute(
        "SELECT requirement_fit_report_json FROM job_detail_projections WHERE job_id = ?",
        (JOB_URL,),
    ).fetchone()
    assert row is not None
    served = json.loads(row["requirement_fit_report_json"])

    assert served == latest.to_read_model()
    assert served["scoreVersion"] == 2
    assert served["summary"]["weightedFit"] == 0.82
    assert served["assessments"][0]["fit"]["evidenceIds"] == ["ev-python"]


def test_projection_requirement_fit_report_is_null_when_no_report_exists(
    conn: sqlite3.Connection,
) -> None:
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    conn.execute(
        """
        INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
        VALUES (?, 'score', 'JobScored', 'info', 'scored', '2026-05-04T12:00:00+00:00', '{}')
        """,
        (JOB_URL,),
    )
    conn.commit()
    builder.refresh()

    row = conn.execute(
        "SELECT requirement_fit_report_json FROM job_detail_projections WHERE job_id = ?",
        (JOB_URL,),
    ).fetchone()
    assert row is not None
    assert row["requirement_fit_report_json"] is None
