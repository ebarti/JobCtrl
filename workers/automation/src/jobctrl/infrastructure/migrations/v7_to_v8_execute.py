"""Private file-to-file executor for the stopped-runtime v7-to-v8 cutover."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import stat
import sys
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Final, Protocol

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    EXACT_V8_MANIFEST,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v8 import (
    upgrade_exact_v7_schema_to_v8,
)

_GENERIC_FAILURE: Final = "v7-to-v8 candidate migration failed"
_RESULT_SCHEMA_VERSION: Final = 1
_EMPTY_V8_TABLES: Final = frozenset(
    {
        "compensation_direct_benchmark_facts",
        "compensation_price_level_facts",
        "compensation_extrapolated_benchmark_facts",
        "compensation_extrapolation_direct_inputs",
        "compensation_extrapolation_price_inputs",
        "compensation_market_refresh_state",
    }
)


class _Digest(Protocol):
    def update(self, data: bytes, /) -> object: ...


class CandidateExecutionError(RuntimeError):
    """Raised when an isolated v8 candidate cannot be built and verified."""


@dataclass(frozen=True)
class CandidateExecutionResult:
    schema_version: int
    status: str
    user_version: int
    source_data_digest: str
    candidate_data_digest: str
    candidate_sha256: str
    job_count: int
    table_count: int


def execute_v7_to_v8_candidate(
    source_path: Path | str,
    candidate_path: Path | str,
    *,
    _after_stamp: Callable[[], None] | None = None,
) -> CandidateExecutionResult:
    """Copy exact v7, add the v8 benchmark schema, and seal a new file."""

    source = Path(source_path)
    candidate = Path(candidate_path)
    source_connection: sqlite3.Connection | None = None
    candidate_connection: sqlite3.Connection | None = None
    created_identity: tuple[int, int] | None = None
    try:
        _assert_paths(source, candidate)
        descriptor = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            created = os.fstat(descriptor)
            created_identity = (created.st_dev, created.st_ino)
        finally:
            os.close(descriptor)

        source_connection = sqlite3.connect(
            f"{source.resolve().as_uri()}?mode=ro",
            uri=True,
        )
        source_connection.execute("PRAGMA foreign_keys = ON")
        if int(source_connection.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V7_MANIFEST.version:
            raise CandidateExecutionError(_GENERIC_FAILURE)
        assert_exact_manifest(source_connection, EXACT_V7_MANIFEST)
        source_tables = _durable_table_names(source_connection)
        source_digest = _table_data_digest(source_connection, source_tables)

        candidate_connection = sqlite3.connect(candidate)
        candidate_connection.execute("PRAGMA foreign_keys = ON")
        source_connection.backup(candidate_connection)
        candidate_connection.commit()
        assert_exact_manifest(candidate_connection, EXACT_V7_MANIFEST)
        if _table_data_digest(candidate_connection, source_tables) != source_digest:
            raise CandidateExecutionError(_GENERIC_FAILURE)

        upgrade_exact_v7_schema_to_v8(candidate_connection)
        if _after_stamp is not None:
            _after_stamp()
        candidate_connection.commit()
        _verify_candidate(
            source_connection,
            candidate_connection,
            source_tables=source_tables,
            source_digest=source_digest,
        )
        candidate_digest = _table_data_digest(candidate_connection, source_tables)
        job_count = int(candidate_connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])

        candidate_connection.close()
        candidate_connection = None
        source_connection.close()
        source_connection = None
        _fsync_regular_file(candidate)
        _fsync_directory(candidate.parent)
        return CandidateExecutionResult(
            schema_version=_RESULT_SCHEMA_VERSION,
            status="ready",
            user_version=EXACT_V8_MANIFEST.version,
            source_data_digest=source_digest,
            candidate_data_digest=candidate_digest,
            candidate_sha256=_sha256_file(candidate),
            job_count=job_count,
            table_count=EXACT_V8_MANIFEST.table_count,
        )
    except BaseException as error:
        if candidate_connection is not None:
            candidate_connection.close()
        if source_connection is not None:
            source_connection.close()
        if created_identity is not None:
            _remove_created_candidate(candidate, created_identity)
        if isinstance(error, Exception):
            raise CandidateExecutionError(_GENERIC_FAILURE) from None
        raise


def _verify_candidate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    source_tables: tuple[str, ...],
    source_digest: str,
) -> None:
    if int(source.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V7_MANIFEST.version:
        raise CandidateExecutionError(_GENERIC_FAILURE)
    assert_exact_manifest(source, EXACT_V7_MANIFEST)
    if _table_data_digest(source, source_tables) != source_digest:
        raise CandidateExecutionError(_GENERIC_FAILURE)

    if int(candidate.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V8_MANIFEST.version:
        raise CandidateExecutionError(_GENERIC_FAILURE)
    assert_exact_manifest(candidate, EXACT_V8_MANIFEST)
    if _table_data_digest(candidate, source_tables) != source_digest:
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if candidate.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    for table in _EMPTY_V8_TABLES:
        if int(candidate.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]) != 0:
            raise CandidateExecutionError(_GENERIC_FAILURE)
    if int(candidate.execute("SELECT COUNT(*) FROM compensation_role_families").fetchone()[0]) < 1:
        raise CandidateExecutionError(_GENERIC_FAILURE)


def _durable_table_names(conn: sqlite3.Connection) -> tuple[str, ...]:
    return tuple(
        name
        for object_type, name, _, _ in schema_dump(conn)
        if object_type == "table"
    )


def _table_data_digest(conn: sqlite3.Connection, tables: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    for table in tables:
        columns = tuple(
            str(row[1])
            for row in conn.execute(f"PRAGMA table_info({_quote_identifier(table)})")
        )
        _digest_value(digest, table)
        _digest_value(digest, columns)
        selected = ", ".join(_quote_identifier(column) for column in columns)
        order_by = ", ".join(_quote_identifier(column) for column in columns)
        rows = conn.execute(
            f"SELECT {selected} FROM {_quote_identifier(table)} ORDER BY {order_by}"
        )
        for row in rows:
            _digest_value(digest, tuple(row))
    _digest_value(digest, _sequence_rows(conn))
    return digest.hexdigest()


def _sequence_rows(conn: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'"
    ).fetchone()
    if exists is None:
        return ()
    return tuple(
        tuple(row)
        for row in conn.execute("SELECT name, seq FROM sqlite_sequence ORDER BY name")
    )


def _digest_value(digest: _Digest, value: object) -> None:
    if value is None:
        encoded = b"n"
    elif isinstance(value, bytes):
        encoded = b"b" + value
    elif isinstance(value, str):
        encoded = b"s" + value.encode("utf-8")
    elif isinstance(value, int):
        encoded = b"i" + str(value).encode("ascii")
    elif isinstance(value, float):
        encoded = b"f" + value.hex().encode("ascii")
    elif isinstance(value, tuple):
        encoded = b"t"
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
        for item in value:
            _digest_value(digest, item)
        return
    else:
        raise CandidateExecutionError(_GENERIC_FAILURE)
    digest.update(len(encoded).to_bytes(8, "big"))
    digest.update(encoded)


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _assert_paths(source: Path, candidate: Path) -> None:
    source_stat = source.lstat()
    if not stat.S_ISREG(source_stat.st_mode):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if os.path.abspath(source) == os.path.abspath(candidate):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if os.path.lexists(candidate):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if any(os.path.lexists(f"{candidate}{suffix}") for suffix in ("-journal", "-shm", "-wal")):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if not stat.S_ISDIR(candidate.parent.stat().st_mode):
        raise CandidateExecutionError(_GENERIC_FAILURE)


def _remove_created_candidate(
    candidate: Path,
    created_identity: tuple[int, int],
) -> None:
    try:
        current = candidate.lstat()
    except FileNotFoundError:
        current = None
    if current is not None and (current.st_dev, current.st_ino) == created_identity:
        candidate.unlink()
    for suffix in ("-journal", "-shm", "-wal"):
        Path(f"{candidate}{suffix}").unlink(missing_ok=True)


def _fsync_regular_file(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise CandidateExecutionError(_GENERIC_FAILURE)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv: Sequence[str] | None = None) -> int:
    """Run the authenticated launcher's private migration subprocess."""

    parser = _PrivateArgumentParser(add_help=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    try:
        arguments = parser.parse_args(argv)
        result = execute_v7_to_v8_candidate(
            arguments.source,
            arguments.candidate,
        )
    except CandidateExecutionError:
        print(_GENERIC_FAILURE, file=sys.stderr)
        return 1
    print(json.dumps(asdict(result), sort_keys=True, separators=(",", ":")))
    return 0


class _PrivateArgumentParser(argparse.ArgumentParser):
    """Argument parser that never echoes private transition paths."""

    def error(self, _message: str) -> None:
        raise CandidateExecutionError(_GENERIC_FAILURE)


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "CandidateExecutionError",
    "CandidateExecutionResult",
    "execute_v7_to_v8_candidate",
    "main",
]
