"""Self-contained exact-v10 SQLite schema and exact-v9 URL ownership upgrade."""

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
    EXACT_V9_MANIFEST,
    EXACT_V10_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v9 import (
    create_unstamped_exact_v9_candidate,
)


def _schema_statements() -> tuple[str, ...]:
    statements: list[str] = []
    buffered = ""
    schema_text = files("jobctrl.infrastructure.migrations").joinpath("schema_v10.sql").read_text(encoding="utf-8")
    for line in schema_text.splitlines():
        buffered = f"{buffered}\n{line}" if buffered else line
        if not sqlite3.complete_statement(buffered):
            continue
        statements.append(buffered.strip())
        buffered = ""
    if buffered.strip():
        raise SchemaManifestError("the frozen v10 schema extension file is incomplete")
    return tuple(statements)


def create_exact_v10_schema(
    conn: sqlite3.Connection,
    *,
    _execute: Callable[[str], object] | None = None,
) -> None:
    """Install the complete exact-v10 schema into an empty database."""

    _create_empty_exact_v10_schema(conn, stamp_version=True, _execute=_execute)


def create_unstamped_exact_v10_candidate(
    conn: sqlite3.Connection,
    *,
    _execute: Callable[[str], object] | None = None,
) -> None:
    """Build an exact-v10 candidate without stamping its user version."""

    _create_empty_exact_v10_schema(conn, stamp_version=False, _execute=_execute)


def upgrade_exact_v9_schema_to_v10(
    conn: sqlite3.Connection,
    *,
    _execute: Callable[[str], object] | None = None,
) -> None:
    """Transfer application URLs and drop the legacy column on an isolated candidate."""

    if conn.in_transaction:
        raise SchemaManifestError("exact v9-to-v10 upgrade requires no active transaction")
    if int(conn.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V9_MANIFEST.version:
        raise SchemaManifestError("exact v9-to-v10 upgrade requires user_version 9")
    assert_exact_manifest(conn, EXACT_V9_MANIFEST)

    execute = _execute or conn.execute
    conn.execute("SAVEPOINT exact_v9_to_v10_schema")
    try:
        for statement in _schema_statements():
            execute(statement)
        execute(f"PRAGMA user_version = {EXACT_V10_MANIFEST.version}")
        assert_exact_manifest(conn, EXACT_V10_MANIFEST)
        conn.execute("RELEASE SAVEPOINT exact_v9_to_v10_schema")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v9_to_v10_schema")
        conn.execute("RELEASE SAVEPOINT exact_v9_to_v10_schema")
        raise


def _create_empty_exact_v10_schema(
    conn: sqlite3.Connection,
    *,
    stamp_version: bool,
    _execute: Callable[[str], object] | None,
) -> None:
    if schema_dump(conn):
        raise SchemaManifestError("exact v10 creation requires an empty schema")
    if not stamp_version and conn.execute("PRAGMA user_version").fetchone()[0] != 0:
        raise SchemaManifestError("unstamped exact v10 candidate creation requires user_version 0")

    execute = _execute or conn.execute
    conn.execute("SAVEPOINT exact_v10_schema")
    try:
        create_unstamped_exact_v9_candidate(conn, _execute=execute)
        for statement in _schema_statements():
            execute(statement)
        if stamp_version:
            seed_builtin_resume_template(conn)
            seed_compensation_role_families(conn)
            execute(f"PRAGMA user_version = {EXACT_V10_MANIFEST.version}")
        assert_exact_manifest(conn, EXACT_V10_MANIFEST)
        conn.execute("RELEASE SAVEPOINT exact_v10_schema")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v10_schema")
        conn.execute("RELEASE SAVEPOINT exact_v10_schema")
        raise


__all__ = [
    "create_exact_v10_schema",
    "create_unstamped_exact_v10_candidate",
    "upgrade_exact_v9_schema_to_v10",
]
