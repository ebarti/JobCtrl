"""Tenant-scoped locator resolution without legacy job-column authority."""

from __future__ import annotations

import sqlite3


def resolve_job_locator(
    conn: sqlite3.Connection, tenant_id: str, locator: str,
) -> tuple[str, str] | None:
    """Prefer posting identity and refuse ambiguous application aliases."""
    posting = conn.execute(
        """
        SELECT job_id, url FROM jobs j
        WHERE tenant_id = ? AND (job_id = ? OR url = ? OR EXISTS (
            SELECT 1 FROM job_locators l WHERE l.tenant_id = j.tenant_id
              AND l.job_id = j.job_id AND l.locator_value = ?
        )) LIMIT 2
        """,
        (tenant_id, locator, locator, locator),
    ).fetchall()
    if posting:
        return (str(posting[0][0]), str(posting[0][1])) if len(posting) == 1 else None
    application = conn.execute(
        """
        SELECT job_id, url FROM jobs j
        WHERE tenant_id = ? AND (EXISTS (
            SELECT 1 FROM job_enrichments e WHERE e.tenant_id = j.tenant_id
              AND e.job_id = j.job_id AND e.application_url = ?
        ) OR EXISTS (
            SELECT 1 FROM job_application_locators l WHERE l.tenant_id = j.tenant_id
              AND l.job_id = j.job_id AND l.application_url = ?
        )) LIMIT 2
        """,
        (tenant_id, locator, locator),
    ).fetchall()
    return (str(application[0][0]), str(application[0][1])) if len(application) == 1 else None
