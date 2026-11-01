"""Exact schema for semantic provenance. Earlier schema constructors stay frozen."""

from __future__ import annotations

import sqlite3
from importlib.resources import files

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V12_MANIFEST,
    EXACT_V13_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v12 import create_exact_v12_schema


def _statements() -> tuple[str, ...]:
    result: list[str] = []
    pending = ""
    for line in files("jobctrl.infrastructure.migrations").joinpath("schema_v13.sql").read_text().splitlines():
        pending += line + "\n"
        if sqlite3.complete_statement(pending):
            result.append(pending.strip())
            pending = ""
    if pending.strip():
        raise SchemaManifestError("incomplete exact-v13 schema")
    return tuple(result)


def _extend(conn: sqlite3.Connection) -> None:
    from jobctrl.infrastructure.profile.legacy_evidence import evidence_rows, record_legacy_inventory

    # Legacy schemas record a boolean, not who supplied it. Preserve the exact
    # original and its history; no value pattern establishes authorship.
    originals = evidence_rows(conn)
    for statement in _statements():
        conn.execute(statement)
    record_legacy_inventory(conn, originals)
    conn.execute("PRAGMA user_version = 13")
    assert_exact_manifest(conn, EXACT_V13_MANIFEST)


def create_exact_v13_schema(conn: sqlite3.Connection) -> None:
    if schema_dump(conn):
        raise SchemaManifestError("exact-v13 creation requires an empty schema")
    conn.execute("SAVEPOINT exact_v13_create")
    try:
        create_exact_v12_schema(conn)
        _extend(conn)
        conn.execute("RELEASE SAVEPOINT exact_v13_create")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v13_create")
        conn.execute("RELEASE SAVEPOINT exact_v13_create")
        raise


def upgrade_exact_v12_schema_to_v13(conn: sqlite3.Connection) -> None:
    if conn.in_transaction or int(conn.execute("PRAGMA user_version").fetchone()[0]) != 12:
        raise SchemaManifestError("stopped exact-v12 source required")
    assert_exact_manifest(conn, EXACT_V12_MANIFEST)
    conn.execute("SAVEPOINT exact_v13_upgrade")
    try:
        _extend(conn)
        conn.execute("RELEASE SAVEPOINT exact_v13_upgrade")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v13_upgrade")
        conn.execute("RELEASE SAVEPOINT exact_v13_upgrade")
        raise
