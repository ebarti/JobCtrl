"""SQLite search-unit planning, fencing, checkpoints, and acceptance receipts."""

from __future__ import annotations

import hashlib
import re
import sqlite3
from datetime import datetime, timezone
from typing import Iterable

from jobstreaming import (
    CheckpointConflictError,
    CheckpointError,
    CheckpointStore,
    SearchCheckpoint,
)

from jobctrl.database import ensure_discovery_search_unit_tables
from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.search_units import (
    DiscoverySearchSpec,
    DiscoverySearchUnit,
    DiscoverySearchUnitLease,
    search_unit_id,
    validate_search_unit_state,
    validate_unit_id,
)
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.sqlite_identity_resolver import (
    SqliteJobIdentityResolver,
)


_SAFE_ERROR_IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

_SELECT_UNIT = """
    SELECT u.tenant_id, u.discover_workflow_id, u.discover_run_id,
           u.unit_id, u.ordinal, u.request_json, u.request_fingerprint,
           u.state, u.lease_owner, u.lease_attempt, u.lease_epoch, u.recovery_count,
           u.checkpoint_revision, u.last_error_code, u.last_error_type,
           u.last_error_retryable, u.reset_checkpoint,
           u.reset_checkpoint_after_revision,
           u.created_at, u.updated_at, u.completed_at,
           COUNT(j.job_id) AS accepted_jobs,
           COALESCE(SUM(j.was_new), 0) AS new_jobs
      FROM discovery_search_units u
      LEFT JOIN discovery_search_unit_jobs j
        ON j.tenant_id = u.tenant_id
       AND j.discover_workflow_id = u.discover_workflow_id
       AND j.discover_run_id = u.discover_run_id
       AND j.unit_id = u.unit_id
"""

_GROUP_UNIT = """
    GROUP BY u.tenant_id, u.discover_workflow_id, u.discover_run_id,
             u.unit_id, u.ordinal, u.request_json, u.request_fingerprint,
             u.state, u.lease_owner, u.lease_attempt, u.lease_epoch, u.recovery_count,
             u.checkpoint_revision, u.last_error_code, u.last_error_type,
             u.last_error_retryable, u.reset_checkpoint,
             u.reset_checkpoint_after_revision,
             u.created_at, u.updated_at, u.completed_at
"""


class DiscoverySearchPlanConflict(ValueError):
    """Raised when a retry tries to rewrite an immutable execution plan."""


class StaleDiscoverySearchUnitLease(CheckpointConflictError):
    """Raised after a newer activity attempt fences an older unit owner."""


class SqliteDiscoverySearchUnitRepository:
    """Caller-owned durable state for JobStreaming consumption."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_discovery_search_unit_tables(conn)

    def plan_units(
        self,
        execution: DiscoveryExecutionRef,
        specs: Iterable[DiscoverySearchSpec],
        *,
        created_at: str | None = None,
    ) -> list[DiscoverySearchUnit]:
        """Create an immutable ordered plan, or validate its exact replay."""

        planned_at = created_at or _utc_now()
        desired = [
            (
                search_unit_id(ordinal, spec),
                ordinal,
                spec,
                spec.to_json(),
                spec.fingerprint(),
            )
            for ordinal, spec in enumerate(specs)
        ]
        with self._conn:
            for unit_id, ordinal, _spec, request_json, fingerprint in desired:
                self._conn.execute(
                    """
                    INSERT INTO discovery_search_units (
                        tenant_id, discover_workflow_id, discover_run_id,
                        unit_id, ordinal, request_json, request_fingerprint,
                        state, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        execution.tenant_id,
                        execution.workflow_id,
                        execution.temporal_run_id,
                        unit_id,
                        ordinal,
                        request_json,
                        fingerprint,
                        planned_at,
                        planned_at,
                    ),
                )

            rows = self._list_rows(execution)
            actual = [(str(row[3]), int(row[4]), str(row[5]), str(row[6])) for row in rows]
            expected = [
                (unit_id, ordinal, request_json, fingerprint)
                for unit_id, ordinal, _spec, request_json, fingerprint in desired
            ]
            if actual != expected:
                raise DiscoverySearchPlanConflict("discovery search plan differs from the persisted execution plan")
        return [self._row_to_unit(row) for row in rows]

    def list_units(self, execution: DiscoveryExecutionRef) -> list[DiscoverySearchUnit]:
        return [self._row_to_unit(row) for row in self._list_rows(execution)]

    def get_unit(
        self,
        execution: DiscoveryExecutionRef,
        unit_id: str,
    ) -> DiscoverySearchUnit | None:
        validate_unit_id(unit_id)
        row = self._conn.execute(
            f"""
            {_SELECT_UNIT}
             WHERE u.tenant_id = ?
               AND u.discover_workflow_id = ?
               AND u.discover_run_id = ?
               AND u.unit_id = ?
            {_GROUP_UNIT}
            """,
            (*_execution_params(execution), unit_id),
        ).fetchone()
        return self._row_to_unit(row) if row is not None else None

    def claim_next(
        self,
        execution: DiscoveryExecutionRef,
        owner_token: str,
        attempt: int,
        *,
        claimed_at: str | None = None,
    ) -> DiscoverySearchUnitLease | None:
        """Claim the first unfinished unit and fence any prior activity owner."""

        owner = _required_owner(owner_token)
        if attempt < 1:
            raise ValueError("attempt must be positive")
        now = claimed_at or _utc_now()
        while True:
            watermark = self._conn.execute(
                """
                SELECT lease_attempt, lease_owner
                  FROM discovery_search_units
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND lease_attempt > 0
                 ORDER BY lease_attempt DESC, lease_epoch DESC
                 LIMIT 1
                """,
                _execution_params(execution),
            ).fetchone()
            if watermark is not None:
                watermark_attempt = int(watermark[0])
                watermark_owner = str(watermark[1])
                if attempt < watermark_attempt or (attempt == watermark_attempt and owner != watermark_owner):
                    raise StaleDiscoverySearchUnitLease(
                        f"activity attempt {attempt} cannot claim discovery work after attempt {watermark_attempt}"
                    )
            row = self._conn.execute(
                """
                SELECT unit_id, state, lease_owner, lease_attempt, lease_epoch
                  FROM discovery_search_units
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND state IN ('pending', 'running')
                 ORDER BY ordinal
                 LIMIT 1
                """,
                _execution_params(execution),
            ).fetchone()
            if row is None:
                return None
            unit_id = str(row[0])
            state = str(row[1])
            current_owner = str(row[2]) if row[2] is not None else None
            current_attempt = int(row[3])
            current_epoch = int(row[4])
            if state == "running" and current_owner == owner and current_attempt == attempt:
                return DiscoverySearchUnitLease(
                    execution=execution,
                    unit_id=unit_id,
                    owner_token=owner,
                    attempt=attempt,
                    epoch=current_epoch,
                )
            if state == "running" and attempt <= current_attempt:
                raise StaleDiscoverySearchUnitLease(
                    f"activity attempt {attempt} cannot reclaim search unit {unit_id} from attempt {current_attempt}"
                )

            next_epoch = current_epoch + 1
            with self._conn:
                updated = self._conn.execute(
                    """
                    UPDATE discovery_search_units
                       SET state = 'running',
                           lease_owner = ?,
                           lease_attempt = ?,
                           lease_epoch = ?,
                           recovery_count = recovery_count + CASE
                               WHEN state = 'running' THEN 1 ELSE 0 END,
                           updated_at = ?,
                           completed_at = NULL
                     WHERE tenant_id = ?
                       AND discover_workflow_id = ?
                       AND discover_run_id = ?
                       AND unit_id = ?
                       AND state IN ('pending', 'running')
                       AND lease_epoch = ?
                       AND (state = 'pending' OR lease_attempt < ?)
                       AND NOT EXISTS (
                           SELECT 1
                             FROM discovery_search_units newer
                            WHERE newer.tenant_id = discovery_search_units.tenant_id
                              AND newer.discover_workflow_id = discovery_search_units.discover_workflow_id
                              AND newer.discover_run_id = discovery_search_units.discover_run_id
                              AND (
                                  newer.lease_attempt > ?
                                  OR (
                                      newer.lease_attempt = ?
                                      AND newer.lease_attempt > 0
                                      AND newer.lease_owner <> ?
                                  )
                              )
                       )
                    """,
                    (
                        owner,
                        attempt,
                        next_epoch,
                        now,
                        *_execution_params(execution),
                        unit_id,
                        current_epoch,
                        attempt,
                        attempt,
                        attempt,
                        owner,
                    ),
                )
            if updated.rowcount == 1:
                return DiscoverySearchUnitLease(
                    execution=execution,
                    unit_id=unit_id,
                    owner_token=owner,
                    attempt=attempt,
                    epoch=next_epoch,
                )

    def fence_write(self, lease: DiscoverySearchUnitLease) -> None:
        """Acquire SQLite's writer ordering and reject a superseded owner."""

        updated = self._conn.execute(
            """
            UPDATE discovery_search_units
               SET lease_epoch = lease_epoch
             WHERE tenant_id = ?
               AND discover_workflow_id = ?
               AND discover_run_id = ?
               AND unit_id = ?
               AND state = 'running'
               AND lease_owner = ?
               AND lease_epoch = ?
            """,
            (
                *_execution_params(lease.execution),
                lease.unit_id,
                lease.owner_token,
                lease.epoch,
            ),
        )
        if updated.rowcount != 1:
            # A stale owner must not leave an implicit SQLite transaction open,
            # and any writes it staged before the fence are invalid together.
            self._conn.rollback()
            raise StaleDiscoverySearchUnitLease(f"search unit {lease.unit_id} is owned by a newer activity attempt")

    def checkpoint_store(
        self,
        lease: DiscoverySearchUnitLease,
    ) -> SqliteDiscoverySearchUnitCheckpointStore:
        return SqliteDiscoverySearchUnitCheckpointStore(self, lease)

    def load_checkpoint(self, lease: DiscoverySearchUnitLease) -> SearchCheckpoint | None:
        row = self._lease_row(lease, "checkpoint_json")
        if row[0] is None:
            return None
        try:
            return SearchCheckpoint.model_validate_json(str(row[0]))
        except Exception as exc:
            raise CheckpointError(f"unable to read checkpoint for search unit {lease.unit_id}") from exc

    def save_checkpoint(
        self,
        lease: DiscoverySearchUnitLease,
        checkpoint: SearchCheckpoint,
        *,
        saved_at: str | None = None,
    ) -> None:
        """Compare-and-swap one provider checkpoint revision under the lease."""

        expected_revision = checkpoint.revision - 1 if checkpoint.revision > 0 else None
        with self._conn:
            updated = self._conn.execute(
                """
                UPDATE discovery_search_units
                   SET checkpoint_json = ?,
                       checkpoint_revision = ?,
                       updated_at = ?
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND unit_id = ?
                   AND state = 'running'
                   AND lease_owner = ?
                   AND lease_epoch = ?
                   AND (
                       (? IS NULL AND checkpoint_revision IS NULL)
                       OR checkpoint_revision = ?
                   )
                """,
                (
                    checkpoint.model_dump_json(),
                    checkpoint.revision,
                    saved_at or _utc_now(),
                    *_execution_params(lease.execution),
                    lease.unit_id,
                    lease.owner_token,
                    lease.epoch,
                    expected_revision,
                    expected_revision,
                ),
            )
        if updated.rowcount != 1:
            raise CheckpointConflictError(f"stale lease or checkpoint revision for search unit {lease.unit_id}")

    def clear_checkpoint(
        self,
        lease: DiscoverySearchUnitLease,
        *,
        cleared_at: str | None = None,
    ) -> None:
        with self._conn:
            self.fence_write(lease)
            self._conn.execute(
                """
                UPDATE discovery_search_units
                   SET checkpoint_json = NULL,
                       checkpoint_revision = NULL,
                       reset_checkpoint = 0,
                       reset_checkpoint_after_revision = NULL,
                       updated_at = ?
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND unit_id = ?
                """,
                (
                    cleared_at or _utc_now(),
                    *_execution_params(lease.execution),
                    lease.unit_id,
                ),
            )

    def reset_checkpoint_if_requested(
        self,
        lease: DiscoverySearchUnitLease,
    ) -> bool:
        """Apply a durable provider reset request before opening the next stream."""

        row = self._lease_row(
            lease,
            "reset_checkpoint, checkpoint_revision, reset_checkpoint_after_revision",
        )
        if not bool(row[0]):
            return False
        current_revision = int(row[1]) if row[1] is not None else None
        required_revision = int(row[2]) if row[2] is not None else None
        if required_revision is not None and (current_revision is None or current_revision < required_revision):
            return False
        self.clear_checkpoint(lease)
        return True

    def record_accepted_job(
        self,
        lease: DiscoverySearchUnitLease,
        job_url: str,
        *,
        was_new: bool,
        accepted_at: str | None = None,
    ) -> None:
        """Record an idempotent accepted-job receipt under the current fence."""

        stable_job_id = self._resolve_job_id(
            lease.execution,
            job_url,
        )
        with self._conn:
            self.fence_write(lease)
            self._conn.execute(
                """
                INSERT INTO discovery_search_unit_jobs (
                    tenant_id, discover_workflow_id, discover_run_id,
                    unit_id, job_id, was_new, accepted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (
                    tenant_id, discover_workflow_id, discover_run_id,
                    unit_id, job_id
                ) DO UPDATE SET
                    was_new = MAX(discovery_search_unit_jobs.was_new, excluded.was_new)
                """,
                (
                    *_execution_params(lease.execution),
                    lease.unit_id,
                    stable_job_id,
                    int(was_new),
                    accepted_at or _utc_now(),
                ),
            )

    def _resolve_job_id(
        self,
        execution: DiscoveryExecutionRef,
        job_url: str,
    ) -> str:
        normalized = job_url.strip()
        if not normalized:
            raise ValueError("job_url must be non-empty")
        resolver = SqliteJobIdentityResolver(self._conn)
        identity = resolver.resolve_by_posting_url(
            TenantId(execution.tenant_id),
            PostingUrl(normalized),
        )
        if identity is None:
            try:
                stable_job_id = canonical_job_id(normalized)
            except ValueError:
                stable_job_id = None
            if stable_job_id is not None:
                identity = resolver.resolve_by_job_id(
                    TenantId(execution.tenant_id),
                    stable_job_id,
                )
        if identity is None:
            raise KeyError(f"No stable Job identity for accepted search result: {normalized}")
        return str(identity.job_id)

    def record_filtered_result(
        self,
        lease: DiscoverySearchUnitLease,
        provider_event_key: str,
        *,
        filtered_at: str | None = None,
    ) -> None:
        """Record one replay-idempotent caller-filtered provider result."""

        normalized_key = provider_event_key.strip()
        if not normalized_key:
            raise ValueError("provider_event_key must be non-empty")
        key_hash = hashlib.sha256(normalized_key.encode("utf-8")).hexdigest()
        with self._conn:
            self.fence_write(lease)
            self._conn.execute(
                """
                INSERT INTO discovery_search_unit_filtered_events (
                    tenant_id, discover_workflow_id, discover_run_id,
                    unit_id, provider_event_key_hash, filtered_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT DO NOTHING
                """,
                (
                    *_execution_params(lease.execution),
                    lease.unit_id,
                    key_hash,
                    filtered_at or _utc_now(),
                ),
            )

    def record_failure(
        self,
        lease: DiscoverySearchUnitLease,
        *,
        error_code: str,
        error_type: str,
        retryable: bool,
        reset_checkpoint: bool,
        terminal: bool = True,
        failed_at: str | None = None,
    ) -> None:
        """Persist a bounded failure and optional terminal disposition.

        A requested cursor reset is durable intent, not an immediate deletion.
        The caller must acknowledge the provider error against the current
        revision first. The next fenced attempt applies the reset with
        :meth:`reset_checkpoint_if_requested` before it opens a stream.

        A concurrent provider stream can report one board failure while another
        board is still producing jobs. Such an event is recorded with
        ``terminal=False`` so later events remain writable; the caller decides
        the unit's final state only after acknowledging ``SearchComplete``.
        """

        code = _safe_error_identifier(error_code, "error_code")
        kind = _safe_error_identifier(error_type, "error_type")
        terminal_state = "failed" if terminal and not retryable else "running"
        now = failed_at or _utc_now()
        with self._conn:
            self.fence_write(lease)
            checkpoint_row = self._conn.execute(
                """
                SELECT checkpoint_revision
                  FROM discovery_search_units
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND unit_id = ?
                """,
                (*_execution_params(lease.execution), lease.unit_id),
            ).fetchone()
            current_revision = (
                int(checkpoint_row[0]) if checkpoint_row is not None and checkpoint_row[0] is not None else None
            )
            reset_after_revision = (
                ((current_revision + 1) if current_revision is not None else 1) if reset_checkpoint else None
            )
            self._conn.execute(
                """
                UPDATE discovery_search_units
                   SET state = ?,
                       last_error_code = ?,
                       last_error_type = ?,
                       last_error_retryable = ?,
                       reset_checkpoint = ?,
                       reset_checkpoint_after_revision = ?,
                       updated_at = ?
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND unit_id = ?
                """,
                (
                    terminal_state,
                    code,
                    kind,
                    int(retryable),
                    int(reset_checkpoint),
                    reset_after_revision,
                    now,
                    *_execution_params(lease.execution),
                    lease.unit_id,
                ),
            )

    def mark_skipped(
        self,
        lease: DiscoverySearchUnitLease,
        *,
        skipped_at: str | None = None,
    ) -> None:
        """Close the active unit after the durable result limit is reached."""

        now = skipped_at or _utc_now()
        with self._conn:
            self.fence_write(lease)
            self._conn.execute(
                """
                UPDATE discovery_search_units
                   SET state = 'skipped',
                       updated_at = ?,
                       completed_at = ?
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND unit_id = ?
                """,
                (now, now, *_execution_params(lease.execution), lease.unit_id),
            )

    def mark_completed(
        self,
        lease: DiscoverySearchUnitLease,
        *,
        clear_error: bool = False,
        completed_at: str | None = None,
    ) -> None:
        now = completed_at or _utc_now()
        with self._conn:
            self.fence_write(lease)
            self._conn.execute(
                """
                UPDATE discovery_search_units
                   SET state = 'completed',
                       updated_at = ?,
                       completed_at = ?,
                       last_error_code = CASE WHEN ? THEN NULL ELSE last_error_code END,
                       last_error_type = CASE WHEN ? THEN NULL ELSE last_error_type END,
                       last_error_retryable = NULL,
                       reset_checkpoint = 0,
                       reset_checkpoint_after_revision = NULL
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND unit_id = ?
                """,
                (
                    now,
                    now,
                    int(clear_error),
                    int(clear_error),
                    *_execution_params(lease.execution),
                    lease.unit_id,
                ),
            )

    def mark_canceled(
        self,
        lease: DiscoverySearchUnitLease,
        *,
        canceled_at: str | None = None,
    ) -> None:
        now = canceled_at or _utc_now()
        with self._conn:
            self.fence_write(lease)
            self._conn.execute(
                """
                UPDATE discovery_search_units
                   SET state = 'canceled',
                       updated_at = ?,
                       completed_at = ?
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND unit_id = ?
                """,
                (now, now, *_execution_params(lease.execution), lease.unit_id),
            )

    def mark_pending_skipped(
        self,
        execution: DiscoveryExecutionRef,
        *,
        skipped_at: str | None = None,
    ) -> int:
        """Close unclaimed units after the caller's durable result limit is met."""

        now = skipped_at or _utc_now()
        with self._conn:
            updated = self._conn.execute(
                """
                UPDATE discovery_search_units
                   SET state = 'skipped',
                       updated_at = ?,
                       completed_at = ?
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND state = 'pending'
                """,
                (now, now, *_execution_params(execution)),
            )
        return updated.rowcount

    def mark_execution_canceled(
        self,
        lease: DiscoverySearchUnitLease,
        *,
        canceled_at: str | None = None,
    ) -> int:
        """Cancel the fenced active unit and every unclaimed sibling unit.

        The initial fence is intentionally inside the same writer transaction.
        A superseded activity therefore cannot convert a newer attempt's work
        into cancellation after its cooperative cancel signal arrives late.
        """

        now = canceled_at or _utc_now()
        with self._conn:
            self.fence_write(lease)
            updated = self._conn.execute(
                """
                UPDATE discovery_search_units
                   SET state = 'canceled',
                       updated_at = ?,
                       completed_at = ?
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND state IN ('pending', 'running')
                """,
                (now, now, *_execution_params(lease.execution)),
            )
        return updated.rowcount

    def execution_counts(self, execution: DiscoveryExecutionRef) -> dict[str, int]:
        row = self._conn.execute(
            """
            SELECT COUNT(*) AS accepted_jobs,
                   COALESCE(SUM(was_new), 0) AS new_jobs
              FROM discovery_search_unit_jobs
             WHERE tenant_id = ?
               AND discover_workflow_id = ?
               AND discover_run_id = ?
            """,
            _execution_params(execution),
        ).fetchone()
        accepted = int(row[0] or 0)
        new_jobs = int(row[1] or 0)
        return {
            "accepted": accepted,
            "new": new_jobs,
            "existing": accepted - new_jobs,
        }

    def execution_provider_job_count(
        self,
        execution: DiscoveryExecutionRef,
    ) -> int:
        """Return the durable provider-emitted job count for an execution.

        JobStreaming stores the acknowledged, de-duplicated provider job keys
        in each checkpoint. Reading that state keeps ``rawTotal`` stable across
        activity retries instead of rebuilding it from process-local counters.
        """

        rows = self._conn.execute(
            """
            SELECT unit_id, checkpoint_json
              FROM discovery_search_units
             WHERE tenant_id = ?
               AND discover_workflow_id = ?
               AND discover_run_id = ?
               AND checkpoint_json IS NOT NULL
            """,
            _execution_params(execution),
        ).fetchall()
        total = 0
        for row in rows:
            try:
                checkpoint = SearchCheckpoint.model_validate_json(str(row[1]))
            except Exception as exc:
                raise CheckpointError(f"unable to read checkpoint for search unit {row[0]}") from exc
            total += sum(adapter.emitted_count for adapter in checkpoint.adapters.values())
        return total

    def execution_filtered_count(
        self,
        execution: DiscoveryExecutionRef,
    ) -> int:
        """Return the durable number of caller-filtered provider results."""

        row = self._conn.execute(
            """
            SELECT COUNT(*)
              FROM discovery_search_unit_filtered_events
             WHERE tenant_id = ?
               AND discover_workflow_id = ?
               AND discover_run_id = ?
            """,
            _execution_params(execution),
        ).fetchone()
        return int(row[0] or 0)

    def _lease_row(self, lease: DiscoverySearchUnitLease, columns: str) -> sqlite3.Row:
        row = self._conn.execute(
            f"""
            SELECT {columns}
              FROM discovery_search_units
             WHERE tenant_id = ?
               AND discover_workflow_id = ?
               AND discover_run_id = ?
               AND unit_id = ?
               AND state = 'running'
               AND lease_owner = ?
               AND lease_epoch = ?
            """,
            (
                *_execution_params(lease.execution),
                lease.unit_id,
                lease.owner_token,
                lease.epoch,
            ),
        ).fetchone()
        if row is None:
            raise StaleDiscoverySearchUnitLease(f"search unit {lease.unit_id} is owned by a newer activity attempt")
        return row

    def _list_rows(self, execution: DiscoveryExecutionRef) -> list[sqlite3.Row]:
        return self._conn.execute(
            f"""
            {_SELECT_UNIT}
             WHERE u.tenant_id = ?
               AND u.discover_workflow_id = ?
               AND u.discover_run_id = ?
            {_GROUP_UNIT}
             ORDER BY u.ordinal
            """,
            _execution_params(execution),
        ).fetchall()

    @staticmethod
    def _row_to_unit(row: sqlite3.Row | tuple[object, ...]) -> DiscoverySearchUnit:
        spec = DiscoverySearchSpec.from_json(str(row[5]))
        fingerprint = str(row[6])
        if spec.fingerprint() != fingerprint:
            raise DiscoverySearchPlanConflict("persisted search request fingerprint is invalid")
        return DiscoverySearchUnit(
            execution=DiscoveryExecutionRef(
                tenant_id=str(row[0]),
                workflow_id=str(row[1]),
                temporal_run_id=str(row[2]),
            ),
            unit_id=validate_unit_id(str(row[3])),
            ordinal=int(row[4]),
            spec=spec,
            request_fingerprint=fingerprint,
            state=validate_search_unit_state(str(row[7])),
            lease_owner=str(row[8]) if row[8] is not None else None,
            lease_attempt=int(row[9]),
            lease_epoch=int(row[10]),
            recovery_count=int(row[11]),
            checkpoint_revision=int(row[12]) if row[12] is not None else None,
            last_error_code=str(row[13]) if row[13] is not None else None,
            last_error_type=str(row[14]) if row[14] is not None else None,
            last_error_retryable=(bool(row[15]) if row[15] is not None else None),
            reset_checkpoint=bool(row[16]),
            reset_checkpoint_after_revision=(int(row[17]) if row[17] is not None else None),
            created_at=str(row[18]),
            updated_at=str(row[19]),
            completed_at=str(row[20]) if row[20] is not None else None,
            accepted_jobs=int(row[21]),
            new_jobs=int(row[22]),
        )


class SqliteDiscoverySearchUnitCheckpointStore(CheckpointStore):
    """JobStreaming checkpoint store bound to one fenced unit lease."""

    def __init__(
        self,
        repository: SqliteDiscoverySearchUnitRepository,
        lease: DiscoverySearchUnitLease,
    ) -> None:
        self._repository = repository
        self._lease = lease

    def load(self) -> SearchCheckpoint | None:
        return self._repository.load_checkpoint(self._lease)

    def save(self, checkpoint: SearchCheckpoint) -> None:
        self._repository.save_checkpoint(self._lease, checkpoint)

    def clear(self) -> None:
        self._repository.clear_checkpoint(self._lease)


def _execution_params(execution: DiscoveryExecutionRef) -> tuple[str, str, str]:
    return execution.tenant_id, execution.workflow_id, execution.temporal_run_id


def _required_owner(owner_token: str) -> str:
    owner = owner_token.strip()
    if not owner:
        raise ValueError("owner_token must be non-empty")
    if len(owner) > 256:
        raise ValueError("owner_token must be at most 256 characters")
    return owner


def _safe_error_identifier(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not _SAFE_ERROR_IDENTIFIER.fullmatch(normalized):
        raise ValueError(f"{field_name} must be a bounded safe identifier")
    return normalized


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
