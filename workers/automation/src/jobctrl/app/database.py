"""Private SQLite admission and one transaction authority for feature adapters."""

from __future__ import annotations

import hashlib
import os
import sqlite3
import stat
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from jobctrl.app.errors import AppError

APPLICATION_ID = 0x4A435354
SCHEMA_VERSION = 1

CORE_SCHEMA = """
CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO app_metadata VALUES ('application', 'jobctrl-python'), ('schema_version', '1');
CREATE TABLE app_feature_schemas (name TEXT PRIMARY KEY, digest TEXT NOT NULL);
CREATE TABLE app_events (
 event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
 feature TEXT NOT NULL, aggregate_id TEXT, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL,
 level TEXT NOT NULL DEFAULT 'info', stage TEXT
);
CREATE INDEX app_events_feature_id ON app_events(feature, event_id);
CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value_json TEXT NOT NULL);
CREATE TABLE app_action_runs (
 run_id TEXT PRIMARY KEY, action TEXT NOT NULL, request_id TEXT NOT NULL,
 idempotency_key TEXT UNIQUE, input_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
 status TEXT NOT NULL, workflow_id TEXT NOT NULL UNIQUE, temporal_run_id TEXT,
 result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 cancellation_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX app_action_runs_status ON app_action_runs(status, updated_at);
CREATE TABLE app_worker_heartbeats (
 worker_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, task_queue TEXT NOT NULL,
 started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE app_model_calls (
 receipt_id TEXT PRIMARY KEY, operation TEXT NOT NULL, provider TEXT NOT NULL,
 model TEXT NOT NULL, lane TEXT NOT NULL, prompt_version TEXT NOT NULL,
 input_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT,
 status TEXT NOT NULL, result_json TEXT, error_code TEXT,
 input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, cost_source TEXT, provider_started INTEGER, pricing_json TEXT,
 owner_pid INTEGER NOT NULL
);
CREATE INDEX app_model_calls_day_lane ON app_model_calls(created_at,lane,status);
"""


class ClosingConnection(sqlite3.Connection):
    """SQLite's stock context manager does not close its descriptor."""

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def execute_schema(connection: sqlite3.Connection, script: str) -> None:
    # executescript implicitly commits an existing transaction. Execute complete
    # statements separately so schema and manifest publication stay atomic.
    pending = ""
    for line in script.splitlines(keepends=True):
        for character in line:
            pending += character
            if character == ";" and sqlite3.complete_statement(pending):
                connection.execute(pending)
                pending = ""
    if pending.strip():
        connection.execute(pending)


class Database:
    def __init__(self, workspace: Path | str):
        root = Path(workspace).expanduser()
        if root.is_symlink():
            raise AppError("unsafe_workspace", "The workspace must be a real directory.", 409)
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.workspace = root.resolve(strict=True)
        self.path = self.workspace / "jobctrl.db"
        if self.path.exists() or self.path.is_symlink():
            # Refuse a legacy workspace before creating even an initializer
            # lock. A target publisher may briefly own the stage's second link;
            # full single-link admission occurs under the shared lock below.
            self._check_header(require_single_link=False)
        with self._initialization_lock():
            if not self.path.exists():
                self._publish_new()
            self._admit()
            info = self.path.stat()
            self.identity = (info.st_dev, info.st_ino)
            self.instance_id = hashlib.sha256(f"{self.workspace}:{info.st_dev}:{info.st_ino}".encode()).hexdigest()

    @contextmanager
    def _initialization_lock(self):
        path = self.workspace / ".jobctrl-database.lock"
        try:
            descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        except OSError:
            raise AppError("unsafe_database_lock", "The database initializer lock is unavailable.", 409) from None
        locked = False
        try:
            info = os.fstat(descriptor)
            named = path.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)
                    or (os.name != "nt" and (info.st_uid != os.getuid() or info.st_mode & 0o077))):
                raise AppError("unsafe_database_lock", "The database initializer lock must be a private regular file.", 409)
            deadline = time.monotonic() + 30
            while not locked:
                try:
                    if os.name == "nt":
                        import msvcrt
                        os.lseek(descriptor, 0, os.SEEK_SET)
                        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    locked = True
                except OSError:
                    if time.monotonic() >= deadline:
                        raise AppError("database_initializer_busy", "Another process is still initializing this workspace.", 409) from None
                    time.sleep(0.05)
            yield
        finally:
            if locked:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _publish_new(self) -> None:
        if any(Path(str(self.path) + suffix).exists() or Path(str(self.path) + suffix).is_symlink()
               for suffix in ("-wal", "-shm", "-journal")):
            raise AppError("database_companions_unowned", "Database companion files require inspection.", 409)
        descriptor, filename = tempfile.mkstemp(prefix=".jobctrl-python-", suffix=".sqlite3", dir=self.workspace)
        os.close(descriptor)
        stage = Path(filename)
        try:
            with sqlite3.connect(stage, factory=ClosingConnection) as connection:
                connection.executescript(CORE_SCHEMA)
                connection.execute(f"PRAGMA application_id={APPLICATION_ID}")
                connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            # Windows file flushing requires write access; r+b preserves the stage.
            with stage.open("r+b") as stream:
                os.fsync(stream.fileno())
            try:
                os.link(stage, self.path)
            except FileExistsError:
                pass  # Admit the winner; never replace another initializer.
            if os.name != "nt":
                parent = os.open(self.workspace, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(parent)
                finally:
                    os.close(parent)
        finally:
            stage.unlink(missing_ok=True)

    def _check_header(self, *, require_single_link: bool = True) -> None:
        metadata = self.path.lstat()
        if (not stat.S_ISREG(metadata.st_mode) or (require_single_link and metadata.st_nlink != 1)
                or (os.name != "nt" and (metadata.st_uid != os.getuid() or metadata.st_mode & 0o077))):
            raise AppError("unsafe_database", "The database must be a private regular file.", 409)
        # A mode=ro SQLite open can still create a shared-memory companion for
        # a WAL database. Reject the legacy format from its ordinary file header
        # before opening SQLite, preserving even its directory entries.
        with self.path.open("rb") as stream:
            header = stream.read(100)
        if len(header) != 100 or header[:16] != b"SQLite format 3\x00":
            raise AppError("invalid_database", "The database cannot be safely opened.", 409)
        if int.from_bytes(header[68:72], "big") != APPLICATION_ID:
            raise AppError("profile_transfer_required", "This workspace requires the deliberate Profile-only transfer before the Python application can start.", 409)
        if int.from_bytes(header[60:64], "big") != SCHEMA_VERSION:
            raise AppError("unsupported_database_version", "This database requires a compatible JobCtrl version.", 409)

    def _admit(self) -> None:
        self._check_header()
        try:
            with sqlite3.connect(f"{self.path.as_uri()}?mode=ro", uri=True, factory=ClosingConnection) as connection:
                application_id = connection.execute("PRAGMA application_id").fetchone()[0]
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                if application_id != APPLICATION_ID:
                    raise AppError(
                        "profile_transfer_required",
                        "This workspace requires the deliberate Profile-only transfer before the Python application can start.",
                        409,
                    )
                if version != SCHEMA_VERSION:
                    raise AppError("unsupported_database_version", "This database requires a compatible JobCtrl version.", 409)
                identity = dict(connection.execute("SELECT key,value FROM app_metadata"))
                if identity != {"application": "jobctrl-python", "schema_version": str(SCHEMA_VERSION)}:
                    raise AppError("invalid_database_identity", "The database identity is incompatible.", 409)
        except sqlite3.DatabaseError:
            raise AppError("invalid_database", "The database cannot be safely opened.", 409) from None

    def connect(self) -> ClosingConnection:
        try:
            info = self.path.lstat()
        except OSError:
            raise AppError("workspace_changed", "The workspace database changed; restart JobCtrl.", 409) from None
        if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino) != self.identity:
            raise AppError("workspace_changed", "The workspace database changed; restart JobCtrl.", 409)
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None, factory=ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA journal_mode=WAL")
        current = self.path.lstat()
        if (current.st_dev, current.st_ino) != self.identity:
            connection.close()
            raise AppError("workspace_changed", "The workspace database changed; restart JobCtrl.", 409)
        return connection

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize_feature(self, name: str, schema: str) -> None:
        if not name or not name.replace("_", "").isalnum():
            raise ValueError("Invalid feature name")
        digest = hashlib.sha256(schema.encode()).hexdigest()
        with self.transaction() as connection:
            row = connection.execute("SELECT digest FROM app_feature_schemas WHERE name=?", (name,)).fetchone()
            if row:
                if row[0] != digest:
                    raise AppError("feature_schema_mismatch", f"Feature {name} requires an explicit schema upgrade.", 409)
                return
            execute_schema(connection, schema)
            connection.execute("INSERT INTO app_feature_schemas VALUES (?,?)", (name, digest))
