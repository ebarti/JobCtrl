"""Exact-v7 tests for the preparation target read boundary."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader


_JOB_ID = canonical_job_id("10000000-0000-4000-8000-000000000001")
_TENANT_A = TenantId("tenant-a")
_TENANT_B = TenantId("tenant-b")
_POSTING_URL = "https://jobs.example.test/roles/security-engineer"


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl-v7.db")


def _seed_target(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId = _JOB_ID,
    full_description: str,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, salary, description,
            location, site, strategy, discovered_at, full_description
        ) VALUES (?, ?, ?, 'Security Engineer', 'Acme', '100k',
                  'Posting summary', 'Remote', 'example', 'search',
                  '2026-07-30T10:00:00+00:00', 'legacy description')
        """,
        (str(tenant_id), str(job_id), _POSTING_URL),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description,
            application_url, enriched_at, extraction_tier, updated_at
        ) VALUES (?, ?, 'enriched', ?, 'https://apply.example.test/role',
                  '2026-07-30T10:01:00+00:00', 'high',
                  '2026-07-30T10:01:00+00:00')
        """,
        (str(tenant_id), str(job_id), full_description),
    )
    conn.commit()


def test_load_uses_tenant_and_job_id_while_preserving_url_as_locator(
    conn: sqlite3.Connection,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A, full_description="Tenant A canonical JD")
    _seed_target(conn, tenant_id=_TENANT_B, full_description="Tenant B canonical JD")

    reader = SqlitePreparationTargetReader(conn)
    target = reader.load(_TENANT_A, _JOB_ID)

    assert target is not None
    assert target["tenant_id"] == str(_TENANT_A)
    assert target["job_id"] == str(_JOB_ID)
    assert target["url"] == _POSTING_URL
    assert target["full_description"] == "Tenant A canonical JD"
    assert target["full_description"] != "legacy description"
    assert reader.load(_TENANT_B, _JOB_ID)["full_description"] == "Tenant B canonical JD"  # type: ignore[index]


def test_load_returns_none_for_another_tenant(conn: sqlite3.Connection) -> None:
    _seed_target(conn, tenant_id=_TENANT_A, full_description="Canonical JD")

    assert SqlitePreparationTargetReader(conn).load(_TENANT_B, _JOB_ID) is None


def test_load_excludes_active_tombstone_and_restores_explicitly(
    conn: sqlite3.Connection,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A, full_description="Canonical JD")
    conn.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (
            tenant_id, job_id, deleted_at, reason
        ) VALUES (?, ?, '2026-07-30T10:02:00+00:00', 'user_deleted')
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    reader = SqlitePreparationTargetReader(conn)

    assert reader.load(_TENANT_A, _JOB_ID) is None

    conn.execute(
        """
        UPDATE jobctrl_deleted_jobs
        SET restored_at = '2026-07-30T10:03:00+00:00'
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()

    assert reader.load(_TENANT_A, _JOB_ID) is not None


def test_load_rejects_url_shaped_job_id(conn: sqlite3.Connection) -> None:
    with pytest.raises(ValueError, match="canonical UUID"):
        SqlitePreparationTargetReader(conn).load(
            _TENANT_A,
            JobId(_POSTING_URL),
        )
