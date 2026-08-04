from __future__ import annotations

import sqlite3

import pytest

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.state import (
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


def test_salary_preference_never_blocks_actionable_downstream_stages(
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

    assert changed == 0
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    for stage in ("tailor", "cover", "apply"):
        assert rows[stage]["state"] == "pending"
        assert rows[stage]["error_code"] is None


def test_salary_reason_is_demoted_but_other_hard_blockers_still_block(
    conn: sqlite3.Connection,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/mixed-blockers",
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=[
            "posted compensation appears below profile minimum",
            "candidate requires sponsorship",
        ],
    )

    assert changed == 3
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert rows["tailor"]["state"] == "blocked"
    assert "candidate requires sponsorship" in rows["tailor"]["error_message"]
    assert "compensation" not in rows["tailor"]["error_message"]


def test_combined_salary_and_sponsorship_reason_remains_blocking(
    conn: sqlite3.Connection,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/combined-blocker",
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=["Compensation is below range and visa sponsorship is unavailable."],
    )

    assert changed == 3
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert rows["tailor"]["state"] == "blocked"
    assert "visa sponsorship" in rows["tailor"]["error_message"]


@pytest.mark.parametrize(
    ("reason", "expected_actionable"),
    (
        (
            "Salary is below target and German proficiency is required.",
            "German proficiency is required",
        ),
        (
            "Salary is below target and posting matches excluded criterion: gambling.",
            "posting matches excluded criterion: gambling",
        ),
        (
            "Salary is below target / German proficiency is required.",
            "German proficiency is required",
        ),
        (
            "Salary is below target: posting matches excluded criterion: gambling.",
            "posting matches excluded criterion: gambling",
        ),
        (
            "Salary is below target — German proficiency is required.",
            "German proficiency is required",
        ),
        (
            "Salary is below target\nGerman proficiency is required.",
            "German proficiency is required",
        ),
    ),
)
def test_combined_salary_reason_preserves_non_compensation_clause(
    conn: sqlite3.Connection,
    reason: str,
    expected_actionable: str,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/combined-clause",
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=[reason],
    )

    assert changed == 3
    row = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)["tailor"]
    assert row["state"] == "blocked"
    assert expected_actionable in row["error_message"]


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
