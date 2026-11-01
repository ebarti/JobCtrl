"""Private file-to-file executor for the stopped-runtime v12-to-v13 cutover."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from collections.abc import Callable, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Final

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V12_MANIFEST,
    EXACT_V13_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.schema_v13 import upgrade_exact_v12_schema_to_v13
from jobctrl.infrastructure.migrations.v7_to_v8_execute import (
    CandidateExecutionResult,
    _assert_paths,
    _digest_value,
    _durable_table_names,
    _fsync_directory,
    _fsync_regular_file,
    _quote_identifier,
    _sequence_rows,
    _sha256_file,
)
from jobctrl.infrastructure.migrations.v9_to_v10_execute import (
    _remove_created_candidate,
    _source_file_state,
)

_GENERIC_FAILURE: Final = "v12-to-v13 candidate migration failed"
_RESULT_SCHEMA_VERSION: Final = 1


class CandidateExecutionError(RuntimeError):
    """Raised when an isolated v13 candidate cannot be built and verified."""


def execute_v12_to_v13_candidate(
    source_path: Path | str,
    candidate_path: Path | str,
    *,
    _after_stamp: Callable[[], None] | None = None,
) -> CandidateExecutionResult:
    """Copy stopped v12, purge derived judgments, and seal an independently verified v13 candidate."""
    source = Path(source_path)
    candidate = Path(candidate_path)
    source_connection: sqlite3.Connection | None = None
    source_lock: sqlite3.Connection | None = None
    candidate_connection: sqlite3.Connection | None = None
    created_identity: tuple[int, int] | None = None
    try:
        _assert_paths(source, candidate)
        source_files = _source_file_state(source)
        # Lock the stopped source against concurrent writers without changing rows.
        source_lock = sqlite3.connect(f"{source.resolve().as_uri()}?mode=rw", uri=True, timeout=0)
        source_lock.execute("BEGIN IMMEDIATE")
        descriptor = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            created = os.fstat(descriptor)
            created_identity = (created.st_dev, created.st_ino)
        finally:
            os.close(descriptor)

        source_connection = sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True)
        source_connection.execute("PRAGMA foreign_keys = ON")
        if int(source_connection.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V12_MANIFEST.version:
            raise CandidateExecutionError(_GENERIC_FAILURE)
        assert_exact_manifest(source_connection, EXACT_V12_MANIFEST)
        source_tables = _durable_table_names(source_connection)
        source_columns = {
            table: tuple(
                str(row[1]) for row in source_connection.execute(f"PRAGMA table_info({_quote_identifier(table)})")
            )
            for table in source_tables
        }
        retained_columns = {
            table: tuple(
                column
                for column in columns
                if not (table == "candidate_profile_achievement_evidence" and column == "seniority_signal")
            )
            for table, columns in source_columns.items()
        }
        expected = sqlite3.connect(":memory:")
        try:
            source_connection.backup(expected)
            upgrade_exact_v12_schema_to_v13(expected)
            retained_columns = {
                table: tuple(str(row[1]) for row in expected.execute(f"PRAGMA table_info({_quote_identifier(table)})"))
                for table in _durable_table_names(expected)
            }
            source_digest = _table_data_digest(expected, retained_columns)
        finally:
            expected.close()

        candidate_connection = sqlite3.connect(candidate)
        candidate_connection.execute("PRAGMA foreign_keys = ON")
        source_connection.backup(candidate_connection)
        candidate_connection.commit()
        assert_exact_manifest(candidate_connection, EXACT_V12_MANIFEST)
        upgrade_exact_v12_schema_to_v13(candidate_connection)
        if _after_stamp is not None:
            _after_stamp()
        candidate_connection.commit()
        _verify_candidate(
            source_connection,
            candidate_connection,
            source_columns=retained_columns,
            source_digest=source_digest,
        )

        candidate_connection.close()
        candidate_connection = None
        source_connection.close()
        source_connection = None
        source_lock.rollback()
        source_lock.close()
        source_lock = None
        if _source_file_state(source) != source_files:
            raise CandidateExecutionError(_GENERIC_FAILURE)
        current = candidate.lstat()
        if (current.st_dev, current.st_ino) != created_identity or current.st_mode & 0o077:
            raise CandidateExecutionError(_GENERIC_FAILURE)
        _fsync_regular_file(candidate)
        _fsync_directory(candidate.parent)
        return CandidateExecutionResult(
            schema_version=_RESULT_SCHEMA_VERSION,
            status="ready",
            user_version=EXACT_V13_MANIFEST.version,
            source_data_digest=source_digest,
            candidate_data_digest=source_digest,
            candidate_sha256=_sha256_file(candidate),
            job_count=_job_count(candidate),
            table_count=EXACT_V13_MANIFEST.table_count,
        )
    except BaseException as error:
        if candidate_connection is not None:
            candidate_connection.close()
        if source_connection is not None:
            source_connection.close()
        if source_lock is not None:
            source_lock.rollback()
            source_lock.close()
        if created_identity is not None:
            _remove_created_candidate(candidate, created_identity)
        if isinstance(error, Exception):
            raise CandidateExecutionError(_GENERIC_FAILURE) from None
        raise


def _verify_candidate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    source_columns: dict[str, tuple[str, ...]],
    source_digest: str,
) -> None:
    if int(source.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V12_MANIFEST.version:
        raise CandidateExecutionError(_GENERIC_FAILURE)
    assert_exact_manifest(source, EXACT_V12_MANIFEST)
    if int(candidate.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V13_MANIFEST.version:
        raise CandidateExecutionError(_GENERIC_FAILURE)
    assert_exact_manifest(candidate, EXACT_V13_MANIFEST)
    if _table_data_digest(candidate, source_columns) != source_digest:
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if candidate.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise CandidateExecutionError(_GENERIC_FAILURE)


def _table_data_digest(conn: sqlite3.Connection, columns_by_table: dict[str, tuple[str, ...]]) -> str:
    digest = hashlib.sha256()
    for table, columns in columns_by_table.items():
        _digest_value(digest, table)
        _digest_value(digest, columns)
        selected = ", ".join(_quote_identifier(column) for column in columns)
        rows = conn.execute(f"SELECT {selected} FROM {_quote_identifier(table)} ORDER BY {selected}")
        for row in rows:
            _digest_value(digest, tuple(row))
    _digest_value(digest, _sequence_rows(conn))
    return digest.hexdigest()


def _job_count(candidate: Path) -> int:
    conn = sqlite3.connect(candidate)
    try:
        return int(conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])
    finally:
        conn.close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = _PrivateArgumentParser(add_help=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    try:
        arguments = parser.parse_args(argv)
        result = execute_v12_to_v13_candidate(arguments.source, arguments.candidate)
    except CandidateExecutionError:
        print(_GENERIC_FAILURE, file=sys.stderr)
        return 1
    print(json.dumps(asdict(result), sort_keys=True, separators=(",", ":")))
    return 0


class _PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise CandidateExecutionError(_GENERIC_FAILURE)


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = ["CandidateExecutionError", "execute_v12_to_v13_candidate", "main"]
