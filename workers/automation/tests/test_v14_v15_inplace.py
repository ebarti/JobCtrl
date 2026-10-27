"""Synthetic data-integrity checks for the unwired in-place migration helper."""

from __future__ import annotations

import os
from contextlib import closing
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
    with closing(sqlite3.connect(path)) as conn:
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
        conn.commit()


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


def _build_bound_candidate(path: Path, tmp_path: Path) -> tuple[Path, Path]:
    from jobctrl.infrastructure.migrations.v14_to_v15_execute import execute_v14_to_v15_candidate
    from jobctrl.infrastructure.migrations.v15_activation import bind_source

    backup = tmp_path / "backup.db"
    candidate = tmp_path / "candidate.db"
    receipt = tmp_path / "candidate.binding.json"
    with closing(sqlite3.connect(path)) as src, closing(sqlite3.connect(backup)) as dst:
        src.backup(dst)
    execute_v14_to_v15_candidate(backup, candidate)
    bind_source(backup, path, candidate, receipt)
    return candidate, receipt


def test_bound_activation_uses_live_inode_and_preserves_wal_writes(tmp_path: Path) -> None:
    from jobctrl.infrastructure.migrations.v15_activation import activate

    path = tmp_path / "owned.db"
    _make(path)
    with closing(sqlite3.connect(path)) as old:
        old.execute("UPDATE candidate_profiles SET personal_full_name='before-binding'")
        old.commit()
    candidate, receipt = _build_bound_candidate(path, tmp_path)
    inode = path.stat().st_ino
    activate(path, candidate, receipt)
    assert path.stat().st_ino == inode
    assert not candidate.exists()
    assert not receipt.exists()
    with sqlite3.connect(path) as writer:
        writer.execute("UPDATE candidate_profiles SET personal_full_name='after-activation'")
    with sqlite3.connect(path) as check:
        assert_exact_manifest(check, EXACT_V15_MANIFEST)
        _assert_protected(check, "after-activation")


def test_bound_activation_preserves_existing_reader_exclusion(tmp_path: Path) -> None:
    import json

    path = tmp_path / "owned.db"
    _make(path)
    reader = sqlite3.connect(path)
    try:
        reader.execute("BEGIN")
        _assert_protected(reader)
        candidate, receipt = _build_bound_candidate(path, tmp_path)
        with pytest.raises(inplace.InPlaceSourceChangedError):
            inplace.upgrade_v14_in_place(path, binding=json.loads(receipt.read_text()))
        assert candidate.exists() and receipt.exists()
        _assert_protected(reader)
        reader.rollback()
        with sqlite3.connect(path) as check:
            assert_exact_manifest(check, EXACT_V14_MANIFEST)
            _assert_protected(check)
    finally:
        reader.close()


def test_bound_activation_rejects_changed_profile_and_retains_backup(tmp_path: Path) -> None:
    from jobctrl.infrastructure.migrations.v15_activation import SourceChangedError, activate

    path = tmp_path / "owned.db"
    _make(path)
    candidate, receipt = _build_bound_candidate(path, tmp_path)
    with sqlite3.connect(path) as writer:
        writer.execute("UPDATE candidate_profiles SET personal_full_name='later-committed'")
    with pytest.raises(SourceChangedError):
        activate(path, candidate, receipt)
    assert candidate.exists() and receipt.exists() and (tmp_path / "backup.db").exists()
    with sqlite3.connect(path) as check:
        assert_exact_manifest(check, EXACT_V14_MANIFEST)
        _assert_protected(check, "later-committed")
    with sqlite3.connect(tmp_path / "backup.db") as backup:
        _assert_protected(backup)


def test_existing_wal_reader_keeps_snapshot_without_data_loss(tmp_path: Path) -> None:
    path = tmp_path / "owned.db"
    _make(path)
    reader = sqlite3.connect(path)
    try:
        reader.execute("BEGIN")
        _assert_protected(reader)
        assert inplace.upgrade_v14_in_place(path)
        # The old transaction remains a coherent historical snapshot; it must
        # restart before it can observe or write against the new schema.
        _assert_protected(reader)
        with pytest.raises(sqlite3.OperationalError):
            reader.execute("UPDATE candidate_profiles SET personal_full_name='stale-write'")
        reader.rollback()
        reader.execute("UPDATE candidate_profiles SET personal_full_name='retried-write'")
        reader.commit()
        with sqlite3.connect(path) as check:
            assert_exact_manifest(check, EXACT_V15_MANIFEST)
            _assert_protected(check, "retried-write")
    finally:
        reader.close()


def test_activation_cleanup_failure_retains_committed_live_data_and_binding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl.infrastructure.migrations.v15_activation import activate

    path = tmp_path / "owned.db"
    _make(path)
    candidate, receipt = _build_bound_candidate(path, tmp_path)
    unlink = Path.unlink

    def fail_candidate_unlink(self: Path, *args: object, **kwargs: object) -> None:
        if self == candidate:
            raise OSError("synthetic cleanup failure")
        unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_candidate_unlink)
    with pytest.raises(OSError, match="synthetic cleanup failure"):
        activate(path, candidate, receipt)
    assert candidate.exists() and receipt.exists()
    with sqlite3.connect(path) as check:
        assert_exact_manifest(check, EXACT_V15_MANIFEST)
        _assert_protected(check)


def test_receipt_to_lock_race_rejects_new_protected_commit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from jobctrl.infrastructure.migrations import v15_activation

    path = tmp_path / "owned.db"
    _make(path)
    candidate, receipt = _build_bound_candidate(path, tmp_path)
    original_upgrade = v15_activation.upgrade_v14_in_place

    def write_before_lock(live: Path, **kwargs: object) -> bool:
        with sqlite3.connect(live) as writer:
            writer.execute("UPDATE candidate_profiles SET personal_full_name='committed-during-handoff'")
        return original_upgrade(live, **kwargs)

    monkeypatch.setattr(v15_activation, "upgrade_v14_in_place", write_before_lock)
    with pytest.raises(v15_activation.SourceChangedError):
        v15_activation.activate(path, candidate, receipt)
    assert candidate.exists() and receipt.exists()
    with sqlite3.connect(path) as check:
        assert_exact_manifest(check, EXACT_V14_MANIFEST)
        _assert_protected(check, "committed-during-handoff")
    with sqlite3.connect(tmp_path / "backup.db") as backup:
        _assert_protected(backup)


@pytest.mark.parametrize("cleanup_stage", ["receipt", "directory"])
def test_post_commit_cleanup_failures_preserve_live_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cleanup_stage: str
) -> None:
    from jobctrl.infrastructure.migrations import v15_activation

    path = tmp_path / "owned.db"
    _make(path)
    candidate, receipt = _build_bound_candidate(path, tmp_path)
    if cleanup_stage == "receipt":
        unlink = Path.unlink

        def fail_receipt_unlink(self: Path, *args: object, **kwargs: object) -> None:
            if self == receipt:
                raise OSError("synthetic receipt failure")
            unlink(self, *args, **kwargs)

        monkeypatch.setattr(Path, "unlink", fail_receipt_unlink)
    else:
        def fail_dirsync(_path: Path) -> None:
            raise OSError("synthetic directory failure")

        monkeypatch.setattr(v15_activation, "_fsync_directory", fail_dirsync)
    with pytest.raises(OSError):
        v15_activation.activate(path, candidate, receipt)
    assert (tmp_path / "backup.db").exists()
    with sqlite3.connect(path) as check:
        assert_exact_manifest(check, EXACT_V15_MANIFEST)
        _assert_protected(check)
    with sqlite3.connect(tmp_path / "backup.db") as backup:
        assert_exact_manifest(backup, EXACT_V14_MANIFEST)
        _assert_protected(backup)
