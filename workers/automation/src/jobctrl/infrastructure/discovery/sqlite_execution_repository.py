"""SQLite adapter for durable Discover execution/job lineage."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from jobctrl.database import ensure_discovery_execution_tables
from jobctrl.domain.discovery.execution import (
    DiscoveryExecutionCohortKind,
    DiscoveryExecutionJob,
    DiscoveryExecutionRef,
    DiscoveryExecutionWorkPlanState,
    DiscoveryPreparationStep,
    validate_cohort_kind,
    validate_required_steps,
    validate_safe_reason_code,
    validate_work_plan_state,
)
from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.sqlite_identity_resolver import (
    SqliteJobIdentityResolver,
)


_SELECT_COLUMNS = """
    execution.tenant_id, execution.discover_workflow_id,
    execution.discover_run_id, jobs.url AS job_url, execution.cohort_kind,
    execution.source_family, execution.source_run_id,
    execution.preparation_workflow_id, execution.work_plan_state,
    execution.required_steps_json, execution.work_plan_reason,
    execution.linked_at
"""


class SqliteDiscoveryExecutionRepository:
    """Persist execution membership independently of mutable source rows."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_discovery_execution_tables(conn)

    def link_job(
        self,
        execution: DiscoveryExecutionRef,
        job_url: str,
        *,
        cohort_kind: DiscoveryExecutionCohortKind,
        source_family: str | None = None,
        source_run_id: str | None = None,
        linked_at: str | None = None,
    ) -> DiscoveryExecutionJob:
        """Idempotently link a job, allowing only backlog-to-observed promotion.

        ``linked_at`` and the first observed source metadata never change after
        their initial write. A backlog row may fill its previously NULL source
        metadata exactly once when promoted to ``observed_this_run``.
        """

        resolved_cohort = validate_cohort_kind(cohort_kind)
        normalized_job_url = _required_text(job_url, "job_url")
        normalized_family = _optional_text(source_family)
        normalized_source_run_id = _optional_text(source_run_id)
        if resolved_cohort == "observed_this_run" and normalized_family is None:
            raise ValueError("source_family is required for an observed execution job")
        linked = linked_at or datetime.now(timezone.utc).isoformat()
        stable_job_id = self._resolve_job_id(execution, normalized_job_url)

        with self._conn:
            self._conn.execute(
                """
                INSERT INTO discovery_execution_jobs (
                    tenant_id, discover_workflow_id, discover_run_id, job_id,
                    cohort_kind, source_family, source_run_id, work_plan_state,
                    linked_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                ON CONFLICT (
                    tenant_id, discover_workflow_id, discover_run_id, job_id
                )
                DO UPDATE SET
                    cohort_kind = CASE
                        WHEN excluded.cohort_kind = 'observed_this_run'
                            THEN 'observed_this_run'
                        ELSE discovery_execution_jobs.cohort_kind
                    END,
                    source_family = CASE
                        WHEN discovery_execution_jobs.cohort_kind = 'existing_backlog'
                         AND excluded.cohort_kind = 'observed_this_run'
                         AND discovery_execution_jobs.source_family IS NULL
                            THEN excluded.source_family
                        ELSE discovery_execution_jobs.source_family
                    END,
                    source_run_id = CASE
                        WHEN discovery_execution_jobs.cohort_kind = 'existing_backlog'
                         AND excluded.cohort_kind = 'observed_this_run'
                         AND discovery_execution_jobs.source_run_id IS NULL
                            THEN excluded.source_run_id
                        ELSE discovery_execution_jobs.source_run_id
                    END
                """,
                (
                    execution.tenant_id,
                    execution.workflow_id,
                    execution.temporal_run_id,
                    stable_job_id,
                    resolved_cohort,
                    normalized_family,
                    normalized_source_run_id,
                    linked,
                ),
            )

        result = self.get(execution, normalized_job_url)
        if result is None:  # pragma: no cover - defensive database invariant
            raise RuntimeError("discovery execution job link was not persisted")
        return result

    def set_work_plan(
        self,
        execution: DiscoveryExecutionRef,
        job_url: str,
        *,
        state: DiscoveryExecutionWorkPlanState,
        required_steps: list[str] | tuple[str, ...] | None = None,
        preparation_workflow_id: str | None = None,
        reason: str | None = None,
    ) -> DiscoveryExecutionJob:
        """Fill a membership row's work plan without rewriting its decision.

        ``pending`` and ``failed`` deliberately retain ``required_steps=NULL``;
        consumers must not interpret either as no work. Failed planning may be
        retried and advanced to a decided state. Once ``planned`` or
        ``not_eligible`` is recorded, only an exact retry is accepted.
        """

        resolved_state = validate_work_plan_state(state)
        resolved_reason = validate_safe_reason_code(reason)
        normalized_workflow_id = _optional_text(preparation_workflow_id)
        normalized_steps: tuple[DiscoveryPreparationStep, ...] | None = None
        if required_steps is not None:
            normalized_steps = validate_required_steps(required_steps)

        if resolved_state == "planned":
            if not normalized_steps:
                raise ValueError("planned work requires at least one preparation step")
            if normalized_workflow_id is None:
                raise ValueError("planned work requires a preparation_workflow_id")
        elif normalized_steps is not None:
            raise ValueError(f"{resolved_state} work must keep required_steps undecided")

        if resolved_state in {"not_eligible", "failed"} and resolved_reason is None:
            raise ValueError(f"{resolved_state} work requires a safe reason code")
        if resolved_state in {"pending", "not_eligible"} and normalized_workflow_id is not None:
            raise ValueError(f"{resolved_state} work cannot name a preparation workflow")

        normalized_job_url = _required_text(job_url, "job_url")
        stable_job_id = self._resolve_job_id(execution, normalized_job_url)
        existing = self.get(execution, normalized_job_url)
        if existing is None:
            raise KeyError(f"Job is not linked to discovery execution: {normalized_job_url}")

        desired_steps_json = (
            json.dumps(list(normalized_steps), separators=(",", ":")) if normalized_steps is not None else None
        )
        if existing.work_plan_state in {"planned", "not_eligible"}:
            desired = (
                resolved_state,
                normalized_steps,
                normalized_workflow_id,
                resolved_reason,
            )
            current = (
                existing.work_plan_state,
                existing.required_steps,
                existing.preparation_workflow_id,
                existing.work_plan_reason,
            )
            if desired != current:
                raise ValueError("A decided discovery execution work plan is immutable")
            return existing

        if existing.preparation_workflow_id is not None and normalized_workflow_id != existing.preparation_workflow_id:
            raise ValueError("preparation_workflow_id is immutable once assigned")

        with self._conn:
            updated = self._conn.execute(
                """
                UPDATE discovery_execution_jobs
                   SET preparation_workflow_id = COALESCE(preparation_workflow_id, ?),
                       work_plan_state = ?,
                       required_steps_json = ?,
                       work_plan_reason = ?
                 WHERE tenant_id = ?
                   AND discover_workflow_id = ?
                   AND discover_run_id = ?
                   AND job_id = ?
                   AND work_plan_state IN ('pending', 'failed')
                """,
                (
                    normalized_workflow_id,
                    resolved_state,
                    desired_steps_json,
                    resolved_reason,
                    execution.tenant_id,
                    execution.workflow_id,
                    execution.temporal_run_id,
                    stable_job_id,
                ),
            )
            if updated.rowcount != 1:
                concurrent = self.get(execution, normalized_job_url)
                if concurrent is not None and (
                    concurrent.work_plan_state,
                    concurrent.required_steps,
                    concurrent.preparation_workflow_id,
                    concurrent.work_plan_reason,
                ) == (
                    resolved_state,
                    normalized_steps,
                    normalized_workflow_id,
                    resolved_reason,
                ):
                    return concurrent
                raise RuntimeError("discovery execution work plan changed concurrently")

        result = self.get(execution, normalized_job_url)
        if result is None:  # pragma: no cover - defensive database invariant
            raise RuntimeError("discovery execution work plan was not persisted")
        return result

    def get(self, execution: DiscoveryExecutionRef, job_url: str) -> DiscoveryExecutionJob | None:
        try:
            stable_job_id = self._resolve_job_id(execution, job_url)
        except KeyError:
            return None
        row = self._conn.execute(
            f"""
            SELECT {_SELECT_COLUMNS}
              FROM discovery_execution_jobs AS execution
              JOIN jobs
                ON jobs.tenant_id = execution.tenant_id
               AND jobs.job_id = execution.job_id
             WHERE execution.tenant_id = ?
               AND execution.discover_workflow_id = ?
               AND execution.discover_run_id = ?
               AND execution.job_id = ?
            """,
            (
                execution.tenant_id,
                execution.workflow_id,
                execution.temporal_run_id,
                stable_job_id,
            ),
        ).fetchone()
        return _row_to_execution_job(row) if row is not None else None

    def list_for_execution(self, execution: DiscoveryExecutionRef) -> list[DiscoveryExecutionJob]:
        rows = self._conn.execute(
            f"""
            SELECT {_SELECT_COLUMNS}
              FROM discovery_execution_jobs AS execution
              JOIN jobs
                ON jobs.tenant_id = execution.tenant_id
               AND jobs.job_id = execution.job_id
             WHERE execution.tenant_id = ?
               AND execution.discover_workflow_id = ?
               AND execution.discover_run_id = ?
             ORDER BY jobs.url
            """,
            (execution.tenant_id, execution.workflow_id, execution.temporal_run_id),
        ).fetchall()
        return [_row_to_execution_job(row) for row in rows]

    def _resolve_job_id(
        self,
        execution: DiscoveryExecutionRef,
        job_reference: str,
    ) -> str:
        normalized = _required_text(job_reference, "job_url")
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
            raise KeyError(f"No stable Job identity for discovery execution member: {normalized}")
        return str(identity.job_id)


def _row_to_execution_job(
    row: sqlite3.Row | tuple[object, ...],
) -> DiscoveryExecutionJob:
    raw_steps = row[9]
    steps: tuple[DiscoveryPreparationStep, ...] | None = None
    if raw_steps is not None:
        decoded = json.loads(str(raw_steps))
        if not isinstance(decoded, list):
            raise ValueError("required_steps_json must contain a list")
        steps = validate_required_steps([str(step) for step in decoded])

    return DiscoveryExecutionJob(
        execution=DiscoveryExecutionRef(
            tenant_id=str(row[0]),
            workflow_id=str(row[1]),
            temporal_run_id=str(row[2]),
        ),
        job_url=str(row[3]),
        cohort_kind=validate_cohort_kind(str(row[4])),
        source_family=_optional_text(row[5]),
        source_run_id=_optional_text(row[6]),
        preparation_workflow_id=_optional_text(row[7]),
        work_plan_state=validate_work_plan_state(str(row[8])),
        required_steps=steps,
        work_plan_reason=validate_safe_reason_code(_optional_text(row[10])),
        linked_at=str(row[11]),
    )


def _required_text(value: object, field_name: str) -> str:
    normalized = _optional_text(value)
    if normalized is None:
        raise ValueError(f"{field_name} must be a non-empty string")
    return normalized


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None
