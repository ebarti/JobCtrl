"""Private file-to-file executor for the stopped-runtime v9-to-v10 cutover."""

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
    EXACT_V9_MANIFEST,
    EXACT_V10_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.schema_v10 import (
    upgrade_exact_v9_schema_to_v10,
)
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

_GENERIC_FAILURE: Final = "v9-to-v10 candidate migration failed"
_RESULT_SCHEMA_VERSION: Final = 1


class CandidateExecutionError(RuntimeError):
    """Raised when an isolated v10 candidate cannot be built and verified."""


def execute_v9_to_v10_candidate(
    source_path: Path | str,
    candidate_path: Path | str,
    *,
    _after_stamp: Callable[[], None] | None = None,
) -> CandidateExecutionResult:
    """Copy exact v9, transfer application URLs, and seal a verified private file."""

    source = Path(source_path)
    candidate = Path(candidate_path)
    source_connection: sqlite3.Connection | None = None
    candidate_connection: sqlite3.Connection | None = None
    created_identity: tuple[int, int] | None = None
    try:
        _assert_paths(source, candidate)
        source_files = _source_file_state(source)
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
        if int(source_connection.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V9_MANIFEST.version:
            raise CandidateExecutionError(_GENERIC_FAILURE)
        assert_exact_manifest(source_connection, EXACT_V9_MANIFEST)
        source_tables = _durable_table_names(source_connection)
        source_columns = _table_columns(source_connection, source_tables)
        full_source_digest = _table_data_digest(source_connection, source_tables, source_columns)
        retained_columns = dict(source_columns)
        for table in ("jobs", "job_enrichments"):
            retained_columns[table] = tuple(c for c in source_columns[table] if c != "application_url")
        enrichment_keys = frozenset(source_connection.execute("SELECT tenant_id, job_id FROM job_enrichments"))
        source_digest = _preserved_data_digest(source_connection, source_tables, retained_columns, enrichment_keys)
        expected_aliases, expected_enrichments = _expected_transfer(
            source_connection, source_columns["job_enrichments"]
        )

        candidate_connection = sqlite3.connect(candidate)
        candidate_connection.execute("PRAGMA foreign_keys = ON")
        source_connection.backup(candidate_connection)
        candidate_connection.commit()
        assert_exact_manifest(candidate_connection, EXACT_V9_MANIFEST)
        if _table_data_digest(candidate_connection, source_tables, source_columns) != full_source_digest:
            raise CandidateExecutionError(_GENERIC_FAILURE)

        upgrade_exact_v9_schema_to_v10(candidate_connection)
        if _after_stamp is not None:
            _after_stamp()
        candidate_connection.commit()
        _verify_candidate(
            source_connection,
            candidate_connection,
            source_tables=source_tables,
            source_columns=source_columns,
            full_source_digest=full_source_digest,
            retained_columns=retained_columns,
            enrichment_keys=enrichment_keys,
            expected_aliases=expected_aliases,
            expected_enrichments=expected_enrichments,
            source_digest=source_digest,
        )
        candidate_digest = _preserved_data_digest(
            candidate_connection, source_tables, retained_columns, enrichment_keys
        )
        job_count = int(candidate_connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])

        candidate_connection.close()
        candidate_connection = None
        source_connection.close()
        source_connection = None
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
            user_version=EXACT_V10_MANIFEST.version,
            source_data_digest=source_digest,
            candidate_data_digest=candidate_digest,
            candidate_sha256=_sha256_file(candidate),
            job_count=job_count,
            table_count=EXACT_V10_MANIFEST.table_count,
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
    source_columns: dict[str, tuple[str, ...]],
    full_source_digest: str,
    retained_columns: dict[str, tuple[str, ...]],
    enrichment_keys: frozenset[tuple[str, str]],
    expected_aliases: set[tuple[object, ...]],
    expected_enrichments: dict[tuple[object, ...], tuple[object, ...]],
    source_digest: str,
) -> None:
    if int(source.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V9_MANIFEST.version:
        raise CandidateExecutionError(_GENERIC_FAILURE)
    assert_exact_manifest(source, EXACT_V9_MANIFEST)
    if _table_data_digest(source, source_tables, source_columns) != full_source_digest:
        raise CandidateExecutionError(_GENERIC_FAILURE)

    if int(candidate.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V10_MANIFEST.version:
        raise CandidateExecutionError(_GENERIC_FAILURE)
    assert_exact_manifest(candidate, EXACT_V10_MANIFEST)
    if _preserved_data_digest(candidate, source_tables, retained_columns, enrichment_keys) != source_digest:
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if candidate.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    aliases = set(candidate.execute("SELECT tenant_id, job_id, application_url FROM job_application_locators"))
    columns = source_columns["job_enrichments"]
    selected = ", ".join(_quote_identifier(c) for c in columns)
    rows = candidate.execute(f"SELECT {selected} FROM job_enrichments")
    enrichments = {(r[columns.index("tenant_id")], r[columns.index("job_id")]): tuple(r) for r in rows}
    if aliases != expected_aliases or enrichments != expected_enrichments:
        raise CandidateExecutionError(_GENERIC_FAILURE)


def _table_columns(
    conn: sqlite3.Connection,
    tables: tuple[str, ...],
) -> dict[str, tuple[str, ...]]:
    return {
        table: tuple(str(row[1]) for row in conn.execute(f"PRAGMA table_info({_quote_identifier(table)})"))
        for table in tables
    }


def _table_data_digest(
    conn: sqlite3.Connection,
    tables: tuple[str, ...],
    columns_by_table: dict[str, tuple[str, ...]],
) -> str:
    digest = hashlib.sha256()
    for table in tables:
        columns = columns_by_table[table]
        _digest_value(digest, table)
        _digest_value(digest, columns)
        selected = ", ".join(_quote_identifier(column) for column in columns)
        order_by = ", ".join(_quote_identifier(column) for column in columns)
        rows = conn.execute(f"SELECT {selected} FROM {_quote_identifier(table)} ORDER BY {order_by}")
        for row in rows:
            _digest_value(digest, tuple(row))
    _digest_value(digest, _sequence_rows(conn))
    return digest.hexdigest()


def _preserved_data_digest(
    conn: sqlite3.Connection,
    tables: tuple[str, ...],
    columns_by_table: dict[str, tuple[str, ...]],
    enrichment_keys: frozenset[tuple[str, str]],
) -> str:
    """Compare all retained cells; separately verify changed URLs and added rows.

    Only the removed jobs URL, enrichment URLs, and newly required enrichment
    rows are omitted. The exact complete enrichment transform is checked before
    issuing a receipt, including every omitted cell and added row.
    """
    digest = hashlib.sha256()
    for table in tables:
        columns = columns_by_table[table]
        _digest_value(digest, table)
        _digest_value(digest, columns)
        selected = ", ".join(_quote_identifier(c) for c in columns)
        for row in conn.execute(f"SELECT {selected} FROM {_quote_identifier(table)} ORDER BY {selected}"):
            if table == "job_enrichments":
                key = (row[columns.index("tenant_id")], row[columns.index("job_id")])
                if key not in enrichment_keys:
                    continue
            _digest_value(digest, tuple(row))
    _digest_value(digest, _sequence_rows(conn))
    return digest.hexdigest()


def _expected_transfer(
    source: sqlite3.Connection,
    columns: tuple[str, ...],
) -> tuple[set[tuple[object, ...]], dict[tuple[object, ...], tuple[object, ...]]]:
    """Derive expected rows independently of the SQL migration implementation."""
    selected = ", ".join(_quote_identifier(c) for c in columns)
    rows = [dict(zip(columns, row, strict=True)) for row in source.execute(f"SELECT {selected} FROM job_enrichments")]
    by_key = {(r["tenant_id"], r["job_id"]): r for r in rows}
    aliases = {
        (r["tenant_id"], r["job_id"], r["application_url"]) for r in rows if r["application_url"] not in (None, "")
    }
    for tenant, job, legacy, detail_at, discovered_at in source.execute(
        "SELECT tenant_id, job_id, application_url, detail_scraped_at, discovered_at FROM jobs"
    ):
        if legacy in (None, ""):
            continue
        aliases.add((tenant, job, legacy))
        key = (tenant, job)
        if key not in by_key:
            row = dict.fromkeys(columns)
            row.update(
                tenant_id=tenant,
                job_id=job,
                current_status="pending",
                application_url=legacy,
                attempts_json="[]",
                updated_at=detail_at or discovered_at or "1970-01-01T00:00:00+00:00",
            )
            by_key[key] = row
        elif by_key[key]["application_url"] in (None, ""):
            by_key[key]["application_url"] = legacy
    return aliases, {key: tuple(row[c] for c in columns) for key, row in by_key.items()}


def _source_file_state(source: Path) -> tuple[tuple[object, ...], ...]:
    """Include the legacy column and SQLite sidecar bytes in immutability proof."""
    state: list[tuple[object, ...]] = []
    for path in (source, *(Path(f"{source}{s}") for s in ("-journal", "-wal", "-shm"))):
        if path.exists():
            info = path.lstat()
            state.append((str(path), info.st_dev, info.st_ino, info.st_mode, _sha256_file(path)))
    return tuple(state)


def _remove_created_candidate(candidate: Path, created_identity: tuple[int, int]) -> None:
    try:
        current = candidate.lstat()
    except FileNotFoundError:
        return
    if (current.st_dev, current.st_ino) != created_identity:
        return
    candidate.unlink()
    for suffix in ("-journal", "-shm", "-wal"):
        Path(f"{candidate}{suffix}").unlink(missing_ok=True)


def main(argv: Sequence[str] | None = None) -> int:
    """Run the authenticated launcher's private migration subprocess."""

    parser = _PrivateArgumentParser(add_help=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    try:
        arguments = parser.parse_args(argv)
        result = execute_v9_to_v10_candidate(arguments.source, arguments.candidate)
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
    "execute_v9_to_v10_candidate",
    "main",
]
