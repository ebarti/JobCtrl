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

Soft-delete state lives in the existing ``jobctrl_deleted_jobs``
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

from jobctrl.domain.discovery.aggregate import Job
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.search_units import DiscoverySearchUnitLease
from jobctrl.domain.discovery.identity import (
    AtsKind,
    CanonicalJobIdentity,
    DuplicateJobLink,
    JobSourceObservation,
    normalize_observed_url,
)
from jobctrl.domain.discovery.value_objects import (
    Employer,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.job_content_identity import (
    content_match_basis,
    is_genuine_employer_identity,
    job_content_fingerprint,
    normalize_identity_text,
)
from jobctrl.domain.ports.discovery import ContentOwnerMatch
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId


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
    the ``jobctrl_deleted_jobs`` tombstone table exists on
    construction so a fresh worker DB never trips over a missing table
    when the API hasn't run yet.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        discovery_execution: DiscoveryExecutionRef | None = None,
        source_family: str | None = None,
        search_unit_lease: DiscoverySearchUnitLease | None = None,
    ) -> None:
        if search_unit_lease is not None:
            if discovery_execution is None:
                discovery_execution = search_unit_lease.execution
            elif discovery_execution != search_unit_lease.execution:
                raise ValueError("search-unit lease does not match discovery execution")
        self._conn = conn
        self._discovery_execution = discovery_execution
        self._source_family = source_family.strip() if source_family else None
        self._search_unit_lease = search_unit_lease
        if discovery_execution is not None and self._source_family is None:
            raise ValueError("source_family is required with discovery_execution")
        self._ensure_deleted_jobs_table()
        if discovery_execution is not None:
            # Imported lazily to keep the aggregate repository's ordinary path
            # independent from the execution-lineage adapter.
            from jobctrl.infrastructure.discovery.sqlite_execution_repository import (
                SqliteDiscoveryExecutionRepository,
            )

            self._execution_repository = SqliteDiscoveryExecutionRepository(conn)
        else:
            self._execution_repository = None
        if search_unit_lease is not None:
            from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import (
                SqliteDiscoverySearchUnitRepository,
            )

            self._search_unit_repository = SqliteDiscoverySearchUnitRepository(conn)
        else:
            self._search_unit_repository = None

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
            CREATE TABLE IF NOT EXISTS jobctrl_deleted_jobs (
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
            LEFT JOIN jobctrl_deleted_jobs d
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
            LEFT JOIN jobctrl_deleted_jobs d
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
                "LEFT JOIN jobctrl_deleted_jobs d "
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
                "LEFT JOIN jobctrl_deleted_jobs d "
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

    def _fence_search_unit_write(self) -> None:
        if self._search_unit_repository is None:
            return
        assert self._search_unit_lease is not None
        self._search_unit_repository.fence_write(self._search_unit_lease)

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
        was_new = existing is None
        self._fence_search_unit_write()

        if existing is not None:
            existing_url = existing["url"] if isinstance(existing, sqlite3.Row) else existing[0]
            if existing_url != str(job.job_id):
                raise JobUrlConflict(
                    posting_url=job.posting_url,
                    owner=JobId(str(existing_url)),
                    attempted=job.job_id,
                )
            existing_discovered_at = existing["discovered_at"] if isinstance(existing, sqlite3.Row) else existing[1]
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
        if self._search_unit_repository is not None:
            assert self._search_unit_lease is not None
            self._search_unit_repository.record_accepted_job(
                self._search_unit_lease,
                job.posting_url.value,
                was_new=was_new,
                accepted_at=job.discovered_at,
            )
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
        self._fence_search_unit_write()
        deleted = existing.soft_delete(reason=reason, deleted_at=deleted_at)
        self._conn.execute(
            """
            INSERT INTO jobctrl_deleted_jobs (job_url, deleted_at, reason, restored_at)
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
        self._fence_search_unit_write()
        restored = existing.restore()
        restore_timestamp = _restore_timestamp(restored_at, deleted_at=existing.deleted_at)
        # Mirror the API's restore semantics — set restored_at rather
        # than deleting the tombstone row so audit history is
        # preserved.
        self._conn.execute(
            "UPDATE jobctrl_deleted_jobs SET restored_at = ? "
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
                    job_url = row["job_url"] if isinstance(row, sqlite3.Row) else row[0]
                    if job_url:
                        return JobId(str(job_url))

        return None

    def find_content_owner(
        self,
        tenant_id: TenantId,
        *,
        title: str,
        company: str,
        description: str,
    ) -> ContentOwnerMatch | None:
        """Resolve an existing Job by content identity after native-id / URL miss.

        Mirrors the JobSpy content-dedup strictness: candidates are gated on an
        exact (normalized) title + employer match, then confirmed by the shared
        ``job_content_fingerprint`` or a substantial-description shingle match.
        The returned :class:`ContentOwnerMatch` records which of the two paths
        matched so the write boundary logs an honest duplicate-link reason.

        Content merges MUST key on a genuine employer on BOTH sides, otherwise
        two DISTINCT employers' postings would collapse into one Job (silent
        data loss). ``jobs.company`` is empty for use-case-created rows, so the
        stored employer coalesces to ``jobs.site`` (the board, which is the real
        employer for ATS-owned rows) — but a platform/sentinel board
        ("User-mediated capture", the "Workday" fallback, a JobSpy board, or the
        ``Unknown`` sentinel) is shared across employers and must not be treated
        as an employer key. When either side lacks a genuine employer this falls
        through to ``None`` (a safe under-merge). Returns ``None`` when the
        posting cannot be fingerprinted or no existing Job matches.

        The incoming posting is a raw LISTING, so the match compares it against
        BOTH the stored listing (``jobs.description``) and the stored enriched
        full text like-for-like. Comparing only against the enriched text drops a
        listing below the shingle threshold once the owner is enriched, silently
        turning off cross-source dedup post-enrichment.
        """

        if not is_genuine_employer_identity(company):
            return None
        incoming_key = job_content_fingerprint(
            title=title,
            company=company,
            description=description,
        )
        if incoming_key is None:
            return None
        self._conn.create_function("jh_normalize_identity", 1, normalize_identity_text, deterministic=True)
        rows = self._conn.execute(
            """
            SELECT j.url, j.title, j.company, j.site,
                   j.description AS listing_description,
                   COALESCE(je.full_description, j.full_description)
                       AS enriched_description,
                   CASE WHEN d.job_url IS NULL THEN 0 ELSE 1 END AS is_deleted
            FROM jobs j
            LEFT JOIN job_enrichments je ON je.job_url = j.url
            LEFT JOIN jobctrl_deleted_jobs d
              ON d.job_url = j.url
             AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
            WHERE jh_normalize_identity(COALESCE(j.title, '')) = ?
              AND jh_normalize_identity(COALESCE(NULLIF(j.company, ''), j.site, '')) = ?
            ORDER BY is_deleted ASC, j.discovered_at ASC NULLS LAST, j.url ASC
            """,
            (normalize_identity_text(title), normalize_identity_text(company)),
        ).fetchall()
        for existing in rows:
            stored_company = existing["company"]
            stored_employer = stored_company if stored_company else existing["site"]
            if not is_genuine_employer_identity(stored_employer):
                continue
            basis = content_match_basis(
                incoming_key=incoming_key,
                incoming_description=description,
                candidate_title=existing["title"],
                candidate_employer=stored_employer,
                candidate_descriptions=(
                    existing["listing_description"],
                    existing["enriched_description"],
                ),
            )
            if basis is not None:
                return ContentOwnerMatch(job_id=JobId(str(existing["url"])), basis=basis)
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

        self._fence_search_unit_write()
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
        if self._search_unit_repository is not None:
            assert self._search_unit_lease is not None
            self._search_unit_repository.record_accepted_job(
                self._search_unit_lease,
                str(job_id),
                was_new=False,
                accepted_at=observation.observed_at,
            )
        if self._execution_repository is not None:
            assert self._discovery_execution is not None
            if str(tenant_id) != self._discovery_execution.tenant_id:
                raise ValueError("source observation tenant does not match discovery execution")
            self._fence_search_unit_write()
            # The Temporal execution ref is the authority. ``observation.run_id``
            # is retained only as first-observation source metadata and may be
            # updated independently in ``job_source_observations`` on retries.
            self._execution_repository.link_job(
                self._discovery_execution,
                str(job_id),
                cohort_kind="observed_this_run",
                source_family=self._source_family,
                source_run_id=observation.run_id,
                linked_at=observation.observed_at,
            )
        self._conn.commit()

    def set_canonical_identity(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        identity: CanonicalJobIdentity,
    ) -> None:
        """Persist (or replace) the canonical identity decision for a Job."""

        self._fence_search_unit_write()
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

        self._fence_search_unit_write()
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

    def record_rejected_duplicate_link(
        self,
        tenant_id: TenantId,
        *,
        owner_job_id: JobId,
        candidate_url: str,
        reason: str,
        rejected_at: str,
    ) -> bool:
        """Record a rejected duplicate link idempotently per (owner, candidate).

        Returns ``True`` when this (owner job, candidate URL) rejection is
        recorded for the first time and ``False`` when an identical rejected link
        already exists, so the caller can skip re-publishing the audit event.
        Without this, every re-ingest of a persistently-rejected duplicate would
        mint a fresh event row (audit noise).
        """

        self._fence_search_unit_write()
        before = self._conn.total_changes
        self._conn.execute(
            """
            INSERT INTO job_rejected_duplicate_links (
                tenant_id, owner_job_url, candidate_url, reason, rejected_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, owner_job_url, candidate_url) DO NOTHING
            """,
            (str(tenant_id), str(owner_job_id), str(candidate_url), reason, rejected_at),
        )
        self._conn.commit()
        return self._conn.total_changes > before

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
                INSERT INTO jobctrl_deleted_jobs (job_url, deleted_at, reason, restored_at)
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
                "UPDATE jobctrl_deleted_jobs SET restored_at = ? "
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
