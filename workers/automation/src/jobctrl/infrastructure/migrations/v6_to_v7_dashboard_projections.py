"""Atomically persist complete v7 dashboard rows during the v6 cutover."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from jobctrl.infrastructure.migrations import (
    v6_to_v7_apply_run_projections as apply_runs,
)
from jobctrl.infrastructure.migrations import (
    v6_to_v7_job_detail_projections as job_details,
)
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    CandidateCopyError,
    JobIdMap,
    build_job_id_map,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    assert_v6_migration_preflight,
)
from jobctrl.infrastructure.migrations.v7_dashboard_projection_rows import (
    DASHBOARD_PROJECTIONS_COLUMNS,
    DASHBOARD_PROJECTIONS_TABLE,
    CandidateDashboardProjectionsError,
    _projection_rows,
    _required_text,
)
from jobctrl.infrastructure.migrations.v7_job_list_projection_rows import (
    CandidateJobListProjectionsError,
    JOB_LIST_PROJECTIONS_COLUMNS,
    _projection_rows as job_list_projection_rows,
)

_TABLE = DASHBOARD_PROJECTIONS_TABLE
_COLUMNS = DASHBOARD_PROJECTIONS_COLUMNS
_CANONICAL_TABLES = (
    "jobs",
    "job_locators",
    "job_list_projections",
    "job_detail_projections",
    "apply_run_projections",
    "job_events",
    "posting_snapshot_sets",
    "jobctrl_deleted_jobs",
    "jobctrl_hidden_jobs",
    "application_outcomes",
    "application_outcome_suggestions",
)


@dataclass(frozen=True)
class CandidateDashboardProjectionsResult:
    """Verified candidate dashboard projection rebuild result."""

    rebuilt_dashboard_projections: int


def rebuild_dashboard_projections(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
    migration_at: str,
) -> CandidateDashboardProjectionsResult:
    """Rebuild dashboard rows without trusting either v6 dashboard/list cache."""
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_columns(candidate, _TABLE, _COLUMNS)
    _assert_authoritative_roots(source, candidate, job_ids)
    timestamp = _required_text(migration_at, "migration_at")
    _assert_upstream_projections(candidate, timestamp)
    _assert_empty_target(candidate)

    source_snapshot = _source_snapshot(source)
    canonical_snapshot = _canonical_snapshot(candidate)
    rows = _projection_rows(candidate, timestamp)

    candidate.execute("SAVEPOINT v6_dashboard_projection_rebuild")
    try:
        _insert_rows(candidate, rows)
        _verify_candidate(
            source=source,
            candidate=candidate,
            expected_rows=rows,
            source_snapshot=source_snapshot,
            canonical_snapshot=canonical_snapshot,
        )
        candidate.execute("RELEASE SAVEPOINT v6_dashboard_projection_rebuild")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_dashboard_projection_rebuild")
        candidate.execute("RELEASE SAVEPOINT v6_dashboard_projection_rebuild")
        raise

    return CandidateDashboardProjectionsResult(
        rebuilt_dashboard_projections=len(rows),
    )


def _assert_authoritative_roots(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        hydrated = build_job_id_map(source, candidate)
    except CandidateCopyError as error:
        raise CandidateDashboardProjectionsError(
            "dashboard projection rebuild requires hydrated candidate roots"
        ) from error
    if dict(hydrated.by_locator) != dict(job_ids.by_locator):
        raise CandidateDashboardProjectionsError(
            "supplied JobIdMap does not match hydrated candidate roots"
        )
    locators = {
        (str(tenant_id), str(locator)): str(job_id)
        for tenant_id, job_id, locator in candidate.execute(
            """
            SELECT tenant_id, job_id, locator_value
            FROM job_locators
            WHERE locator_kind = 'posting_url'
              AND is_current = 1
              AND retired_at IS NULL
            """
        ).fetchall()
    }
    if (
        locators != dict(job_ids.by_locator)
        or _row_count(candidate, "job_locators") != len(locators)
    ):
        raise CandidateDashboardProjectionsError(
            "dashboard projection rebuild requires exactly one current root locator per JobId"
        )


def _assert_upstream_projections(
    candidate: sqlite3.Connection,
    migration_at: str,
) -> None:
    _assert_apply_projection(candidate)
    try:
        expected_details = job_details._projection_rows(
            candidate, migration_at=migration_at
        )
    except job_details.CandidateJobDetailProjectionsError as error:
        raise CandidateDashboardProjectionsError(
            "candidate job-detail projections cannot be verified"
        ) from error
    actual_details = _rows(
        candidate,
        "job_detail_projections",
        job_details._COLUMNS,
        order="tenant_id, job_id",
    )
    if actual_details != expected_details:
        raise CandidateDashboardProjectionsError(
            "candidate job_detail_projections must match the canonical rebuild"
        )

    try:
        expected_list = job_list_projection_rows(candidate, migration_at)
    except CandidateJobListProjectionsError as error:
        raise CandidateDashboardProjectionsError(
            "candidate job-list projections cannot be verified"
        ) from error
    actual_list = _rows(
        candidate,
        "job_list_projections",
        JOB_LIST_PROJECTIONS_COLUMNS,
        order="tenant_id, job_id",
    )
    if actual_list != expected_list:
        raise CandidateDashboardProjectionsError(
            "candidate job_list_projections must match the canonical rebuild"
        )


def _assert_apply_projection(candidate: sqlite3.Connection) -> None:
    try:
        jobs = apply_runs._candidate_job_metadata(candidate)
        events = apply_runs._candidate_events_by_run(candidate, jobs)
        expected_apply = tuple(
            apply_runs._project_run(run_id, run_events, jobs)
            for run_id, run_events in sorted(events.items())
        )
        actual_apply = apply_runs._rows(
            candidate,
            "apply_run_projections",
            apply_runs._PROJECTION_COLUMNS,
        )
    except apply_runs.CandidateApplyRunProjectionsError as error:
        raise CandidateDashboardProjectionsError(
            "candidate apply-run projections cannot be verified"
        ) from error
    if actual_apply != expected_apply:
        raise CandidateDashboardProjectionsError(
            "candidate apply_run_projections must match the canonical event rebuild"
        )


def _assert_empty_target(candidate: sqlite3.Connection) -> None:
    if _row_count(candidate, _TABLE):
        raise CandidateDashboardProjectionsError(
            "candidate dashboard_projections must be empty"
        )


def _insert_rows(
    candidate: sqlite3.Connection,
    rows: tuple[tuple[object, ...], ...],
) -> None:
    if not rows:
        return
    candidate.executemany(
        f"INSERT INTO {_identifier(_TABLE)} ({_identifiers(_COLUMNS)}) "
        f"VALUES ({', '.join('?' for _ in _COLUMNS)})",
        rows,
    )


def _verify_candidate(
    *,
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    expected_rows: tuple[tuple[object, ...], ...],
    source_snapshot: tuple[int, int],
    canonical_snapshot: tuple[tuple[str, tuple[tuple[object, ...], ...]], ...],
) -> None:
    if _rows(candidate, _TABLE, _COLUMNS, order="tenant_id") != expected_rows:
        raise CandidateDashboardProjectionsError(
            "candidate rebuild changed dashboard projection rows"
        )
    if _row_count(candidate, _TABLE) != len(expected_rows):
        raise CandidateDashboardProjectionsError(
            "candidate rebuild changed dashboard projection row count"
        )
    if _source_snapshot(source) != source_snapshot:
        raise CandidateDashboardProjectionsError(
            "candidate rebuild mutated the v6 source database"
        )
    if _canonical_snapshot(candidate) != canonical_snapshot:
        raise CandidateDashboardProjectionsError(
            "candidate rebuild mutated canonical dashboard inputs"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateDashboardProjectionsError(
            "candidate rebuild left a foreign-key violation"
        )
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)


def _canonical_snapshot(
    candidate: sqlite3.Connection,
) -> tuple[tuple[str, tuple[tuple[object, ...], ...]], ...]:
    return tuple(
        (table, _rows(candidate, table, _columns(candidate, table), order="rowid"))
        for table in _CANONICAL_TABLES
    )


def _source_snapshot(source: sqlite3.Connection) -> tuple[int, int]:
    """Capture mutation-only source state without reading stale caches."""
    return (
        source.total_changes,
        int(source.execute("PRAGMA schema_version").fetchone()[0]),
    )


def _assert_columns(
    conn: sqlite3.Connection,
    table: str,
    expected: tuple[str, ...],
) -> None:
    if _columns(conn, table) != expected:
        raise CandidateDashboardProjectionsError(
            f"{table} columns do not match the exact v7 schema"
        )


def _columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    columns = tuple(
        str(row[1])
        for row in conn.execute(
            f"PRAGMA table_info({_identifier(table)})"
        ).fetchall()
    )
    if not columns:
        raise CandidateDashboardProjectionsError(
            f"missing required table: {table}"
        )
    return columns


def _rows(
    conn: sqlite3.Connection,
    table: str,
    columns: tuple[str, ...],
    *,
    order: str,
) -> tuple[tuple[object, ...], ...]:
    return tuple(
        tuple(row)
        for row in conn.execute(
            f"SELECT {_identifiers(columns)} FROM {_identifier(table)} ORDER BY {order}"
        ).fetchall()
    )


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_identifier(table)}").fetchone()[0])


def _identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def _identifiers(values: tuple[str, ...]) -> str:
    return ", ".join(_identifier(value) for value in values)


__all__ = [
    "CandidateDashboardProjectionsError",
    "CandidateDashboardProjectionsResult",
    "rebuild_dashboard_projections",
]
