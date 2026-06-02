from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import init_db
from jobhunter.state import (
    SCORE_ELIGIBILITY_BLOCKED_ERROR_CODE,
    ensure_job_stage_rows,
    reconcile_score_eligibility_blockers,
    set_stage_state,
)


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


def _seed_scored_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, full_description, discovered_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (url, "Engineer", "Acme", "Need Python.", "2024-01-01T00:00:00+00:00"),
    )
    ensure_job_stage_rows(conn, url, discovered_at="2024-01-01T00:00:00+00:00")
    set_stage_state(conn, url, "enrich", "succeeded", validate_transition=False)
    set_stage_state(conn, url, "score", "succeeded", validate_transition=False)
    conn.commit()


def _stage_rows(conn: sqlite3.Connection, url: str) -> dict[str, sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT stage, state, error_code, error_message, retryable, blocked_by_json
        FROM job_stage_states
        WHERE job_url = ?
        """,
        (url,),
    ).fetchall()
    return {str(row["stage"]): row for row in rows}


def test_score_eligibility_blocker_blocks_actionable_downstream_stages(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/blocked"
    _seed_scored_job(conn, url)

    changed = reconcile_score_eligibility_blockers(
        conn,
        job_url=url,
        eligibility_status="blocked",
        hard_blockers=["posted compensation appears below profile minimum"],
        now="2024-01-02T00:00:00+00:00",
    )

    assert changed == 3
    rows = _stage_rows(conn, url)
    for stage in ("tailor", "cover", "apply"):
        row = rows[stage]
        assert row["state"] == "blocked"
        assert row["error_code"] == SCORE_ELIGIBILITY_BLOCKED_ERROR_CODE
        assert row["retryable"] == 0
        assert "posted compensation appears below profile minimum" in row["error_message"]
        assert row["blocked_by_json"] == '["score"]'


def test_score_eligibility_clear_restores_dependency_states(conn: sqlite3.Connection) -> None:
    url = "https://example.com/job/cleared"
    _seed_scored_job(conn, url)
    reconcile_score_eligibility_blockers(
        conn,
        job_url=url,
        eligibility_status="blocked",
        hard_blockers=["candidate requires sponsorship"],
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        job_url=url,
        eligibility_status="eligible",
        hard_blockers=[],
        now="2024-01-03T00:00:00+00:00",
    )

    assert changed == 3
    rows = _stage_rows(conn, url)
    assert rows["tailor"]["state"] == "pending"
    assert rows["tailor"]["error_code"] is None
    assert rows["cover"]["state"] == "blocked"
    assert rows["cover"]["error_message"] == "tailor has not completed."
    assert rows["apply"]["state"] == "blocked"
    assert rows["apply"]["error_message"] == "Materials are not ready."
