"""S-09 / round-1 review M1: one-shot snake_case → PascalCase migration over
historical ``job_events`` rows.

The migration runs unconditionally inside ``ensure_state_tables`` and is
idempotent — every PascalCase row falls through the ELSE branch unchanged.
"""

from __future__ import annotations

from pathlib import Path

from jobctl.database import close_connection, ensure_state_tables, init_db


def test_migration_renames_legacy_snake_case_event_types(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        # Seed historical rows that pre-date the PascalCase rip-and-replace.
        conn.executemany(
            "INSERT INTO job_events (job_url, stage, event_type, occurred_at) VALUES (?, ?, ?, ?)",
            [
                ("u1", "score", "stage_succeeded", "t0"),
                ("u1", "tailor", "stage_failed", "t1"),
                ("u1", "apply", "mark_skipped", "t2"),
                ("u1", "apply", "cancel_requested", "t3"),
                ("u1", "apply", "lock_released", "t4"),
                ("u1", "apply", "action_started", "t5"),
                ("u1", "apply", "action_succeeded", "t6"),
                ("u1", "apply", "action_failed", "t7"),
                ("u1", "apply", "dry_run_completed", "t8"),
                ("u1", "score", "retry_requested", "t9"),
                ("u1", "score", "mark_applied", "t10"),
                # Already-PascalCase rows must pass through unchanged.
                ("u1", "score", "StageCompleted", "t11"),
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
        conn.execute(
            "INSERT INTO job_events (job_url, stage, event_type, occurred_at) VALUES (?, ?, ?, ?)",
            ("u1", "score", "stage_succeeded", "t0"),
        )
        conn.commit()

        ensure_state_tables(conn)
        ensure_state_tables(conn)
        ensure_state_tables(conn)

        row = conn.execute("SELECT event_type FROM job_events WHERE occurred_at = 't0'").fetchone()
        assert row["event_type"] == "StageCompleted"
    finally:
        close_connection(db_path)
