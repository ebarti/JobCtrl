"""Synthetic data-integrity checks for the unwired in-place migration helper."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v14_to_v15_inplace as inplace
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V14_MANIFEST,
    EXACT_V15_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema


def _make(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
        create_exact_v14_schema(conn)
        conn.execute(
            "INSERT INTO candidate_profiles (tenant_id,profile_id,personal_full_name,updated_at) "
            "VALUES ('synthetic','default','owned-profile','t')"
        )
        conn.execute(
            "INSERT INTO discovery_settings (tenant_id,search_config_json,created_at,updated_at) "
            "VALUES ('synthetic','{\"owned_search\":true}','t','t')"
        )
        conn.execute(
            "INSERT INTO resume_templates (tenant_id,template_id,display_name,created_at,updated_at) "
            "VALUES ('synthetic','owned','owned-resume','t','t')"
        )
        conn.execute("INSERT INTO jobs (tenant_id,job_id,url) VALUES ('synthetic','j','https://example.invalid/j')")


def _assert_protected(conn: sqlite3.Connection, name: str = "owned-profile") -> None:
    assert conn.execute("SELECT personal_full_name FROM candidate_profiles").fetchone() == (name,)
    assert conn.execute("SELECT search_config_json FROM discovery_settings").fetchone() == ('{"owned_search":true}',)
    assert conn.execute("SELECT display_name FROM resume_templates WHERE tenant_id='synthetic' AND template_id='owned'").fetchone() == ("owned-resume",)
    assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_live_wal_and_preexisting_connection_keep_protected_data(tmp_path: Path) -> None:
    path = tmp_path / "owned.db"
    _make(path)
    resume = tmp_path / "owned-resume.txt"
    resume.write_bytes(b"synthetic-resume\x00unchanged")
    old = sqlite3.connect(path)
    try:
        old.execute("UPDATE candidate_profiles SET personal_full_name='committed-before'")
        old.commit()
        assert Path(f"{path}-wal").exists()
        inode = path.stat().st_ino
        assert inplace.upgrade_v14_in_place(path)
        assert path.stat().st_ino == inode
        old.execute("UPDATE candidate_profiles SET personal_full_name='committed-after'")
        old.commit()
        old.execute("DELETE FROM jobs WHERE tenant_id='synthetic' AND job_id='j'")
        old.commit()
        with sqlite3.connect(path) as check:
            assert_exact_manifest(check, EXACT_V15_MANIFEST)
            _assert_protected(check, "committed-after")
            assert check.execute("SELECT revision FROM job_lifecycle_clock").fetchone()[0] > 0
        assert resume.read_bytes() == b"synthetic-resume\x00unchanged"
        assert not inplace.upgrade_v14_in_place(path)
    finally:
        old.close()


def test_failed_ddl_rolls_back_without_replacing_live_inode(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "owned.db"
    _make(path)
    inode = path.stat().st_ino
    real_extend = inplace._extend

    def fail_after_ddl(conn: sqlite3.Connection) -> None:
        real_extend(conn)
        raise RuntimeError("synthetic failure after schema update")

    monkeypatch.setattr(inplace, "_extend", fail_after_ddl)
    with pytest.raises(RuntimeError, match="synthetic failure"):
        inplace.upgrade_v14_in_place(path)
    assert path.stat().st_ino == inode
    with sqlite3.connect(path) as conn:
        assert_exact_manifest(conn, EXACT_V14_MANIFEST)
        _assert_protected(conn)



def test_competing_writer_waits_and_preserves_every_acknowledged_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "owned.db"
    _make(path)
    locked = threading.Event()
    release = threading.Event()
    failures: list[BaseException] = []
    original_extend = inplace._extend

    def hold_during_ddl(conn: sqlite3.Connection) -> None:
        original_extend(conn)
        locked.set()
        if not release.wait(timeout=10):
            raise RuntimeError("synthetic test did not release migrator")

    monkeypatch.setattr(inplace, "_extend", hold_during_ddl)

    def migrate() -> None:
        try:
            inplace.upgrade_v14_in_place(path)
        except BaseException as exc:
            failures.append(exc)

    thread = threading.Thread(target=migrate)
    thread.start()
    try:
        assert locked.wait(timeout=10)
        with sqlite3.connect(path, timeout=0) as writer:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                writer.execute("UPDATE candidate_profiles SET personal_full_name='not-acknowledged'")
        release.set()
        thread.join(timeout=10)
        assert not thread.is_alive()
        assert not failures
        with sqlite3.connect(path) as writer:
            writer.execute("UPDATE candidate_profiles SET personal_full_name='acknowledged-after'")
        with sqlite3.connect(path) as check:
            assert_exact_manifest(check, EXACT_V15_MANIFEST)
            _assert_protected(check, "acknowledged-after")
    finally:
        release.set()
        thread.join(timeout=10)


def test_locked_existing_caller_transaction_is_not_committed(tmp_path: Path) -> None:
    path = tmp_path / "owned.db"
    _make(path)
    original = sqlite3.connect(path)
    try:
        original.execute("UPDATE candidate_profiles SET personal_full_name='not-committed'")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            inplace.upgrade_v14_in_place(path)
        assert original.in_transaction
        original.rollback()
        with sqlite3.connect(path) as check:
            assert_exact_manifest(check, EXACT_V14_MANIFEST)
            _assert_protected(check)
    finally:
        original.close()


def test_post_commit_directory_sync_failure_does_not_restore_old_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "owned.db"
    _make(path)

    def fail_sync(_path: Path) -> None:
        raise OSError("synthetic directory sync failure")

    monkeypatch.setattr(inplace, "_fsync_directory", fail_sync)
    with pytest.raises(inplace.InPlaceDurabilityUncertainError):
        inplace.upgrade_v14_in_place(path)
    with sqlite3.connect(path) as check:
        assert_exact_manifest(check, EXACT_V15_MANIFEST)
        _assert_protected(check)
    monkeypatch.undo()
    assert not inplace.upgrade_v14_in_place(path)



@pytest.mark.parametrize("when", ["before", "after"])
def test_commit_exception_reports_correct_transaction_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, when: str
) -> None:
    path = tmp_path / "owned.db"
    _make(path)
    real_connect = sqlite3.connect

    class FailCommit:
        def __init__(self, conn: sqlite3.Connection) -> None:
            self.conn = conn

        @property
        def in_transaction(self) -> bool:
            return self.conn.in_transaction

        def execute(self, sql: str, *args: object) -> sqlite3.Cursor:
            if sql == "COMMIT":
                if when == "after":
                    self.conn.execute(sql)
                raise sqlite3.OperationalError("synthetic commit error")
            return self.conn.execute(sql, *args)

        def close(self) -> None:
            self.conn.close()

    monkeypatch.setattr(inplace.sqlite3, "connect", lambda *args, **kwargs: FailCommit(real_connect(*args, **kwargs)))
    error = inplace.InPlaceDurabilityUncertainError if when == "after" else sqlite3.OperationalError
    with pytest.raises(error):
        inplace.upgrade_v14_in_place(path)
    monkeypatch.undo()
    with sqlite3.connect(path) as check:
        assert_exact_manifest(check, EXACT_V15_MANIFEST if when == "after" else EXACT_V14_MANIFEST)
        _assert_protected(check)


def test_symlink_and_hardlink_sources_are_refused(tmp_path: Path) -> None:
    path = tmp_path / "owned.db"
    _make(path)
    symlink = tmp_path / "link.db"
    symlink.symlink_to(path)
    with pytest.raises(SchemaManifestError):
        inplace.upgrade_v14_in_place(symlink)
    alias = tmp_path / "alias.db"
    os.link(path, alias)
    with pytest.raises(SchemaManifestError):
        inplace.upgrade_v14_in_place(path)
    with sqlite3.connect(path) as check:
        assert_exact_manifest(check, EXACT_V14_MANIFEST)
        _assert_protected(check)


@pytest.mark.parametrize("stage", ["before_first_table", "before_trigger", "before_stamp", "before_commit", "after_commit"])
def test_owned_process_death_leaves_exact_schema_and_protected_data(tmp_path: Path, stage: str) -> None:
    path = tmp_path / "owned.db"
    marker = tmp_path / "ready"
    _make(path)
    inode = path.stat().st_ino
    source = '''
import pathlib, sys, time
from jobctrl.infrastructure.migrations import v14_to_v15_inplace as migration
path, marker, stage = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
def pause():
    marker.write_text('ready')
    while True: time.sleep(0.1)
if stage in ('before_first_table', 'before_trigger', 'before_stamp'):
    original_connect = migration.sqlite3.connect
    def traced_connect(*args, **kwargs):
        conn = original_connect(*args, **kwargs)
        def trace(sql):
            normalized = sql.strip().upper()
            if (stage == 'before_first_table' and 'CREATE TABLE JOB_LIFECYCLE_CLOCK' in normalized) or (stage == 'before_trigger' and normalized.startswith('CREATE TRIGGER JOB_LIFECYCLE_CLOCK_NO_DELETE')) or (stage == 'before_stamp' and normalized == 'PRAGMA USER_VERSION = 15'):
                pause()
        conn.set_trace_callback(trace)
        return conn
    migration.sqlite3.connect = traced_connect
elif stage == 'before_commit':
    original = migration._extend
    def extend(conn):
        original(conn)
        pause()
    migration._extend = extend
else:
    def directory_sync(_path):
        pause()
    migration._fsync_directory = directory_sync
migration.upgrade_v14_in_place(path)
'''
    proc = subprocess.Popen([sys.executable, "-c", source, str(path), str(marker), stage], env=os.environ.copy())
    try:
        deadline = time.monotonic() + 30
        while not marker.exists() and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert marker.exists(), f"synthetic child did not reach {stage}: {proc.poll()}"
        proc.kill()
        proc.wait(timeout=10)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
    assert path.stat().st_ino == inode
    with sqlite3.connect(path) as check:
        assert_exact_manifest(check, EXACT_V15_MANIFEST if stage == "after_commit" else EXACT_V14_MANIFEST)
        _assert_protected(check)
