from __future__ import annotations

import sqlite3

import pytest

from jobctl import config
from jobctl.config import WorkspaceMigrationError, migrate_default_workspace


def _legacy_token() -> str:
    return "job" + "hunter"


def _seed_legacy_workspace(home) -> tuple[object, object]:
    legacy = home / f".{_legacy_token()}"
    legacy.mkdir()
    (legacy / ".env").write_text("GEMINI_API_KEY=placeholder\n", encoding="utf-8")
    (legacy / "gmail").mkdir()
    (legacy / "gmail" / "token.json").write_text("{}", encoding="utf-8")
    (legacy / "backups").mkdir()
    (legacy / "backups" / "backup.db").write_text("backup", encoding="utf-8")

    db_path = legacy / f"{_legacy_token()}.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            f"""
            CREATE TABLE jobs (url TEXT PRIMARY KEY, title TEXT);
            INSERT INTO jobs (url, title) VALUES ('https://example.test/job', 'Engineer');
            CREATE TABLE {_legacy_token()}_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT
            );
            INSERT INTO {_legacy_token()}_deleted_jobs
                (job_url, deleted_at, reason)
            VALUES ('https://example.test/job', '2026-07-07T00:00:00Z', 'test');
            CREATE TABLE {_legacy_token()}_hidden_jobs (
                job_url TEXT PRIMARY KEY,
                hidden_at TEXT NOT NULL,
                reason TEXT
            );
            INSERT INTO {_legacy_token()}_hidden_jobs
                (job_url, hidden_at, reason)
            VALUES ('https://example.test/job', '2026-07-07T00:00:00Z', 'test');
            """
        )
        conn.commit()
    finally:
        conn.close()
    (legacy / f"{_legacy_token()}.db-wal").write_text("wal", encoding="utf-8")
    (legacy / f"{_legacy_token()}.db-shm").write_text("shm", encoding="utf-8")
    return legacy, db_path


def _table_names(db_path) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        return {str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    finally:
        conn.close()


def _table_columns(db_path, table_name: str) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        return {str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table_name}")')}
    finally:
        conn.close()


def test_default_workspace_migration_moves_files_and_renames_db_tables(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("JOBCTL_DIR", raising=False)
    monkeypatch.setattr(config, "WORKSPACE_MIGRATION_NOTICE", None)
    legacy, _ = _seed_legacy_workspace(tmp_path)

    current = migrate_default_workspace(tmp_path)

    assert current == tmp_path / ".jobctl"
    assert not legacy.exists()
    assert (current / ".env").is_file()
    assert (current / "gmail" / "token.json").is_file()
    assert (current / "backups" / "backup.db").is_file()
    assert (current / "jobctl.db").is_file()
    assert not (current / f"{_legacy_token()}.db").exists()
    assert not (current / f"{_legacy_token()}.db-wal").exists()
    assert not (current / f"{_legacy_token()}.db-shm").exists()

    tables = _table_names(current / "jobctl.db")
    assert "jobctl_deleted_jobs" in tables
    assert "jobctl_hidden_jobs" in tables
    assert f"{_legacy_token()}_deleted_jobs" not in tables
    assert f"{_legacy_token()}_hidden_jobs" not in tables

    conn = sqlite3.connect(current / "jobctl.db")
    try:
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM jobctl_deleted_jobs").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM jobctl_hidden_jobs").fetchone()[0] == 1
        assert conn.execute("SELECT restored_at FROM jobctl_deleted_jobs").fetchone()[0] is None
        assert conn.execute("SELECT unhidden_at FROM jobctl_hidden_jobs").fetchone()[0] is None
    finally:
        conn.close()
    assert {"job_url", "deleted_at", "reason", "restored_at"} <= _table_columns(
        current / "jobctl.db",
        "jobctl_deleted_jobs",
    )
    assert {"job_url", "hidden_at", "reason", "unhidden_at"} <= _table_columns(
        current / "jobctl.db",
        "jobctl_hidden_jobs",
    )
    assert config.WORKSPACE_MIGRATION_NOTICE is not None

    assert migrate_default_workspace(tmp_path) == current


def test_legacy_table_migration_normalizes_previously_renamed_tables(tmp_path) -> None:
    db_path = tmp_path / "jobctl.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE jobs (url TEXT PRIMARY KEY, title TEXT);
            INSERT INTO jobs (url, title) VALUES ('https://example.test/job', 'Engineer');
            CREATE TABLE jobctl_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT
            );
            INSERT INTO jobctl_deleted_jobs
                (job_url, deleted_at, reason)
            VALUES ('https://example.test/job', '2026-07-07T00:00:00Z', 'test');
            CREATE TABLE jobctl_hidden_jobs (
                job_url TEXT PRIMARY KEY,
                hidden_at TEXT NOT NULL,
                reason TEXT
            );
            INSERT INTO jobctl_hidden_jobs
                (job_url, hidden_at, reason)
            VALUES ('https://example.test/job', '2026-07-07T00:00:00Z', 'test');
            """
        )

        assert config.migrate_legacy_job_tables(conn) == []
        assert conn.execute("SELECT restored_at FROM jobctl_deleted_jobs").fetchone()[0] is None
        assert conn.execute("SELECT unhidden_at FROM jobctl_hidden_jobs").fetchone()[0] is None
    finally:
        conn.close()

    assert {"job_url", "deleted_at", "reason", "restored_at"} <= _table_columns(
        db_path,
        "jobctl_deleted_jobs",
    )
    assert {"job_url", "hidden_at", "reason", "unhidden_at"} <= _table_columns(
        db_path,
        "jobctl_hidden_jobs",
    )


def test_default_workspace_migration_refuses_existing_current_dir(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("JOBCTL_DIR", raising=False)
    legacy, _ = _seed_legacy_workspace(tmp_path)
    current = tmp_path / ".jobctl"
    current.mkdir()
    (current / "sentinel").write_text("keep", encoding="utf-8")

    with pytest.raises(WorkspaceMigrationError):
        migrate_default_workspace(tmp_path)

    assert legacy.exists()
    assert (current / "sentinel").read_text(encoding="utf-8") == "keep"


def test_jobctl_dir_override_suppresses_default_workspace_migration(tmp_path, monkeypatch) -> None:
    legacy, _ = _seed_legacy_workspace(tmp_path)
    override = tmp_path / "custom-jobctl"
    monkeypatch.setenv("JOBCTL_DIR", str(override))

    assert migrate_default_workspace(tmp_path) == override
    assert legacy.exists()
    assert not (tmp_path / ".jobctl").exists()
