"""Copy the v6 root Job identity into an isolated exact-v7 candidate."""

from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from types import MappingProxyType

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import JobIdMap


class CandidateRootCopyError(RuntimeError):
    """Raised when the candidate root cannot preserve every v6 Job."""


@dataclass(frozen=True)
class CandidateRootCopyResult:
    """Verified root-copy result consumed by dependent candidate transforms."""

    job_ids: JobIdMap
    copied_jobs: int


def copy_root_jobs(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_id_factory: Callable[[], str] | None = None,
    migration_at: str | None = None,
) -> CandidateRootCopyResult:
    """Copy v6 ``jobs`` and derive current posting locators in the candidate.

    The source connection is read-only from this function's perspective. The
    caller may discard a failed candidate and retry from the same admitted v6
    database without repairing partially altered source tables.
    """
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    source_columns = _columns(source, "jobs")
    target_columns = _columns(candidate, "jobs")
    expected_target_columns = (*source_columns, "tenant_id", "job_id")
    if target_columns != expected_target_columns:
        raise CandidateRootCopyError(
            "candidate jobs columns do not exactly extend the admitted v6 row"
        )
    if _row_count(candidate, "jobs") or _row_count(candidate, "job_locators"):
        raise CandidateRootCopyError(
            "candidate jobs and job_locators must both be empty"
        )

    allocate = job_id_factory or (lambda: str(uuid.uuid4()))
    copied_at = migration_at or datetime.now(timezone.utc).isoformat()
    source_rows = source.execute(
        f"SELECT {', '.join(_quote(column) for column in source_columns)} "
        "FROM jobs ORDER BY rowid"
    ).fetchall()
    source_dump = tuple(tuple(row) for row in source_rows)
    job_rows: list[tuple[object, ...]] = []
    locator_rows: list[tuple[object, ...]] = []
    identities: dict[tuple[str, str], str] = {}
    allocated_ids: set[str] = set()

    for row in source_dump:
        values = dict(zip(source_columns, row, strict=True))
        tenant_id = "local"
        posting_url = str(values.get("url") or "").strip()
        if not posting_url:
            raise CandidateRootCopyError("v6 jobs contains an empty posting URL")
        identity_key = (tenant_id, posting_url)
        if identity_key in identities:
            raise CandidateRootCopyError(
                f"v6 jobs contains a duplicate posting URL: {posting_url!r}"
            )
        job_id = _canonical_job_id(allocate())
        if job_id in allocated_ids:
            raise CandidateRootCopyError(
                f"JobId allocator returned a duplicate value: {job_id}"
            )
        allocated_ids.add(job_id)
        identities[identity_key] = job_id

        job_rows.append((*row, tenant_id, job_id))
        first_seen_at = str(values.get("discovered_at") or "").strip() or copied_at
        locator_rows.append(
            (
                tenant_id,
                job_id,
                "posting_url",
                posting_url,
                1,
                first_seen_at,
                first_seen_at,
                None,
            )
        )

    candidate.execute("SAVEPOINT v6_root_candidate_copy")
    try:
        if job_rows:
            placeholders = ", ".join("?" for _ in target_columns)
            candidate.executemany(
                f"INSERT INTO jobs ({', '.join(_quote(column) for column in target_columns)}) "
                f"VALUES ({placeholders})",
                job_rows,
            )
            candidate.executemany(
                """
                INSERT INTO job_locators (
                    tenant_id, job_id, locator_kind, locator_value, is_current,
                    first_seen_at, last_seen_at, retired_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                locator_rows,
            )
        _verify_root_candidate(
            source=source,
            candidate=candidate,
            expected_rows=source_dump,
            source_columns=source_columns,
            identities=identities,
        )
        candidate.execute("RELEASE SAVEPOINT v6_root_candidate_copy")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_root_candidate_copy")
        candidate.execute("RELEASE SAVEPOINT v6_root_candidate_copy")
        raise

    return CandidateRootCopyResult(
        job_ids=JobIdMap(MappingProxyType(identities)),
        copied_jobs=len(job_rows),
    )


def _verify_root_candidate(
    *,
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    expected_rows: tuple[tuple[object, ...], ...],
    source_columns: tuple[str, ...],
    identities: dict[tuple[str, str], str],
) -> None:
    candidate_rows = candidate.execute(
        f"SELECT {', '.join(_quote(column) for column in source_columns)} "
        "FROM jobs ORDER BY rowid"
    ).fetchall()
    if tuple(tuple(row) for row in candidate_rows) != expected_rows:
        raise CandidateRootCopyError("candidate root copy changed v6 Job data")
    if _row_count(candidate, "jobs") != len(expected_rows):
        raise CandidateRootCopyError("candidate root copy changed the Job count")
    if _row_count(candidate, "job_locators") != len(expected_rows):
        raise CandidateRootCopyError(
            "candidate root copy did not create exactly one current locator per Job"
        )
    locator_map = {
        (str(row[0]), str(row[1])): str(row[2])
        for row in candidate.execute(
            """
            SELECT tenant_id, locator_value, job_id
            FROM job_locators
            WHERE locator_kind = 'posting_url'
              AND is_current = 1
              AND retired_at IS NULL
            """
        ).fetchall()
    }
    if locator_map != identities:
        raise CandidateRootCopyError(
            "candidate root locators do not match the allocated Job identities"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateRootCopyError(
            "candidate root copy left a foreign-key violation"
        )
    # A second read closes the proof that no source row was consumed or deleted.
    source_rows_after = source.execute(
        f"SELECT {', '.join(_quote(column) for column in source_columns)} "
        "FROM jobs ORDER BY rowid"
    ).fetchall()
    if tuple(tuple(row) for row in source_rows_after) != expected_rows:
        raise CandidateRootCopyError("candidate root copy mutated the v6 source")


def _canonical_job_id(value: object) -> str:
    normalized = str(value or "")
    try:
        parsed = uuid.UUID(normalized)
    except ValueError as error:
        raise CandidateRootCopyError(
            f"JobId allocator returned a non-canonical UUID: {value!r}"
        ) from error
    if str(parsed) != normalized:
        raise CandidateRootCopyError(
            f"JobId allocator returned a non-canonical UUID: {value!r}"
        )
    return normalized


def _columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    rows = conn.execute(f"PRAGMA table_info({_quote(table)})").fetchall()
    if not rows:
        raise CandidateRootCopyError(f"missing required table: {table}")
    return tuple(str(row[1]) for row in rows)


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return int(
        conn.execute(f"SELECT COUNT(*) FROM {_quote(table)}").fetchone()[0]
    )


def _quote(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


__all__ = [
    "CandidateRootCopyError",
    "CandidateRootCopyResult",
    "copy_root_jobs",
]
