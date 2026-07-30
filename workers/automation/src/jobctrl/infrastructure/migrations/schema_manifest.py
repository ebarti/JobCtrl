"""Immutable manifest for the exact v7 database."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass


@dataclass(frozen=True)
class SchemaManifest:
    version: int
    object_count: int
    table_count: int
    fingerprint: str


# This hash is over the full ordered sqlite_master schema tuple
# ``(type, name, tbl_name, sql)`` exactly as SQLite stores it. The frozen schema
# is the sole constructor, so formatting differences are rejected too. Keeping
# the raw SQL is important: quote and whitespace changes inside defaults can be
# semantically meaningful and must never normalize to the same fingerprint.
EXACT_V7_MANIFEST = SchemaManifest(
    version=7,
    object_count=197,
    table_count=101,
    fingerprint="14e3ee939ca12ae4535fca7ab031671976b2375c911a51ada89851113bb5e4af",
)


class SchemaManifestError(RuntimeError):
    """Raised before writes when a database is not an exact known schema."""


def schema_dump(conn: sqlite3.Connection) -> tuple[tuple[str, str, str, str], ...]:
    """Return the complete stable DDL inventory without mutating SQLite."""
    rows = conn.execute(
        """
        SELECT type, name, tbl_name, COALESCE(sql, '')
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
        """
    ).fetchall()
    return tuple(tuple(str(value) for value in row) for row in rows)


def schema_manifest(conn: sqlite3.Connection, *, version: int) -> SchemaManifest:
    dump = schema_dump(conn)
    encoded = json.dumps(
        dump,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()
    return SchemaManifest(
        version=version,
        object_count=len(dump),
        table_count=sum(1 for item in dump if item[0] == "table"),
        fingerprint=hashlib.sha256(encoded).hexdigest(),
    )


def assert_exact_manifest(
    conn: sqlite3.Connection,
    expected: SchemaManifest,
) -> None:
    observed = schema_manifest(conn, version=expected.version)
    if observed != expected:
        raise SchemaManifestError(
            "JobCtrl database schema does not match the exact "
            f"v{expected.version} manifest; restore a compatible backup or "
            "complete the documented stopped-runtime migration."
        )
