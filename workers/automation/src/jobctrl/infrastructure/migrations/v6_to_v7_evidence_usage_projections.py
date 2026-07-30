"""Atomically persist v7 evidence-usage rows during the v6-to-v7 cutover."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

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
from jobctrl.infrastructure.migrations.v7_evidence_usage_projection_rows import (
    CandidateEvidenceUsageProjectionsError,
    EVIDENCE_USAGE_PROJECTIONS_COLUMNS,
    EVIDENCE_USAGE_PROJECTIONS_TABLE,
    _projection_rows,
    _required_text,
)

_TABLE = EVIDENCE_USAGE_PROJECTIONS_TABLE
_COLUMNS = EVIDENCE_USAGE_PROJECTIONS_COLUMNS
_CANONICAL_TABLES = (
    "jobs",
    "job_locators",
    "candidate_profile_achievement_evidence",
    "candidate_profile_experience_entries",
    "candidate_profile_skill_categories",
    "candidate_profile_skill_items",
    "job_bullet_provenance",
    "job_requirement_fit_reports",
    "job_requirement_fit_items",
    "artifact_list_projections",
)


@dataclass(frozen=True)
class CandidateEvidenceUsageProjectionsResult:
    """Verified candidate evidence-usage projection rebuild result."""

    rebuilt_evidence_usage_projections: int


def rebuild_evidence_usage_projections(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
    migration_at: str,
) -> CandidateEvidenceUsageProjectionsResult:
    """Rebuild the tenant evidence map without reading the v6 projection cache."""

    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_columns(candidate, _TABLE, _COLUMNS)
    _assert_authoritative_roots(source, candidate, job_ids)
    _assert_empty_target(candidate)
    timestamp = _required_text(migration_at, "migration_at")

    canonical_snapshot = _canonical_snapshot(candidate)
    rows = _projection_rows(candidate, timestamp)

    candidate.execute("SAVEPOINT v6_evidence_usage_projection_rebuild")
    try:
        _insert_rows(candidate, rows)
        _verify_candidate(
            candidate=candidate,
            expected_rows=rows,
            canonical_snapshot=canonical_snapshot,
        )
        candidate.execute("RELEASE SAVEPOINT v6_evidence_usage_projection_rebuild")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_evidence_usage_projection_rebuild")
        candidate.execute("RELEASE SAVEPOINT v6_evidence_usage_projection_rebuild")
        raise

    return CandidateEvidenceUsageProjectionsResult(
        rebuilt_evidence_usage_projections=len(rows)
    )


def _assert_authoritative_roots(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        candidate_job_ids = build_job_id_map(source, candidate)
    except CandidateCopyError as error:
        raise CandidateEvidenceUsageProjectionsError(
            "evidence usage rebuild requires hydrated candidate roots"
        ) from error
    if dict(candidate_job_ids.by_locator) != dict(job_ids.by_locator):
        raise CandidateEvidenceUsageProjectionsError(
            "supplied JobIdMap does not match hydrated candidate roots"
        )
    current_locators = {
        (str(tenant_id), str(locator)): str(job_id)
        for tenant_id, locator, job_id in candidate.execute(
            """
            SELECT tenant_id, locator_value, job_id
            FROM job_locators
            WHERE locator_kind = 'posting_url'
              AND is_current = 1
              AND retired_at IS NULL
            """
        ).fetchall()
    }
    if current_locators != dict(job_ids.by_locator):
        raise CandidateEvidenceUsageProjectionsError(
            "candidate root locators do not match the admitted JobId map"
        )


def _assert_empty_target(candidate: sqlite3.Connection) -> None:
    if _row_count(candidate, _TABLE):
        raise CandidateEvidenceUsageProjectionsError(
            "candidate evidence_usage_projections must be empty"
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
    candidate: sqlite3.Connection,
    expected_rows: tuple[tuple[object, ...], ...],
    canonical_snapshot: tuple[tuple[str, tuple[tuple[object, ...], ...]], ...],
) -> None:
    if _rows(candidate, _TABLE, _COLUMNS) != expected_rows:
        raise CandidateEvidenceUsageProjectionsError(
            "candidate evidence usage rebuild changed projection rows"
        )
    if _row_count(candidate, _TABLE) != len(expected_rows):
        raise CandidateEvidenceUsageProjectionsError(
            "candidate evidence usage rebuild changed projection row count"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateEvidenceUsageProjectionsError(
            "candidate evidence usage rebuild left a foreign-key violation"
        )
    if _canonical_snapshot(candidate) != canonical_snapshot:
        raise CandidateEvidenceUsageProjectionsError(
            "candidate evidence usage rebuild mutated canonical source rows"
        )
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)


def _canonical_snapshot(
    candidate: sqlite3.Connection,
) -> tuple[tuple[str, tuple[tuple[object, ...], ...]], ...]:
    return tuple(
        (table, _rows(candidate, table, _columns(candidate, table)))
        for table in _CANONICAL_TABLES
    )


def _assert_columns(
    conn: sqlite3.Connection,
    table: str,
    expected: tuple[str, ...],
) -> None:
    if _columns(conn, table) != expected:
        raise CandidateEvidenceUsageProjectionsError(
            f"{table} columns do not match the admitted schema"
        )


def _columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    columns = tuple(
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({_identifier(table)})").fetchall()
    )
    if not columns:
        raise CandidateEvidenceUsageProjectionsError(
            f"missing required table: {table}"
        )
    return columns


def _rows(
    conn: sqlite3.Connection,
    table: str,
    columns: tuple[str, ...],
) -> tuple[tuple[object, ...], ...]:
    return tuple(
        tuple(row)
        for row in conn.execute(
            f"SELECT {_identifiers(columns)} FROM {_identifier(table)} ORDER BY rowid"
        ).fetchall()
    )


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_identifier(table)}").fetchone()[0])


def _identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def _identifiers(values: tuple[str, ...]) -> str:
    return ", ".join(_identifier(value) for value in values)


__all__ = [
    "CandidateEvidenceUsageProjectionsError",
    "CandidateEvidenceUsageProjectionsResult",
    "rebuild_evidence_usage_projections",
]
