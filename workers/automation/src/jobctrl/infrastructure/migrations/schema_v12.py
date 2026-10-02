"""Exact-v12 interview storage; historical schema constructors stay frozen."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from importlib.resources import files

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V11_MANIFEST,
    EXACT_V12_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v11 import create_exact_v11_schema


def _schema_statements() -> tuple[str, ...]:
    statements: list[str] = []
    buffered = ""
    for line in (
        files("jobctrl.infrastructure.migrations").joinpath("schema_v12.sql").read_text(encoding="utf-8").splitlines()
    ):
        buffered = f"{buffered}\n{line}" if buffered else line
        if sqlite3.complete_statement(buffered):
            statements.append(buffered.strip())
            buffered = ""
    if buffered.strip():
        raise SchemaManifestError("the frozen v12 schema extension file is incomplete")
    return tuple(statements)


def create_exact_v12_schema(conn: sqlite3.Connection, *, _execute: Callable[[str], object] | None = None) -> None:
    """Install exact v12 atomically into an empty database."""
    if schema_dump(conn):
        raise SchemaManifestError("exact v12 creation requires an empty schema")
    execute = _execute or conn.execute
    conn.execute("SAVEPOINT exact_v12_schema")
    try:
        create_exact_v11_schema(conn, _execute=execute)
        for statement in _schema_statements():
            execute(statement)
        execute(f"PRAGMA user_version = {EXACT_V12_MANIFEST.version}")
        assert_exact_manifest(conn, EXACT_V12_MANIFEST)
        conn.execute("RELEASE SAVEPOINT exact_v12_schema")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v12_schema")
        conn.execute("RELEASE SAVEPOINT exact_v12_schema")
        raise


def upgrade_exact_v11_schema_to_v12(
    conn: sqlite3.Connection, *, _execute: Callable[[str], object] | None = None
) -> None:
    """Extend a stopped exact-v11 candidate without changing its retained cells."""
    if conn.in_transaction:
        raise SchemaManifestError("exact v11-to-v12 upgrade requires no active transaction")
    if int(conn.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V11_MANIFEST.version:
        raise SchemaManifestError("exact v11-to-v12 upgrade requires user_version 11")
    assert_exact_manifest(conn, EXACT_V11_MANIFEST)
    execute = _execute or conn.execute
    conn.execute("SAVEPOINT exact_v11_to_v12_schema")
    try:
        for statement in _schema_statements():
            execute(statement)
        execute(f"PRAGMA user_version = {EXACT_V12_MANIFEST.version}")
        assert_exact_manifest(conn, EXACT_V12_MANIFEST)
        conn.execute("RELEASE SAVEPOINT exact_v11_to_v12_schema")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v11_to_v12_schema")
        conn.execute("RELEASE SAVEPOINT exact_v11_to_v12_schema")
        raise
