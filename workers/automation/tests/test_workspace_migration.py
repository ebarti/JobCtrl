from __future__ import annotations

import sqlite3

import pytest

from jobctrl import config
from jobctrl.config import WorkspaceMigrationError, resolve_default_workspace


def _legacy_token() -> str:
    return "job" + "hunter"


def _immediate_legacy_token() -> str:
    return "job" + "ctl"


def _legacy_tokens() -> tuple[str, str]:
    return (_immediate_legacy_token(), _legacy_token())


def _seed_legacy_workspace(home, token: str) -> tuple[object, object]:
    legacy = home / f".{token}"
    legacy.mkdir()
    (legacy / ".env").write_text("GEMINI_API_KEY=placeholder\n", encoding="utf-8")
    (legacy / "gmail").mkdir()
    (legacy / "gmail" / "token.json").write_text("{}", encoding="utf-8")
    (legacy / "backups").mkdir()
    (legacy / "backups" / "backup.db").write_text("backup", encoding="utf-8")

    db_path = legacy / f"{token}.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            f"""
            CREATE TABLE jobs (url TEXT PRIMARY KEY, title TEXT);
            INSERT INTO jobs (url, title) VALUES ('https://example.test/job', 'Engineer');
            CREATE TABLE {token}_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT
            );
            INSERT INTO {token}_deleted_jobs
                (job_url, deleted_at, reason)
            VALUES ('https://example.test/job', '2026-07-07T00:00:00Z', 'test');
            CREATE TABLE {token}_hidden_jobs (
                job_url TEXT PRIMARY KEY,
                hidden_at TEXT NOT NULL,
                reason TEXT
            );
            INSERT INTO {token}_hidden_jobs
                (job_url, hidden_at, reason)
            VALUES ('https://example.test/job', '2026-07-07T00:00:00Z', 'test');
            """
        )
        conn.commit()
    finally:
        conn.close()
    (legacy / f"{token}.db-wal").write_text("wal", encoding="utf-8")
    (legacy / f"{token}.db-shm").write_text("shm", encoding="utf-8")
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


@pytest.mark.parametrize("legacy_token", _legacy_tokens())
def test_default_workspace_resolution_ignores_legacy_only_workspace(
    tmp_path,
    monkeypatch,
    legacy_token: str,
) -> None:
    monkeypatch.delenv("JOBCTRL_DIR", raising=False)
    legacy, _ = _seed_legacy_workspace(tmp_path, legacy_token)

    current = resolve_default_workspace(tmp_path)

    assert current == tmp_path / ".jobctrl"
    assert legacy.exists()
    assert not current.exists()
    assert (legacy / ".env").is_file()
    assert (legacy / "gmail" / "token.json").is_file()
    assert (legacy / "backups" / "backup.db").is_file()
    assert (legacy / f"{legacy_token}.db").is_file()
    assert (legacy / f"{legacy_token}.db-wal").is_file()
    assert (legacy / f"{legacy_token}.db-shm").is_file()

    assert resolve_default_workspace(tmp_path) == current


def test_default_workspace_resolution_uses_current_dir_when_legacy_dir_also_exists(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.delenv("JOBCTRL_DIR", raising=False)
    legacy, _ = _seed_legacy_workspace(tmp_path, _immediate_legacy_token())
    current = tmp_path / ".jobctrl"
    current.mkdir()
    (current / "sentinel").write_text("keep", encoding="utf-8")

    assert resolve_default_workspace(tmp_path) == current
    assert legacy.exists()
    assert (current / "sentinel").read_text(encoding="utf-8") == "keep"


@pytest.mark.parametrize("legacy_token", _legacy_tokens())
def test_legacy_table_migration_moves_legacy_rows_to_current_tables(
    tmp_path,
    legacy_token: str,
) -> None:
    _, db_path = _seed_legacy_workspace(tmp_path, legacy_token)
    conn = sqlite3.connect(db_path)
    try:
        assert set(config.migrate_legacy_job_tables(conn)) == {
            "jobctrl_deleted_jobs",
            "jobctrl_hidden_jobs",
        }

        tables = _table_names(db_path)
        assert "jobctrl_deleted_jobs" in tables
        assert "jobctrl_hidden_jobs" in tables
        assert f"{legacy_token}_deleted_jobs" not in tables
        assert f"{legacy_token}_hidden_jobs" not in tables
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM jobctrl_deleted_jobs").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM jobctrl_hidden_jobs").fetchone()[0] == 1
        assert conn.execute("SELECT restored_at FROM jobctrl_deleted_jobs").fetchone()[0] is None
        assert conn.execute("SELECT unhidden_at FROM jobctrl_hidden_jobs").fetchone()[0] is None
    finally:
        conn.close()

    assert {"job_url", "deleted_at", "reason", "restored_at"} <= _table_columns(
        db_path,
        "jobctrl_deleted_jobs",
    )
    assert {"job_url", "hidden_at", "reason", "unhidden_at"} <= _table_columns(
        db_path,
        "jobctrl_hidden_jobs",
    )


def test_legacy_table_migration_normalizes_previously_renamed_tables(tmp_path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE jobs (url TEXT PRIMARY KEY, title TEXT);
            INSERT INTO jobs (url, title) VALUES ('https://example.test/job', 'Engineer');
            CREATE TABLE jobctrl_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT
            );
            INSERT INTO jobctrl_deleted_jobs
                (job_url, deleted_at, reason)
            VALUES ('https://example.test/job', '2026-07-07T00:00:00Z', 'test');
            CREATE TABLE jobctrl_hidden_jobs (
                job_url TEXT PRIMARY KEY,
                hidden_at TEXT NOT NULL,
                reason TEXT
            );
            INSERT INTO jobctrl_hidden_jobs
                (job_url, hidden_at, reason)
            VALUES ('https://example.test/job', '2026-07-07T00:00:00Z', 'test');
            """
        )

        assert config.migrate_legacy_job_tables(conn) == []
        assert conn.execute("SELECT restored_at FROM jobctrl_deleted_jobs").fetchone()[0] is None
        assert conn.execute("SELECT unhidden_at FROM jobctrl_hidden_jobs").fetchone()[0] is None
    finally:
        conn.close()

    assert {"job_url", "deleted_at", "reason", "restored_at"} <= _table_columns(
        db_path,
        "jobctrl_deleted_jobs",
    )
    assert {"job_url", "hidden_at", "reason", "unhidden_at"} <= _table_columns(
        db_path,
        "jobctrl_hidden_jobs",
    )


def test_default_workspace_resolution_does_not_inspect_legacy_db_conflicts(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.delenv("JOBCTRL_DIR", raising=False)
    legacy, _ = _seed_legacy_workspace(tmp_path, _immediate_legacy_token())
    (legacy / "jobctrl.db").write_text("new", encoding="utf-8")

    assert resolve_default_workspace(tmp_path) == tmp_path / ".jobctrl"

    assert legacy.exists()
    assert not (tmp_path / ".jobctrl").exists()
    assert (legacy / "jobctrl.db").read_text(encoding="utf-8") == "new"


def test_legacy_table_migration_refuses_duplicate_job_urls_without_dropping_legacy_table(
    tmp_path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    token = "job" + "ctl"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            f"""
            CREATE TABLE jobctrl_hidden_jobs (
                job_url TEXT PRIMARY KEY,
                hidden_at TEXT NOT NULL,
                reason TEXT,
                unhidden_at TEXT
            );
            INSERT INTO jobctrl_hidden_jobs
                (job_url, hidden_at, reason, unhidden_at)
            VALUES ('https://example.test/duplicate', '2026-07-07T00:00:00Z', 'current', NULL);
            CREATE TABLE {token}_hidden_jobs (
                job_url TEXT PRIMARY KEY,
                hidden_at TEXT NOT NULL,
                reason TEXT
            );
            INSERT INTO {token}_hidden_jobs
                (job_url, hidden_at, reason)
            VALUES ('https://example.test/duplicate', '2026-07-07T00:01:00Z', 'legacy');
            """
        )
        conn.commit()

        with pytest.raises(WorkspaceMigrationError, match="duplicate job_url"):
            config.migrate_legacy_job_tables(conn)

        assert "jobctrl_hidden_jobs" in _table_names(db_path)
        assert f"{token}_hidden_jobs" in _table_names(db_path)
        assert conn.execute("SELECT COUNT(*) FROM jobctrl_hidden_jobs").fetchone()[0] == 1
        assert conn.execute(f"SELECT COUNT(*) FROM {token}_hidden_jobs").fetchone()[0] == 1
    finally:
        conn.close()


def test_jobctrl_dir_override_selects_explicit_workspace_without_moving_legacy_dir(
    tmp_path,
    monkeypatch,
) -> None:
    legacy, _ = _seed_legacy_workspace(tmp_path, _immediate_legacy_token())
    override = tmp_path / "custom-jobctrl"
    monkeypatch.setenv("JOBCTRL_DIR", str(override))

    assert resolve_default_workspace(tmp_path) == override
    assert legacy.exists()
    assert not (tmp_path / ".jobctrl").exists()
