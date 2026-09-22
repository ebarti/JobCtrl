"""Self-contained exact-v11 SQLite schema and exact-v10 spend-ledger upgrade."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from importlib.resources import files

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V10_MANIFEST,
    EXACT_V11_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v10 import (
    create_unstamped_exact_v10_candidate,
)


def _schema_statements() -> tuple[str, ...]:
    statements: list[str] = []
    buffered = ""
    schema_text = files("jobctrl.infrastructure.migrations").joinpath("schema_v11.sql").read_text(encoding="utf-8")
    for line in schema_text.splitlines():
        buffered = f"{buffered}\n{line}" if buffered else line
        if not sqlite3.complete_statement(buffered):
            continue
        statements.append(buffered.strip())
        buffered = ""
    if buffered.strip():
        raise SchemaManifestError("the frozen v11 schema extension file is incomplete")
    return tuple(statements)


def create_exact_v11_schema(
    conn: sqlite3.Connection,
    *,
    _execute: Callable[[str], object] | None = None,
) -> None:
    """Install the complete exact-v11 schema into an empty database."""
    if schema_dump(conn):
        raise SchemaManifestError("exact v11 creation requires an empty schema")
    execute = _execute or conn.execute
    conn.execute("SAVEPOINT exact_v11_schema")
    try:
        create_unstamped_exact_v10_candidate(conn, _execute=execute)
        for statement in _schema_statements():
            execute(statement)
        from jobctrl.infrastructure.migrations.compensation_role_family_seed import (
            seed_compensation_role_families,
        )
        from jobctrl.infrastructure.migrations.resume_template_seed import (
            seed_builtin_resume_template,
        )

        seed_builtin_resume_template(conn)
        seed_compensation_role_families(conn)
        execute(f"PRAGMA user_version = {EXACT_V11_MANIFEST.version}")
        assert_exact_manifest(conn, EXACT_V11_MANIFEST)
        conn.execute("RELEASE SAVEPOINT exact_v11_schema")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v11_schema")
        conn.execute("RELEASE SAVEPOINT exact_v11_schema")
        raise


def upgrade_exact_v10_schema_to_v11(
    conn: sqlite3.Connection,
    *,
    _execute: Callable[[str], object] | None = None,
) -> None:
    """Move v10 global spend rows to the explicit legacy lane atomically."""
    if conn.in_transaction:
        raise SchemaManifestError("exact v10-to-v11 upgrade requires no active transaction")
    if int(conn.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V10_MANIFEST.version:
        raise SchemaManifestError("exact v10-to-v11 upgrade requires user_version 10")
    assert_exact_manifest(conn, EXACT_V10_MANIFEST)

    execute = _execute or conn.execute
    conn.execute("SAVEPOINT exact_v10_to_v11_schema")
    try:
        for statement in _schema_statements():
            execute(statement)
        execute(f"PRAGMA user_version = {EXACT_V11_MANIFEST.version}")
        assert_exact_manifest(conn, EXACT_V11_MANIFEST)
        conn.execute("RELEASE SAVEPOINT exact_v10_to_v11_schema")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v10_to_v11_schema")
        conn.execute("RELEASE SAVEPOINT exact_v10_to_v11_schema")
        raise


__all__ = ["create_exact_v11_schema", "upgrade_exact_v10_schema_to_v11"]
