"""SQLite read adapter for per-job preparation targets."""

from __future__ import annotations

import sqlite3
from typing import Any

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import TenantId


class SqlitePreparationTargetReader:
    """Load one active preparation target by tenant-scoped canonical JobId."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> dict[str, Any] | None:
        stable_job_id = canonical_job_id(str(job_id))
        cursor = self._conn.execute(
            """
            SELECT
                j.tenant_id,
                j.job_id,
                j.url,
                j.title,
                j.company,
                j.salary,
                j.description,
                j.location,
                j.site,
                j.strategy,
                j.discovered_at,
                je.current_status AS enrichment_status,
                je.full_description,
                je.application_url,
                je.enriched_at AS detail_scraped_at,
                je.extraction_tier
            FROM jobs j
            LEFT JOIN job_enrichments je
              ON je.tenant_id = j.tenant_id
             AND je.job_id = j.job_id
            LEFT JOIN jobctrl_deleted_jobs deleted
              ON deleted.tenant_id = j.tenant_id
             AND deleted.job_id = j.job_id
             AND (
                 deleted.restored_at IS NULL
                 OR julianday(deleted.restored_at) <= julianday(deleted.deleted_at)
             )
            WHERE j.tenant_id = ?
              AND j.job_id = ?
              AND deleted.job_id IS NULL
            LIMIT 1
            """,
            (str(tenant_id), str(stable_job_id)),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        column_names = tuple(description[0] for description in cursor.description or ())
        return dict(zip(column_names, row, strict=True))


__all__ = [
    "SqlitePreparationTargetReader",
]
