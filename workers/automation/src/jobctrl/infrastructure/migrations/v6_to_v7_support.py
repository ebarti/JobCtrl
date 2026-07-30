"""Shared primitives for the explicit stopped-runtime v6-to-v7 transforms."""

from __future__ import annotations

import sqlite3


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    """Return whether a named table is present in the migration database."""
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone() is not None


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """Return the declared columns for a known migration table."""
    return {
        str(row[1])
        for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    }


def has_tenant_job_foreign_key(
    conn: sqlite3.Connection,
    table: str,
    reference_column: str,
) -> bool:
    """Check the required cascading composite reference to ``jobs``."""
    groups: dict[int, set[tuple[str, str]]] = {}
    cascades: dict[int, bool] = {}
    for row in conn.execute(f'PRAGMA foreign_key_list("{table}")').fetchall():
        if str(row[2]) != "jobs":
            continue
        foreign_key_id = int(row[0])
        groups.setdefault(foreign_key_id, set()).add(
            (str(row[3]), str(row[4]))
        )
        cascades[foreign_key_id] = str(row[6]).upper() == "CASCADE"
    expected = {("tenant_id", "tenant_id"), (reference_column, "job_id")}
    return any(
        columns == expected and cascades.get(foreign_key_id, False)
        for foreign_key_id, columns in groups.items()
    )
