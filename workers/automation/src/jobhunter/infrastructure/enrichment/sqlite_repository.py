"""SqliteEnrichmentRepository — local-mode adapter for the Enrichment context.

Persists ``JobEnrichment`` aggregates to the ``job_enrichments`` table
created by ``database.ensure_enrichment_tables``. The aggregate identity
is ``(tenant_id, job_id)`` and the table primary key is ``job_url``;
local mode collapses ``JobId`` onto the legacy ``jobs.url`` per the
migration plan §8 (deferred narrowing).

The repository is an upsert on every save — versioning is per-attempt
inside the aggregate's ``attempts_json`` blob, not per-row.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobhunter.domain.enrichment.aggregate import (
    EnrichmentLifecycle,
    JobEnrichment,
)
from jobhunter.domain.enrichment.entities import EnrichmentAttempt
from jobhunter.domain.enrichment.value_objects import (
    ApplicationUrl,
    ExtractionTier,
    FullDescription,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId


class SqliteEnrichmentRepository:
    """SQLite-backed implementation of ``EnrichmentRepository``.

    A single ``sqlite3.Connection`` is held for the lifetime of the
    adapter; ``save`` commits eagerly so consumers see the row
    immediately. Tests inject their own connection via the constructor
    for isolation.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def load(self, tenant_id: TenantId, job_id: JobId) -> JobEnrichment | None:
        row = self._conn.execute(
            """
            SELECT job_url, tenant_id, current_status, full_description,
                   application_url, enriched_at, extraction_tier,
                   attempts_json, updated_at
            FROM job_enrichments
            WHERE job_url = ? AND tenant_id = ?
            LIMIT 1
            """,
            (str(job_id), str(tenant_id)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_enrichment(row, tenant_id)

    def list_pending(self, tenant_id: TenantId, *, limit: int = 0) -> list[JobId]:
        """Return job_ids whose enrichment is `pending`.

        A job is pending when:

          * the discovery row exists in ``jobs``,
          * AND either there is no ``job_enrichments`` row, or the
            row's ``current_status`` is ``pending``.

        We deliberately exclude rows whose status is ``running`` (in
        flight) or ``failed`` (the orchestrator has the failed list to
        decide whether to retry).
        """
        params: list[Any] = [str(tenant_id)]
        sql = (
            "SELECT j.url FROM jobs j "
            "LEFT JOIN job_enrichments e "
            "  ON e.job_url = j.url AND e.tenant_id = ? "
            "WHERE e.job_url IS NULL OR e.current_status = 'pending' "
            "ORDER BY j.discovered_at DESC NULLS LAST"
        )
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [JobId(row[0]) for row in rows if row[0]]

    def list_failed(self, tenant_id: TenantId, *, limit: int = 0) -> list[JobEnrichment]:
        params: list[Any] = [str(tenant_id)]
        sql = (
            "SELECT job_url, tenant_id, current_status, full_description, "
            "application_url, enriched_at, extraction_tier, attempts_json, "
            "updated_at "
            "FROM job_enrichments "
            "WHERE tenant_id = ? AND current_status = 'failed' "
            "ORDER BY updated_at DESC"
        )
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [self._row_to_enrichment(row, tenant_id) for row in rows]

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def save(self, enrichment: JobEnrichment) -> None:
        attempts_json = json.dumps(
            [a.to_dict() for a in enrichment.attempts],
            sort_keys=True,
        )
        self._conn.execute(
            """
            INSERT INTO job_enrichments (
                job_url, tenant_id, current_status, full_description,
                application_url, enriched_at, extraction_tier,
                attempts_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_url) DO UPDATE SET
                tenant_id = excluded.tenant_id,
                current_status = excluded.current_status,
                full_description = excluded.full_description,
                application_url = excluded.application_url,
                enriched_at = excluded.enriched_at,
                extraction_tier = excluded.extraction_tier,
                attempts_json = excluded.attempts_json,
                updated_at = excluded.updated_at
            """,
            (
                str(enrichment.job_id),
                str(enrichment.tenant_id),
                enrichment.current_status,
                (
                    enrichment.full_description.text
                    if enrichment.full_description
                    else None
                ),
                (
                    enrichment.application_url.value
                    if enrichment.application_url
                    else None
                ),
                enrichment.enriched_at,
                (
                    enrichment.extraction_tier.value
                    if enrichment.extraction_tier
                    else None
                ),
                attempts_json,
                enrichment.updated_at,
            ),
        )
        self._conn.commit()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_enrichment(row: Any, tenant_id: TenantId | None = None) -> JobEnrichment:
        if isinstance(row, sqlite3.Row):
            job_url = row["job_url"]
            current_status = row["current_status"]
            full_description = row["full_description"]
            application_url = row["application_url"]
            enriched_at = row["enriched_at"]
            extraction_tier = row["extraction_tier"]
            attempts_json = row["attempts_json"]
            updated_at = row["updated_at"]
        else:
            (
                job_url,
                _tenant,
                current_status,
                full_description,
                application_url,
                enriched_at,
                extraction_tier,
                attempts_json,
                updated_at,
            ) = row

        attempts_data = json.loads(attempts_json) if attempts_json else []
        attempts = tuple(EnrichmentAttempt.from_dict(d) for d in attempts_data)

        # Defensively coerce the lifecycle string — invalid values would
        # break the aggregate's __post_init__ and we want the load path
        # to surface that as a clear error rather than a silent rewrite.
        return JobEnrichment(
            tenant_id=tenant_id or LOCAL_TENANT,
            job_id=JobId(str(job_url)),
            current_status=str(current_status or EnrichmentLifecycle.PENDING),
            attempts=attempts,
            full_description=(
                FullDescription(text=str(full_description)) if full_description else None
            ),
            application_url=(
                ApplicationUrl(value=str(application_url)) if application_url else None
            ),
            enriched_at=(str(enriched_at) if enriched_at else None),
            extraction_tier=ExtractionTier.from_optional(extraction_tier),
            updated_at=str(updated_at or ""),
        )
