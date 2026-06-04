"""SqliteJobRepository — local-mode adapter for the Discovery context.

Persists the ``Job`` aggregate to the existing wide ``jobs`` table (no
new table is introduced this phase per the migration plan §8 deferred
scope). The adapter touches only the discovery-owned columns of the
table:

  ``url``           — ``Job.posting_url`` (still the legacy PRIMARY KEY).
  ``title``,
  ``salary``,
  ``description``,
  ``location``      — ``Job.metadata`` value object fields.
  ``site``          — ``Job.source.board``.
  ``strategy``      — ``Job.search_strategy.value``.
  ``discovered_at`` — ``Job.discovered_at``.

Soft-delete state lives in the existing ``jobhunter_deleted_jobs``
tombstone table (mirror of the API's
``apps/api/src/write-model.ts:softDeleteJobs``); the adapter
reads/writes that table through ``ensure_deleted_jobs_table`` so a
worker-side delete and an API-side delete share the same tombstone row
shape.

The legacy ``Job.employer`` is **not** persisted here this phase: the
``jobs`` table has no dedicated employer column (the legacy code
conflates employer with ``site``). The adapter writes ``employer.name``
into ``site`` only when ``source.board`` is empty — but since the
``Source.board`` invariant is non-empty, ``site`` always carries the
board. ``employer`` round-trips on the in-memory aggregate; persisting
it natively is deferred to the table-narrowing PR called out by §8.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Any

from jobhunter.domain.discovery.aggregate import Job
from jobhunter.domain.discovery.identity import (
    AtsKind,
    CanonicalJobIdentity,
    DuplicateJobLink,
    JobSourceObservation,
    normalize_observed_url,
)
from jobhunter.domain.discovery.value_objects import (
    Employer,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId


class JobUrlConflict(ValueError):
    """Raised when ``save`` is given a posting_url owned by a different job."""

    def __init__(self, *, posting_url: PostingUrl, owner: JobId, attempted: JobId) -> None:
        self.posting_url = posting_url
        self.owner = owner
        self.attempted = attempted
        super().__init__(
            f"PostingUrl {posting_url.value!r} is already owned by job_id={owner!r}; "
            f"attempted save with job_id={attempted!r}"
        )


class SqliteJobRepository:
    """SQLite-backed implementation of ``JobRepository``.

    A single ``sqlite3.Connection`` is held for the lifetime of the
    adapter; ``save`` commits eagerly. Tests inject their own
    connection via the constructor for isolation. The adapter ensures
    the ``jobhunter_deleted_jobs`` tombstone table exists on
    construction so a fresh worker DB never trips over a missing table
    when the API hasn't run yet.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._ensure_deleted_jobs_table()

    # ------------------------------------------------------------------
    # Schema bootstrapping
    # ------------------------------------------------------------------

    def _ensure_deleted_jobs_table(self) -> None:
        """Mirror of ``apps/api/src/write-model.ts:ensureDeletedJobsTable``.

        Created on demand so the worker-side delete path matches the
        API-side delete path on row shape.
        """
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobhunter_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT,
                restored_at TEXT,
                FOREIGN KEY(job_url) REFERENCES jobs(url)
            )
            """
        )
        self._conn.commit()

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def load(self, tenant_id: TenantId, job_id: JobId) -> Job | None:
        """Return a Job by aggregate id.

        Local mode collapses ``JobId`` and ``PostingUrl`` onto the same
        ``jobs.url`` column (per migration plan §8: stable ``JobId``
        narrowing is deferred), so ``load`` and ``load_by_url`` use the
        same lookup. The cloud cutover swaps in a system-generated UUID
        column without touching the port.
        """
        return self.load_by_url(tenant_id, PostingUrl(value=str(job_id)))

    def load_by_url(self, tenant_id: TenantId, posting_url: PostingUrl) -> Job | None:
        """Resolve a posting URL to its canonical Job aggregate.

        Per the RFC §"Deduplication Boundary", ``load_by_url`` MUST keep
        resolving both the canonical ``jobs.url`` and the additional
        observation URLs during the compatibility window so existing
        callers and local databases continue to work. Resolution order:

          1. Direct match on ``jobs.url`` (the legacy primary key and
             the canonical posting URL during the migration).
          2. Match on a normalised observation URL — when a broad-board
             callsite passes the URL it scraped from Indeed/LinkedIn,
             we still want to find the canonical Job that owns it.
        """

        row = self._conn.execute(
            """
            SELECT j.url, j.title, j.salary, j.description, j.location,
                   j.site, j.strategy, j.discovered_at,
                   d.deleted_at, d.reason
            FROM jobs j
            LEFT JOIN jobhunter_deleted_jobs d
              ON d.job_url = j.url
             AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
            WHERE j.url = ?
            LIMIT 1
            """,
            (posting_url.value,),
        ).fetchone()
        if row is not None:
            return self._row_to_job(row, tenant_id)

        # Fall back to the observation index — this is the
        # compatibility seam that lets a broad-board URL resolve to
        # the canonical Job after PR 2's identity migration lands.
        normalized = normalize_observed_url(posting_url.value)
        if not normalized:
            return None
        row = self._conn.execute(
            """
            SELECT j.url, j.title, j.salary, j.description, j.location,
                   j.site, j.strategy, j.discovered_at,
                   d.deleted_at, d.reason
            FROM jobs j
            JOIN job_source_observations o
              ON o.job_url = j.url AND o.tenant_id = ?
            LEFT JOIN jobhunter_deleted_jobs d
              ON d.job_url = j.url
             AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
            WHERE o.normalized_observed_url = ?
            LIMIT 1
            """,
            (str(tenant_id), normalized),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_job(row, tenant_id)

    def list_recent(
        self,
        tenant_id: TenantId,
        *,
        limit: int = 100,
        include_deleted: bool = False,
    ) -> list[Job]:
        if not include_deleted:
            sql = (
                "SELECT j.url, j.title, j.salary, j.description, j.location, "
                "j.site, j.strategy, j.discovered_at, "
                "d.deleted_at, d.reason "
                "FROM jobs j "
                "LEFT JOIN jobhunter_deleted_jobs d "
                "  ON d.job_url = j.url "
                " AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at)) "
                "WHERE d.job_url IS NULL "
                "ORDER BY j.discovered_at DESC NULLS LAST"
            )
        else:
            sql = (
                "SELECT j.url, j.title, j.salary, j.description, j.location, "
                "j.site, j.strategy, j.discovered_at, "
                "d.deleted_at, d.reason "
                "FROM jobs j "
                "LEFT JOIN jobhunter_deleted_jobs d "
                "  ON d.job_url = j.url "
                " AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at)) "
                "ORDER BY j.discovered_at DESC NULLS LAST"
            )
        params: list[Any] = []
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [self._row_to_job(row, tenant_id) for row in rows]

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def save(self, job: Job) -> None:
        """Insert / upsert a Job into the wide ``jobs`` table.

        Enforces the §4.1 dedup invariant in two ways:

          * If the URL already exists, the row's ``job_id`` (the URL
            itself in local mode) MUST match — otherwise the call is
            illegal.
          * The upsert preserves ``discovered_at`` for already-known
            URLs so a re-discovery doesn't reset the discovery
            timestamp.
        """
        existing = self._conn.execute(
            "SELECT url, discovered_at FROM jobs WHERE url = ?",
            (job.posting_url.value,),
        ).fetchone()

        if existing is not None:
            existing_url = existing["url"] if isinstance(existing, sqlite3.Row) else existing[0]
            if existing_url != str(job.job_id):
                raise JobUrlConflict(
                    posting_url=job.posting_url,
                    owner=JobId(str(existing_url)),
                    attempted=job.job_id,
                )
            existing_discovered_at = (
                existing["discovered_at"]
                if isinstance(existing, sqlite3.Row)
                else existing[1]
            )
            preserved_discovered_at = existing_discovered_at or job.discovered_at
            self._conn.execute(
                """
                UPDATE jobs SET
                    title = ?,
                    company = COALESCE(NULLIF(company, ''), ?),
                    salary = ?,
                    description = ?,
                    location = ?,
                    site = ?,
                    strategy = ?,
                    discovered_at = ?
                WHERE url = ?
                """,
                (
                    job.metadata.title,
                    None if job.employer.is_unknown() else job.employer.name,
                    job.metadata.salary,
                    job.metadata.description,
                    job.metadata.location,
                    job.source.board,
                    job.search_strategy.value,
                    preserved_discovered_at,
                    job.posting_url.value,
                ),
            )
        else:
            self._conn.execute(
                """
                INSERT INTO jobs (
                    url, title, company, salary, description, location,
                    site, strategy, discovered_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job.posting_url.value,
                    job.metadata.title,
                    None if job.employer.is_unknown() else job.employer.name,
                    job.metadata.salary,
                    job.metadata.description,
                    job.metadata.location,
                    job.source.board,
                    job.search_strategy.value,
                    job.discovered_at,
                ),
            )
        self._sync_tombstone(job)
        self._conn.commit()

    def soft_delete(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        reason: str | None,
        deleted_at: str,
    ) -> Job | None:
        existing = self.load(tenant_id, job_id)
        if existing is None:
            return None
        deleted = existing.soft_delete(reason=reason, deleted_at=deleted_at)
        self._conn.execute(
            """
            INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at, reason, restored_at)
            VALUES (?, ?, ?, NULL)
            ON CONFLICT(job_url) DO UPDATE SET
                deleted_at = excluded.deleted_at,
                reason = excluded.reason,
                restored_at = NULL
            """,
            (str(deleted.job_id), deleted.deleted_at, deleted.delete_reason),
        )
        self._conn.commit()
        return deleted

    def restore(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        restored_at: str | None = None,
    ) -> Job | None:
        existing = self.load(tenant_id, job_id)
        if existing is None:
            return None
        restored = existing.restore()
        restore_timestamp = _restore_timestamp(restored_at, deleted_at=existing.deleted_at)
        # Mirror the API's restore semantics — set restored_at rather
        # than deleting the tombstone row so audit history is
        # preserved.
        self._conn.execute(
            "UPDATE jobhunter_deleted_jobs SET restored_at = ? "
            "WHERE job_url = ? "
            "AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))",
            (restore_timestamp, str(restored.job_id)),
        )
        self._conn.commit()
        return restored

    # ------------------------------------------------------------------
    # PR 2: canonical identity, source observations, duplicate links
    # ------------------------------------------------------------------

    def find_canonical_owner(
        self,
        tenant_id: TenantId,
        *,
        source_id: str,
        source_native_id: str,
        canonical_url: str,
    ) -> JobId | None:
        """Look up the canonical Job for an incoming posting identity.

        Resolution order matches the RFC §"Recommended identity checks":
        source-native id first, canonical URL second, normalised
        observation URL third.
        """

        if source_id and source_native_id:
            row = self._conn.execute(
                """
                SELECT job_url FROM job_source_observations
                WHERE tenant_id = ? AND source_id = ? AND source_native_id = ?
                LIMIT 1
                """,
                (str(tenant_id), source_id, source_native_id),
            ).fetchone()
            if row is not None:
                job_url = row["job_url"] if isinstance(row, sqlite3.Row) else row[0]
                if job_url:
                    return JobId(str(job_url))

        if canonical_url:
            row = self._conn.execute(
                """
                SELECT url FROM jobs
                WHERE url = ?
                LIMIT 1
                """,
                (canonical_url,),
            ).fetchone()
            if row is not None:
                job_url = row["url"] if isinstance(row, sqlite3.Row) else row[0]
                if job_url:
                    return JobId(str(job_url))

            row = self._conn.execute(
                """
                SELECT job_url FROM job_canonical_identities
                WHERE tenant_id = ? AND canonical_url = ?
                LIMIT 1
                """,
                (str(tenant_id), canonical_url),
            ).fetchone()
            if row is not None:
                job_url = row["job_url"] if isinstance(row, sqlite3.Row) else row[0]
                if job_url:
                    return JobId(str(job_url))

            normalized = normalize_observed_url(canonical_url)
            if normalized:
                row = self._conn.execute(
                    """
                    SELECT job_url FROM job_source_observations
                    WHERE tenant_id = ? AND normalized_observed_url = ?
                    LIMIT 1
                    """,
                    (str(tenant_id), normalized),
                ).fetchone()
                if row is not None:
                    job_url = (
                        row["job_url"] if isinstance(row, sqlite3.Row) else row[0]
                    )
                    if job_url:
                        return JobId(str(job_url))

        return None

    def attach_source_observation(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        observation: JobSourceObservation,
    ) -> None:
        """Persist or replace an observation row.

        Idempotent on ``(tenant_id, source_id, source_native_id)``: if
        the same source emits the same posting twice, the second write
        REPLACES the first observation rather than creating a duplicate
        row. The unique index on ``(tenant_id, normalized_observed_url)``
        also collapses cosmetic URL variants.
        """

        normalized = normalize_observed_url(observation.observed_url)
        updated = self._conn.execute(
            """
            UPDATE job_source_observations SET
                source_observation_id = ?,
                job_url = ?,
                observed_url = ?,
                normalized_observed_url = ?,
                run_id = ?,
                observed_at = ?
            WHERE tenant_id = ? AND source_id = ? AND source_native_id = ?
            """,
            (
                observation.source_observation_id,
                str(job_id),
                observation.observed_url,
                normalized,
                observation.run_id,
                observation.observed_at,
                str(tenant_id),
                observation.source_id,
                observation.source_native_id,
            ),
        )
        if updated.rowcount == 0:
            updated = self._conn.execute(
                """
                UPDATE job_source_observations SET
                    source_observation_id = ?,
                    job_url = ?,
                    source_id = ?,
                    source_native_id = ?,
                    observed_url = ?,
                    run_id = ?,
                    observed_at = ?
                WHERE tenant_id = ? AND normalized_observed_url = ?
                """,
                (
                    observation.source_observation_id,
                    str(job_id),
                    observation.source_id,
                    observation.source_native_id,
                    observation.observed_url,
                    observation.run_id,
                    observation.observed_at,
                    str(tenant_id),
                    normalized,
                ),
            )
        if updated.rowcount == 0:
            self._conn.execute(
                """
                INSERT INTO job_source_observations (
                    tenant_id, source_observation_id, job_url, source_id,
                    source_native_id, observed_url, normalized_observed_url,
                    run_id, observed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(tenant_id),
                    observation.source_observation_id,
                    str(job_id),
                    observation.source_id,
                    observation.source_native_id,
                    observation.observed_url,
                    normalized,
                    observation.run_id,
                    observation.observed_at,
                ),
            )
        self._conn.commit()

    def set_canonical_identity(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        identity: CanonicalJobIdentity,
    ) -> None:
        """Persist (or replace) the canonical identity decision for a Job."""

        self._conn.execute(
            """
            INSERT INTO job_canonical_identities (
                tenant_id, job_url, canonical_url, ats_kind,
                source_native_id, confidence, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, job_url) DO UPDATE SET
                canonical_url = excluded.canonical_url,
                ats_kind = excluded.ats_kind,
                source_native_id = excluded.source_native_id,
                confidence = excluded.confidence,
                resolved_at = excluded.resolved_at
            """,
            (
                str(tenant_id),
                str(job_id),
                identity.canonical_url,
                identity.ats_kind.value,
                identity.source_native_id,
                float(identity.confidence),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        self._conn.commit()

    def record_duplicate_link(
        self,
        tenant_id: TenantId,
        link: DuplicateJobLink,
    ) -> None:
        """Persist a confirmed duplicate-link audit record."""

        self._conn.execute(
            """
            INSERT INTO job_duplicate_links (
                tenant_id, duplicate_link_id, surviving_job_id,
                superseded_job_or_observation_id, reason, confidence,
                linked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, duplicate_link_id) DO UPDATE SET
                surviving_job_id = excluded.surviving_job_id,
                superseded_job_or_observation_id =
                    excluded.superseded_job_or_observation_id,
                reason = excluded.reason,
                confidence = excluded.confidence,
                linked_at = excluded.linked_at
            """,
            (
                str(tenant_id),
                link.duplicate_link_id,
                link.surviving_job_id,
                link.superseded_job_or_observation_id,
                link.reason,
                float(link.confidence),
                link.linked_at,
            ),
        )
        self._conn.commit()

    def list_observations(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> list[JobSourceObservation]:
        """Read-side helper used by tests and the future Operations projection."""

        rows = self._conn.execute(
            """
            SELECT source_observation_id, source_id, source_native_id,
                   observed_url, run_id, observed_at
            FROM job_source_observations
            WHERE tenant_id = ? AND job_url = ?
            ORDER BY observed_at ASC
            """,
            (str(tenant_id), str(job_id)),
        ).fetchall()
        return [
            JobSourceObservation(
                source_observation_id=str(row["source_observation_id"]),
                source_id=str(row["source_id"]),
                source_native_id=str(row["source_native_id"]),
                observed_url=str(row["observed_url"]),
                run_id=str(row["run_id"]),
                observed_at=str(row["observed_at"]),
            )
            for row in rows
        ]

    def load_canonical_identity(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> CanonicalJobIdentity | None:
        """Read-side helper used by tests and the future Operations projection."""

        row = self._conn.execute(
            """
            SELECT canonical_url, ats_kind, source_native_id, confidence
            FROM job_canonical_identities
            WHERE tenant_id = ? AND job_url = ?
            LIMIT 1
            """,
            (str(tenant_id), str(job_id)),
        ).fetchone()
        if row is None:
            return None
        return CanonicalJobIdentity(
            canonical_url=str(row["canonical_url"]),
            ats_kind=AtsKind.from_optional(row["ats_kind"]),
            source_native_id=str(row["source_native_id"]),
            confidence=float(row["confidence"]),
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _sync_tombstone(self, job: Job) -> None:
        """Reflect the aggregate's ``deleted_at`` field in the tombstone table.

        Called from ``save``. If the aggregate carries a deleted_at,
        upsert the tombstone; otherwise clear any active tombstone for
        the URL. This keeps the two sources of truth consistent on
        every save.
        """
        if job.deleted_at is not None:
            self._conn.execute(
                """
                INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at, reason, restored_at)
                VALUES (?, ?, ?, NULL)
                ON CONFLICT(job_url) DO UPDATE SET
                    deleted_at = excluded.deleted_at,
                    reason = excluded.reason,
                    restored_at = NULL
                """,
                (str(job.job_id), job.deleted_at, job.delete_reason),
            )
        else:
            # Keep legacy active-save behaviour, but timestamp-aware
            # readers only treat this as restored when the active row
            # is newer than the tombstone.
            self._conn.execute(
                "UPDATE jobhunter_deleted_jobs SET restored_at = ? "
                "WHERE job_url = ? "
                "AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))",
                (job.discovered_at, str(job.job_id)),
            )

    @staticmethod
    def _row_to_job(row: Any, tenant_id: TenantId | None = None) -> Job:
        if isinstance(row, sqlite3.Row):
            url = row["url"]
            title = row["title"]
            salary = row["salary"]
            description = row["description"]
            location = row["location"]
            site = row["site"]
            strategy_raw = row["strategy"]
            discovered_at = row["discovered_at"]
            deleted_at = row["deleted_at"] if "deleted_at" in row.keys() else None
            delete_reason = row["reason"] if "reason" in row.keys() else None
        else:
            (
                url,
                title,
                salary,
                description,
                location,
                site,
                strategy_raw,
                discovered_at,
                deleted_at,
                delete_reason,
            ) = row

        strategy = SearchStrategy.from_optional(strategy_raw) or SearchStrategy.MANUAL
        # ``site`` is the canonical board name in the legacy schema.
        # When it's empty (legacy rows that pre-date the column) we
        # fall back to the sentinel "unknown" so the value object
        # invariant holds.
        board = (site or "unknown").strip() or "unknown"
        return Job(
            tenant_id=tenant_id or LOCAL_TENANT,
            job_id=JobId(str(url)),
            posting_url=PostingUrl(value=str(url)),
            source=Source(board=board),
            employer=Employer.unknown(),
            search_strategy=strategy,
            metadata=JobMetadata(
                title=str(title or ""),
                salary=str(salary or ""),
                description=str(description or ""),
                location=str(location or ""),
            ),
            discovered_at=str(discovered_at or ""),
            deleted_at=(str(deleted_at) if deleted_at else None),
            delete_reason=(str(delete_reason) if delete_reason else None),
        )


def _restore_timestamp(restored_at: str | None, *, deleted_at: str | None) -> str:
    candidate = str(restored_at or "").strip() or datetime.now(timezone.utc).isoformat()
    if deleted_at and _timestamp_lte(candidate, str(deleted_at)):
        return datetime.now(timezone.utc).isoformat()
    return candidate


def _timestamp_lte(left: str, right: str) -> bool:
    try:
        return _parse_iso(left) <= _parse_iso(right)
    except ValueError:
        return False


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
