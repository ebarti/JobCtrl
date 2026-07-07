"""Regression tests for the stage-runner thread safety bugs fixed in
``debug/post-temporal-stack``.

The tailor / scorer / cover_letter runners hand work to a
``ThreadPoolExecutor``. Two related defects landed in production:

* Tailor passed a main-thread-built ``use_case`` (with main-thread
  ``SqliteMaterialsRepository``) into worker threads, which crashed with
  ``sqlite3.ProgrammingError: SQLite objects created in a thread can only
  be used in that same thread`` on every job.
* All three runners wrote ``set_stage_state(..., "running")`` without
  ``validate_transition=False``. Once ``set_stage_state`` enforced the
  canonical state-machine table (PR 6), retried jobs in ``failed`` state
  hit ``Invalid state transition for tailor: failed -> running``.

This file pins both invariants so they never silently regress.
"""

from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from jobctl.database import get_connection, init_db
from jobctl.infrastructure.materials import SqliteMaterialsRepository
from jobctl.infrastructure.profile import factory as profile_factory
from jobctl.state import set_stage_state, ensure_job_stage_rows


@pytest.fixture()
def db(tmp_path: Path, monkeypatch) -> sqlite3.Connection:
    db_path = tmp_path / "jobctl.db"
    init_db(db_path)
    # Force ``get_connection()`` to use the temp DB path so worker threads
    # build their own thread-local connection against the same DB the
    # test fixture initialised.
    monkeypatch.setenv("JOBCTL_DIR", str(tmp_path))
    return get_connection()


def test_thread_local_sqlite_connection_isolation(db: sqlite3.Connection) -> None:
    """``get_connection()`` is the per-thread SQLite cache that the stage
    runners rely on after the cross-thread fix. Pin that two threads see
    two different connection objects so a future refactor can't silently
    revert to a shared singleton (which would crash with
    ``ProgrammingError: SQLite objects created in a thread can only be
    used in that same thread``)."""

    main_thread_conn_id = id(get_connection())

    def worker_gets_own_conn() -> tuple[int, int]:
        worker_conn = get_connection()
        # Hitting the worker conn from the worker thread must succeed.
        worker_conn.execute("SELECT 1").fetchone()
        # Building a SqliteMaterialsRepository (the type tailor.py uses)
        # against the worker conn also must not raise.
        repo = SqliteMaterialsRepository(worker_conn)
        return id(worker_conn), id(repo._conn)  # type: ignore[attr-defined]

    with ThreadPoolExecutor(max_workers=1) as executor:
        worker_conn_id, repo_conn_id = executor.submit(worker_gets_own_conn).result()

    assert worker_conn_id == repo_conn_id, "repository and conn must be the same handle"
    assert worker_conn_id != main_thread_conn_id, (
        "worker thread must get its own SQLite connection — a shared "
        "main-thread conn would crash with ProgrammingError"
    )


def test_profile_repository_cache_is_thread_local(tmp_path: Path, monkeypatch) -> None:
    """The profile repository also owns a SQLite connection.

    A process-wide profile repository singleton is enough to reintroduce
    the tailor-stage crash: Temporal activities run the sync pipeline in
    executor threads, so a repository first created elsewhere cannot be
    reused safely inside the activity worker thread.
    """

    monkeypatch.setattr(profile_factory.config, "DB_PATH", tmp_path / "jobctl.db")
    profile_factory.reset_profile_repository()

    main_repo = profile_factory.get_profile_repository()
    main_repo.load("local")
    main_repo_id = id(main_repo)
    main_conn_id = id(main_repo._conn)  # type: ignore[attr-defined]

    def worker_gets_own_repo() -> tuple[int, int]:
        worker_repo = profile_factory.get_profile_repository()
        worker_repo.load("local")
        return id(worker_repo), id(worker_repo._conn)  # type: ignore[attr-defined]

    with ThreadPoolExecutor(max_workers=1) as executor:
        worker_repo_id, worker_conn_id = executor.submit(worker_gets_own_repo).result()

    assert worker_repo_id != main_repo_id
    assert worker_conn_id != main_conn_id


def test_failed_to_running_transition_skips_validation(
    db: sqlite3.Connection,
) -> None:
    """Stage runners (scorer/tailor/cover_letter) restart previously-
    failed jobs by writing ``running`` directly. The canonical state
    machine table only allows Failed -> Pending (Reset) and Failed ->
    Exhausted; the runners pass ``validate_transition=False`` to skip
    the check. Pin that the underlying ``set_stage_state`` honors the
    bypass so a reverted runner doesn't silently start crashing in
    production."""

    url = "https://example.com/job/1"
    ensure_job_stage_rows(db, url, discovered_at="2026-01-01T00:00:00+00:00")
    # Seed the row in 'failed' state via the validation bypass — the
    # canonical state machine doesn't permit pending -> failed directly,
    # but for this test we just need the row to BE in failed state to
    # exercise the fix.
    set_stage_state(
        db, url, "tailor", "failed",
        error_message="prior run died",
        validate_transition=False,
    )

    # Strict path: Failed -> Running must be rejected by the canonical table.
    with pytest.raises(ValueError, match="Invalid state transition"):
        set_stage_state(db, url, "tailor", "running")

    # Bypass path: runners pass validate_transition=False and survive.
    set_stage_state(db, url, "tailor", "running", validate_transition=False)
    row = db.execute(
        "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = ?",
        (url, "tailor"),
    ).fetchone()
    assert row["state"] == "running"
