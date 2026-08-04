"""Recovery invariants for score activities that lose their runtime owner."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from jobctrl.database import init_db
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.preparation_recovery import (
    RecoverPreparationStateInput,
    recover_preparation_state_rows,
)
from jobctrl.state import ensure_job_stage_rows, set_stage_state


_STARTED_AT = "2026-08-04T17:50:38+00:00"


def _seed_job(conn: sqlite3.Connection, suffix: int, *, with_score: bool) -> str:
    job_id = str(canonical_job_id(f"00000000-0000-4000-8000-{suffix:012d}"))
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, site, strategy, discovered_at
        ) VALUES ('local', ?, ?, 'Synthetic role', 'Synthetic company',
                  'synthetic', 'chaos', ?)
        """,
        (job_id, f"https://example.test/jobs/{suffix}", _STARTED_AT),
    )
    ensure_job_stage_rows(
        conn,
        canonical_job_id(job_id),
        tenant_id=LOCAL_TENANT,
        discovered_at=_STARTED_AT,
    )
    if with_score:
        conn.execute(
            """
            INSERT INTO job_scores (
                tenant_id, job_id, version, fit_score, breakdown_json,
                keywords_json, scored_at, criteria_json, trace_json
            ) VALUES ('local', ?, 1, 8, '{}', '[]', ?, '{}', '{}')
            """,
            (job_id, _STARTED_AT),
        )
    return job_id


def _mark_owned_running(
    conn: sqlite3.Connection,
    job_id: str,
    *,
    workflow_id: str,
    rescore: bool,
) -> None:
    set_stage_state(
        conn,
        canonical_job_id(job_id),
        "score",
        "running",
        tenant_id=LOCAL_TENANT,
        started_at=_STARTED_AT,
        metadata={
            "activityOwner": workflow_id,
            "rescore": rescore,
            "priorScoreVersion": 1 if rescore else 0,
        },
        validate_transition=False,
    )
    conn.commit()


def test_recovery_restores_existing_score_without_recomputing(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "score-recovery.db")
    owned = _seed_job(conn, 1, with_score=True)
    other = _seed_job(conn, 2, with_score=True)
    _mark_owned_running(conn, owned, workflow_id="run-owned", rescore=False)
    _mark_owned_running(conn, other, workflow_id="run-other", rescore=False)

    result = recover_preparation_state_rows(
        conn,
        RecoverPreparationStateInput(
            tenant_id="local", workflow_id="run-owned", stage="score"
        ),
    )

    assert result.restored == 1
    assert result.failed == 0
    rows = {
        row["job_id"]: row
        for row in conn.execute(
            "SELECT job_id, state, metadata_json FROM job_stage_states WHERE stage = 'score'"
        ).fetchall()
    }
    assert rows[owned]["state"] == "succeeded"
    assert "orphaned_activity_restored_committed_score" in rows[owned]["metadata_json"]
    assert rows[other]["state"] == "running"
    assert conn.execute(
        "SELECT COUNT(*) FROM job_scores WHERE tenant_id = 'local' AND job_id = ?",
        (owned,),
    ).fetchone()[0] == 1


def test_recovery_does_not_accept_old_score_for_explicit_rescore(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "score-rescore-recovery.db")
    job_id = _seed_job(conn, 3, with_score=True)
    _mark_owned_running(conn, job_id, workflow_id="run-rescore", rescore=True)

    result = recover_preparation_state_rows(
        conn,
        RecoverPreparationStateInput(
            tenant_id="local", workflow_id="run-rescore", stage="score"
        ),
    )

    assert result.restored == 0
    assert result.failed == 1
    row = conn.execute(
        "SELECT state, error_code, retryable FROM job_stage_states WHERE job_id = ? AND stage = 'score'",
        (job_id,),
    ).fetchone()
    assert dict(row) == {
        "state": "failed",
        "error_code": "SCORE_ACTIVITY_OWNER_STOPPED",
        "retryable": 1,
    }


def test_recovery_accepts_new_score_version_for_explicit_rescore(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "score-rescore-committed.db")
    job_id = _seed_job(conn, 5, with_score=True)
    _mark_owned_running(conn, job_id, workflow_id="run-rescore", rescore=True)
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, criteria_json, trace_json
        ) VALUES ('local', ?, 2, 9, '{}', '[]', ?, '{}', '{}')
        """,
        (job_id, _STARTED_AT),
    )
    conn.commit()

    result = recover_preparation_state_rows(
        conn,
        RecoverPreparationStateInput(
            tenant_id="local", workflow_id="run-rescore", stage="score"
        ),
    )

    assert (result.restored, result.failed) == (1, 0)
    assert conn.execute(
        "SELECT state FROM job_stage_states WHERE job_id = ? AND stage = 'score'",
        (job_id,),
    ).fetchone()[0] == "succeeded"


def test_recovery_terminalizes_owned_running_row_without_score(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "score-missing-recovery.db")
    job_id = _seed_job(conn, 4, with_score=False)
    _mark_owned_running(conn, job_id, workflow_id="run-missing", rescore=False)

    result = recover_preparation_state_rows(
        conn,
        RecoverPreparationStateInput(
            tenant_id="local", workflow_id="run-missing", stage="score"
        ),
    )

    assert result.restored == 0
    assert result.failed == 1
    assert conn.execute(
        "SELECT state FROM job_stage_states WHERE job_id = ? AND stage = 'score'",
        (job_id,),
    ).fetchone()[0] == "failed"
