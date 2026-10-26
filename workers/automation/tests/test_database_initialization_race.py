"""Fresh database publication must not replace or remove another owner's data."""

from __future__ import annotations

import os
import queue
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path
from typing import TextIO

import pytest

from jobctrl import database


JOB_ID = "00000000-0000-4000-8000-000000000127"


def _insert_job(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title) VALUES (?, ?, ?, ?)",
        ("local", JOB_ID, "https://example.test/owned", "Synthetic job"),
    )
    conn.commit()


def _assert_job(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT title FROM jobs WHERE job_id = ?", (JOB_ID,)).fetchone() == ("Synthetic job",)
        assert conn.execute("PRAGMA user_version").fetchone() == (14,)
        assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)


def _readline_with_deadline(stream: TextIO) -> str:
    result: queue.Queue[str] = queue.Queue()
    threading.Thread(target=lambda: result.put(stream.readline()), daemon=True).start()
    return result.get(timeout=15).strip()


def test_competing_threads_keep_winner_and_committed_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "jobctrl.db"
    at_publish = threading.Event()
    release = threading.Event()
    errors: list[BaseException] = []
    real_link = os.link

    def paused_link(src: object, dst: object, **kwargs: object) -> None:
        if threading.current_thread().name == "loser":
            at_publish.set()
            assert release.wait(10), "winner did not complete"
        real_link(src, dst, **kwargs)

    monkeypatch.setattr(database.os, "link", paused_link)

    def contender() -> None:
        try:
            connection = database.init_db(path)
            assert connection.execute("SELECT title FROM jobs WHERE job_id = ?", (JOB_ID,)).fetchone()[0] == "Synthetic job"
        except BaseException as error:
            errors.append(error)
        finally:
            database.close_connection(path)

    thread = threading.Thread(target=contender, name="loser")
    thread.start()
    try:
        assert at_publish.wait(10)
        winner = database.init_db(path)
        _insert_job(winner)
        assert Path(f"{path}-wal").exists()
        assert Path(f"{path}-shm").exists()
    finally:
        release.set()
        thread.join(10)
    assert not thread.is_alive()
    assert not errors
    assert Path(f"{path}-wal").exists()
    assert Path(f"{path}-shm").exists()
    assert winner.execute("SELECT title FROM jobs WHERE job_id = ?", (JOB_ID,)).fetchone()[0] == "Synthetic job"
    database.close_connection(path)
    _assert_job(path)
    assert not list(tmp_path.glob(".jobctrl-init-*"))


def test_competing_processes_keep_winner_and_committed_data(tmp_path: Path) -> None:
    path = tmp_path / "jobctrl.db"
    source = '''\
import os, sys
from jobctrl import database
path = sys.argv[1]
real_link = os.link
def paused_link(src, dst, **kwargs):
    print("ready", flush=True)
    assert sys.stdin.readline().strip() == "continue"
    return real_link(src, dst, **kwargs)
database.os.link = paused_link
try:
    connection = database.init_db(path)
    row = connection.execute("SELECT title FROM jobs WHERE job_id = ?", (sys.argv[2],)).fetchone()
    print("winner=" + str(row[0] if row else None), flush=True)
finally:
    database.close_connection(path)
'''
    child = subprocess.Popen(
        [sys.executable, "-u", "-c", source, str(path), JOB_ID],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout is not None and child.stdin is not None
        assert _readline_with_deadline(child.stdout) == "ready"
        winner = database.init_db(path)
        _insert_job(winner)
        assert Path(f"{path}-wal").exists()
        assert Path(f"{path}-shm").exists()
        stdout, stderr = child.communicate("continue\n", timeout=15)
        assert child.returncode == 0, stderr
        assert "winner=Synthetic job" in stdout
        assert Path(f"{path}-wal").exists()
        assert Path(f"{path}-shm").exists()
        winner.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, title) VALUES (?, ?, ?, ?)",
            ("local", "00000000-0000-4000-8000-000000000128", "https://example.test/second", "Second job"),
        )
        winner.commit()
        peer = subprocess.run(
            [sys.executable, "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('SELECT count(*) FROM jobs').fetchone()[0])", str(path)],
            capture_output=True, text=True, timeout=15,
        )
        assert peer.returncode == 0, peer.stderr
        assert peer.stdout.strip() == "2"
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=5)
        database.close_connection(path)
    _assert_job(path)
    assert not list(tmp_path.glob(".jobctrl-init-*"))


@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
def test_orphan_sidecars_are_preserved_and_refused(tmp_path: Path, suffix: str) -> None:
    path = tmp_path / "jobctrl.db"
    sidecar = Path(f"{path}{suffix}")
    sidecar.write_bytes(b"unfamiliar sidecar")
    with pytest.raises(FileExistsError, match="sidecars"):
        database.init_db(path)
    assert not path.exists()
    assert sidecar.read_bytes() == b"unfamiliar sidecar"


def test_target_symlink_and_referent_are_preserved(tmp_path: Path) -> None:
    path = tmp_path / "jobctrl.db"
    target = tmp_path / "outside.db"
    target.write_bytes(b"owned unrelated bytes")
    path.symlink_to(target)
    with pytest.raises(FileExistsError, match="not a regular file"):
        database.init_db(path)
    assert path.is_symlink()
    assert target.read_bytes() == b"owned unrelated bytes"


def test_substituted_target_at_publication_is_not_followed_or_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "jobctrl.db"
    target = tmp_path / "unrelated.db"
    target.write_bytes(b"unrelated")
    real_link = os.link

    def substitute(src: object, dst: object, **kwargs: object) -> None:
        path.symlink_to(target)
        real_link(src, dst, **kwargs)

    monkeypatch.setattr(database.os, "link", substitute)
    with pytest.raises(FileExistsError):
        database.init_db(path)
    assert path.is_symlink()
    assert target.read_bytes() == b"unrelated"


def test_failure_after_publication_never_removes_database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "jobctrl.db"

    def fail_open(*args: object, **kwargs: object) -> None:
        raise RuntimeError("synthetic open failure")

    monkeypatch.setattr(database, "get_connection", fail_open)
    with pytest.raises(RuntimeError, match="synthetic open failure"):
        database.create_exact_v14_database(path)
    assert path.is_file()
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone() == (14,)
        assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)


def test_candidate_write_failure_cleans_only_staging_and_allows_retry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "jobctrl.db"
    unrelated = tmp_path / "unrelated.txt"
    unrelated.write_bytes(b"preserved")

    with monkeypatch.context() as patch:
        def fail_fsync(_fd: int) -> None:
            raise OSError("synthetic fsync failure")

        patch.setattr(database.os, "fsync", fail_fsync)
        with pytest.raises(OSError, match="synthetic fsync failure"):
            database.init_db(path)
    assert not path.exists()
    assert unrelated.read_bytes() == b"preserved"
    assert not list(tmp_path.glob(".jobctrl-init-*"))
    conn = database.init_db(path)
    _insert_job(conn)
    database.close_connection(path)
    _assert_job(path)


def test_schema_commit_failure_does_not_publish_or_delete_unrelated_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "jobctrl.db"
    unrelated = tmp_path / "unrelated.txt"
    unrelated.write_bytes(b"preserved")
    real_connect = sqlite3.connect

    class FailingCommit(sqlite3.Connection):
        def commit(self) -> None:
            raise sqlite3.OperationalError("synthetic commit failure")

    def connect(*args: object, **kwargs: object) -> sqlite3.Connection:
        return real_connect(*args, **kwargs, factory=FailingCommit)

    with monkeypatch.context() as patch:
        patch.setattr(database.sqlite3, "connect", connect)
        with pytest.raises(sqlite3.OperationalError, match="synthetic commit failure"):
            database.init_db(path)
    assert not path.exists()
    assert unrelated.read_bytes() == b"preserved"
    assert not list(tmp_path.glob(".jobctrl-init-*"))
    conn = database.init_db(path)
    _insert_job(conn)
    database.close_connection(path)
    _assert_job(path)


def test_cleanup_failure_does_not_remove_published_database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "jobctrl.db"
    original_unlink = Path.unlink

    def fail_candidate_unlink(target: Path, *args: object, **kwargs: object) -> None:
        if target.name == "candidate.db":
            raise PermissionError("synthetic cleanup failure")
        original_unlink(target, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", fail_candidate_unlink)
        with pytest.raises(PermissionError, match="synthetic cleanup failure"):
            database.init_db(path)
    database.close_connection(path)
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone() == (14,)
        assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)


def test_recovery_after_published_wal_open_allows_repeated_admission(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "jobctrl.db"
    real_get = database.get_connection

    class FailingBusyTimeout:
        def __init__(self, conn: sqlite3.Connection) -> None:
            self.conn = conn

        def execute(self, sql: str, *args: object) -> object:
            if sql == "PRAGMA busy_timeout=10000":
                raise OSError("injected post-WAL failure")
            return self.conn.execute(sql, *args)

    def fail_after_wal(*args: object, **kwargs: object) -> object:
        return FailingBusyTimeout(real_get(*args, **kwargs))

    with monkeypatch.context() as patch:
        patch.setattr(database, "get_connection", fail_after_wal)
        with pytest.raises(OSError, match="post-WAL failure"):
            database.init_db(path)
    # No sidecar need remain after SQLite closes. The retained publication must
    # still fail closed rather than appear recovered and fail on a later call.
    with pytest.raises(RuntimeError, match="unresolved publication"):
        database.init_db(path)
    staging = next(tmp_path.glob(".jobctrl-init-*"))
    (staging / "candidate.db").unlink()
    staging.rmdir()
    first = database.init_db(path)
    second = database.init_db(path)
    assert first is second
    database.close_connection(path)


def test_substituted_symlink_before_admission_does_not_change_referent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "jobctrl.db"
    unrelated = tmp_path / "unrelated.db"
    with sqlite3.connect(unrelated) as conn:
        conn.execute("CREATE TABLE retained (value TEXT)")
        conn.execute("INSERT INTO retained VALUES ('preserved')")
    real_get = database.get_connection

    def substitute(*args: object, **kwargs: object) -> sqlite3.Connection:
        path.unlink()
        path.symlink_to(unrelated)
        return real_get(*args, **kwargs)

    monkeypatch.setattr(database, "get_connection", substitute)
    with pytest.raises(RuntimeError, match="changed during admission"):
        database.create_exact_v14_database(path)
    assert path.is_symlink()
    with sqlite3.connect(unrelated) as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone() == ("delete",)
        assert conn.execute("SELECT value FROM retained").fetchone() == ("preserved",)
    assert not Path(f"{unrelated}-wal").exists()


@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
def test_sidecar_appearing_at_publication_is_not_adopted_or_removed(
    tmp_path: Path, suffix: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "jobctrl.db"
    sidecar = Path(f"{path}{suffix}")
    real_link = os.link

    def inject_sidecar(src: object, dst: object, **kwargs: object) -> None:
        sidecar.write_bytes(b"unrelated sidecar")
        real_link(src, dst, **kwargs)

    monkeypatch.setattr(database.os, "link", inject_sidecar)
    with pytest.raises(RuntimeError, match="sidecars appeared"):
        database.init_db(path)
    assert path.is_file()
    assert sidecar.read_bytes() == b"unrelated sidecar"
    with pytest.raises(RuntimeError, match="unresolved publication"):
        database.init_db(path)
    assert sidecar.read_bytes() == b"unrelated sidecar"


@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
def test_sidecar_appearing_before_open_is_not_adopted_or_removed(
    tmp_path: Path, suffix: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "jobctrl.db"
    sidecar = Path(f"{path}{suffix}")
    real_get = database.get_connection

    def inject(*args: object, **kwargs: object) -> sqlite3.Connection:
        sidecar.write_bytes(b"unrelated sidecar")
        return real_get(*args, **kwargs)

    monkeypatch.setattr(database, "get_connection", inject)
    with pytest.raises(RuntimeError, match="sidecars appeared"):
        database.init_db(path)
    assert path.is_file()
    assert sidecar.read_bytes() == b"unrelated sidecar"
    with pytest.raises(RuntimeError, match="unresolved publication"):
        database.init_db(path)
    assert sidecar.read_bytes() == b"unrelated sidecar"


def test_parent_replacement_refuses_publication_and_preserves_unfamiliar_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.infrastructure.migrations import schema_v14

    parent = tmp_path / "workspace"
    parent.mkdir()
    old_parent = tmp_path / "original-workspace"
    path = parent / "jobctrl.db"
    create_schema = schema_v14.create_exact_v14_schema
    replacement_candidate: list[Path] = []

    def replace_parent(conn: sqlite3.Connection) -> None:
        staging = next(parent.glob(".jobctrl-init-*"))
        parent.rename(old_parent)
        parent.mkdir()
        substituted_staging = parent / staging.name
        substituted_staging.mkdir()
        replacement = substituted_staging / "candidate.db"
        replacement.write_bytes(b"unfamiliar data")
        (substituted_staging / "candidate.db-journal").write_bytes(b"unfamiliar journal")
        replacement_candidate.append(replacement)
        create_schema(conn)

    monkeypatch.setattr(schema_v14, "create_exact_v14_schema", replace_parent)
    with pytest.raises(RuntimeError, match="directory changed"):
        database.init_db(path)
    assert not path.exists()
    assert replacement_candidate[0].read_bytes() == b"unfamiliar data"
    assert (replacement_candidate[0].parent / "candidate.db-journal").read_bytes() == b"unfamiliar journal"
    assert list(old_parent.glob(".jobctrl-init-*"))


def test_process_death_before_publication_preserves_staging_and_allows_fresh_creation(tmp_path: Path) -> None:
    path = tmp_path / "jobctrl.db"
    source = '''\
import sys
from jobctrl import database
from jobctrl.infrastructure.migrations import schema_v14
real_create = schema_v14.create_exact_v14_schema
def pause(conn):
    real_create(conn)
    print("ready", flush=True)
    sys.stdin.readline()
schema_v14.create_exact_v14_schema = pause
database.init_db(sys.argv[1])
'''
    child = subprocess.Popen(
        [sys.executable, "-u", "-c", source, str(path)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        assert child.stdout is not None
        assert _readline_with_deadline(child.stdout) == "ready"
        child.kill()
        child.communicate(timeout=5)
        assert not path.exists()
        abandoned = list(tmp_path.glob(".jobctrl-init-*"))
        assert len(abandoned) == 1
        conn = database.init_db(path)
        _insert_job(conn)
        database.close_connection(path)
        _assert_job(path)
        assert abandoned[0].is_dir()  # Unfamiliar interrupted staging is never swept.
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=5)
        database.close_connection(path)


def test_fresh_database_mode_matches_sqlite_with_permissive_umask(tmp_path: Path) -> None:
    source = '''\
import os, pathlib, sqlite3, sys
from jobctrl import database
root = pathlib.Path(sys.argv[1]); os.umask(0)
reference = root / "reference.db"
connection = sqlite3.connect(reference); connection.close()
target = root / "jobctrl.db"
database.init_db(target); database.close_connection(target)
print(oct(reference.stat().st_mode & 0o777), oct(target.stat().st_mode & 0o777))
'''
    result = subprocess.run([sys.executable, "-c", source, str(tmp_path)], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "0o644 0o644"


def test_direct_config_and_source_proposals_readers_refuse_unresolved_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import config, source_proposals_cli

    path = tmp_path / "jobctrl.db"
    database.init_db(path)
    database.close_connection(path)
    staging = tmp_path / ".jobctrl-init-synthetic"
    staging.mkdir()
    os.link(path, staging / "candidate.db")
    sidecar = Path(f"{path}-wal")
    sidecar.write_bytes(b"unrelated sidecar")
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.setattr(config, "load_env", lambda: ())

    with pytest.raises(RuntimeError, match="unresolved publication"):
        database.get_connection(path)
    assert sidecar.read_bytes() == b"unrelated sidecar"
    for read in (
        config._load_discovery_search_config_from_db,
        config._load_profile_target_search,
        config._local_source_registry_rows,
        lambda: config._save_discovery_search_config_to_db({}),
    ):
        with pytest.raises(RuntimeError, match="unresolved publication"):
            read()
        assert sidecar.read_bytes() == b"unrelated sidecar"
    with pytest.raises(RuntimeError, match="unresolved publication"):
        with source_proposals_cli.connection(readonly=False):
            pass
    assert sidecar.read_bytes() == b"unrelated sidecar"
    backup = tmp_path / "backup.db"
    with pytest.raises(RuntimeError, match="unresolved publication"):
        database.backup_database(backup, db_path=path)
    assert not backup.exists()
    assert sidecar.read_bytes() == b"unrelated sidecar"
