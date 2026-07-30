"""Atomically persist complete v7 job-list rows during the v6 cutover."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from jobctrl.infrastructure.migrations import (
    v6_to_v7_apply_run_projections as apply_runs,
)
from jobctrl.infrastructure.migrations import (
    v6_to_v7_artifact_list_projections as artifacts,
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
from jobctrl.infrastructure.migrations.v7_job_list_projection_rows import (
    CandidateJobListProjectionsError,
    JOB_LIST_PROJECTIONS_COLUMNS,
    JOB_LIST_PROJECTIONS_TABLE,
    _projection_rows,
    _required_text,
)

_TABLE = JOB_LIST_PROJECTIONS_TABLE
_COLUMNS = JOB_LIST_PROJECTIONS_COLUMNS
_CANONICAL_TABLES = (
    "jobs",
    "job_locators",
    "job_enrichments",
    "job_scores",
    "job_requirement_fit_reports",
    "job_stage_states",
    "job_posted_compensation_facts",
    "job_market_compensation_estimates",
    "job_materials",
    "job_materials_artifacts",
    "apply_run_projections",
    "artifact_list_projections",
    "job_events",
    "application_outcomes",
    "jobctrl_deleted_jobs",
)


@dataclass(frozen=True)
class CandidateJobListProjectionsResult:
    """Verified candidate job-list projection rebuild result."""

    rebuilt_job_list_projections: int


def rebuild_job_list_projections(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
    migration_at: str,
) -> CandidateJobListProjectionsResult:
    """Rebuild complete list rows without trusting the v6 list cache.

    This is a stopped-runtime, one-shot v6-to-v7 cutover step.  It requires
    the canonical root rewrite plus already-rebuilt apply and artifact
    projections, and leaves the source database byte-for-byte unchanged.
    """
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_columns(candidate, _TABLE, _COLUMNS)
    _assert_authoritative_roots(source, candidate, job_ids)
    _assert_upstream_projections(candidate)
    _assert_empty_target(candidate)
    timestamp = _required_text(migration_at, "migration_at")

    source_snapshot = _source_snapshot(source)
    canonical_snapshot = _canonical_snapshot(candidate)
    rows = _projection_rows(candidate, timestamp)

    candidate.execute("SAVEPOINT v6_job_list_projection_rebuild")
    try:
        _insert_rows(candidate, rows)
        _verify_candidate(
            source=source,
            candidate=candidate,
            expected_rows=rows,
            source_snapshot=source_snapshot,
            canonical_snapshot=canonical_snapshot,
        )
        candidate.execute("RELEASE SAVEPOINT v6_job_list_projection_rebuild")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_job_list_projection_rebuild")
        candidate.execute("RELEASE SAVEPOINT v6_job_list_projection_rebuild")
        raise

    return CandidateJobListProjectionsResult(
        rebuilt_job_list_projections=len(rows),
    )


def _assert_authoritative_roots(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        hydrated = build_job_id_map(source, candidate)
    except CandidateCopyError as error:
        raise CandidateJobListProjectionsError(
            "job-list projection rebuild requires hydrated candidate roots"
        ) from error
    if dict(hydrated.by_locator) != dict(job_ids.by_locator):
        raise CandidateJobListProjectionsError(
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
        raise CandidateJobListProjectionsError(
            "job-list projection rebuild requires exactly one current root locator per JobId"
        )


def _assert_upstream_projections(candidate: sqlite3.Connection) -> None:
    try:
        apply_jobs = apply_runs._candidate_job_metadata(candidate)
        apply_events = apply_runs._candidate_events_by_run(candidate, apply_jobs)
        expected_apply_rows = tuple(
            apply_runs._project_run(run_id, events, apply_jobs)
            for run_id, events in sorted(apply_events.items())
        )
        actual_apply_rows = apply_runs._rows(
            candidate,
            "apply_run_projections",
            apply_runs._PROJECTION_COLUMNS,
        )
    except apply_runs.CandidateApplyRunProjectionsError as error:
        raise CandidateJobListProjectionsError(
            "candidate apply-run projection cannot be verified"
        ) from error
    if actual_apply_rows != expected_apply_rows:
        raise CandidateJobListProjectionsError(
            "candidate apply_run_projections must match the canonical event rebuild"
        )

    try:
        artifact_jobs = artifacts._candidate_job_metadata(candidate)
        layout_by_artifact, provenance_by_artifact = artifacts._candidate_audits(
            candidate
        )
        canonical_artifacts = artifacts._candidate_artifacts(
            candidate,
            artifact_jobs,
        )
        expected_artifact_rows = artifacts._project_artifacts(
            canonical_artifacts,
            artifact_jobs,
            layout_by_artifact,
            provenance_by_artifact,
        )
        actual_artifact_rows = artifacts._rows(
            candidate,
            "artifact_list_projections",
            artifacts._COLUMNS,
        )
    except artifacts.CandidateArtifactListProjectionsError as error:
        raise CandidateJobListProjectionsError(
            "candidate artifact projection cannot be verified"
        ) from error
    if actual_artifact_rows != expected_artifact_rows:
        raise CandidateJobListProjectionsError(
            "candidate artifact_list_projections must match the canonical artifact rebuild"
        )


def _assert_empty_target(candidate: sqlite3.Connection) -> None:
    if _row_count(candidate, _TABLE):
        raise CandidateJobListProjectionsError(
            "candidate job_list_projections must be empty"
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
    if _rows(candidate, _TABLE, _COLUMNS, order="tenant_id, job_id") != expected_rows:
        raise CandidateJobListProjectionsError(
            "candidate rebuild changed job-list projection rows"
        )
    if _row_count(candidate, _TABLE) != len(expected_rows):
        raise CandidateJobListProjectionsError(
            "candidate rebuild changed job-list projection row count"
        )
    if _source_snapshot(source) != source_snapshot:
        raise CandidateJobListProjectionsError(
            "candidate rebuild mutated the v6 source database"
        )
    if _canonical_snapshot(candidate) != canonical_snapshot:
        raise CandidateJobListProjectionsError(
            "candidate rebuild mutated canonical job-list inputs"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateJobListProjectionsError(
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
    """Capture mutation-only source state without reading the stale list cache."""
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
        raise CandidateJobListProjectionsError(
            f"{table} columns do not match the exact v7 schema"
        )


def _columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    columns = tuple(
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({_identifier(table)})").fetchall()
    )
    if not columns:
        raise CandidateJobListProjectionsError(f"missing required table: {table}")
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
    "CandidateJobListProjectionsError",
    "CandidateJobListProjectionsResult",
    "rebuild_job_list_projections",
]
