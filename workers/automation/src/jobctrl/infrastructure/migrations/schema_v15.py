"""Exact schema with transactionally maintained job lifecycle generations."""

from __future__ import annotations

import sqlite3
from importlib.resources import files

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V14_MANIFEST,
    EXACT_V15_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema


def _extend(conn: sqlite3.Connection) -> None:
    pending = ""
    for line in files("jobctrl.infrastructure.migrations").joinpath("schema_v15.sql").read_text().splitlines():
        pending += line + "\n"
        if sqlite3.complete_statement(pending):
            conn.execute(pending.strip())
            pending = ""
    if pending.strip():
        raise SchemaManifestError("incomplete exact-v15 schema")
    conn.execute("PRAGMA user_version = 15")
    assert_exact_manifest(conn, EXACT_V15_MANIFEST)


def create_exact_v15_schema(conn: sqlite3.Connection) -> None:
    if schema_dump(conn):
        raise SchemaManifestError("exact-v15 creation requires an empty schema")
    conn.execute("SAVEPOINT exact_v15_create")
    try:
        create_exact_v14_schema(conn)
        _extend(conn)
        conn.execute("RELEASE SAVEPOINT exact_v15_create")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v15_create")
        conn.execute("RELEASE SAVEPOINT exact_v15_create")
        raise


def upgrade_exact_v14_schema_to_v15(conn: sqlite3.Connection) -> None:
    if conn.in_transaction or int(conn.execute("PRAGMA user_version").fetchone()[0]) != 14:
        raise SchemaManifestError("stopped exact-v14 source required")
    assert_exact_manifest(conn, EXACT_V14_MANIFEST)
    conn.execute("SAVEPOINT exact_v15_upgrade")
    try:
        _extend(conn)
        conn.execute("RELEASE SAVEPOINT exact_v15_upgrade")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v15_upgrade")
        conn.execute("RELEASE SAVEPOINT exact_v15_upgrade")
        raise
