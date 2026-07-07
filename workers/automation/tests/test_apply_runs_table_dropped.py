"""PR 4: ``init_db`` drops the legacy ``apply_runs`` + ``apply_run_events``
tables and never re-creates them.

The Temporal workflow is the canonical record of an apply lifecycle from
PR 4 onward; ``apply_run_projections`` (sourced from ``job_events``) is
the read-side. Dropping the bespoke tables removes the second write path.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db


def _table_exists(conn, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
        (name,),
    ).fetchone()
    return row is not None


@pytest.fixture()
def fresh_db(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    yield db_path
    close_connection(db_path)


def test_init_db_does_not_create_apply_runs(fresh_db: Path) -> None:
    conn = init_db(fresh_db)
    assert _table_exists(conn, "apply_runs") is False


def test_init_db_does_not_create_apply_run_events(fresh_db: Path) -> None:
    conn = init_db(fresh_db)
    assert _table_exists(conn, "apply_run_events") is False


def test_init_db_drops_existing_apply_runs_table(fresh_db: Path) -> None:
    """If a legacy database already has ``apply_runs``, the migration
    drops it idempotently."""
    import sqlite3

    # Pre-create the legacy table to simulate an existing local DB.
    pre = sqlite3.connect(str(fresh_db))
    pre.execute(
        """
        CREATE TABLE apply_runs (
            run_id TEXT PRIMARY KEY,
            job_url TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'starting',
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    pre.execute(
        """
        CREATE TABLE apply_run_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            event_type TEXT NOT NULL
        )
        """
    )
    pre.commit()
    pre.close()

    conn = init_db(fresh_db)
    assert _table_exists(conn, "apply_runs") is False
    assert _table_exists(conn, "apply_run_events") is False
