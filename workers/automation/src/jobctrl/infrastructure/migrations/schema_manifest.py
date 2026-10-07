"""Immutable manifests for the supported exact database schemas."""

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


EXACT_V8_MANIFEST = SchemaManifest(
    version=8,
    object_count=272,
    table_count=117,
    fingerprint="3705f7c7d90454bbeaa85227a9d4ce87c12efd14935e0d14afc830939e80ff31",
)


EXACT_V9_MANIFEST = SchemaManifest(
    version=9,
    object_count=272,
    table_count=117,
    fingerprint="ee90d737238c162f34d69f5becf01f15897d4bbeb2c4b2c51d41526ec6343621",
)


EXACT_V10_MANIFEST = SchemaManifest(
    version=10,
    object_count=274,
    table_count=118,
    fingerprint="d5c1676fff6e81c987055bf4db6d725c582c74b834f4bf92c9eef3f5980f3641",
)


EXACT_V11_MANIFEST = SchemaManifest(
    version=11,
    object_count=274,
    table_count=118,
    fingerprint="6a653761d23c9c17f4e8000f13d14003d265cc5739877063212991569564e542",
)


EXACT_V12_MANIFEST = SchemaManifest(
    version=12,
    object_count=276,
    table_count=120,
    fingerprint="10a8edc30fbfa77e7bea57f3c939a80d836ef3d579f4c5378e7e6e49c6754b56",
)

EXACT_V13_MANIFEST = SchemaManifest(
    version=13,
    object_count=286,
    table_count=128,
    fingerprint="24f551f62457dd2190db390df3d72db50620fc0ae60de3706a6dfc4f38934138",
)


EXACT_V14_MANIFEST = SchemaManifest(
    version=14,
    object_count=286,
    table_count=128,
    fingerprint="d84e0f30dc509e70e270f74993cb2c7d8e5f1905b0f583626553b5a16adda09f",
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
    if object_type == "index" and name.startswith("sqlite_autoindex_") and table_name and sql == "":
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
