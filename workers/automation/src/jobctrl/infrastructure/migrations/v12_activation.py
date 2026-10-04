"""Private native v12 source binding and locked atomic activation.

This helper never reports paths, rows, note text, or profile values. It refuses a
live source that changed after paired backup and retains the SQLite writer lock
through rename so a later writer cannot commit between validation and cutover.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import stat
import sys
from collections.abc import Sequence
from pathlib import Path

from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V12_MANIFEST, assert_exact_manifest, schema_dump
from jobctrl.infrastructure.migrations.v11_to_v12_execute import _table_data_digest
from jobctrl.infrastructure.migrations.v7_to_v8_execute import _durable_table_names, _fsync_directory, _sha256_file


class SourceChangedError(RuntimeError):
    pass


def _regular(path: Path, *, private: bool = False) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or (private and info.st_mode & 0o077):
        raise SourceChangedError()


def _state(path: Path) -> list[list[object]]:
    result: list[list[object]] = []
    for suffix in ("", "-journal", "-wal", "-shm"):
        current = Path(f"{path}{suffix}")
        if os.path.lexists(current):
            _regular(current)
            info = current.lstat()
            result.append([suffix, info.st_dev, info.st_ino, info.st_mode, _sha256_file(current)])
    return result


def _columns(conn: sqlite3.Connection) -> dict[str, tuple[str, ...]]:
    return {
        table: tuple(str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table}")'))
        for table in _durable_table_names(conn)
    }


def _schema_digest(conn: sqlite3.Connection) -> str:
    return hashlib.sha256(json.dumps(schema_dump(conn), separators=(",", ":")).encode()).hexdigest()


def bind_source(source: Path, live: Path, candidate: Path, receipt: Path) -> None:
    _regular(source)
    _regular(live)
    _regular(candidate, private=True)
    source_conn = sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True)
    lock = sqlite3.connect(f"{live.resolve().as_uri()}?mode=rw", uri=True, timeout=0)
    try:
        try:
            lock.execute("BEGIN IMMEDIATE")
        except sqlite3.Error:
            raise SourceChangedError() from None
        version = int(source_conn.execute("PRAGMA user_version").fetchone()[0])
        if int(lock.execute("PRAGMA user_version").fetchone()[0]) != version or schema_dump(lock) != schema_dump(
            source_conn
        ):
            raise SourceChangedError()
        columns = _columns(source_conn)
        source_digest = _table_data_digest(source_conn, columns)
        source_schema_digest = _schema_digest(source_conn)
        if _table_data_digest(lock, columns) != source_digest:
            raise SourceChangedError()
        locked_identity = live.lstat()
    finally:
        lock.rollback()
        lock.close()
        source_conn.close()
    # Bind complete file state and logical cells; either kind of drift refuses.
    value = {
        "schemaVersion": 1,
        "sourceVersion": version,
        "sourceDigest": source_digest,
        "sourceSchemaDigest": source_schema_digest,
        "state": _state(live),
        "device": locked_identity.st_dev,
        "inode": locked_identity.st_ino,
        "candidateDigest": _sha256_file(candidate),
    }
    descriptor = os.open(receipt, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(value, output, sort_keys=True, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    _fsync_directory(receipt.parent)


def activate(live: Path, candidate: Path, receipt: Path) -> None:
    _regular(receipt, private=True)
    _regular(live)
    _regular(candidate, private=True)
    expected = json.loads(receipt.read_text(encoding="utf-8"))
    if expected["schemaVersion"] != 1 or _state(live) != expected["state"]:
        raise SourceChangedError()
    if _sha256_file(candidate) != expected["candidateDigest"]:
        raise RuntimeError("invalid candidate")
    conn = sqlite3.connect(f"{candidate.resolve().as_uri()}?mode=ro", uri=True)
    try:
        if int(conn.execute("PRAGMA user_version").fetchone()[0]) != 12:
            raise RuntimeError("invalid candidate")
        assert_exact_manifest(conn, EXACT_V12_MANIFEST)
        if conn.execute("PRAGMA foreign_key_check").fetchall() or conn.execute("PRAGMA integrity_check").fetchone() != (
            "ok",
        ):
            raise RuntimeError("invalid candidate")
    finally:
        conn.close()
    lock = sqlite3.connect(f"{live.resolve().as_uri()}?mode=rw", uri=True, timeout=0)
    try:
        try:
            # WAL connections retain access to the old inode after rename and
            # can acknowledge commits that no longer reach the live path. A
            # DELETE-mode conversion requires WAL readers/writers to quiesce;
            # an exclusive transaction then prevents mode changes at cutover.
            if lock.execute("PRAGMA journal_mode=DELETE").fetchone() != ("delete",):
                raise SourceChangedError()
            lock.execute("BEGIN EXCLUSIVE")
            if lock.execute("PRAGMA journal_mode").fetchone() != ("delete",):
                raise SourceChangedError()
        except sqlite3.Error:
            raise SourceChangedError() from None
        actual = live.lstat()
        if (actual.st_dev, actual.st_ino) != (expected["device"], expected["inode"]):
            raise SourceChangedError()
        if int(lock.execute("PRAGMA user_version").fetchone()[0]) != expected["sourceVersion"]:
            raise SourceChangedError()
        if _schema_digest(lock) != expected["sourceSchemaDigest"]:
            raise SourceChangedError()
        if _table_data_digest(lock, _columns(lock)) != expected["sourceDigest"]:
            raise SourceChangedError()
        # Clean only the locked source's sidecars before publishing the new
        # inode. A writer can open that new inode immediately after rename;
        # deleting its acknowledged WAL afterwards would lose its commit.
        for suffix in ("-journal", "-wal", "-shm"):
            Path(f"{live}{suffix}").unlink(missing_ok=True)
        # DELETE mode and the exclusive lock stay on the old inode through replacement.
        os.replace(candidate, live)
        _fsync_directory(live.parent)
    finally:
        lock.rollback()
        lock.close()
    receipt.unlink()
    _fsync_directory(live.parent)


def main(argv: Sequence[str] | None = None) -> int:
    parser = _PrivateParser(add_help=False)
    parser.add_argument("--mode", required=True, choices=("bind", "activate"))
    parser.add_argument("--source")
    parser.add_argument("--live", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--receipt", required=True)
    try:
        args = parser.parse_args(argv)
        if args.mode == "bind":
            if not args.source:
                raise RuntimeError("missing source")
            bind_source(Path(args.source), Path(args.live), Path(args.candidate), Path(args.receipt))
        else:
            activate(Path(args.live), Path(args.candidate), Path(args.receipt))
    except SourceChangedError:
        print("v12_source_changed", file=sys.stderr)
        return 1
    except Exception:
        print("v12_activation_failed", file=sys.stderr)
        return 1
    return 0


class _PrivateParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise RuntimeError("invalid private arguments")


if __name__ == "__main__":
    raise SystemExit(main())
