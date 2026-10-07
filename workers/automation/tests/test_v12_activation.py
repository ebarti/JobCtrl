from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v12_activation as activation
from jobctrl.infrastructure.migrations import v13_activation
from jobctrl.infrastructure.migrations.schema_v11 import create_exact_v11_schema
from jobctrl.infrastructure.migrations.schema_v12 import create_exact_v12_schema
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V12_MANIFEST, EXACT_V13_MANIFEST, assert_exact_manifest
from jobctrl.infrastructure.migrations.v11_to_v12_execute import execute_v11_to_v12_candidate
from jobctrl.infrastructure.migrations.v12_to_v13_execute import execute_v12_to_v13_candidate

_create_source_schema = create_exact_v11_schema
_execute_candidate = execute_v11_to_v12_candidate
_target_manifest = EXACT_V12_MANIFEST
_source_version = 11


@pytest.fixture(params=[12, 13], autouse=True)
def migration_case(request, monkeypatch):
    """Exercise both private activation implementations with their real schemas."""
    module, source, execute, manifest, version = (
        (activation, create_exact_v11_schema, execute_v11_to_v12_candidate, EXACT_V12_MANIFEST, 11)
        if request.param == 12
        else (v13_activation, create_exact_v12_schema, execute_v12_to_v13_candidate, EXACT_V13_MANIFEST, 12)
    )
    for name, value in {
        "activation": module, "_create_source_schema": source, "_execute_candidate": execute,
        "_target_manifest": manifest, "_source_version": version,
    }.items():
        monkeypatch.setitem(globals(), name, value)


def _bound(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    source, live, candidate, receipt = (
        tmp_path / name for name in ["paired.db", "live.db", "candidate.db", "binding.json"]
    )
    with sqlite3.connect(source) as conn:
        _create_source_schema(conn)
        conn.execute(
            "INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','j','https://synthetic/post','paired title')"
        )
    shutil.copyfile(source, live)
    _execute_candidate(source, candidate)
    activation.bind_source(source, live, candidate, receipt)
    return source, live, candidate, receipt


def test_atomic_activation_holds_writer_lock_through_rename(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source, live, candidate, receipt = _bound(tmp_path)
    original = activation.os.replace
    checked = []

    def guarded_replace(old, new):
        with sqlite3.connect(live, timeout=0) as writer:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                writer.execute("UPDATE jobs SET title='late concurrent write'")
        checked.append(True)
        return original(old, new)

    monkeypatch.setattr(activation.os, "replace", guarded_replace)
    activation.activate(live, candidate, receipt)
    assert checked == [True]
    assert not candidate.exists() and not receipt.exists()
    with sqlite3.connect(live) as conn:
        assert_exact_manifest(conn, _target_manifest)
        assert conn.execute("SELECT title FROM jobs").fetchone() == ("paired title",)


@pytest.mark.parametrize("when", ["before_bind", "after_bind"])
def test_live_write_after_paired_backup_is_retained_and_refused(tmp_path: Path, when: str) -> None:
    source, live, candidate, receipt = _bound(tmp_path)
    if when == "before_bind":
        receipt.unlink()
    with sqlite3.connect(live) as writer:
        writer.execute("UPDATE jobs SET title='independent committed write'")
    before = live.read_bytes()
    with pytest.raises(activation.SourceChangedError):
        if when == "before_bind":
            activation.bind_source(source, live, candidate, receipt)
        else:
            activation.activate(live, candidate, receipt)
    assert live.read_bytes() == before
    assert candidate.exists()
    with sqlite3.connect(live) as conn:
        assert conn.execute("SELECT title FROM jobs").fetchone() == ("independent committed write",)


def test_unmanaged_writer_before_activation_and_symlink_candidate_refuse(tmp_path: Path) -> None:
    _, live, candidate, receipt = _bound(tmp_path)
    before = live.read_bytes()
    writer = sqlite3.connect(live)
    try:
        writer.execute("BEGIN IMMEDIATE")
        with pytest.raises(activation.SourceChangedError):
            activation.activate(live, candidate, receipt)
    finally:
        writer.rollback()
        writer.close()
    alternate = tmp_path / "linked-candidate.db"
    alternate.symlink_to(candidate)
    with pytest.raises(activation.SourceChangedError):
        activation.activate(live, alternate, receipt)
    assert live.read_bytes() == before


def test_source_binding_requires_private_receipt_and_candidate_digest(tmp_path: Path) -> None:
    _, live, candidate, receipt = _bound(tmp_path)
    receipt.chmod(0o644)
    with pytest.raises(activation.SourceChangedError):
        activation.activate(live, candidate, receipt)
    receipt.chmod(0o600)
    with sqlite3.connect(candidate) as conn:
        conn.execute("UPDATE jobs SET title='tampered candidate'")
    before = live.read_bytes()
    with pytest.raises(RuntimeError, match="invalid candidate"):
        activation.activate(live, candidate, receipt)
    assert live.read_bytes() == before


def test_schema_drift_during_candidate_verification_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, live, candidate, receipt = _bound(tmp_path)
    original = activation.assert_exact_manifest

    def mutate_live_after_initial_state_check(conn, manifest):
        original(conn, manifest)
        with sqlite3.connect(live) as writer:
            writer.execute("CREATE VIEW independent_view AS SELECT title FROM jobs")

    monkeypatch.setattr(activation, "assert_exact_manifest", mutate_live_after_initial_state_check)
    with pytest.raises(activation.SourceChangedError):
        activation.activate(live, candidate, receipt)
    assert candidate.exists()
    with sqlite3.connect(live) as conn:
        assert conn.execute("SELECT title FROM independent_view").fetchone() == ("paired title",)
        assert conn.execute("PRAGMA user_version").fetchone() == (_source_version,)


@pytest.mark.parametrize("wal_at_bind", [True, False])
def test_wal_connection_opened_after_initial_check_cannot_acknowledge_lost_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, wal_at_bind: bool
) -> None:
    import threading
    import time

    source, live, candidate, receipt = _bound(tmp_path)
    if wal_at_bind:
        receipt.unlink()
        conn = sqlite3.connect(live)
        try:
            assert conn.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
        finally:
            conn.close()
        activation.bind_source(source, live, candidate, receipt)
    original = activation.assert_exact_manifest
    original_replace = activation.os.replace
    ready, write, attempted = threading.Event(), threading.Event(), threading.Event()
    outcomes: list[object] = []
    threads: list[threading.Thread] = []

    def writer() -> None:
        conn = sqlite3.connect(live, timeout=2)
        try:
            assert conn.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
            assert conn.execute("SELECT title FROM jobs").fetchall() == [("paired title",)]
            ready.set()
            assert write.wait(3)
            attempted.set()
            conn.execute("UPDATE jobs SET title='acknowledged WAL write'")
            conn.commit()
            outcomes.append("committed")
        except BaseException as error:
            outcomes.append(error)
            ready.set()
        finally:
            conn.close()

    def open_old_wal_connection(conn, manifest):
        original(conn, manifest)
        thread = threading.Thread(target=writer)
        threads.append(thread)
        thread.start()
        assert ready.wait(3)

    def signal_waiting_writer_then_replace(old, new):
        # This was the original losing schedule. Quiescence now refuses before
        # this rename boundary while the late WAL connection remains open.
        write.set()
        assert attempted.wait(3)
        time.sleep(0.05)
        original_replace(old, new)

    monkeypatch.setattr(activation, "assert_exact_manifest", open_old_wal_connection)
    monkeypatch.setattr(activation.os, "replace", signal_waiting_writer_then_replace)
    try:
        with pytest.raises(activation.SourceChangedError):
            activation.activate(live, candidate, receipt)
    finally:
        write.set()
        for thread in threads:
            thread.join(3)
            assert not thread.is_alive()
    assert outcomes == ["committed"]
    with sqlite3.connect(live) as conn:
        assert conn.execute("SELECT title FROM jobs").fetchone() == ("acknowledged WAL write",)
        assert conn.execute("PRAGMA user_version").fetchone() == (_source_version,)
    assert candidate.exists()


def test_quiescent_wal_source_activates_in_delete_mode(tmp_path: Path) -> None:
    _, live, candidate, receipt = _bound(tmp_path)
    receipt.unlink()
    conn = sqlite3.connect(live)
    try:
        assert conn.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
    finally:
        conn.close()
    activation.bind_source(tmp_path / "paired.db", live, candidate, receipt)
    activation.activate(live, candidate, receipt)
    with sqlite3.connect(live) as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone() == ("delete",)
        assert_exact_manifest(conn, _target_manifest)
        assert conn.execute("SELECT title FROM jobs").fetchone() == ("paired title",)


def test_writer_on_new_live_inode_keeps_its_acknowledged_wal_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, live, candidate, receipt = _bound(tmp_path)
    original = activation.os.replace
    connections: list[sqlite3.Connection] = []

    def write_to_new_live_after_replace(old, new):
        original(old, new)
        writer = sqlite3.connect(live, timeout=0)
        connections.append(writer)
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
        writer.execute("UPDATE jobs SET title='new-inode acknowledged write'")
        writer.commit()

    monkeypatch.setattr(activation.os, "replace", write_to_new_live_after_replace)
    try:
        activation.activate(live, candidate, receipt)
        reader = sqlite3.connect(live)
        try:
            assert reader.execute("SELECT title FROM jobs").fetchone() == ("new-inode acknowledged write",)
            assert reader.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        finally:
            reader.close()
    finally:
        for connection in connections:
            connection.close()
