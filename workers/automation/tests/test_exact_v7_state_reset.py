"""Exact-v7 regressions for administrative stage resets."""

from __future__ import annotations

import sqlite3

import pytest

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.state import ensure_job_stage_rows, reset_job_stage, set_stage_state


_JOB_ID = JobId("00000000-0000-4000-8000-000000000001")
_JOB_URL = "https://jobs.example/platform-engineer"
_OTHER_TENANT = TenantId("other")
_NOW = "2026-07-31T09:00:00+00:00"


def _exact_v7_candidate(stage: str) -> sqlite3.Connection:
    candidate = sqlite3.connect(":memory:")
    candidate.row_factory = sqlite3.Row
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    candidate.executemany(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
        VALUES (?, ?, ?, 'Platform Engineer', ?)
        """,
        [
            (str(LOCAL_TENANT), str(_JOB_ID), _JOB_URL, _NOW),
            (str(_OTHER_TENANT), str(_JOB_ID), _JOB_URL, _NOW),
        ],
    )
    candidate.execute(
        """
        UPDATE jobs
        SET tailored_resume_path = 'legacy-resume.md',
            cover_letter_path = 'legacy-cover.md'
        """
    )
    for tenant_id in (LOCAL_TENANT, _OTHER_TENANT):
        ensure_job_stage_rows(candidate, _JOB_ID, tenant_id=tenant_id, discovered_at=_NOW)
        set_stage_state(
            candidate,
            _JOB_ID,
            stage,
            "failed",
            tenant_id=tenant_id,
            error_code="QUALITY_GATE",
            error_message="needs revision",
            validate_transition=False,
        )
        candidate.execute(
            """
            INSERT INTO job_materials (
                tenant_id, job_id, generation, status, created_at, updated_at
            ) VALUES (?, ?, 1, 'review_pending', ?, ?)
            """,
            (str(tenant_id), str(_JOB_ID), _NOW, _NOW),
        )
        artifacts = [
            ("tailored_resume", "approved" if stage == "cover" else "rejected", "resume.md", "markdown"),
            ("resume_pdf", "approved" if stage == "cover" else "rejected", "resume.pdf", "pdf"),
        ]
        if stage == "cover":
            artifacts.extend(
                [
                    ("cover_letter", "rejected", "cover.md", "markdown"),
                    ("cover_letter_pdf", "rejected", "cover.pdf", "pdf"),
                ]
            )
        candidate.executemany(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id,
                status, path, render_format, created_at
            ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    str(tenant_id),
                    str(_JOB_ID),
                    artifact_type,
                    f"{tenant_id}-{artifact_type}",
                    status,
                    path,
                    render_format,
                    _NOW,
                )
                for artifact_type, status, path, render_format in artifacts
            ],
        )
    candidate.commit()
    return candidate


@pytest.mark.parametrize(
    ("stage", "expected_status", "remaining_artifacts"),
    [
        ("tailor", "resume_in_progress", set()),
        ("cover", "resume_approved", {"tailored_resume", "resume_pdf"}),
    ],
)
def test_reset_materials_uses_tenant_scoped_job_id(
    stage: str,
    expected_status: str,
    remaining_artifacts: set[str],
) -> None:
    candidate = _exact_v7_candidate(stage)

    assert reset_job_stage(candidate, _JOB_URL, stage) == _JOB_URL

    local_materials = candidate.execute(
        """
        SELECT status
        FROM job_materials
        WHERE tenant_id = ? AND job_id = ? AND generation = 1
        """,
        (str(LOCAL_TENANT), str(_JOB_ID)),
    ).fetchone()
    assert local_materials is not None
    assert local_materials["status"] == expected_status
    local_artifacts = candidate.execute(
        """
        SELECT artifact_type
        FROM job_materials_artifacts
        WHERE tenant_id = ? AND job_id = ? AND generation = 1
        """,
        (str(LOCAL_TENANT), str(_JOB_ID)),
    ).fetchall()
    assert {row["artifact_type"] for row in local_artifacts} == remaining_artifacts

    local_state = candidate.execute(
        """
        SELECT state
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = ?
        """,
        (str(LOCAL_TENANT), str(_JOB_ID), stage),
    ).fetchone()
    assert local_state is not None
    assert local_state["state"] == "pending"
    local_event = candidate.execute(
        """
        SELECT job_id
        FROM job_events
        WHERE tenant_id = ? AND event_type = 'StageReset'
        ORDER BY event_id DESC
        LIMIT 1
        """,
        (str(LOCAL_TENANT),),
    ).fetchone()
    assert local_event is not None
    assert local_event["job_id"] == str(_JOB_ID)
    legacy_projection = candidate.execute(
        """
        SELECT tailored_resume_path, cover_letter_path
        FROM jobs
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(_JOB_ID)),
    ).fetchone()
    assert legacy_projection is not None
    assert legacy_projection["tailored_resume_path"] == "legacy-resume.md"
    assert legacy_projection["cover_letter_path"] == "legacy-cover.md"

    other_materials = candidate.execute(
        """
        SELECT status
        FROM job_materials
        WHERE tenant_id = ? AND job_id = ? AND generation = 1
        """,
        (str(_OTHER_TENANT), str(_JOB_ID)),
    ).fetchone()
    assert other_materials is not None
    assert other_materials["status"] == "review_pending"
    other_artifact_count = candidate.execute(
        """
        SELECT COUNT(*)
        FROM job_materials_artifacts
        WHERE tenant_id = ? AND job_id = ? AND generation = 1
        """,
        (str(_OTHER_TENANT), str(_JOB_ID)),
    ).fetchone()[0]
    assert other_artifact_count == (4 if stage == "cover" else 2)
