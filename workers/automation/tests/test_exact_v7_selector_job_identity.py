"""Exact-v7 selector identity regressions.

The runtime returns URLs as locators, but selector joins must use the
tenant-scoped canonical job_id. These fixtures deliberately give two tenants
the same URL to prove no queue state crosses the aggregate boundary.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import count_ready_to_apply, get_jobs_by_stage, get_stats, init_db


LOCAL_TENANT = "local"
OTHER_TENANT = "other"
SHARED_URL = "https://example.test/jobs/shared"
TIMESTAMP = "2026-07-31T12:00:00+00:00"
LOCAL_JOB_ID = "90000000-0000-4000-8000-000000000001"
OTHER_JOB_ID = "90000000-0000-4000-8000-000000000002"
TAILOR_JOB_ID = "90000000-0000-4000-8000-000000000003"
TAILOR_URL = "https://example.test/jobs/tailor"


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def _insert_job(
    conn: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
    *,
    url: str = SHARED_URL,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, discovered_at
        ) VALUES (?, ?, ?, 'Engineer', 'Example', ?)
        """,
        (tenant_id, job_id, url, TIMESTAMP),
    )


def _insert_enrichment(
    conn: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
    *,
    status: str = "enriched",
    description: str | None = "Build reliable systems.",
    application_url: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description,
            application_url, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (tenant_id, job_id, status, description, application_url, TIMESTAMP),
    )


def _insert_score(
    conn: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
    *,
    fit_score: int = 9,
) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at
        ) VALUES (?, ?, 1, ?, '{}', '[]', ?)
        """,
        (tenant_id, job_id, fit_score, TIMESTAMP),
    )


def _insert_materials(
    conn: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
    *,
    artifact_types: tuple[str, ...],
) -> None:
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES (?, ?, 1, 'approved', ?, ?)
        """,
        (tenant_id, job_id, TIMESTAMP, TIMESTAMP),
    )
    for artifact_type in artifact_types:
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id,
                status, path, render_format, created_at
            ) VALUES (?, ?, 1, ?, ?, 'approved', ?, 'text', ?)
            """,
            (
                tenant_id,
                job_id,
                artifact_type,
                f"{job_id}:{artifact_type}",
                f"/tmp/{job_id}-{artifact_type}",
                TIMESTAMP,
            ),
        )


def _identities(rows: list[dict]) -> set[tuple[str, str, str]]:
    return {(row["tenant_id"], row["job_id"], row["url"]) for row in rows}


def test_pending_score_uses_exact_v7_identity_for_enrichment_and_scores(
    conn: sqlite3.Connection,
) -> None:
    _insert_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_job(conn, OTHER_TENANT, OTHER_JOB_ID)
    _insert_enrichment(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_enrichment(
        conn,
        OTHER_TENANT,
        OTHER_JOB_ID,
        status="pending",
        description=None,
    )
    _insert_score(conn, OTHER_TENANT, OTHER_JOB_ID)
    conn.commit()

    assert _identities(get_jobs_by_stage(conn, "pending_score")) == {
        (LOCAL_TENANT, LOCAL_JOB_ID, SHARED_URL)
    }


def test_pending_detail_uses_exact_v7_enrichment_identity(
    conn: sqlite3.Connection,
) -> None:
    _insert_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_job(conn, OTHER_TENANT, OTHER_JOB_ID)
    _insert_enrichment(conn, OTHER_TENANT, OTHER_JOB_ID)
    conn.commit()

    assert _identities(get_jobs_by_stage(conn, "pending_detail")) == {
        (LOCAL_TENANT, LOCAL_JOB_ID, SHARED_URL)
    }


def test_pending_tailor_does_not_cross_tenant_materials_or_stage_state(
    conn: sqlite3.Connection,
) -> None:
    _insert_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_job(conn, OTHER_TENANT, OTHER_JOB_ID)
    _insert_enrichment(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_enrichment(conn, OTHER_TENANT, OTHER_JOB_ID)
    _insert_score(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_score(conn, OTHER_TENANT, OTHER_JOB_ID)
    _insert_materials(
        conn,
        OTHER_TENANT,
        OTHER_JOB_ID,
        artifact_types=("tailored_resume",),
    )
    conn.execute(
        """
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, attempt_count, updated_at
        ) VALUES (?, ?, 'tailor', 'exhausted', 5, ?)
        """,
        (OTHER_TENANT, OTHER_JOB_ID, TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_score_staleness (
            tenant_id, job_id, stale_reason, old_policy_version,
            new_policy_version, marked_at
        ) VALUES (?, ?, 'policy_changed', 1, 2, ?)
        """,
        (OTHER_TENANT, OTHER_JOB_ID, TIMESTAMP),
    )
    conn.commit()

    assert _identities(get_jobs_by_stage(conn, "pending_tailor", min_score=7)) == {
        (LOCAL_TENANT, LOCAL_JOB_ID, SHARED_URL)
    }


def test_pending_apply_does_not_cross_tenant_apply_or_posting_state(
    conn: sqlite3.Connection,
) -> None:
    _insert_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_job(conn, OTHER_TENANT, OTHER_JOB_ID)
    _insert_enrichment(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_enrichment(conn, OTHER_TENANT, OTHER_JOB_ID)
    _insert_score(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_score(conn, OTHER_TENANT, OTHER_JOB_ID)
    _insert_materials(
        conn,
        LOCAL_TENANT,
        LOCAL_JOB_ID,
        artifact_types=("tailored_resume", "resume_pdf"),
    )
    conn.execute(
        """
        INSERT INTO apply_run_projections (
            run_id, tenant_id, job_id, status, started_at, finished_at
        ) VALUES ('other-run', ?, ?, 'succeeded', ?, ?)
        """,
        (OTHER_TENANT, OTHER_JOB_ID, TIMESTAMP, TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_active_state, updated_at
        ) VALUES (?, ?, '{}', 'closed', ?)
        """,
        (OTHER_TENANT, OTHER_JOB_ID, TIMESTAMP),
    )
    conn.commit()

    assert _identities(get_jobs_by_stage(conn, "pending_apply", min_score=7)) == {
        (LOCAL_TENANT, LOCAL_JOB_ID, SHARED_URL)
    }


def test_ready_apply_count_uses_exact_v7_stage_identity(
    conn: sqlite3.Connection,
) -> None:
    for tenant_id, job_id in (
        (LOCAL_TENANT, LOCAL_JOB_ID),
        (OTHER_TENANT, OTHER_JOB_ID),
    ):
        _insert_job(conn, tenant_id, job_id)
        _insert_enrichment(
            conn,
            tenant_id,
            job_id,
            application_url=f"https://apply.example.test/{job_id}",
        )
        _insert_score(conn, tenant_id, job_id)
        _insert_materials(
            conn,
            tenant_id,
            job_id,
            artifact_types=("tailored_resume", "resume_pdf"),
        )
    conn.execute(
        """
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, attempt_count, updated_at
        ) VALUES (?, ?, 'apply', 'running', 1, ?)
        """,
        (OTHER_TENANT, OTHER_JOB_ID, TIMESTAMP),
    )
    conn.commit()

    assert count_ready_to_apply(conn, min_score=7) == 1


def test_exact_v7_selectors_ignore_retired_wide_job_state(
    conn: sqlite3.Connection,
) -> None:
    _insert_job(conn, OTHER_TENANT, OTHER_JOB_ID)
    _insert_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_job(conn, LOCAL_TENANT, TAILOR_JOB_ID, url=TAILOR_URL)
    _insert_enrichment(
        conn,
        LOCAL_TENANT,
        LOCAL_JOB_ID,
        application_url="https://apply.example.test/canonical",
    )
    _insert_enrichment(conn, LOCAL_TENANT, TAILOR_JOB_ID)
    _insert_score(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_score(conn, LOCAL_TENANT, TAILOR_JOB_ID)
    _insert_materials(
        conn,
        LOCAL_TENANT,
        LOCAL_JOB_ID,
        artifact_types=("tailored_resume", "resume_pdf"),
    )
    conn.execute(
        """
        UPDATE jobs
        SET full_description = 'retired description',
            application_url = 'https://apply.example.test/retired',
            detail_scraped_at = ?, detail_error = 'retired detail error',
            fit_score = 10, tailored_resume_path = '/tmp/retired-resume.txt',
            cover_letter_path = '/tmp/retired-cover.txt',
            tailor_attempts = 5, cover_attempts = 5,
            applied_at = ?, apply_status = 'applied', apply_error = 'retired apply error'
        WHERE tenant_id = ? AND job_id = ?
        """,
        (TIMESTAMP, TIMESTAMP, OTHER_TENANT, OTHER_JOB_ID),
    )
    conn.execute(
        """
        UPDATE jobs
        SET cover_letter_path = '/tmp/retired-cover.txt', cover_attempts = 5,
            applied_at = ?, apply_status = 'applied', apply_error = 'retired apply error'
        WHERE tenant_id = ? AND job_id = ?
        """,
        (TIMESTAMP, LOCAL_TENANT, LOCAL_JOB_ID),
    )
    conn.execute(
        """
        UPDATE jobs
        SET tailored_resume_path = '/tmp/retired-resume.txt', tailor_attempts = 5
        WHERE tenant_id = ? AND job_id = ?
        """,
        (LOCAL_TENANT, TAILOR_JOB_ID),
    )
    conn.commit()

    pending_detail = get_jobs_by_stage(conn, "pending_detail")
    assert _identities(pending_detail) == {
        (OTHER_TENANT, OTHER_JOB_ID, SHARED_URL)
    }
    assert pending_detail[0]["full_description"] is None
    assert pending_detail[0]["application_url"] is None
    assert pending_detail[0]["fit_score"] is None
    assert pending_detail[0]["tailored_resume_path"] is None
    assert _identities(get_jobs_by_stage(conn, "pending_score")) == set()
    assert _identities(get_jobs_by_stage(conn, "pending_tailor", min_score=7)) == {
        (LOCAL_TENANT, TAILOR_JOB_ID, TAILOR_URL)
    }
    assert _identities(get_jobs_by_stage(conn, "pending_cover", min_score=7)) == {
        (LOCAL_TENANT, LOCAL_JOB_ID, SHARED_URL)
    }
    pending_apply = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    assert _identities(pending_apply) == {(LOCAL_TENANT, LOCAL_JOB_ID, SHARED_URL)}
    assert pending_apply[0]["applied_at"] is None
    assert pending_apply[0]["apply_status"] is None
    assert pending_apply[0]["cover_letter_path"] is None
    assert _identities(get_jobs_by_stage(conn, "applied")) == set()
    assert count_ready_to_apply(conn, min_score=7) == 1

    stats = get_stats(conn)
    assert stats["with_description"] == 2
    assert stats["detail_errors"] == 0
    assert stats["scored"] == 2
    assert stats["tailored"] == 1
    assert stats["with_cover_letter"] == 0
    assert stats["tailor_exhausted"] == 0
    assert stats["cover_exhausted"] == 0
    assert stats["applied"] == 0
    assert stats["apply_errors"] == 0
    assert stats["ready_to_apply"] == 1
