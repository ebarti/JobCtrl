"""Stable Job identity resolution for SQLite compensation adapters."""

from __future__ import annotations

import sqlite3

from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.ports.discovery import ResolvedJobIdentity
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.sqlite_identity_resolver import (
    SqliteJobIdentityResolver,
)


class SqliteCompensationJobReference:
    """Resolve URL-shaped compatibility input to one physical table key."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        table_name: str,
    ) -> None:
        self._conn = conn
        self._table_name = table_name
        self.column = (
            "job_id"
            if "job_id"
            in {
                str(row[1])
                for row in conn.execute(
                    f'PRAGMA table_info("{table_name}")'
                ).fetchall()
            }
            else "job_url"
        )
        self._identity_resolver = SqliteJobIdentityResolver(conn)

    def _identity(
        self,
        tenant_id: str,
        raw_reference: str,
    ) -> ResolvedJobIdentity | None:
        tenant = TenantId(str(tenant_id))
        reference = str(raw_reference or "").strip()
        if not reference:
            raise ValueError("job reference must be non-empty")
        identity = self._identity_resolver.resolve_by_posting_url(
            tenant,
            PostingUrl(reference),
        )
        if identity is not None:
            return identity
        direct = self._conn.execute(
            """
            SELECT job_id
            FROM jobs
            WHERE tenant_id = ? AND url = ?
            LIMIT 1
            """,
            (str(tenant), reference),
        ).fetchone()
        if direct is not None and str(direct[0] or "").strip():
            identity = self._identity_resolver.resolve_by_job_id(
                tenant,
                JobId(str(direct[0])),
            )
            if identity is not None:
                return identity
        try:
            stable_candidate = canonical_job_id(reference)
        except ValueError:
            return None
        return self._identity_resolver.resolve_by_job_id(
            tenant,
            stable_candidate,
        )

    def for_read(
        self,
        tenant_id: str,
        raw_reference: str,
    ) -> str | None:
        identity = self._identity(tenant_id, raw_reference)
        if identity is None:
            return None
        if self.column == "job_id":
            return str(identity.job_id)
        exact = self._conn.execute(
            f"""
            SELECT 1
            FROM "{self._table_name}"
            WHERE tenant_id = ? AND job_url = ?
            LIMIT 1
            """,
            (str(tenant_id), str(raw_reference)),
        ).fetchone()
        return (
            str(raw_reference)
            if exact is not None
            else identity.storage_url.value
        )

    def for_write(
        self,
        tenant_id: str,
        raw_reference: str,
    ) -> str:
        identity = self._identity(tenant_id, raw_reference)
        if identity is None:
            raise ValueError(
                "no stable Job identity for compensation reference: "
                f"{raw_reference}"
            )
        return (
            str(identity.job_id)
            if self.column == "job_id"
            else identity.storage_url.value
        )

    def storage_url(
        self,
        tenant_id: str,
        raw_reference: str,
    ) -> str:
        """Return the canonical URL required by legacy event foreign keys."""
        identity = self._identity(tenant_id, raw_reference)
        if identity is None:
            raise ValueError(
                "no stable Job identity for compensation reference: "
                f"{raw_reference}"
            )
        return identity.storage_url.value


__all__ = ["SqliteCompensationJobReference"]
