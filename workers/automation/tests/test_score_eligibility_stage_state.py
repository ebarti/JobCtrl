from __future__ import annotations

import sqlite3

import pytest

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.state import (
    SCORE_ELIGIBILITY_BLOCKED_ERROR_CODE,
    ensure_job_stage_rows,
    reconcile_score_eligibility_blockers,
    set_stage_state,
)

_TENANT_A = TenantId("tenant-a")
_TENANT_B = TenantId("tenant-b")
_JOB_ID = canonical_job_id("00000000-0000-4000-8000-000000000001")


@pytest.fixture()
def conn() -> sqlite3.Connection:
    candidate = sqlite3.connect(":memory:")
    candidate.row_factory = sqlite3.Row
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    return candidate


def _seed_scored_job(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    url: str,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(tenant_id),
            str(job_id),
            url,
            "Engineer",
            "Acme",
            "Need Python.",
            "2024-01-01T00:00:00+00:00",
        ),
    )
    ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=tenant_id,
        discovered_at="2024-01-01T00:00:00+00:00",
    )
    set_stage_state(
        conn,
        job_id,
        "enrich",
        "succeeded",
        tenant_id=tenant_id,
        validate_transition=False,
    )
    set_stage_state(
        conn,
        job_id,
        "score",
        "succeeded",
        tenant_id=tenant_id,
        validate_transition=False,
    )
    conn.commit()


def _stage_rows(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> dict[str, sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT stage, state, error_code, error_message, retryable, blocked_by_json
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(tenant_id), str(job_id)),
    ).fetchall()
    return {str(row["stage"]): row for row in rows}


def test_score_eligibility_blocker_blocks_actionable_downstream_stages(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/blocked"
    _seed_scored_job(conn, tenant_id=_TENANT_A, job_id=_JOB_ID, url=url)

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=["posted compensation appears below profile minimum"],
        now="2024-01-02T00:00:00+00:00",
    )

    assert changed == 3
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    for stage in ("tailor", "cover", "apply"):
        row = rows[stage]
        assert row["state"] == "blocked"
        assert row["error_code"] == SCORE_ELIGIBILITY_BLOCKED_ERROR_CODE
        assert row["retryable"] == 0
        assert "posted compensation appears below profile minimum" in row["error_message"]
        assert row["blocked_by_json"] == '["score"]'


def test_score_eligibility_clear_restores_dependency_states(conn: sqlite3.Connection) -> None:
    url = "https://example.com/job/cleared"
    _seed_scored_job(conn, tenant_id=_TENANT_A, job_id=_JOB_ID, url=url)
    reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=["candidate requires sponsorship"],
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="eligible",
        hard_blockers=[],
        now="2024-01-03T00:00:00+00:00",
    )

    assert changed == 3
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert rows["tailor"]["state"] == "pending"
    assert rows["tailor"]["error_code"] is None
    assert rows["cover"]["state"] == "blocked"
    assert rows["cover"]["error_message"] == "tailor has not completed."
    assert rows["apply"]["state"] == "blocked"
    assert rows["apply"]["error_message"] == "Materials are not ready."


def test_score_eligibility_blockers_are_tenant_scoped(conn: sqlite3.Connection) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/tenant-a",
    )
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_B,
        job_id=_JOB_ID,
        url="https://example.com/job/tenant-b",
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=["candidate requires sponsorship"],
    )

    assert changed == 3
    assert _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)["tailor"]["state"] == "blocked"
    assert _stage_rows(conn, tenant_id=_TENANT_B, job_id=_JOB_ID)["tailor"]["state"] == "pending"
