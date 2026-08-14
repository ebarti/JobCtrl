"""Self-contained exact-v8 SQLite schema and exact-v7 upgrade contract."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from importlib.resources import files

from jobctrl.infrastructure.migrations.compensation_role_family_seed import (
    seed_compensation_role_families,
)
from jobctrl.infrastructure.migrations.resume_template_seed import (
    seed_builtin_resume_template,
)
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    EXACT_V8_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v7 import (
    create_unstamped_exact_v7_candidate,
)


def _schema_statements() -> tuple[str, ...]:
    statements: list[str] = []
    buffered = ""
    schema_text = (
        files("jobctrl.infrastructure.migrations")
        .joinpath("schema_v8.sql")
        .read_text(encoding="utf-8")
    )
    for line in schema_text.splitlines():
        buffered = f"{buffered}\n{line}" if buffered else line
        if not sqlite3.complete_statement(buffered):
            continue
        statements.append(buffered.strip())
        buffered = ""
    if buffered.strip():
        raise SchemaManifestError("the frozen v8 schema extension file is incomplete")
    return tuple(statements)


def create_exact_v8_schema(
    conn: sqlite3.Connection,
    *,
    _execute: Callable[[str], object] | None = None,
) -> None:
    """Install the complete exact-v8 schema into an empty database."""

    _create_empty_exact_v8_schema(conn, stamp_version=True, _execute=_execute)


def create_unstamped_exact_v8_candidate(
    conn: sqlite3.Connection,
    *,
    _execute: Callable[[str], object] | None = None,
) -> None:
    """Build an exact-v8 candidate without stamping its user version."""

    _create_empty_exact_v8_schema(conn, stamp_version=False, _execute=_execute)


def upgrade_exact_v7_schema_to_v8(
    conn: sqlite3.Connection,
    *,
    _execute: Callable[[str], object] | None = None,
) -> None:
    """Upgrade one isolated exact-v7 candidate to exact v8 transactionally."""

    if conn.in_transaction:
        raise SchemaManifestError("exact v7-to-v8 upgrade requires no active transaction")
    if int(conn.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V7_MANIFEST.version:
        raise SchemaManifestError("exact v7-to-v8 upgrade requires user_version 7")
    assert_exact_manifest(conn, EXACT_V7_MANIFEST)

    execute = _execute or conn.execute
    conn.execute("SAVEPOINT exact_v7_to_v8_schema")
    try:
        for statement in _schema_statements():
            execute(statement)
        seed_compensation_role_families(conn)
        execute(f"PRAGMA user_version = {EXACT_V8_MANIFEST.version}")
        assert_exact_manifest(conn, EXACT_V8_MANIFEST)
        conn.execute("RELEASE SAVEPOINT exact_v7_to_v8_schema")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v7_to_v8_schema")
        conn.execute("RELEASE SAVEPOINT exact_v7_to_v8_schema")
        raise


def _create_empty_exact_v8_schema(
    conn: sqlite3.Connection,
    *,
    stamp_version: bool,
    _execute: Callable[[str], object] | None,
) -> None:
    if schema_dump(conn):
        raise SchemaManifestError("exact v8 creation requires an empty schema")
    if not stamp_version and conn.execute("PRAGMA user_version").fetchone()[0] != 0:
        raise SchemaManifestError(
            "unstamped exact v8 candidate creation requires user_version 0"
        )

    execute = _execute or conn.execute
    conn.execute("SAVEPOINT exact_v8_schema")
    try:
        create_unstamped_exact_v7_candidate(conn, _execute=execute)
        for statement in _schema_statements():
            execute(statement)
        if stamp_version:
            seed_builtin_resume_template(conn)
            seed_compensation_role_families(conn)
            execute(f"PRAGMA user_version = {EXACT_V8_MANIFEST.version}")
        assert_exact_manifest(conn, EXACT_V8_MANIFEST)
        conn.execute("RELEASE SAVEPOINT exact_v8_schema")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v8_schema")
        conn.execute("RELEASE SAVEPOINT exact_v8_schema")
        raise
