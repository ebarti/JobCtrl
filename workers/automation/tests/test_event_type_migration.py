"""S-09 / round-1 review M1: one-shot snake_case → PascalCase migration over
historical ``job_events`` rows.

The migration runs unconditionally inside ``ensure_state_tables`` and is
idempotent — every PascalCase row falls through the ELSE branch unchanged.
"""

from __future__ import annotations

from pathlib import Path

from jobctrl.database import close_connection, ensure_state_tables, init_db
from jobctrl.domain.identifiers import generate_job_id
from jobctrl.domain.tenant import LOCAL_TENANT


def test_migration_renames_legacy_snake_case_event_types(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = generate_job_id()
        # Seed historical rows that pre-date the PascalCase rip-and-replace.
        conn.executemany(
            """
            INSERT INTO job_events (
                tenant_id, job_id, identity_version, stage, event_type, level, occurred_at
            ) VALUES (?, ?, 1, ?, ?, 'info', ?)
            """,
            [
                (str(LOCAL_TENANT), str(job_id), "score", "stage_succeeded", "t0"),
                (str(LOCAL_TENANT), str(job_id), "tailor", "stage_failed", "t1"),
                (str(LOCAL_TENANT), str(job_id), "apply", "mark_skipped", "t2"),
                (str(LOCAL_TENANT), str(job_id), "apply", "cancel_requested", "t3"),
                (str(LOCAL_TENANT), str(job_id), "apply", "lock_released", "t4"),
                (str(LOCAL_TENANT), str(job_id), "apply", "action_started", "t5"),
                (str(LOCAL_TENANT), str(job_id), "apply", "action_succeeded", "t6"),
                (str(LOCAL_TENANT), str(job_id), "apply", "action_failed", "t7"),
                (str(LOCAL_TENANT), str(job_id), "apply", "dry_run_completed", "t8"),
                (str(LOCAL_TENANT), str(job_id), "score", "retry_requested", "t9"),
                (str(LOCAL_TENANT), str(job_id), "score", "mark_applied", "t10"),
                # Already-PascalCase rows must pass through unchanged.
                (str(LOCAL_TENANT), str(job_id), "score", "StageCompleted", "t11"),
            ],
        )
        conn.commit()

        # Re-running the migration is the entry point.
        ensure_state_tables(conn)

        rows = conn.execute("SELECT event_type, occurred_at FROM job_events ORDER BY occurred_at").fetchall()
        renamed = {row["occurred_at"]: row["event_type"] for row in rows}
        assert renamed == {
            "t0": "StageCompleted",
            "t1": "StageFailed",
            "t2": "StageSkipped",
            "t3": "StageCanceled",
            "t4": "LockReleased",
            "t5": "ActionStarted",
            "t6": "ActionSucceeded",
            "t7": "ActionFailed",
            "t8": "DryRunCompleted",
            "t9": "StageReset",
            "t10": "ApplicationManuallyMarked",
            "t11": "StageCompleted",
        }
    finally:
        close_connection(db_path)


def test_migration_is_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = generate_job_id()
        conn.execute(
            """
            INSERT INTO job_events (
                tenant_id, job_id, identity_version, stage, event_type, level, occurred_at
            ) VALUES (?, ?, 1, ?, ?, 'info', ?)
            """,
            (str(LOCAL_TENANT), str(job_id), "score", "stage_succeeded", "t0"),
        )
        conn.commit()

        ensure_state_tables(conn)
        ensure_state_tables(conn)
        ensure_state_tables(conn)

        row = conn.execute("SELECT event_type FROM job_events WHERE occurred_at = 't0'").fetchone()
        assert row["event_type"] == "StageCompleted"
    finally:
        close_connection(db_path)
