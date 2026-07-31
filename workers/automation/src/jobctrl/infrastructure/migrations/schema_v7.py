"""Self-contained exact-v7 SQLite schema constructor."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from importlib.resources import files

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)


def _schema_statements() -> tuple[str, ...]:
    statements: list[str] = []
    buffered = ""
    schema_text = (
        files("jobctrl.infrastructure.migrations")
        .joinpath("schema_v7.sql")
        .read_text(encoding="utf-8")
    )
    for line in schema_text.splitlines():
        buffered = f"{buffered}\n{line}" if buffered else line
        if not sqlite3.complete_statement(buffered):
            continue
        statements.append(buffered.strip())
        buffered = ""
    if buffered.strip():
        raise SchemaManifestError("the frozen v7 schema file is incomplete")
    return tuple(statements)


def create_exact_v7_schema(
    conn: sqlite3.Connection,
    *,
    _execute: Callable[[str], object] | None = None,
) -> None:
    """Install the complete target schema into an empty SQLite database."""
    _create_exact_v7_schema(conn, stamp_version=True, _execute=_execute)


def create_unstamped_exact_v7_candidate(
    conn: sqlite3.Connection,
    *,
    _execute: Callable[[str], object] | None = None,
) -> None:
    """Build an exact-v7 migration candidate without stamping its version."""
    _create_exact_v7_schema(conn, stamp_version=False, _execute=_execute)


def _create_exact_v7_schema(
    conn: sqlite3.Connection,
    *,
    stamp_version: bool,
    _execute: Callable[[str], object] | None,
) -> None:
    if schema_dump(conn):
        raise SchemaManifestError("exact v7 creation requires an empty schema")
    if not stamp_version and conn.execute("PRAGMA user_version").fetchone()[0] != 0:
        raise SchemaManifestError(
            "unstamped exact v7 candidate creation requires user_version 0"
        )
    execute = _execute or conn.execute
    conn.execute("SAVEPOINT exact_v7_schema")
    try:
        for statement in _schema_statements():
            execute(statement)
        if stamp_version:
            execute(f"PRAGMA user_version = {EXACT_V7_MANIFEST.version}")
        assert_exact_manifest(conn, EXACT_V7_MANIFEST)
        conn.execute("RELEASE SAVEPOINT exact_v7_schema")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v7_schema")
        conn.execute("RELEASE SAVEPOINT exact_v7_schema")
        raise
