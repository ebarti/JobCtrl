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
    object_count=242,
    table_count=110,
    fingerprint="775312f0ec2640a2a87889602886c90e21a49e06fffc53cf26c435856247da97",
)


class SchemaManifestError(RuntimeError):
    """Raised before writes when a database is not an exact known schema."""


def schema_dump(conn: sqlite3.Connection) -> tuple[tuple[str, str, str, str], ...]:
    """Return the complete stable DDL inventory without mutating SQLite."""
    rows = conn.execute(
        """
        SELECT type, name, tbl_name, COALESCE(sql, '')
        FROM sqlite_master
        ORDER BY type, name
        """
    ).fetchall()
    dump = tuple(tuple(str(value) for value in row) for row in rows)
    return tuple(row for row in dump if not _is_sqlite_owned_schema_row(row))


def _is_sqlite_owned_schema_row(row: tuple[str, str, str, str]) -> bool:
    """Ignore only exact inert objects created internally by SQLite."""
    object_type, name, table_name, sql = row
    if (
        object_type == "index"
        and name.startswith("sqlite_autoindex_")
        and table_name
        and sql == ""
    ):
        return True
    return row in {
        (
            "table",
            "sqlite_sequence",
            "sqlite_sequence",
            "CREATE TABLE sqlite_sequence(name,seq)",
        ),
        (
            "table",
            "sqlite_stat1",
            "sqlite_stat1",
            "CREATE TABLE sqlite_stat1(tbl,idx,stat)",
        ),
        (
            "table",
            "sqlite_stat4",
            "sqlite_stat4",
            "CREATE TABLE sqlite_stat4(tbl,idx,neq,nlt,ndlt,sample)",
        ),
    }


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
