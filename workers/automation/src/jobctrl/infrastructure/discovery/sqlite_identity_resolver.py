"""SQLite adapter for stable Job identity resolution."""

from __future__ import annotations

import sqlite3
from typing import Any

from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.ports.discovery import ResolvedJobIdentity
from jobctrl.domain.tenant import TenantId


_CURRENT_POSTING_URL_SQL = """
COALESCE(
    (
        SELECT storage_alias.alias_value
        FROM job_identity_aliases storage_alias
        WHERE storage_alias.tenant_id = j.tenant_id
          AND storage_alias.alias_kind = 'posting_url'
          AND storage_alias.job_id = j.job_id
          AND storage_alias.alias_value = j.url
          AND storage_alias.retired_at IS NULL
        LIMIT 1
    ),
    (
        SELECT current_alias.alias_value
        FROM job_identity_aliases current_alias
        WHERE current_alias.tenant_id = j.tenant_id
          AND current_alias.alias_kind = 'posting_url'
          AND current_alias.job_id = j.job_id
          AND current_alias.retired_at IS NULL
        ORDER BY
            current_alias.created_at DESC,
            current_alias.alias_value ASC
        LIMIT 1
    ),
    j.url
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
                {_CURRENT_POSTING_URL_SQL} AS posting_url,
                j.url AS storage_url
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
                {_CURRENT_POSTING_URL_SQL} AS posting_url,
                j.url AS storage_url
            FROM job_identity_aliases a
            JOIN jobs j
              ON j.tenant_id = a.tenant_id
             AND j.job_id = a.job_id
            WHERE a.tenant_id = ?
              AND a.alias_kind = 'posting_url'
              AND a.alias_value = ?
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
        storage_url = row["storage_url"]
    else:
        tenant_id, job_id, posting_url, storage_url = row
    return ResolvedJobIdentity(
        tenant_id=TenantId(str(tenant_id)),
        job_id=JobId(str(job_id)),
        posting_url=PostingUrl(value=str(posting_url)),
        storage_url=PostingUrl(value=str(storage_url)),
    )


__all__ = ["SqliteJobIdentityResolver"]
