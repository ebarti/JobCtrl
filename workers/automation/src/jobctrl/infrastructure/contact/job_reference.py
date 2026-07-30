"""Compatibility boundary for Contact and Outreach optional Job links.

Schemas v24-v25 store tenant-scoped stable ``JobId`` values while the Contact,
ContactResearch, and Outreach domains and public DTOs remain URL-shaped until
the Phase-4 cutover. Resolution is deliberately URL-first so a UUID-shaped
posting URL cannot bind to an unrelated row whose stable id happens to contain
the same text.
"""

from __future__ import annotations

import sqlite3

from jobctrl.domain.tenant import TenantId


def contact_job_reference_column(
    conn: sqlite3.Connection,
    table: str,
) -> str:
    columns = {
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table}")'
        ).fetchall()
    }
    if "job_id" in columns:
        return "job_id"
    if "job_url" in columns:
        return "job_url"
    raise RuntimeError(f"{table} has no Job identity column")


def physical_contact_job_reference(
    conn: sqlite3.Connection,
    *,
    table: str,
    tenant_id: TenantId,
    public_reference: str | None,
) -> str | None:
    if public_reference is None:
        return None
    raw_reference = str(public_reference).strip()
    if not raw_reference:
        raise ValueError("job link must be non-empty")
    if contact_job_reference_column(conn, table) == "job_url":
        return raw_reference

    tenant = str(tenant_id)
    lookups = (
        """
        SELECT job_id
        FROM jobs
        WHERE tenant_id = ? AND url = ?
        LIMIT 1
        """,
        """
        SELECT aliases.job_id
        FROM job_identity_aliases aliases
        JOIN jobs
          ON jobs.tenant_id = aliases.tenant_id
         AND jobs.job_id = aliases.job_id
        WHERE aliases.tenant_id = ?
          AND aliases.alias_kind = 'posting_url'
          AND aliases.alias_value = ?
        LIMIT 1
        """,
        """
        SELECT job_id
        FROM jobs
        WHERE tenant_id = ? AND job_id = ?
        LIMIT 1
        """,
    )
    for sql in lookups:
        row = conn.execute(sql, (tenant, raw_reference)).fetchone()
        if row is not None and str(row[0] or "").strip():
            return str(row[0])
    raise KeyError(
        f"No stable Job identity for contact link: {raw_reference}"
    )


def public_contact_job_reference(
    conn: sqlite3.Connection,
    *,
    table: str,
    tenant_id: TenantId,
    physical_reference: str | None,
) -> str | None:
    if physical_reference is None:
        return None
    if contact_job_reference_column(conn, table) == "job_url":
        return str(physical_reference)
    row = conn.execute(
        """
        SELECT url
        FROM jobs
        WHERE tenant_id = ? AND job_id = ?
        LIMIT 1
        """,
        (str(tenant_id), str(physical_reference)),
    ).fetchone()
    if row is None:
        raise RuntimeError(
            f"{table} contains an unresolved JobId: {physical_reference}"
        )
    return str(row[0])


__all__ = [
    "contact_job_reference_column",
    "physical_contact_job_reference",
    "public_contact_job_reference",
]
