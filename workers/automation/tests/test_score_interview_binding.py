"""Interview preparation reads only fit evidence for the selected score version."""

from __future__ import annotations

import json
from pathlib import Path

from jobctrl.database import close_connection, init_db
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.scoring import SqliteRequirementFitReportRepository, SqliteScoreRepository
from jobctrl.interview.activities import ANALYSIS_PROMPT_VERSION, _load_employer_and_fit_context
from tests.test_score_repository import _build_score, _job_id, _requirement_report, _seed_job


def test_interview_context_requires_report_for_current_score_and_keeps_history(tmp_path: Path) -> None:
    db_path = tmp_path / "owned.db"
    conn = init_db(db_path)
    try:
        job_id = _job_id(1273)
        _seed_job(conn, job_id=job_id, url="https://example.test/interview-synthetic")
        conn.execute(
            """INSERT INTO job_employer_analysis (
                tenant_id, job_id, generation, snapshot_hash, prompt_version,
                sdk_set_version, cache_key, role_framing, inferred_seniority,
                requirements_json, legs_attempted, legs_succeeded, created_at
            ) VALUES ('local', ?, 2, 'synthetic-hash', ?, 'synthetic-sdk', 'synthetic-cache',
                      'Synthetic role', 'senior', ?, 1, 1, '2026-01-01T00:00:00Z')""",
            (str(job_id), ANALYSIS_PROMPT_VERSION, json.dumps([{
                "id": "r1", "text": "Requirement r1", "tier": "must_have", "weight": 0.8,
                "evidence_span": "Requirement r1",
            }])),
        )
        conn.commit()
        scores = SqliteScoreRepository(conn)
        reports = SqliteRequirementFitReportRepository(conn)
        scores.save(_build_score(job_id, version=1))
        historical_report = _requirement_report(job_id, score_version=1)
        reports.save(LOCAL_TENANT, historical_report)

        # Control: an exact version-1 fit belongs to the current analysis and
        # profile and contributes its recorded evidence to preparation.
        _, fit, requirements = _load_employer_and_fit_context(conn, LOCAL_TENANT, job_id, 3)
        assert fit is not None and fit["scoreVersion"] == 1 and fit["status"] == "current"
        assert requirements[0]["evidenceIds"] == ["ev-r1"]

        # A historical database may contain a newer score with no fit report.
        # Do not associate version-1 evidence with version 2.
        scores.save(_build_score(job_id, version=2))
        _, fit, requirements = _load_employer_and_fit_context(conn, LOCAL_TENANT, job_id, 3)
        assert fit is None
        assert requirements[0]["evidenceIds"] == []
        assert "fitKind" not in requirements[0]
        assert reports.load(LOCAL_TENANT, job_id, score_version=1) == historical_report

        # Once the exact current report exists, the reader admits its evidence.
        current_report = _requirement_report(job_id, score_version=2)
        reports.save(LOCAL_TENANT, current_report)
        _, fit, requirements = _load_employer_and_fit_context(conn, LOCAL_TENANT, job_id, 3)
        assert fit is not None and fit["scoreVersion"] == 2 and fit["status"] == "current"
        assert requirements[0]["evidenceIds"] == ["ev-r1"]
        assert reports.load(LOCAL_TENANT, job_id, score_version=1) == historical_report
    finally:
        close_connection(db_path)
