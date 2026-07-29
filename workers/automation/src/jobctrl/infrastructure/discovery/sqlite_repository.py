"""SqliteJobRepository — local-mode adapter for the Discovery context.

Persists the ``Job`` aggregate to the existing wide ``jobs`` table (no
new table is introduced this phase per the migration plan §8 deferred
scope). The adapter touches only the discovery-owned columns of the
table:

  ``tenant_id``     — tenant boundary for the aggregate.
  ``job_id``        — stable, system-generated aggregate identifier.
  ``url``           — legacy storage key (still the physical PRIMARY KEY).
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
from jobctrl.domain.identifiers import (
    JobId,
    canonical_job_id,
    generate_job_id,
)
from jobctrl.domain.job_content_identity import (
    content_match_basis,
    is_genuine_employer_identity,
    job_content_fingerprint,
    normalize_identity_text,
)
from jobctrl.domain.ports.discovery import (
    ContentOwnerMatch,
    JobIdentityResolver,
    ResolvedJobIdentity,
)
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.sqlite_identity_resolver import (
    SqliteJobIdentityResolver,
)


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
        identity_resolver: JobIdentityResolver | None = None,
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
        self._identity_resolver = identity_resolver or SqliteJobIdentityResolver(conn)
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

    def resolve_by_job_id(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> ResolvedJobIdentity | None:
        return self._identity_resolver.resolve_by_job_id(tenant_id, job_id)

    def resolve_by_posting_url(
        self,
        tenant_id: TenantId,
        posting_url: PostingUrl,
    ) -> ResolvedJobIdentity | None:
        return self._identity_resolver.resolve_by_posting_url(
            tenant_id,
            posting_url,
        )

    def load(self, tenant_id: TenantId, job_id: JobId) -> Job | None:
        """Return a Job by stable id.

        URL-shaped ``JobId`` values remain accepted only at this repository
        boundary while legacy callers are migrated. They are resolved through
        the alias index and the hydrated aggregate always carries its UUID.
        """
        identity = self.resolve_by_job_id(tenant_id, job_id)
        if identity is not None:
            return self._load_resolved(identity)
        return self.load_by_url(
            tenant_id,
            PostingUrl(value=str(job_id)),
        )

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

        identity = self.resolve_by_posting_url(tenant_id, posting_url)
        if identity is not None:
            return self._load_resolved(identity)

        # Fall back to the observation index — this is the
        # compatibility seam that lets a broad-board URL resolve to
        # the canonical Job after PR 2's identity migration lands.
        normalized = normalize_observed_url(posting_url.value)
        if not normalized:
            return None
        row = self._conn.execute(
            """
            SELECT j.job_id
            FROM jobs j
            JOIN job_source_observations o
              ON o.job_id = j.job_id AND o.tenant_id = ?
            WHERE j.tenant_id = ?
              AND o.normalized_observed_url = ?
            LIMIT 1
            """,
            (str(tenant_id), str(tenant_id), normalized),
        ).fetchone()
        if row is None:
            return None
        resolved_job_id = JobId(str(row["job_id"])) if isinstance(row, sqlite3.Row) else JobId(str(row[0]))
        identity = self.resolve_by_job_id(tenant_id, resolved_job_id)
        if identity is None:
            return None
        return self._load_resolved(identity)

    def list_recent(
        self,
        tenant_id: TenantId,
        *,
        limit: int = 100,
        include_deleted: bool = False,
    ) -> list[Job]:
        if not include_deleted:
            sql = (
                "SELECT j.tenant_id, j.job_id, j.url, "
                "j.title, j.salary, j.description, j.location, "
                "j.site, j.strategy, j.discovered_at, "
                "d.deleted_at, d.reason "
                "FROM jobs j "
                "LEFT JOIN jobctrl_deleted_jobs d "
                "  ON d.job_url = j.url "
                " AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at)) "
                "WHERE j.tenant_id = ? AND d.job_url IS NULL "
                "ORDER BY j.discovered_at DESC NULLS LAST"
            )
        else:
            sql = (
                "SELECT j.tenant_id, j.job_id, j.url, "
                "j.title, j.salary, j.description, j.location, "
                "j.site, j.strategy, j.discovered_at, "
                "d.deleted_at, d.reason "
                "FROM jobs j "
                "LEFT JOIN jobctrl_deleted_jobs d "
                "  ON d.job_url = j.url "
                " AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at)) "
                "WHERE j.tenant_id = ? "
                "ORDER BY j.discovered_at DESC NULLS LAST"
            )
        params: list[Any] = [str(tenant_id)]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        jobs: list[Job] = []
        for row in rows:
            row_job_id = JobId(str(row["job_id"])) if isinstance(row, sqlite3.Row) else JobId(str(row[1]))
            identity = self.resolve_by_job_id(tenant_id, row_job_id)
            if identity is None:
                continue
            jobs.append(
                self._row_to_job(
                    row,
                    posting_url=identity.posting_url,
                )
            )
        return jobs

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def _fence_search_unit_write(self) -> None:
        if self._search_unit_repository is None:
            return
        assert self._search_unit_lease is not None
        self._search_unit_repository.fence_write(self._search_unit_lease)

    def save(self, job: Job) -> JobId:
        """Persist ``job`` and leave no partial compatibility write on failure."""

        try:
            return self._save(job)
        except BaseException:
            self._conn.rollback()
            raise

    def _save(self, job: Job) -> JobId:
        """Atomically insert or upsert a Job and return its stable owner id.

        ``jobs.url`` remains the compatibility-era storage key for URL-keyed
        child tables. A stable-id upsert may change the aggregate's current
        ``posting_url`` by moving the active alias without rewriting that
        physical key. URL-shaped ids are accepted only as lookup input and
        cannot promote a historical alias back to current.

        If another writer wins a first insert for the same posting URL after
        this call's initial read, the unique constraints arbitrate ownership.
        The losing call returns the winner's stable id instead of leaking a raw
        ``sqlite3.IntegrityError``.
        """
        is_legacy_url_input = str(job.job_id) == job.posting_url.value
        supplied_job_id: JobId | None
        try:
            supplied_job_id = canonical_job_id(str(job.job_id))
        except ValueError:
            if not is_legacy_url_input:
                raise ValueError(
                    "New Job.job_id must be a canonical UUID; "
                    "URL-shaped ids are accepted only when equal to posting_url"
                )
            supplied_job_id = None

        stable_owner = self.resolve_by_job_id(job.tenant_id, supplied_job_id) if supplied_job_id is not None else None
        url_owner = self.resolve_by_posting_url(
            job.tenant_id,
            job.posting_url,
        )
        # Identity discovery is read-only. Fence immediately before the first
        # possible mutation so parallel search units can both reach the atomic
        # URL claim and the unique constraint can select one stable owner.
        self._fence_search_unit_write()

        if stable_owner is not None:
            if url_owner is not None and url_owner.job_id != stable_owner.job_id:
                raise JobUrlConflict(
                    posting_url=job.posting_url,
                    owner=url_owner.job_id,
                    attempted=stable_owner.job_id,
                )
            persisted_identity = self._set_current_posting_url(
                stable_owner,
                job.posting_url,
            )
            self._update_existing_job(job, persisted_identity)
            was_new = False
        elif url_owner is not None:
            if supplied_job_id is not None and supplied_job_id != url_owner.job_id:
                raise JobUrlConflict(
                    posting_url=job.posting_url,
                    owner=url_owner.job_id,
                    attempted=supplied_job_id,
                )
            # A URL-shaped compatibility save resolves the owner but never
            # changes which alias is the current external locator.
            persisted_identity = url_owner
            self._update_existing_job(job, persisted_identity)
            was_new = False
        else:
            candidate_job_id = supplied_job_id or generate_job_id()
            persisted_identity, was_new = self._insert_or_resolve_winner(
                job,
                candidate_job_id,
            )
            if not was_new:
                # No candidate state belongs on a concurrently-created owner.
                # The application use case re-enters its existing-owner flow.
                self._conn.commit()
                return persisted_identity.job_id

        self._sync_tombstone(job, persisted_identity)
        if self._search_unit_repository is not None:
            assert self._search_unit_lease is not None
            self._search_unit_repository.record_accepted_job(
                self._search_unit_lease,
                persisted_identity.storage_url.value,
                was_new=was_new,
                accepted_at=job.discovered_at,
            )
        self._conn.commit()
        return persisted_identity.job_id

    def _set_current_posting_url(
        self,
        identity: ResolvedJobIdentity,
        posting_url: PostingUrl,
    ) -> ResolvedJobIdentity:
        """Move the current locator while preserving the legacy storage key."""

        if posting_url == identity.posting_url:
            return identity
        changed_at = datetime.now(timezone.utc).isoformat()
        claimed = self._conn.execute(
            """
            INSERT INTO job_identity_aliases (
                tenant_id, alias_kind, alias_value, job_id, created_at, retired_at
            ) VALUES (?, 'posting_url', ?, ?, ?, NULL)
            ON CONFLICT (tenant_id, alias_kind, alias_value) DO UPDATE SET
                retired_at = NULL
            WHERE job_identity_aliases.job_id = excluded.job_id
            """,
            (
                str(identity.tenant_id),
                posting_url.value,
                str(identity.job_id),
                changed_at,
            ),
        )
        if claimed.rowcount != 1:
            owner = self.resolve_by_posting_url(identity.tenant_id, posting_url)
            if owner is not None:
                raise JobUrlConflict(
                    posting_url=posting_url,
                    owner=owner.job_id,
                    attempted=identity.job_id,
                )
            raise RuntimeError("Posting URL alias claim failed without a resolvable owner")
        self._conn.execute(
            """
            UPDATE job_identity_aliases
            SET retired_at = ?
            WHERE tenant_id = ?
              AND alias_kind = 'posting_url'
              AND job_id = ?
              AND alias_value != ?
              AND retired_at IS NULL
            """,
            (
                changed_at,
                str(identity.tenant_id),
                str(identity.job_id),
                posting_url.value,
            ),
        )
        return ResolvedJobIdentity(
            tenant_id=identity.tenant_id,
            job_id=identity.job_id,
            posting_url=posting_url,
            storage_url=identity.storage_url,
        )

    def _update_existing_job(
        self,
        job: Job,
        identity: ResolvedJobIdentity,
    ) -> None:
        existing = self._conn.execute(
            """
            SELECT discovered_at
            FROM jobs
            WHERE tenant_id = ? AND job_id = ?
            LIMIT 1
            """,
            (str(identity.tenant_id), str(identity.job_id)),
        ).fetchone()
        if existing is None:
            raise LookupError("Stable Job owner disappeared before repository upsert")
        existing_discovered_at = existing["discovered_at"] if isinstance(existing, sqlite3.Row) else existing[0]
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
            WHERE tenant_id = ? AND job_id = ?
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
                str(identity.tenant_id),
                str(identity.job_id),
            ),
        )

    def _insert_or_resolve_winner(
        self,
        job: Job,
        candidate_job_id: JobId,
    ) -> tuple[ResolvedJobIdentity, bool]:
        """Claim a first URL, returning a concurrent winner when one exists."""

        try:
            self._conn.execute(
                """
                INSERT INTO jobs (
                    tenant_id, job_id, url, title, company, salary,
                    description, location, site, strategy, discovered_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(job.tenant_id),
                    str(candidate_job_id),
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
        except sqlite3.IntegrityError:
            winner = self.resolve_by_posting_url(
                job.tenant_id,
                job.posting_url,
            )
            if winner is not None:
                return winner, False

            stable_winner = self.resolve_by_job_id(
                job.tenant_id,
                candidate_job_id,
            )
            if stable_winner is not None:
                url_owner = self.resolve_by_posting_url(
                    job.tenant_id,
                    job.posting_url,
                )
                if url_owner is not None and url_owner.job_id != candidate_job_id:
                    raise JobUrlConflict(
                        posting_url=job.posting_url,
                        owner=url_owner.job_id,
                        attempted=candidate_job_id,
                    )
                stable_winner = self._set_current_posting_url(
                    stable_winner,
                    job.posting_url,
                )
                self._update_existing_job(job, stable_winner)
                return stable_winner, False

            global_owner = self._conn.execute(
                "SELECT job_id FROM jobs WHERE url = ? LIMIT 1",
                (job.posting_url.value,),
            ).fetchone()
            if global_owner is not None:
                owner_job_id = global_owner["job_id"] if isinstance(global_owner, sqlite3.Row) else global_owner[0]
                raise JobUrlConflict(
                    posting_url=job.posting_url,
                    owner=JobId(str(owner_job_id)),
                    attempted=candidate_job_id,
                )
            raise

        identity = self.resolve_by_job_id(job.tenant_id, candidate_job_id)
        if identity is None:
            raise RuntimeError("Inserted Job is missing its stable identity alias")
        return identity, True

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
        identity = self._require_identity(tenant_id, existing.job_id)
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
            (
                identity.storage_url.value,
                deleted.deleted_at,
                deleted.delete_reason,
            ),
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
        identity = self._require_identity(tenant_id, existing.job_id)
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
            (restore_timestamp, identity.storage_url.value),
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
                SELECT j.job_id
                FROM job_source_observations o
                JOIN jobs j
                  ON j.tenant_id = o.tenant_id
                 AND j.job_id = o.job_id
                WHERE o.tenant_id = ?
                  AND o.source_id = ?
                  AND o.source_native_id = ?
                LIMIT 1
                """,
                (str(tenant_id), source_id, source_native_id),
            ).fetchone()
            if row is not None:
                job_id = row["job_id"] if isinstance(row, sqlite3.Row) else row[0]
                if job_id:
                    return JobId(str(job_id))

        if canonical_url:
            direct = self._identity_resolver.resolve_by_posting_url(
                tenant_id,
                PostingUrl(value=canonical_url),
            )
            if direct is not None:
                return direct.job_id

            row = self._conn.execute(
                """
                SELECT j.job_id
                FROM job_canonical_identities c
                JOIN jobs j
                  ON j.tenant_id = c.tenant_id
                 AND j.job_id = c.job_id
                WHERE c.tenant_id = ? AND c.canonical_url = ?
                LIMIT 1
                """,
                (str(tenant_id), canonical_url),
            ).fetchone()
            if row is not None:
                job_id = row["job_id"] if isinstance(row, sqlite3.Row) else row[0]
                if job_id:
                    return JobId(str(job_id))

            normalized = normalize_observed_url(canonical_url)
            if normalized:
                row = self._conn.execute(
                    """
                    SELECT j.job_id
                    FROM job_source_observations o
                    JOIN jobs j
                      ON j.tenant_id = o.tenant_id
                     AND j.job_id = o.job_id
                    WHERE o.tenant_id = ?
                      AND o.normalized_observed_url = ?
                    LIMIT 1
                    """,
                    (str(tenant_id), normalized),
                ).fetchone()
                if row is not None:
                    job_id = row["job_id"] if isinstance(row, sqlite3.Row) else row[0]
                    if job_id:
                        return JobId(str(job_id))

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
            SELECT j.job_id, j.url, j.title, j.company, j.site,
                   j.description AS listing_description,
                   COALESCE(je.full_description, j.full_description)
                       AS enriched_description,
                   CASE WHEN d.job_url IS NULL THEN 0 ELSE 1 END AS is_deleted
            FROM jobs j
            LEFT JOIN job_enrichments je
              ON je.tenant_id = j.tenant_id
             AND je.job_id = j.job_id
            LEFT JOIN jobctrl_deleted_jobs d
              ON d.job_url = j.url
             AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
            WHERE j.tenant_id = ?
              AND jh_normalize_identity(COALESCE(j.title, '')) = ?
              AND jh_normalize_identity(COALESCE(NULLIF(j.company, ''), j.site, '')) = ?
            ORDER BY is_deleted ASC, j.discovered_at ASC NULLS LAST, j.url ASC
            """,
            (
                str(tenant_id),
                normalize_identity_text(title),
                normalize_identity_text(company),
            ),
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
                return ContentOwnerMatch(job_id=JobId(str(existing["job_id"])), basis=basis)
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

        identity = self._require_identity(tenant_id, job_id)
        stable_job_id = str(identity.job_id)
        job_url = identity.storage_url.value
        self._fence_search_unit_write()
        normalized = normalize_observed_url(observation.observed_url)
        updated = self._conn.execute(
            """
            UPDATE job_source_observations SET
                source_observation_id = ?,
                job_id = ?,
                observed_url = ?,
                normalized_observed_url = ?,
                run_id = ?,
                observed_at = ?
            WHERE tenant_id = ? AND source_id = ? AND source_native_id = ?
            """,
            (
                observation.source_observation_id,
                stable_job_id,
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
                    job_id = ?,
                    source_id = ?,
                    source_native_id = ?,
                    observed_url = ?,
                    run_id = ?,
                    observed_at = ?
                WHERE tenant_id = ? AND normalized_observed_url = ?
                """,
                (
                    observation.source_observation_id,
                    stable_job_id,
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
                    tenant_id, source_observation_id, job_id, source_id,
                    source_native_id, observed_url, normalized_observed_url,
                    run_id, observed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(tenant_id),
                    observation.source_observation_id,
                    stable_job_id,
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
                job_url,
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
                job_url,
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

        resolved = self._require_identity(tenant_id, job_id)
        self._fence_search_unit_write()
        self._conn.execute(
            """
            INSERT INTO job_canonical_identities (
                tenant_id, job_id, canonical_url, ats_kind,
                source_native_id, confidence, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, job_id) DO UPDATE SET
                canonical_url = excluded.canonical_url,
                ats_kind = excluded.ats_kind,
                source_native_id = excluded.source_native_id,
                confidence = excluded.confidence,
                resolved_at = excluded.resolved_at
            """,
            (
                str(tenant_id),
                str(resolved.job_id),
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

        owner = self._require_identity(
            tenant_id,
            JobId(link.surviving_job_id),
        )
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
                str(owner.job_id),
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

        owner = self._require_identity(tenant_id, owner_job_id)
        self._fence_search_unit_write()
        before = self._conn.total_changes
        self._conn.execute(
            """
            INSERT INTO job_rejected_duplicate_links (
                tenant_id, owner_job_id, candidate_url, reason, rejected_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, owner_job_id, candidate_url) DO NOTHING
            """,
            (
                str(tenant_id),
                str(owner.job_id),
                str(candidate_url),
                reason,
                rejected_at,
            ),
        )
        self._conn.commit()
        return self._conn.total_changes > before

    def list_observations(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> list[JobSourceObservation]:
        """Read-side helper used by tests and the future Operations projection."""

        identity = self._resolve_identity(tenant_id, job_id)
        if identity is None:
            return []
        rows = self._conn.execute(
            """
            SELECT source_observation_id, source_id, source_native_id,
                   observed_url, run_id, observed_at
            FROM job_source_observations
            WHERE tenant_id = ? AND job_id = ?
            ORDER BY observed_at ASC
            """,
            (str(tenant_id), str(identity.job_id)),
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

        identity = self._resolve_identity(tenant_id, job_id)
        if identity is None:
            return None
        row = self._conn.execute(
            """
            SELECT canonical_url, ats_kind, source_native_id, confidence
            FROM job_canonical_identities
            WHERE tenant_id = ? AND job_id = ?
            LIMIT 1
            """,
            (str(tenant_id), str(identity.job_id)),
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

    def _load_resolved(self, identity: ResolvedJobIdentity) -> Job | None:
        row = self._conn.execute(
            """
            SELECT j.tenant_id, j.job_id, j.url,
                   j.title, j.salary, j.description, j.location,
                   j.site, j.strategy, j.discovered_at,
                   d.deleted_at, d.reason
            FROM jobs j
            LEFT JOIN jobctrl_deleted_jobs d
              ON d.job_url = j.url
             AND (
                    d.restored_at IS NULL
                 OR julianday(d.restored_at) <= julianday(d.deleted_at)
             )
            WHERE j.tenant_id = ? AND j.job_id = ?
            LIMIT 1
            """,
            (str(identity.tenant_id), str(identity.job_id)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_job(row, posting_url=identity.posting_url)

    def _resolve_identity(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> ResolvedJobIdentity | None:
        identity = self._identity_resolver.resolve_by_job_id(tenant_id, job_id)
        if identity is not None:
            return identity
        # Compatibility input only: callers that still pass jobs.url as a
        # JobId are translated here and nowhere below the repository.
        return self._identity_resolver.resolve_by_posting_url(
            tenant_id,
            PostingUrl(value=str(job_id)),
        )

    def _require_identity(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> ResolvedJobIdentity:
        identity = self._resolve_identity(tenant_id, job_id)
        if identity is None:
            raise LookupError(f"Unknown Job identity for tenant={tenant_id!r} job_id={job_id!r}")
        return identity

    def _sync_tombstone(
        self,
        job: Job,
        identity: ResolvedJobIdentity,
    ) -> None:
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
                (
                    identity.storage_url.value,
                    job.deleted_at,
                    job.delete_reason,
                ),
            )
        else:
            # Keep legacy active-save behaviour, but timestamp-aware
            # readers only treat this as restored when the active row
            # is newer than the tombstone.
            self._conn.execute(
                "UPDATE jobctrl_deleted_jobs SET restored_at = ? "
                "WHERE job_url = ? "
                "AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))",
                (job.discovered_at, identity.storage_url.value),
            )

    @staticmethod
    def _row_to_job(
        row: Any,
        *,
        posting_url: PostingUrl | None = None,
    ) -> Job:
        if isinstance(row, sqlite3.Row):
            tenant_id = row["tenant_id"]
            job_id = row["job_id"]
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
                tenant_id,
                job_id,
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
            tenant_id=TenantId(str(tenant_id)),
            job_id=JobId(str(job_id)),
            posting_url=posting_url or PostingUrl(value=str(url)),
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
