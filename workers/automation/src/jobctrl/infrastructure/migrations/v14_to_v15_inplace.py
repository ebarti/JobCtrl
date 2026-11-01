"""Transactional exact-v14 to v15 activation on the existing SQLite inode.

This helper is not a lifecycle or runtime-quiescence guarantee. It never
restores the paired backup. The native caller authenticates its release and
transition separately; bound activation retains the existing exclusive guard.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
from pathlib import Path

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V14_MANIFEST,
    EXACT_V15_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v15 import _extend
from jobctrl.infrastructure.migrations.v11_to_v12_execute import _table_data_digest
from jobctrl.infrastructure.migrations.v7_to_v8_execute import _durable_table_names, _fsync_directory


class InPlaceSourceChangedError(RuntimeError):
    """The bound live source changed before its writer lock was acquired."""


class InPlaceDurabilityUncertainError(RuntimeError):
    """SQLite committed, but the containing directory could not be synced."""


def _regular_file(path: Path) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise SchemaManifestError("in-place migration requires an unaliased regular database")
    return info


def _assert_regular_companions(path: Path) -> None:
    for suffix in ("-journal", "-wal", "-shm"):
        companion = Path(f"{path}{suffix}")
        if os.path.lexists(companion):
            info = companion.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise SchemaManifestError("in-place migration refuses an unsafe SQLite companion")


def upgrade_v14_in_place(
    path: Path, *, timeout: float = 0, binding: dict[str, object] | None = None
) -> bool:
    """Migrate an exact-v14 live inode; return False for an already-exact v15.

    The separate SQLite connection obtains the writer lock *before* it checks
    the source schema or records table data. Bound activation also requires
    DELETE mode and an exclusive lock, preserving its existing reader guard.
    No existing caller transaction is
    committed. SQLite's durable commit is the database activation boundary;
    an error syncing the parent after commit is reported as an uncertain outcome
    and a retry must inspect the exact schema rather than restore a snapshot.
    """
    path = Path(path).absolute()
    before = _regular_file(path)
    _assert_regular_companions(path)
    conn = sqlite3.connect(f"{path.as_uri()}?mode=rw", uri=True, timeout=timeout, isolation_level=None)
    committed = False
    commit_started = False
    changed = False
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA synchronous = FULL")
        try:
            if binding is not None:
                if conn.execute("PRAGMA journal_mode=DELETE").fetchone() != ("delete",):
                    raise InPlaceSourceChangedError("source readers or writers have not quiesced")
                conn.execute("BEGIN EXCLUSIVE")
                if conn.execute("PRAGMA journal_mode").fetchone() != ("delete",):
                    raise InPlaceSourceChangedError("source journal mode changed")
            else:
                conn.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as exc:
            if binding is not None:
                raise InPlaceSourceChangedError("bound v14 source is not writable") from exc
            raise
        current = _regular_file(path)
        _assert_regular_companions(path)
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            raise SchemaManifestError("database changed during in-place migration")
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if binding is not None:
            actual_schema = hashlib.sha256(json.dumps(schema_dump(conn), separators=(",", ":")).encode()).hexdigest()
            original_tables = {
                table: tuple(str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table}")'))
                for table in _durable_table_names(conn)
            }
            if (
                version != 14
                or binding.get("sourceVersion") != version
                or binding.get("device") != current.st_dev
                or binding.get("inode") != current.st_ino
                or binding.get("sourceSchemaDigest") != actual_schema
                or binding.get("sourceDigest") != _table_data_digest(conn, original_tables)
            ):
                raise InPlaceSourceChangedError("bound v14 source changed")
        if version == 15:
            assert_exact_manifest(conn, EXACT_V15_MANIFEST)
        elif version == 14:
            assert_exact_manifest(conn, EXACT_V14_MANIFEST)
            tables = {
                table: tuple(str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table}")'))
                for table in _durable_table_names(conn)
            }
            before_digest = _table_data_digest(conn, tables)
            _extend(conn)
            if _table_data_digest(conn, tables) != before_digest:
                raise SchemaManifestError("in-place migration changed existing table contents")
            changed = True
        else:
            raise SchemaManifestError("in-place migration requires exact v14 or v15")
        if conn.execute("PRAGMA foreign_key_check").fetchall() or conn.execute("PRAGMA integrity_check").fetchone() != (
            "ok",
        ):
            raise SchemaManifestError("in-place migration integrity check failed")
        commit_started = True
        conn.execute("COMMIT")
        committed = True
    except BaseException as exc:
        if commit_started and not conn.in_transaction:
            raise InPlaceDurabilityUncertainError("database commit outcome requires verification") from exc
        raise
    finally:
        try:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
        finally:
            try:
                conn.close()
            except Exception as exc:
                if commit_started:
                    raise InPlaceDurabilityUncertainError("database close outcome requires verification") from exc
                raise
    if committed:
        try:
            _fsync_directory(path.parent)
        except OSError as exc:
            raise InPlaceDurabilityUncertainError("database committed but directory sync failed") from exc
    return changed
