"""ProjectionBuilder — watermark + backfill behaviour."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from jobhunter.domain.compensation import ReportedCompensationObservation, parse_posted_compensation
from jobhunter.database import close_connection, init_db
from jobhunter.infrastructure.compensation import SqliteMarketCompensationRepository, SqlitePostedCompensationRepository
from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus
from jobhunter.infrastructure.events.watermark import SqliteEventWatermarkRepository
from jobhunter.infrastructure.projections.projection_builder import (
    PROJECTION_NAME,
    ProjectionBuilder,
)
from jobhunter.state import record_job_event, utc_now


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def _seed_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, strategy, location, salary,
                          discovered_at, application_url, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (url, "Engineer", "ExampleCo", "jobspy", "Remote", "", utc_now(), url, "x"),
    )
    conn.commit()


def test_initial_watermark_is_zero(conn: sqlite3.Connection) -> None:
    repo = SqliteEventWatermarkRepository(conn)
    assert repo.get(PROJECTION_NAME) == 0


def test_refresh_advances_watermark(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/a")
    record_job_event(conn, "https://example.com/a", "discover", "JobDiscovered")
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()

    repo = SqliteEventWatermarkRepository(conn)
    last = repo.get(PROJECTION_NAME)
    assert last >= 1


def test_refresh_resumes_from_watermark(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/r1")
    record_job_event(conn, "https://example.com/r1", "discover", "JobDiscovered")
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()

    # Add another event for a new job; watermark should advance only by
    # the delta.
    repo = SqliteEventWatermarkRepository(conn)
    pre_watermark = repo.get(PROJECTION_NAME)
    _seed_job(conn, "https://example.com/r2")
    record_job_event(conn, "https://example.com/r2", "discover", "JobDiscovered")
    conn.commit()

    builder.refresh()
    post_watermark = repo.get(PROJECTION_NAME)
    assert post_watermark > pre_watermark


def test_backfill_from_empty(conn: sqlite3.Connection) -> None:
    """Initial backfill — existing jobs in the table get projected even if
    no events have ever been emitted (legacy / pre-DDD-migration data).
    """
    _seed_job(conn, "https://example.com/legacy-1")
    _seed_job(conn, "https://example.com/legacy-2")
    # No record_job_event calls.

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    rows = conn.execute(
        "SELECT job_id FROM job_list_projections ORDER BY job_id"
    ).fetchall()
    assert [row[0] for row in rows] == [
        "https://example.com/legacy-1",
        "https://example.com/legacy-2",
    ]


def test_evidence_usage_projection_inverts_profile_provenance_and_requirement_fit(
    conn: sqlite3.Connection,
) -> None:
    job_url = "https://example.com/evidence-map"
    _seed_job(conn, job_url)
    conn.execute(
        """
        INSERT INTO candidate_profile_experience_entries (
            tenant_id, profile_id, entry_id, position_index, date_range,
            title, company, location
        ) VALUES ('local', 'default', 'exp-platform', 0, '2024-2025',
                  'Senior Engineer', 'Acme', 'Remote')
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_achievement_evidence (
            tenant_id, profile_id, entry_id, evidence_index, evidence_id,
            source_text, scope, action, tools_json, metrics_json, outcome,
            seniority_signal, evidence_strength, claim_confidence,
            user_confirmed, tags_json
        ) VALUES (
            'local', 'default', 'exp-platform', 0, 'ev_platform',
            'Led a platform migration that reduced latency by 40%.',
            'Platform migration', 'Led migration', '["Python", "Postgres"]',
            '["40% latency reduction"]', 'Reduced latency', '',
            'verified', 0.95, 1, '["migration"]'
        )
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_skill_categories (
            tenant_id, profile_id, category_id, position_index, label
        ) VALUES ('local', 'default', 'backend', 0, 'Backend')
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_skill_items (
            tenant_id, profile_id, category_id, item_index, item_text
        ) VALUES ('local', 'default', 'backend', 0, 'Python')
        """
    )
    conn.execute(
        """
        INSERT INTO job_materials (
            job_url, generation, tenant_id, status, created_at, updated_at
        ) VALUES (?, 1, 'local', 'complete',
                  '2026-07-05T12:00:00Z', '2026-07-05T12:10:00Z')
        """,
        (job_url,),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            job_url, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, 1, 'tailored_resume', 'artifact-resume-1', 'approved',
                  '/tmp/resume.txt', 'text', 12, '{}', '2026-07-05T12:05:00Z')
        """,
        (job_url,),
    )
    conn.execute(
        """
        INSERT INTO job_bullet_provenance (
            job_url, generation, bullet_id, tenant_id, artifact_id, section,
            source_id, evidence_ids_json, requirement_ids_json,
            matched_keywords_json, transform_type, control, rationale,
            generated_text, position, created_at, coverage_json
        ) VALUES (
            ?, 1, 'experience:exp-platform#0', 'local', 'artifact-resume-1',
            'experience', 'exp-platform', '["ev_platform"]',
            '["req-platform"]', '["latency"]', 'reframe',
            'rephrase_allowed', 'Used profile evidence.',
            'Led migration and reduced latency 40%.', 0,
            '2026-07-05T12:10:00Z',
            '{"covered":["Python"],"declared":[],"missing":["Kubernetes"]}'
        )
        """,
        (job_url,),
    )
    conn.execute(
        """
        INSERT INTO job_requirement_fit_reports (
            job_url, score_version, tenant_id, employer_analysis_generation,
            profile_snapshot_version, scoring_policy_version, formula_version,
            resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES (
            ?, 2, 'local', 1, 1, 1, 'v1', 8, 'strong', 'high',
            '{"weighted_fit":0.8,"must_have_coverage":0.5,"blocker_count":0,"missing_high_weight_count":1}',
            '2026-07-05T12:20:00Z'
        )
        """,
        (job_url,),
    )
    conn.execute(
        """
        INSERT INTO job_requirement_fit_items (
            job_url, score_version, tenant_id, requirement_id, requirement_text,
            tier, weight, job_evidence_span, fit_json, contribution_json,
            tailoring_json, artifact_coverage_json, position
        ) VALUES (
            ?, 2, 'local', 'req-platform', 'Own platform migrations',
            'must_have', 0.8, 'platform migrations',
            '{"kind":"matched","evidence_ids":["ev_platform"],"strength":"direct"}',
            '{}', '{}',
            '{"state":"covered","source":"tailored_resume_bullet_provenance","bullet_count":1,"examples":["Led migration"]}',
            0
        )
        """,
        (job_url,),
    )
    conn.execute(
        """
        INSERT INTO job_requirement_fit_items (
            job_url, score_version, tenant_id, requirement_id, requirement_text,
            tier, weight, job_evidence_span, fit_json, contribution_json,
            tailoring_json, artifact_coverage_json, position
        ) VALUES (
            ?, 2, 'local', 'req-kubernetes', 'Run Kubernetes clusters',
            'must_have', 0.7, 'Kubernetes clusters',
            '{"kind":"missing","reason":"No Kubernetes profile evidence."}',
            '{}', '{}',
            '{"state":"missing_from_profile","source":"tailored_resume_bullet_provenance","bullet_count":0,"examples":[]}',
            1
        )
        """,
        (job_url,),
    )
    record_job_event(conn, job_url, "score", "JobScored")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    entry_row = conn.execute(
        """
        SELECT payload_json
          FROM evidence_usage_projections
         WHERE tenant_id = 'local'
           AND projection_kind = 'entry'
           AND evidence_id = 'ev_platform'
        """
    ).fetchone()
    assert entry_row is not None
    entry = json.loads(entry_row["payload_json"])
    assert entry["resumeUsages"][0]["artifactId"] == "artifact-resume-1"
    assert entry["resumeUsages"][0]["bulletId"] == "experience:exp-platform#0"
    assert entry["requirementUsages"][0]["requirementId"] == "req-platform"
    assert entry["freshness"]["evidenceDateRange"] == "2024-2025"
    assert entry["freshness"]["lastUsedAt"] == "2026-07-05T12:10:00Z"

    gap_rows = conn.execute(
        """
        SELECT payload_json
          FROM evidence_usage_projections
         WHERE tenant_id = 'local' AND projection_kind = 'gap'
         ORDER BY projection_id
        """
    ).fetchall()
    gaps = [json.loads(row["payload_json"]) for row in gap_rows]
    assert any(
        gap["kind"] == "missing_requirement"
        and gap["requirementId"] == "req-kubernetes"
        and gap["jobRefs"][0]["jobKey"] == job_url
        for gap in gaps
    )
    assert any(
        gap["kind"] == "missing_skill"
        and gap["demandedSkill"] == "Kubernetes"
        and gap["jobRefs"][0]["artifactId"] == "artifact-resume-1"
        for gap in gaps
    )


def test_evidence_map_excludes_soft_deleted_and_hidden_jobs(
    conn: sqlite3.Connection,
) -> None:
    """Regression for the R5 evidence-usage index: soft delete only writes a
    jobhunter_deleted_jobs tombstone (and hide only writes jobhunter_hidden_jobs),
    leaving the job_bullet_provenance / job_requirement_fit_items /
    artifact_list_projections rows in place. Those rows must not re-surface a
    removed job's title, employer, generated-text preview, usages, or gaps.
    """
    active_url = "https://example.com/jobs/active-role"
    deleted_url = "https://example.com/jobs/deleted-role"
    hidden_url = "https://example.com/jobs/hidden-role"

    conn.execute(
        """
        INSERT INTO candidate_profile_experience_entries (
            tenant_id, profile_id, entry_id, position_index, date_range,
            title, company, location
        ) VALUES ('local', 'default', 'exp-platform', 0, '2024-2025',
                  'Senior Engineer', 'Acme', 'Remote')
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_achievement_evidence (
            tenant_id, profile_id, entry_id, evidence_index, evidence_id,
            source_text, scope, action, tools_json, metrics_json, outcome,
            seniority_signal, evidence_strength, claim_confidence,
            user_confirmed, tags_json
        ) VALUES (
            'local', 'default', 'exp-platform', 0, 'ev_platform',
            'Led a platform migration that reduced latency by 40%.',
            'Platform migration', 'Led migration', '["Python", "Postgres"]',
            '["40% latency reduction"]', 'Reduced latency', '',
            'verified', 0.95, 1, '["migration"]'
        )
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_skill_categories (
            tenant_id, profile_id, category_id, position_index, label
        ) VALUES ('local', 'default', 'backend', 0, 'Backend')
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_skill_items (
            tenant_id, profile_id, category_id, item_index, item_text
        ) VALUES ('local', 'default', 'backend', 0, 'Python')
        """
    )

    # jobhunter_deleted_jobs / jobhunter_hidden_jobs are owned by the TS
    # write-model; create them here so the Python builder's _table_exists-guarded
    # exclusion joins engage.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jobhunter_deleted_jobs (
            job_url TEXT PRIMARY KEY,
            deleted_at TEXT NOT NULL,
            reason TEXT,
            restored_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jobhunter_hidden_jobs (
            job_url TEXT PRIMARY KEY,
            hidden_at TEXT NOT NULL,
            reason TEXT,
            unhidden_at TEXT
        )
        """
    )

    def seed_job_evidence(
        job_url: str,
        *,
        title: str,
        site: str,
        artifact_id: str,
        generated_text: str,
        created_at: str,
    ) -> None:
        conn.execute(
            """
            INSERT INTO jobs (url, title, site, strategy, location, salary,
                              discovered_at, application_url, description)
            VALUES (?, ?, ?, 'jobspy', 'Remote', '', ?, ?, 'x')
            """,
            (job_url, title, site, utc_now(), job_url),
        )
        conn.execute(
            """
            INSERT INTO job_materials (
                job_url, generation, tenant_id, status, created_at, updated_at
            ) VALUES (?, 1, 'local', 'complete',
                      '2026-07-05T12:00:00Z', '2026-07-05T12:10:00Z')
            """,
            (job_url,),
        )
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                job_url, generation, artifact_type, artifact_id, status, path,
                render_format, size_bytes, metadata_json, created_at
            ) VALUES (?, 1, 'tailored_resume', ?, 'approved',
                      '/tmp/resume.txt', 'text', 12, '{}', '2026-07-05T12:05:00Z')
            """,
            (job_url, artifact_id),
        )
        conn.execute(
            """
            INSERT INTO job_bullet_provenance (
                job_url, generation, bullet_id, tenant_id, artifact_id, section,
                source_id, evidence_ids_json, requirement_ids_json,
                matched_keywords_json, transform_type, control, rationale,
                generated_text, position, created_at, coverage_json
            ) VALUES (
                ?, 1, 'experience:exp-platform#0', 'local', ?,
                'experience', 'exp-platform', '["ev_platform"]',
                '["req-platform"]', '["latency"]', 'reframe',
                'rephrase_allowed', 'Used profile evidence.',
                ?, 0, ?,
                '{"covered":["Python"],"declared":[],"missing":["Kubernetes"]}'
            )
            """,
            (job_url, artifact_id, generated_text, created_at),
        )
        conn.execute(
            """
            INSERT INTO job_requirement_fit_reports (
                job_url, score_version, tenant_id, employer_analysis_generation,
                profile_snapshot_version, scoring_policy_version, formula_version,
                resolved_fit_score, fit_band, confidence, summary_json, created_at
            ) VALUES (
                ?, 2, 'local', 1, 1, 1, 'v1', 8, 'strong', 'high',
                '{"weighted_fit":0.8,"must_have_coverage":0.5,"blocker_count":0,"missing_high_weight_count":1}',
                '2026-07-05T12:20:00Z'
            )
            """,
            (job_url,),
        )
        conn.execute(
            """
            INSERT INTO job_requirement_fit_items (
                job_url, score_version, tenant_id, requirement_id, requirement_text,
                tier, weight, job_evidence_span, fit_json, contribution_json,
                tailoring_json, artifact_coverage_json, position
            ) VALUES (
                ?, 2, 'local', 'req-platform', 'Own platform migrations',
                'must_have', 0.8, 'platform migrations',
                '{"kind":"matched","evidence_ids":["ev_platform"],"strength":"direct"}',
                '{}', '{}',
                '{"state":"covered","source":"tailored_resume_bullet_provenance","bullet_count":1,"examples":["Led migration"]}',
                0
            )
            """,
            (job_url,),
        )
        conn.execute(
            """
            INSERT INTO job_requirement_fit_items (
                job_url, score_version, tenant_id, requirement_id, requirement_text,
                tier, weight, job_evidence_span, fit_json, contribution_json,
                tailoring_json, artifact_coverage_json, position
            ) VALUES (
                ?, 2, 'local', 'req-kubernetes', 'Run Kubernetes clusters',
                'must_have', 0.7, 'Kubernetes clusters',
                '{"kind":"missing","reason":"No Kubernetes profile evidence."}',
                '{}', '{}',
                '{"state":"missing_from_profile","source":"tailored_resume_bullet_provenance","bullet_count":0,"examples":[]}',
                1
            )
            """,
            (job_url,),
        )
        record_job_event(conn, job_url, "score", "JobScored")

    seed_job_evidence(
        active_url,
        title="Active Platform Role",
        site="ActiveCorp",
        artifact_id="artifact-active",
        generated_text="ACTIVE-bullet reduced latency 40%.",
        created_at="2026-07-05T12:10:00Z",
    )
    seed_job_evidence(
        deleted_url,
        title="Deleted Platform Role",
        site="DeletedCorp",
        artifact_id="artifact-deleted",
        generated_text="DELETED-bullet should never surface.",
        created_at="2026-07-04T12:10:00Z",
    )
    seed_job_evidence(
        hidden_url,
        title="Hidden Platform Role",
        site="HiddenCorp",
        artifact_id="artifact-hidden",
        generated_text="HIDDEN-bullet should never surface.",
        created_at="2026-07-03T12:10:00Z",
    )

    conn.execute(
        "INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at, reason, restored_at) "
        "VALUES (?, '2026-07-05T13:00:00Z', 'user delete', NULL)",
        (deleted_url,),
    )
    conn.execute(
        "INSERT INTO jobhunter_hidden_jobs (job_url, hidden_at, reason, unhidden_at) "
        "VALUES (?, '2026-07-05T13:00:00Z', 'user hide', NULL)",
        (hidden_url,),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    rows = conn.execute(
        """
        SELECT projection_kind, payload_json
          FROM evidence_usage_projections
         WHERE tenant_id = 'local'
           AND projection_kind IN ('entry', 'gap')
        """
    ).fetchall()
    referenced_job_keys: set[str] = set()
    serialized = ""
    for row in rows:
        payload_json = row["payload_json"]
        serialized += payload_json
        payload = json.loads(payload_json)
        if row["projection_kind"] == "entry":
            for key in ("resumeUsages", "requirementUsages", "coverageUsages"):
                for usage in payload.get(key, []):
                    referenced_job_keys.add(usage["jobKey"])
        else:
            for ref in payload.get("jobRefs", []):
                referenced_job_keys.add(ref["jobKey"])

    # The live job still populates the map (positive control) ...
    assert active_url in referenced_job_keys
    # ... while the soft-deleted and hidden jobs are fully excluded.
    assert deleted_url not in referenced_job_keys
    assert hidden_url not in referenced_job_keys

    # No removed job's title, employer, or generated-text preview may leak
    # through any evidence field.
    for leaked in (
        "Deleted Platform Role",
        "DeletedCorp",
        "DELETED-bullet",
        "Hidden Platform Role",
        "HiddenCorp",
        "HIDDEN-bullet",
    ):
        assert leaked not in serialized
    assert "ACTIVE-bullet" in serialized


def test_job_projection_uses_explicit_company_before_source(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        INSERT INTO jobs (url, title, company, site, strategy, location, salary,
                          discovered_at, application_url, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "https://www.linkedin.com/jobs/view/1",
            "Head of Engineering",
            "Keyrock",
            "linkedin",
            "jobspy",
            "Barcelona, Spain",
            "",
            utc_now(),
            "https://www.linkedin.com/jobs/view/1",
            "x",
        ),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT employer FROM job_list_projections WHERE job_id = ?",
        ("https://www.linkedin.com/jobs/view/1",),
    ).fetchone()
    assert row is not None
    assert row[0] == "Keyrock"


def test_projects_compensation_summary_and_audit_json(conn: sqlite3.Connection) -> None:
    job_url = "https://example.com/compensation"
    _seed_job(conn, job_url)
    conn.execute("UPDATE jobs SET salary = ? WHERE url = ?", ("USD 70000-90000/year", job_url))
    SqlitePostedCompensationRepository(conn).save_fact(
        parse_posted_compensation(
            "USD 70000-90000/year",
            job_url=job_url,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    SqliteMarketCompensationRepository(conn).estimate_and_save_job(
        job_url=job_url,
        title="Senior Software Developer",
        company="ExampleCo",
        location="Madrid, Spain",
        observations=(
            ReportedCompensationObservation(
                source_id="levels_fyi",
                company_name="ExampleCo",
                role_title="Senior Software Developer",
                level_label="Senior",
                company_tier="tier_2_ambitious",
                location="Remote Europe",
                minimum_amount=118_000,
                maximum_amount=142_000,
                release_year=2026,
                sample_count=4,
                attribution="Levels.fyi reported compensation data",
            ),
            ReportedCompensationObservation(
                source_id="glassdoor",
                company_name="ExampleCo",
                role_title="Senior Software Developer",
                level_label="Senior",
                company_tier="tier_2_ambitious",
                location="Madrid, Spain",
                minimum_amount=112_000,
                maximum_amount=136_000,
                release_year=2026,
                sample_count=3,
                attribution="Glassdoor reported compensation data",
            ),
        ),
        estimated_at="2026-06-19T10:01:00Z",
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        """
        SELECT salary, compensation_summary_json
        FROM job_list_projections
        WHERE job_id = ?
        """,
        (job_url,),
    ).fetchone()
    assert row is not None
    assert row["salary"] == "USD 70000-90000/year"
    summary = json.loads(row["compensation_summary_json"])
    assert summary["posted"]["recordStatus"] == "recorded"
    assert summary["posted"]["displayRange"] == "USD 70000-90000/year"
    assert summary["posted"]["range"]["annualizedMinimumEur"] == 64_400
    assert summary["posted"]["range"]["annualizedMaximumEur"] == 82_800
    assert summary["market"]["recordStatus"] == "recorded"
    assert summary["market"]["sourceKind"] == "reported_company_role_market"
    assert summary["market"]["displayRange"] == "EUR 112000-142000/year"
    assert summary["market"]["range"]["annualizedMinimumEur"] == 112_000
    assert summary["market"]["range"]["annualizedMaximumEur"] == 142_000
    assert summary["market"]["confidenceScore"] == 0.78
    assert summary["market"]["sourceCount"] == 2
    assert summary["market"]["sampleCount"] == 7

    detail = conn.execute(
        """
        SELECT compensation_audit_json
        FROM job_detail_projections
        WHERE job_id = ?
        """,
        (job_url,),
    ).fetchone()
    assert detail is not None
    audit = json.loads(detail["compensation_audit_json"])
    assert audit["posted"]["fact"]["sourceText"] == "USD 70000-90000/year"
    assert {
        source["sourceId"] for source in audit["market"]["estimate"]["sources"]
    } == {"levels_fyi", "glassdoor"}
    assert audit["market"]["estimate"]["companyName"] == "ExampleCo"
    assert audit["market"]["estimate"]["matchScope"] == "exact_company_role"
    assert "Glassdoor" in json.dumps(audit)
    assert "/Users/" not in json.dumps(audit)


def _insert_score(
    conn: sqlite3.Connection,
    job_url: str,
    *,
    fit_score: int,
    scored_at: str,
    criteria_json: str,
    trace_json: str,
    correction_json: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (job_url, version, tenant_id, fit_score,
                                breakdown_json, keywords_json, scored_at,
                                correction_json, criteria_json, trace_json)
        VALUES (?, 1, 'local', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_url,
            fit_score,
            json.dumps(
                {
                    "technical_fit": 9,
                    "experience_fit": 7,
                    "role_fit": 8,
                    "reasoning": "Strong fit",
                }
            ),
            json.dumps(["python"]),
            scored_at,
            correction_json,
            criteria_json,
            trace_json,
        ),
    )


def test_projects_score_audit_columns_from_job_scores(conn: sqlite3.Connection) -> None:
    """Score audit columns (rubric criteria + prompt/model trace) are projected
    verbatim from ``job_scores`` into both the list and detail projections.

    Regression guard for the read-model NULL bug: the Python builder must write
    the same three audit columns the TS builder does, sourced byte-for-byte from
    the latest ``job_scores`` row, so the score-audit surface is never NULL for a
    normally-scored job even when the Python event handler owns the refresh.
    """
    url = "https://example.com/jobs/score-audit"
    _seed_job(conn, url)
    criteria_json = json.dumps(
        {
            "formula_version": "score-v3",
            "rubric": {"technical_fit": "Depth of required stack"},
            "weights": {"experience_fit": 0.3, "role_fit": 0.2, "technical_fit": 0.5},
        },
        sort_keys=True,
    )
    trace_json = json.dumps(
        {
            "correction_history": [],
            "model": "claude-opus",
            "parser_warnings": [],
            "prompt_version": "score-prompt-v7",
            "schema_version": "score-schema-v2",
            "scoring_policy_version": 3,
        },
        sort_keys=True,
    )
    _insert_score(
        conn,
        url,
        fit_score=8,
        scored_at="2026-06-20T10:00:00+00:00",
        criteria_json=criteria_json,
        trace_json=trace_json,
        correction_json=None,
    )
    record_job_event(conn, url, "score", "JobScored")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    list_row = conn.execute(
        """
        SELECT score_criteria_json, score_trace_json, score_correction_json
        FROM job_list_projections WHERE job_id = ?
        """,
        (url,),
    ).fetchone()
    assert list_row is not None
    assert list_row["score_criteria_json"] == criteria_json
    assert list_row["score_trace_json"] == trace_json
    assert list_row["score_correction_json"] is None
    assert json.loads(list_row["score_criteria_json"])["formula_version"] == "score-v3"
    assert json.loads(list_row["score_trace_json"])["scoring_policy_version"] == 3

    detail_row = conn.execute(
        """
        SELECT score_criteria_json, score_trace_json, score_correction_json
        FROM job_detail_projections WHERE job_id = ?
        """,
        (url,),
    ).fetchone()
    assert detail_row is not None
    assert detail_row["score_criteria_json"] == criteria_json
    assert detail_row["score_trace_json"] == trace_json
    assert detail_row["score_correction_json"] is None


def test_projects_score_correction_json_when_correction_exists(
    conn: sqlite3.Connection,
) -> None:
    """A self-correction on the latest score row is projected verbatim into
    ``score_correction_json`` for both projections, preserving the correction
    history the score-audit surface renders.
    """
    url = "https://example.com/jobs/score-correction"
    _seed_job(conn, url)
    correction_json = json.dumps(
        {
            "adjustments": [
                {"dimension": "experience_fit", "from": 9, "note": "overstated tenure", "to": 6}
            ],
            "corrected_fit_score": 7,
            "original_fit_score": 9,
            "reason": "adversarial_self_correction",
        },
        sort_keys=True,
    )
    _insert_score(
        conn,
        url,
        fit_score=7,
        scored_at="2026-06-20T11:00:00+00:00",
        criteria_json=json.dumps({"formula_version": "score-v3"}, sort_keys=True),
        trace_json=json.dumps({"prompt_version": "score-prompt-v7"}, sort_keys=True),
        correction_json=correction_json,
    )
    record_job_event(conn, url, "score", "JobScored")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    list_row = conn.execute(
        "SELECT score_correction_json FROM job_list_projections WHERE job_id = ?",
        (url,),
    ).fetchone()
    assert list_row is not None
    assert list_row["score_correction_json"] == correction_json

    detail_row = conn.execute(
        "SELECT score_correction_json FROM job_detail_projections WHERE job_id = ?",
        (url,),
    ).fetchone()
    assert detail_row is not None
    assert detail_row["score_correction_json"] == correction_json
    assert json.loads(detail_row["score_correction_json"])["corrected_fit_score"] == 7


def test_score_audit_backfill_repopulates_existing_null_rows(conn: sqlite3.Connection) -> None:
    """One-time backfill repopulates audit columns for jobs scored before the
    Python builder learned to project them.

    Reproduces the production state on an existing DB: a projection row written
    by the old Python builder (audit columns NULL), a canonical ``job_scores``
    row, and a watermark already advanced past the ``JobScored`` event (the
    Python-first consumption that blocks the TS refresher). ``refresh()`` must
    rebuild the row and populate the three audit columns from ``job_scores``
    with no new score event. Without the backfill the row stays NULL because the
    columns already exist, so the schema-migration reset never fires.
    """
    url = "https://example.com/jobs/backfill-existing-null"
    _seed_job(conn, url)
    criteria_json = json.dumps({"formula_version": "score-v3"}, sort_keys=True)
    trace_json = json.dumps({"prompt_version": "score-prompt-v7"}, sort_keys=True)
    correction_json = json.dumps({"reason": "adversarial_self_correction"}, sort_keys=True)
    _insert_score(
        conn,
        url,
        fit_score=8,
        scored_at="2026-06-20T10:00:00+00:00",
        criteria_json=criteria_json,
        trace_json=trace_json,
        correction_json=correction_json,
    )
    record_job_event(conn, url, "score", "JobScored")
    conn.commit()

    # Pre-fix projection rows: the old Python upsert never wrote the audit
    # columns, so they default to NULL.
    conn.execute(
        "INSERT INTO job_list_projections (tenant_id, job_id, title, fit_score) "
        "VALUES ('local', ?, 'Engineer', 8)",
        (url,),
    )
    conn.execute(
        "INSERT INTO job_detail_projections (tenant_id, job_id, description_preview) "
        "VALUES ('local', ?, 'Short job description')",
        (url,),
    )
    # Watermark already advanced past the score event: no event-driven rebuild.
    latest_event_id = conn.execute("SELECT MAX(event_id) FROM job_events").fetchone()[0]
    SqliteEventWatermarkRepository(conn).set(PROJECTION_NAME, int(latest_event_id))
    conn.commit()

    pre = conn.execute(
        "SELECT score_criteria_json FROM job_list_projections WHERE job_id = ?",
        (url,),
    ).fetchone()
    assert pre["score_criteria_json"] is None

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    list_row = conn.execute(
        """
        SELECT score_criteria_json, score_trace_json, score_correction_json
        FROM job_list_projections WHERE job_id = ?
        """,
        (url,),
    ).fetchone()
    assert list_row is not None
    assert list_row["score_criteria_json"] == criteria_json
    assert list_row["score_trace_json"] == trace_json
    assert list_row["score_correction_json"] == correction_json

    detail_row = conn.execute(
        """
        SELECT score_criteria_json, score_trace_json, score_correction_json
        FROM job_detail_projections WHERE job_id = ?
        """,
        (url,),
    ).fetchone()
    assert detail_row is not None
    assert detail_row["score_criteria_json"] == criteria_json
    assert detail_row["score_trace_json"] == trace_json
    assert detail_row["score_correction_json"] == correction_json


def test_score_audit_backfill_runs_at_most_once(conn: sqlite3.Connection) -> None:
    """The backfill marker gates the scan so it runs once per DB. A NULL-audit
    row that appears after the marker is set is not re-backfilled, keeping steady
    state cheap (no per-refresh O(jobs) resync).
    """
    first = "https://example.com/jobs/backfill-marker-first"
    _seed_job(conn, first)
    conn.commit()

    # First refresh materialises the projection and sets the backfill marker.
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    marker = conn.execute(
        "SELECT COUNT(*) FROM projection_backfills WHERE name LIKE 'score_audit_columns_v1%'"
    ).fetchone()[0]
    assert marker == 1

    # A stray NULL-audit projection row with a canonical score appears AFTER the
    # marker is set. With the watermark advanced, the next refresh must leave it
    # untouched — the one-time scan does not run again.
    later = "https://example.com/jobs/backfill-marker-later"
    _seed_job(conn, later)
    _insert_score(
        conn,
        later,
        fit_score=6,
        scored_at="2026-06-20T12:00:00+00:00",
        criteria_json=json.dumps({"formula_version": "score-v3"}, sort_keys=True),
        trace_json=json.dumps({"prompt_version": "score-prompt-v7"}, sort_keys=True),
        correction_json=None,
    )
    conn.execute(
        "INSERT INTO job_list_projections (tenant_id, job_id, title, fit_score) "
        "VALUES ('local', ?, 'Engineer', 6)",
        (later,),
    )
    record_job_event(conn, later, "score", "JobScored")
    latest_event_id = conn.execute("SELECT MAX(event_id) FROM job_events").fetchone()[0]
    SqliteEventWatermarkRepository(conn).set(PROJECTION_NAME, int(latest_event_id))
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT score_criteria_json FROM job_list_projections WHERE job_id = ?",
        (later,),
    ).fetchone()
    assert row is not None
    assert row["score_criteria_json"] is None


def test_feedback_only_history_rebuilds_source_quality(conn: sqlite3.Connection) -> None:
    record_job_event(
        conn,
        "job-1",
        "discover",
        "DiscoveryFeedbackRecorded",
        payload={
            "feedback_id": "feedback-1",
            "job_id": "job-1",
            "source_id": "greenhouse:acme",
            "kind": "bad_source",
            "recorded_at": utc_now(),
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        """
        SELECT observed_jobs, detail_failure_count, last_error_class
        FROM source_quality_stats
        WHERE source_id = ?
        """,
        ("greenhouse:acme",),
    ).fetchone()
    assert row is not None
    assert row[0] == 1
    assert row[1] == 1
    assert row[2] == "user_bad_source"


def test_subscribes_to_event_bus(conn: sqlite3.Connection) -> None:
    """Wiring the builder to the bus refreshes projections on publish."""
    _seed_job(conn, "https://example.com/bus")
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    bus = InProcessEventBus()
    builder.subscribe_to(bus)

    # Publish via the bus AFTER recording the event in the table.
    record_job_event(conn, "https://example.com/bus", "discover", "JobDiscovered")
    conn.commit()
    from jobhunter.domain.events.base import create_domain_event
    from jobhunter.domain.tenant import LOCAL_TENANT

    bus.publish(create_domain_event("JobDiscovered", LOCAL_TENANT, {"job_url": "https://example.com/bus"}))

    row = conn.execute(
        "SELECT job_id FROM job_list_projections WHERE job_id = ?",
        ("https://example.com/bus",),
    ).fetchone()
    assert row is not None


def test_unsubscribe_stops_refreshes(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/sub")
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    bus = InProcessEventBus()
    sub = builder.subscribe_to(bus)
    sub.unsubscribe()

    from jobhunter.domain.events.base import create_domain_event
    from jobhunter.domain.tenant import LOCAL_TENANT

    bus.publish(create_domain_event("JobDiscovered", LOCAL_TENANT, {"job_url": "https://example.com/sub"}))

    rows = conn.execute("SELECT COUNT(*) FROM job_list_projections").fetchone()
    # Builder has not been called manually; nothing in projections yet.
    assert rows[0] == 0
