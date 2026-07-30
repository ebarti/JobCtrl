"""SQLite adapter for stable Job identity resolution."""

from __future__ import annotations

import sqlite3
from typing import Any

from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.ports.discovery import ResolvedJobIdentity
from jobctrl.domain.tenant import TenantId


_CURRENT_POSTING_URL_SQL = """
(
    SELECT locator.locator_value
    FROM job_locators locator
    WHERE locator.tenant_id = j.tenant_id
      AND locator.job_id = j.job_id
      AND locator.locator_kind = 'posting_url'
      AND locator.is_current = 1
      AND locator.retired_at IS NULL
    LIMIT 1
)
"""


class SqliteJobIdentityResolver:
    """Resolve UUID-backed Job identities and their posting-URL aliases."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def resolve_by_job_id(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> ResolvedJobIdentity | None:
        row = self._conn.execute(
            f"""
            SELECT
                j.tenant_id,
                j.job_id,
                {_CURRENT_POSTING_URL_SQL} AS posting_url
            FROM jobs j
            WHERE j.tenant_id = ? AND j.job_id = ?
            LIMIT 1
            """,
            (str(tenant_id), str(job_id)),
        ).fetchone()
        return _resolved_identity(row)

    def resolve_by_posting_url(
        self,
        tenant_id: TenantId,
        posting_url: PostingUrl,
    ) -> ResolvedJobIdentity | None:
        row = self._conn.execute(
            f"""
            SELECT
                j.tenant_id,
                j.job_id,
                {_CURRENT_POSTING_URL_SQL} AS posting_url
            FROM job_locators a
            JOIN jobs j
              ON j.tenant_id = a.tenant_id
             AND j.job_id = a.job_id
            WHERE a.tenant_id = ?
              AND a.locator_kind = 'posting_url'
              AND a.locator_value = ?
            LIMIT 1
            """,
            (str(tenant_id), posting_url.value),
        ).fetchone()
        return _resolved_identity(row)


def _resolved_identity(row: Any | None) -> ResolvedJobIdentity | None:
    if row is None:
        return None
    if isinstance(row, sqlite3.Row):
        tenant_id = row["tenant_id"]
        job_id = row["job_id"]
        posting_url = row["posting_url"]
    else:
        tenant_id, job_id, posting_url = row
    return ResolvedJobIdentity(
        tenant_id=TenantId(str(tenant_id)),
        job_id=JobId(str(job_id)),
        posting_url=PostingUrl(value=str(posting_url)),
    )


__all__ = ["SqliteJobIdentityResolver"]
