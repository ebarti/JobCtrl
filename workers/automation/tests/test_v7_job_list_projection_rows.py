"""Contract tests for complete v7 job-list row serialization."""

from __future__ import annotations

import json
import sqlite3

from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v7_job_list_projection_rows import (
    JOB_LIST_PROJECTIONS_COLUMNS,
    _projection_rows,
)

_JOB_ID = "00000000-0000-4000-8000-000000000001"
_JOB_URL = "https://jobs.example/platform-engineer"
_MIGRATION_AT = "2026-07-31T09:00:00+00:00"
_INERT_CONTEXT_JSON = '{"userContext":"Attack vectors:\\nPrompt injection"}'


def _candidate() -> sqlite3.Connection:
    candidate = sqlite3.connect(":memory:")
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    candidate.execute(
        """
        INSERT INTO jobs (
            url, title, company, salary, description, location, site, strategy,
            discovered_at, full_description, application_url, apply_status,
            applied_at, tenant_id, job_id
        ) VALUES (?, 'Platform Engineer', '', '€95k', 'Short summary',
                  'MD, ES, remoto', 'greenhouse', 'focused',
                  '2026-07-30T09:00:00+00:00', 'Original description',
                  NULL, 'applied', '2026-07-30T12:00:00+00:00', 'local', ?)
        """,
        (_JOB_URL, _JOB_ID),
    )
    candidate.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value, is_current,
            first_seen_at, last_seen_at, retired_at
        ) VALUES ('local', ?, 'posting_url', ?, 1, ?, ?, NULL)
        """,
        (_JOB_ID, _JOB_URL, _MIGRATION_AT, _MIGRATION_AT),
    )
    candidate.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description,
            application_url, enriched_at, extraction_tier, attempts_json, updated_at
        ) VALUES ('local', ?, 'succeeded', 'Canonical enriched description',
                  'https://boards.greenhouse.io/exampleco/jobs/42', ?, 'html', '[]', ?)
        """,
        (_JOB_ID, _MIGRATION_AT, _MIGRATION_AT),
    )
    candidate.executemany(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
            scored_at, correction_json, criteria_json, trace_json
        ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                _JOB_ID,
                1,
                4,
                '{"reasoning":"older score"}',
                '["older"]',
                "2026-07-30T09:30:00+00:00",
                '{"old":true}',
                '{"old":true}',
                '{"old":true}',
            ),
            (
                _JOB_ID,
                3,
                8,
                '{"technical_fit":9,"experience_fit":8,"role_fit":7,'
                '"reasoning":"canonical score","matched_signals":["Python"]}',
                '["Python"]',
                "2026-07-30T10:00:00+00:00",
                '{"opaque":{"repair":"keep-exact"}}',
                '{"opaque":{"criterion":"keep-exact"}}',
                '{"opaque":{"trace":"keep-exact"}}',
            ),
        ],
    )
    candidate.executemany(
        """
        INSERT INTO job_requirement_fit_reports (
            tenant_id, job_id, score_version, employer_analysis_generation,
            profile_snapshot_version, scoring_policy_version, formula_version,
            resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES ('local', ?, ?, 1, 1, 1, 'requirement-fit-v1', ?, ?, 'high', '{}', ?)
        """,
        [
            (_JOB_ID, 1, 4, "poor", _MIGRATION_AT),
            (_JOB_ID, 3, 8, "strong", _MIGRATION_AT),
        ],
    )
    candidate.executemany(
        """
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, attempt_count, max_attempts,
            updated_at, error_code, error_message, retryable, blocked_by_json,
            next_action, version
        ) VALUES ('local', ?, ?, ?, 1, 3, ?, ?, ?, 1, '[]', ?, 1)
        """,
        [
            (_JOB_ID, "discover", "succeeded", _MIGRATION_AT, None, None, None),
            (_JOB_ID, "enrich", "skipped", _MIGRATION_AT, None, None, None),
            (_JOB_ID, "score", "succeeded", _MIGRATION_AT, None, None, None),
            (
                _JOB_ID,
                "tailor",
                "failed",
                _MIGRATION_AT,
                "quality_gate",
                "needs revision",
                "retry_tailor",
            ),
        ],
    )
    _seed_materials(candidate)
    _seed_mutable_template_drift(candidate)
    candidate.executemany(
        """
        INSERT INTO artifact_list_projections (
            artifact_id, tenant_id, job_id, job_title, job_employer,
            artifact_type, status, local_path
        ) VALUES (?, 'local', ?, 'Cache title', 'Cache employer', ?, ?, ?)
        """,
        [
            ("artifact-active", _JOB_ID, "tailored_resume", "approved", "/tmp/resume.txt"),
            ("artifact-pdf", _JOB_ID, "resume_pdf", "approved", "/tmp/resume.pdf"),
            ("artifact-suppressed", _JOB_ID, "debug", "suppressed", "/tmp/debug.txt"),
        ],
    )
    candidate.execute(
        """
        INSERT INTO job_list_projections (tenant_id, job_id, title)
        VALUES ('local', ?, 'STALE URL CACHE')
        """,
        (_JOB_URL,),
    )
    candidate.execute(
        """
        INSERT INTO apply_run_projections (
            run_id, tenant_id, job_id, job_title, job_employer, status, result,
            dry_run, started_at, finished_at, events_json
        ) VALUES ('run-latest', 'local', ?, 'Ignored title', 'Ignored employer',
                  'succeeded', 'applied', 0, '2026-07-30T13:00:00+00:00',
                  '2026-07-30T13:05:00+00:00', '[]')
        """,
        (_JOB_ID,),
    )
    candidate.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (
            tenant_id, job_id, deleted_at, reason, restored_at
        ) VALUES ('local', ?, '2026-07-30T14:00:00+00:00', 'duplicate',
                  '2026-07-30T13:59:00+00:00')
        """,
        (_JOB_ID,),
    )
    return candidate


def _seed_materials(candidate: sqlite3.Connection) -> None:
    accepted_metadata = json.dumps(
        {
            "resume_template": {
                "templateId": "accepted-template",
                "templateName": "Accepted template",
            },
            "tailoringPolicyVersion": 7,
        }
    )
    candidate.executemany(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at,
            metadata_json
        ) VALUES ('local', ?, ?, ?, ?, ?, ?)
        """,
        [
            (_JOB_ID, 4, "complete", _MIGRATION_AT, _MIGRATION_AT, _INERT_CONTEXT_JSON),
            (_JOB_ID, 5, "resume_in_progress", _MIGRATION_AT, _MIGRATION_AT, _INERT_CONTEXT_JSON),
        ],
    )
    candidate.executemany(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status,
            path, render_format, size_bytes, metadata_json, created_at, superseded_at
        ) VALUES ('local', ?, ?, ?, ?, ?, ?, 'text', 100, ?, ?, NULL)
        """,
        [
            (
                _JOB_ID,
                4,
                "tailored_resume",
                "accepted-resume",
                "approved",
                "/tmp/accepted-resume.txt",
                accepted_metadata,
                _MIGRATION_AT,
            ),
            (
                _JOB_ID,
                4,
                "cover_letter",
                "accepted-cover",
                "approved",
                "/tmp/accepted-cover.txt",
                None,
                _MIGRATION_AT,
            ),
            (
                _JOB_ID,
                4,
                "resume_pdf",
                "accepted-resume-pdf",
                "approved",
                "/tmp/accepted-resume.pdf",
                None,
                _MIGRATION_AT,
            ),
            (
                _JOB_ID,
                5,
                "tailored_resume",
                "rejected-resume",
                "rejected",
                "/tmp/rejected-resume.txt",
                json.dumps(
                    {
                        "resume_template": {
                            "templateId": "rejected-template",
                            "templateName": "Rejected template",
                        },
                        "tailoringPolicyVersion": 99,
                    }
                ),
                _MIGRATION_AT,
            ),
        ],
    )


def _seed_mutable_template_drift(candidate: sqlite3.Connection) -> None:
    candidate.execute(
        """
        INSERT INTO resume_templates (
            tenant_id, template_id, display_name, status, built_in, created_at, updated_at
        ) VALUES ('local', 'mutable-template', 'Mutable default', 'active', 0, ?, ?)
        """,
        (_MIGRATION_AT, _MIGRATION_AT),
    )
    candidate.execute(
        """
        INSERT INTO resume_template_versions (
            tenant_id, version_id, template_id, version_number, display_name,
            status, theme_json, layout_json, content_hash, created_at
        ) VALUES ('local', 'mutable-version', 'mutable-template', 1, 'Mutable default',
                  'active', '{}', '{}', 'hash', ?)
        """,
        (_MIGRATION_AT,),
    )
    candidate.execute(
        """
        INSERT INTO resume_template_defaults (
            tenant_id, profile_id, template_id, version_id, updated_at
        ) VALUES ('local', 'default', 'mutable-template', 'mutable-version', ?)
        """,
        (_MIGRATION_AT,),
    )
    candidate.execute(
        """
        INSERT INTO job_resume_template_assignments (
            tenant_id, job_id, template_id, version_id, updated_at
        ) VALUES ('local', ?, 'mutable-template', 'mutable-version', ?)
        """,
        (_JOB_ID, _MIGRATION_AT),
    )


def _row(candidate: sqlite3.Connection) -> dict[str, object]:
    rows = _projection_rows(candidate, _MIGRATION_AT)
    assert len(rows) == 1
    assert len(rows[0]) == 41
    assert len(JOB_LIST_PROJECTIONS_COLUMNS) == 41
    return dict(zip(JOB_LIST_PROJECTIONS_COLUMNS, rows[0], strict=True))


def test_serializes_every_v7_column_from_canonical_uuid_rows() -> None:
    candidate = _candidate()
    try:
        row = _row(candidate)

        assert row["job_id"] == _JOB_ID
        assert row["job_id"] != _JOB_URL
        assert "STALE URL CACHE" not in json.dumps(row)
        assert row["title"] == "Platform Engineer"
        assert row["employer"] == "Unknown company"
        assert row["source"] == "greenhouse"
        assert row["location"] == "Community of Madrid, Spain (Remote)"
        assert row["full_description"] == "Canonical enriched description"
        assert row["fit_score"] == 8
        assert row["fit_band"] == "strong"
        assert row["score_version"] == 3
        assert row["score_reasoning"] == "canonical score"
        assert row["score_criteria_json"] == '{"opaque":{"criterion":"keep-exact"}}'
        assert row["score_trace_json"] == '{"opaque":{"trace":"keep-exact"}}'
        assert row["score_correction_json"] == '{"opaque":{"repair":"keep-exact"}}'
        assert json.loads(str(row["score_breakdown_json"])) == {
            "technicalFit": 9,
            "experienceFit": 8,
            "roleFit": 7,
            "reasoning": "canonical score",
            "fitBand": "plausible",
            "confidence": "medium",
            "eligibility": {
                "status": "unknown",
                "hardBlockers": [],
                "warnings": [],
            },
            "matchedSignals": ["Python"],
            "missingSignals": [],
            "transferableSignals": [],
        }
        assert json.loads(str(row["compensation_summary_json"]))["legacyRawSalary"] == "€95k"
        assert (
            row["current_stage"],
            row["current_substage"],
            row["current_state"],
            row["current_error_code"],
            row["current_error_message"],
            row["current_next_action"],
        ) == ("discover", "tailor", "failed", "quality_gate", "needs revision", "retry_tailor")
        assert (row["has_resume"], row["has_cover_letter"], row["has_pdf"]) == (True, True, True)
        assert row["resume_template_id"] == "accepted-template"
        assert row["resume_template_name"] == "Accepted template"
        assert row["tailoring_policy_version"] == 7
        assert row["artifact_count"] == 2
        assert row["apply_status"] == "applied"
        assert row["applied_at"] == "2026-07-30T13:05:00+00:00"
        assert row["apply_mode"] == "automated_live"
        assert row["deleted_at"] == "2026-07-30T14:00:00+00:00"
        assert row["last_updated_at"] == _MIGRATION_AT
        assert candidate.execute(
            "SELECT metadata_json FROM job_materials WHERE generation = 4"
        ).fetchone() == (_INERT_CONTEXT_JSON,)
    finally:
        candidate.close()


def test_apply_legacy_fallbacks_and_active_delete_lifecycle() -> None:
    candidate = _candidate()
    try:
        candidate.execute("DELETE FROM apply_run_projections")
        candidate.execute(
            """
            INSERT INTO job_events (
                tenant_id, job_id, identity_version, stage, event_type, occurred_at
            ) VALUES ('local', ?, 1, 'apply', 'ApplicationManuallyMarked', ?)
            """,
            (_JOB_ID, _MIGRATION_AT),
        )
        row = _row(candidate)
        assert row["apply_status"] == "applied"
        assert row["applied_at"] == "2026-07-30T12:00:00+00:00"
        assert row["apply_mode"] == "manual_marked"

        candidate.execute("DELETE FROM job_events")
        candidate.execute(
            """
            INSERT INTO application_outcomes (
                tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at
            ) VALUES ('local', 'outcome-1', ?, 'applied_confirmation', 'gmail', ?, ?)
            """,
            (_JOB_ID, _MIGRATION_AT, _MIGRATION_AT),
        )
        candidate.execute(
            """
            UPDATE jobctrl_deleted_jobs
            SET restored_at = '2026-07-30T14:01:00+00:00'
            WHERE tenant_id = 'local' AND job_id = ?
            """,
            (_JOB_ID,),
        )
        row = _row(candidate)
        assert row["apply_mode"] == "external_confirmed"
        assert row["deleted_at"] is None
    finally:
        candidate.close()
