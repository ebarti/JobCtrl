"""Contracts for deterministic v7 evidence-usage projection rows."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v7_evidence_usage_projection_rows as rows
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema

_JOB_URL = "https://jobs.example/shipped-v6"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
_MIGRATION_AT = "2026-07-30T10:30:00+00:00"
_INERT_CONTEXT_JSON = '{"userContext":"Attack vectors:\\nPrompt injection"}'


def _candidate(tmp_path: Path) -> sqlite3.Connection:
    candidate = sqlite3.connect(tmp_path / "candidate.db")
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    return candidate


def _seed_candidate(candidate: sqlite3.Connection) -> None:
    candidate.execute(
        """
        INSERT INTO jobs (url, title, company, discovered_at, tenant_id, job_id)
        VALUES (?, 'Shipped V7 fixture', 'Acme', ?, 'local', ?)
        """,
        (_JOB_URL, "2026-07-30T09:00:00+00:00", _JOB_ID),
    )
    candidate.execute(
        """
        INSERT INTO candidate_profile_experience_entries (
            tenant_id, profile_id, entry_id, position_index, date_range,
            title, company, location
        ) VALUES (
            'local', 'default', 'exp-platform', 0, '2024-2025',
            'Senior Engineer', 'Acme', 'Remote'
        )
        """
    )
    candidate.execute(
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
    candidate.execute(
        """
        INSERT INTO candidate_profile_skill_categories (
            tenant_id, profile_id, category_id, position_index, label
        ) VALUES ('local', 'default', 'backend', 0, 'Backend')
        """
    )
    candidate.execute(
        """
        INSERT INTO candidate_profile_skill_items (
            tenant_id, profile_id, category_id, item_index, item_text
        ) VALUES ('local', 'default', 'backend', 0, 'Python')
        """
    )
    candidate.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at,
            metadata_json
        ) VALUES ('local', ?, 1, 'complete', ?, ?, ?)
        """,
        (
            _JOB_ID,
            "2026-07-30T10:01:00+00:00",
            "2026-07-30T10:02:00+00:00",
            _INERT_CONTEXT_JSON,
        ),
    )
    candidate.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status,
            path, render_format, size_bytes, metadata_json, created_at
        ) VALUES (
            'local', ?, 1, 'tailored_resume', 'artifact-resume-1', 'approved',
            '/tmp/resume.txt', 'text', 12, ?, ?
        )
        """,
        (_JOB_ID, _INERT_CONTEXT_JSON, "2026-07-30T10:03:00+00:00"),
    )
    candidate.execute(
        """
        INSERT INTO job_bullet_provenance (
            tenant_id, job_id, generation, bullet_id, artifact_id, section,
            source_id, evidence_ids_json, requirement_ids_json,
            matched_keywords_json, transform_type, control, rationale,
            generated_text, position, created_at, coverage_json
        ) VALUES (
            'local', ?, 1, 'experience:exp-platform#0', 'artifact-resume-1',
            'experience', 'exp-platform', '["ev_platform"]',
            '["req-platform"]', '["latency"]', 'reframe',
            'rephrase_allowed', 'Used profile evidence.',
            'Led migration and reduced latency 40%.', 0, ?,
            '{"covered":["Python"],"declared":[],"missing":["Kubernetes"]}'
        )
        """,
        (_JOB_ID, "2026-07-30T10:04:00+00:00"),
    )
    candidate.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
            scored_at, correction_json, criteria_json, trace_json
        ) VALUES ('local', ?, 2, 8, '{}', '["Python"]', ?, NULL, '{}', '{}')
        """,
        (_JOB_ID, "2026-07-30T10:05:00+00:00"),
    )
    candidate.execute(
        """
        INSERT INTO job_requirement_fit_reports (
            tenant_id, job_id, score_version, employer_analysis_generation,
            profile_snapshot_version, scoring_policy_version, formula_version,
            resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES (
            'local', ?, 2, 1, 1, 1, 'v1', 8, 'strong', 'high',
            '{"weighted_fit":0.8,"must_have_coverage":0.5,"blocker_count":0,"missing_high_weight_count":1}',
            ?
        )
        """,
        (_JOB_ID, "2026-07-30T10:05:00+00:00"),
    )
    candidate.executemany(
        """
        INSERT INTO job_requirement_fit_items (
            tenant_id, job_id, score_version, requirement_id, requirement_text,
            tier, weight, job_evidence_span, fit_json, contribution_json,
            tailoring_json, artifact_coverage_json, position
        ) VALUES (
            'local', ?, 2, ?, ?, 'must_have', ?, ?, ?, '{}', '{}', ?, ?
        )
        """,
        (
            (
                _JOB_ID,
                "req-platform",
                "Own platform migrations",
                0.8,
                "platform migrations",
                '{"kind":"matched","evidence_ids":["ev_platform"],"strength":"direct"}',
                '{"state":"covered","source":"tailored_resume_bullet_provenance","bullet_count":1,"examples":["Led migration"]}',
                0,
            ),
            (
                _JOB_ID,
                "req-kubernetes",
                "Run Kubernetes clusters",
                0.7,
                "Kubernetes clusters",
                '{"kind":"missing","reason":"No Kubernetes profile evidence."}',
                '{"state":"missing_from_profile","source":"tailored_resume_bullet_provenance","bullet_count":0,"examples":[]}',
                1,
            ),
        ),
    )
    candidate.executemany(
        """
        INSERT INTO artifact_list_projections (
            artifact_id, tenant_id, job_id, job_title, job_employer,
            artifact_type, status, local_path, size_bytes, created_at,
            generation, metadata_json, layout_boxes_json,
            bullet_provenance_json, coverage_audit_json, voice_pass_json
        ) VALUES (?, 'local', ?, 'Shipped V7 fixture', 'Acme',
                  'tailored_resume', 'approved', ?, 12, ?, ?, ?, NULL, NULL,
                  '{"covered":["Python"],"declared":[],"missing":["Kubernetes"]}',
                  NULL)
        """,
        (
            (
                "artifact-resume-1",
                _JOB_ID,
                "/tmp/resume.txt",
                "2026-07-30T10:03:00+00:00",
                1,
                _INERT_CONTEXT_JSON,
            ),
            (
                "artifact-resume-2",
                _JOB_ID,
                "/tmp/resume-2.txt",
                "2026-07-30T10:13:00+00:00",
                2,
                _INERT_CONTEXT_JSON,
            ),
        ),
    )
    candidate.commit()


def _payloads(candidate: sqlite3.Connection) -> dict[tuple[str, str], dict[str, object]]:
    return {
        (str(row[1]), str(row[2])): json.loads(str(row[7]))
        for row in rows._projection_rows(candidate, _MIGRATION_AT)
    }


def test_projection_rows_preserve_v7_contracts_and_ignore_inert_context(
    tmp_path: Path,
) -> None:
    candidate = _candidate(tmp_path)
    try:
        _seed_candidate(candidate)
        projected = rows._projection_rows(candidate, _MIGRATION_AT)

        assert projected == rows._projection_rows(candidate, _MIGRATION_AT)
        assert [(row[1], row[2]) for row in projected] == [
            ("entry", "ev_platform"),
            ("entry", "skill:backend:0"),
            ("gap", f"{_JOB_ID}#req-kubernetes"),
            ("gap", f"{_JOB_ID}#skill#kubernetes"),
        ]
        assert all(row[8] == _MIGRATION_AT for row in projected)

        payloads = _payloads(candidate)
        evidence = payloads[("entry", "ev_platform")]
        assert evidence["story"] == {
            "scope": "Platform migration",
            "action": "Led migration",
            "outcome": "Reduced latency",
            "metrics": ["40% latency reduction"],
        }
        assert evidence["resumeUsages"] == [
            {
                "kind": "resume_bullet",
                "jobId": _JOB_ID,
                "jobTitle": "Shipped V7 fixture",
                "employer": "Acme",
                "artifactId": "artifact-resume-1",
                "bulletId": "experience:exp-platform#0",
                "generation": 1,
                "generatedTextPreview": "Led migration and reduced latency 40%.",
                "scoreVersion": None,
                "requirementId": None,
                "requirementText": None,
                "requirementFitKind": None,
                "artifactCoverageState": None,
                "keyword": None,
                "coverageState": None,
                "occurredAt": "2026-07-30T10:04:00+00:00",
            }
        ]
        assert evidence["requirementUsages"][0]["jobId"] == _JOB_ID
        assert evidence["requirementUsages"][0]["requirementId"] == "req-platform"
        assert evidence["freshness"]["lastUsedAt"] == "2026-07-30T10:04:00+00:00"

        skill = payloads[("entry", "skill:backend:0")]
        assert [usage["artifactId"] for usage in skill["coverageUsages"]] == [
            "artifact-resume-1",
            "artifact-resume-2",
        ]
        assert {usage["coverageState"] for usage in skill["coverageUsages"]} == {
            "covered"
        }
        missing_skill = payloads[("gap", f"{_JOB_ID}#skill#kubernetes")]
        assert [ref["artifactId"] for ref in missing_skill["jobRefs"]] == [
            "artifact-resume-1",
            "artifact-resume-2",
        ]

        serialized = json.dumps(list(payloads.values()), sort_keys=True)
        assert _JOB_ID in serialized
        assert _JOB_URL not in serialized
        assert _INERT_CONTEXT_JSON not in serialized
        assert all(alias not in serialized for alias in ("jobKey", "job_key", "jobUrl", "job_url"))
        assert candidate.execute(
            "SELECT metadata_json FROM job_materials_artifacts"
        ).fetchone() == (_INERT_CONTEXT_JSON,)
    finally:
        candidate.close()


@pytest.mark.parametrize(
    ("table", "restored_column", "restored_value", "expected_count"),
    (
        ("jobctrl_deleted_jobs", "restored_at", None, 2),
        ("jobctrl_deleted_jobs", "restored_at", "2026-07-30T10:10:00+00:00", 2),
        ("jobctrl_deleted_jobs", "restored_at", "2026-07-30T10:20:00+00:00", 4),
        ("jobctrl_hidden_jobs", "unhidden_at", None, 2),
        ("jobctrl_hidden_jobs", "unhidden_at", "2026-07-30T10:20:00+00:00", 4),
    ),
)
def test_projection_rows_exclude_only_active_deleted_and_hidden_jobs(
    tmp_path: Path,
    table: str,
    restored_column: str,
    restored_value: str | None,
    expected_count: int,
) -> None:
    candidate = _candidate(tmp_path)
    try:
        _seed_candidate(candidate)
        action_column = "deleted_at" if table == "jobctrl_deleted_jobs" else "hidden_at"
        candidate.execute(
            f"""
            INSERT INTO {table} (
                tenant_id, job_id, {action_column}, {restored_column}
            ) VALUES ('local', ?, '2026-07-30T10:10:00+00:00', ?)
            """,
            (_JOB_ID, restored_value),
        )

        projected = rows._projection_rows(candidate, _MIGRATION_AT)

        assert len(projected) == expected_count
        serialized = " ".join(str(row[7]) for row in projected)
        if expected_count == 2:
            assert "Led migration and reduced latency 40%." not in serialized
            assert _JOB_ID not in serialized
        else:
            assert "Led migration and reduced latency 40%." in serialized
            assert _JOB_ID in serialized
    finally:
        candidate.close()
