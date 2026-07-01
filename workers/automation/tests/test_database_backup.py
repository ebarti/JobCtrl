"""Schema-version guard + VACUUM INTO backup for the local SQLite database.

These pin the two data-durability invariants added alongside ``jobhunter
backup``: every database carries a stamped ``PRAGMA user_version`` (adopted
cleanly for pre-guard files, never silently downgraded), and a backup is a
readable standalone SQLite file holding the same tables and rows as the source.
"""

from __future__ import annotations

import logging
import sqlite3

import pytest

from jobhunter.database import (
    SCHEMA_VERSION,
    backup_database,
    close_connection,
    init_db,
)


def _user_version(db_path) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()


def test_fresh_db_is_stamped_with_schema_version(tmp_path) -> None:
    db_path = tmp_path / "jobhunter.db"
    init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == SCHEMA_VERSION


def test_schema_version_persists_across_reopen(tmp_path) -> None:
    db_path = tmp_path / "jobhunter.db"
    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION

    # Re-opening an already-stamped database must be a no-op, not a re-stamp.
    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION


def test_legacy_version_zero_db_is_adopted_without_data_loss(tmp_path) -> None:
    db_path = tmp_path / "jobhunter.db"
    conn = init_db(db_path)
    conn.execute("INSERT INTO jobs (url, title) VALUES (?, ?)", ("https://ex/legacy", "Engineer"))
    conn.commit()
    close_connection(db_path)

    # Simulate a database created before the guard existed: version 0.
    raw = sqlite3.connect(db_path)
    raw.execute("PRAGMA user_version = 0")
    raw.commit()
    raw.close()

    init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == SCHEMA_VERSION
    check = sqlite3.connect(db_path)
    try:
        row = check.execute("SELECT title FROM jobs WHERE url = ?", ("https://ex/legacy",)).fetchone()
    finally:
        check.close()
    assert row is not None and row[0] == "Engineer"


def test_newer_schema_version_is_not_downgraded_and_warns(tmp_path, caplog) -> None:
    db_path = tmp_path / "jobhunter.db"
    init_db(db_path)
    close_connection(db_path)

    future_version = SCHEMA_VERSION + 5
    raw = sqlite3.connect(db_path)
    raw.execute(f"PRAGMA user_version = {future_version}")
    raw.commit()
    raw.close()

    with caplog.at_level(logging.WARNING, logger="jobhunter.database"):
        init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == future_version
    assert "newer" in caplog.text.lower()


def test_backup_copies_tables_and_rows_into_readable_sqlite(tmp_path) -> None:
    db_path = tmp_path / "jobhunter.db"
    conn = init_db(db_path)
    conn.execute(
        "INSERT INTO jobs (url, title, company) VALUES (?, ?, ?)",
        ("https://ex/backup-1", "Staff Engineer", "Acme"),
    )
    conn.execute(
        "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("https://ex/backup-1", "discover", "StageCompleted", "info", "done", "2026-05-01T00:00:00+00:00"),
    )
    conn.commit()

    destination = backup_database(tmp_path / "snapshot.db", db_path=db_path)

    assert destination == tmp_path / "snapshot.db"
    assert destination.exists()
    # VACUUM INTO produces a standalone single-file database, no WAL sidecar.
    assert not (tmp_path / "snapshot.db-wal").exists()

    backup = sqlite3.connect(destination)
    try:
        assert int(backup.execute("PRAGMA user_version").fetchone()[0]) == SCHEMA_VERSION
        tables = {row[0] for row in backup.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()}
        for expected in ("jobs", "job_events", "job_stage_states", "candidate_profiles"):
            assert expected in tables
        job_row = backup.execute(
            "SELECT title, company FROM jobs WHERE url = ?", ("https://ex/backup-1",)
        ).fetchone()
        assert job_row == ("Staff Engineer", "Acme")
        event_count = backup.execute(
            "SELECT COUNT(*) FROM job_events WHERE job_url = ?", ("https://ex/backup-1",)
        ).fetchone()[0]
        assert event_count == 1
    finally:
        backup.close()


def test_backup_default_path_is_timestamped_under_source_backups_dir(tmp_path) -> None:
    db_path = tmp_path / "jobhunter.db"
    init_db(db_path)

    destination = backup_database(db_path=db_path)

    assert destination.parent == tmp_path / "backups"
    assert destination.name.startswith("jobhunter-")
    assert destination.suffix == ".db"
    assert destination.exists()
    readback = sqlite3.connect(destination)
    try:
        assert readback.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    finally:
        readback.close()


def test_backup_into_existing_directory_generates_timestamped_file(tmp_path) -> None:
    db_path = tmp_path / "jobhunter.db"
    init_db(db_path)
    out_dir = tmp_path / "manual-backups"
    out_dir.mkdir()

    destination = backup_database(out_dir, db_path=db_path)

    assert destination.parent == out_dir
    assert destination.name.startswith("jobhunter-")
    assert destination.suffix == ".db"
    assert destination.exists()


def test_backup_missing_source_raises(tmp_path) -> None:
    with pytest.raises(FileNotFoundError):
        backup_database(db_path=tmp_path / "does-not-exist.db")


def test_backup_refuses_existing_destination(tmp_path) -> None:
    db_path = tmp_path / "jobhunter.db"
    init_db(db_path)
    destination = tmp_path / "already-there.db"
    destination.write_bytes(b"")

    with pytest.raises(FileExistsError):
        backup_database(destination, db_path=db_path)
