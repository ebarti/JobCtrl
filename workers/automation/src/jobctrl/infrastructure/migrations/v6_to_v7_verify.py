"""Final verification and transactional sealing for a v6-to-v7 candidate."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_candidate import (
    CandidatePopulationResult,
    CandidatePopulationStepReceipt,
    candidate_logical_digest,
    source_logical_digest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import build_job_id_map
from jobctrl.infrastructure.migrations.v6_to_v7_plan import (
    ColumnRole,
    TABLE_PLANS,
    classify_column,
    target_tables,
)
from jobctrl.infrastructure.migrations.v6_to_v7_population_steps import (
    CANDIDATE_POPULATION_STEPS,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    assert_v6_migration_preflight,
)

_STAMP_SAVEPOINT: Final = "v6_to_v7_candidate_stamp"
_SEQUENCE_OWNED_TABLES: Final = tuple(sorted(table for table, plan in TABLE_PLANS.items() if plan.sequence_owned))


class CandidateVerificationError(RuntimeError):
    """Raised when a populated v7 candidate cannot be sealed safely."""


@dataclass(frozen=True)
class CandidateVerificationResult:
    """Metadata-only proof that a candidate satisfies the requested version."""

    user_version: int
    job_count: int
    current_posting_locator_count: int
    table_row_counts: tuple[tuple[str, int], ...]
    sequence_high_watermarks: tuple[tuple[str, int | None], ...]


def verify_v7_candidate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    population: CandidatePopulationResult,
) -> CandidateVerificationResult:
    """Verify an unstamped, fully populated exact-v7 candidate.

    This deliberately has no write path.  It returns only counts and version
    metadata so it remains safe to retain in migration diagnostics.
    """
    _assert_entry_connections(source, candidate)
    original_query_only = _query_only(source)
    restored = False
    try:
        _set_query_only(source, True)
        result = _verify_candidate(
            source,
            candidate,
            population,
            expected_user_version=0,
        )
        _set_query_only(source, bool(original_query_only))
        restored = True
        return result
    except CandidateVerificationError:
        raise
    except BaseException:
        raise CandidateVerificationError("candidate verification failed") from None
    finally:
        if not restored:
            _restore_query_only(source, original_query_only)


def verify_and_stamp_v7_candidate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    population: CandidatePopulationResult,
    *,
    _after_stamp: Callable[[], None] | None = None,
) -> CandidateVerificationResult:
    """Preverify an unstamped candidate and atomically seal it as v7.

    The source is forced read-only throughout.  Restoring that source setting
    happens before releasing the candidate savepoint, so a failed restore
    cannot leave a sealed candidate behind.
    """
    _assert_entry_connections(source, candidate)
    original_query_only = _query_only(source)
    restored = False
    savepoint_open = False
    after_stamp_failed = False
    try:
        _set_query_only(source, True)
        candidate.execute(f"SAVEPOINT {_STAMP_SAVEPOINT}")
        savepoint_open = True
        _verify_candidate(
            source,
            candidate,
            population,
            expected_user_version=0,
        )
        candidate.execute(f"PRAGMA user_version = {EXACT_V7_MANIFEST.version}")
        if _after_stamp is not None:
            try:
                _after_stamp()
            except BaseException:
                after_stamp_failed = True
                _rollback_stamp(candidate)
                savepoint_open = False
                raise
        result = _verify_candidate(
            source,
            candidate,
            population,
            expected_user_version=EXACT_V7_MANIFEST.version,
        )
        _set_query_only(source, bool(original_query_only))
        restored = True
        candidate.execute(f"RELEASE SAVEPOINT {_STAMP_SAVEPOINT}")
        savepoint_open = False
        return result
    except BaseException:
        if savepoint_open:
            _rollback_stamp(candidate)
            savepoint_open = False
        if after_stamp_failed:
            raise
        raise CandidateVerificationError("candidate verification or stamp failed") from None
    finally:
        if not restored:
            _restore_query_only(source, original_query_only)


def _assert_entry_connections(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> None:
    if source is candidate:
        raise CandidateVerificationError("source and candidate must be distinct")
    if source.in_transaction or candidate.in_transaction:
        raise CandidateVerificationError("candidate verification requires connections without active transactions")


def _verify_candidate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    population: CandidatePopulationResult,
    *,
    expected_user_version: int,
) -> CandidateVerificationResult:
    _assert_population_type(population)
    assert_v6_migration_preflight(source)
    _assert_source_handoff(source, population)
    _assert_candidate_state(candidate, expected_user_version)
    _assert_candidate_handoff(candidate, population)

    live_counts = _target_table_counts(candidate)
    _assert_population_receipts(population, live_counts)
    job_count, locator_count = _assert_root_binding(source, candidate)
    _assert_job_id_references(candidate)
    sequence_high_watermarks = _assert_sequences(source, candidate, population)

    return CandidateVerificationResult(
        user_version=expected_user_version,
        job_count=job_count,
        current_posting_locator_count=locator_count,
        table_row_counts=live_counts,
        sequence_high_watermarks=sequence_high_watermarks,
    )


def _assert_population_type(population: CandidatePopulationResult) -> None:
    if not isinstance(population, CandidatePopulationResult):
        raise CandidateVerificationError("candidate population handoff is invalid")


def _assert_source_handoff(
    source: sqlite3.Connection,
    population: CandidatePopulationResult,
) -> None:
    if source.total_changes != population.source_total_changes:
        raise CandidateVerificationError("candidate population source change count differs")
    if source_logical_digest(source) != population.source_digest:
        raise CandidateVerificationError("candidate population source digest differs")


def _assert_candidate_state(
    candidate: sqlite3.Connection,
    expected_user_version: int,
) -> None:
    if int(candidate.execute("PRAGMA user_version").fetchone()[0]) != expected_user_version:
        raise CandidateVerificationError("candidate user_version is not expected")
    try:
        assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    except BaseException:
        raise CandidateVerificationError("candidate schema does not match exact v7") from None
    if candidate.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise CandidateVerificationError("candidate has foreign-key violations")
    if tuple(candidate.execute("PRAGMA integrity_check").fetchall()) != (("ok",),):
        raise CandidateVerificationError("candidate integrity check did not pass")


def _assert_candidate_handoff(
    candidate: sqlite3.Connection,
    population: CandidatePopulationResult,
) -> None:
    if candidate_logical_digest(candidate) != population.candidate_digest:
        raise CandidateVerificationError("candidate population content digest differs")


def _assert_population_receipts(
    population: CandidatePopulationResult,
    live_counts: tuple[tuple[str, int], ...],
) -> None:
    expected_steps = tuple((step.step_id, tuple(sorted(step.owned_tables))) for step in CANDIDATE_POPULATION_STEPS)
    receipts = tuple(population.steps)
    if len(receipts) != len(expected_steps):
        raise CandidateVerificationError("candidate population receipt count is invalid")

    receipt_tables: list[str] = []
    for receipt, (step_id, owned_tables) in zip(receipts, expected_steps, strict=True):
        if not isinstance(receipt, CandidatePopulationStepReceipt):
            raise CandidateVerificationError("candidate population receipt is invalid")
        if receipt.step_id != step_id:
            raise CandidateVerificationError("candidate population receipt order is invalid")
        if tuple(receipt.owned_tables) != owned_tables:
            raise CandidateVerificationError("candidate population receipt owners are invalid")
        expected_counts = tuple((table, _count_table_from_live_counts(live_counts, table)) for table in owned_tables)
        if tuple(receipt.table_row_counts) != expected_counts:
            raise CandidateVerificationError("candidate population receipt counts differ")
        receipt_tables.extend(owned_tables)

    targets = tuple(sorted(target_tables()))
    if tuple(sorted(receipt_tables)) != targets or len(set(receipt_tables)) != len(receipt_tables):
        raise CandidateVerificationError("candidate population receipt coverage is invalid")
    if tuple(population.table_row_counts) != live_counts:
        raise CandidateVerificationError("candidate population table counts differ")


def _count_table_from_live_counts(
    live_counts: tuple[tuple[str, int], ...],
    table: str,
) -> int:
    for live_table, count in live_counts:
        if live_table == table:
            return count
    raise CandidateVerificationError("candidate target table is missing")


def _assert_root_binding(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> tuple[int, int]:
    source_columns = _table_columns(source, "jobs")
    candidate_columns = _table_columns(candidate, "jobs")
    if not source_columns or not set(source_columns) <= set(candidate_columns):
        raise CandidateVerificationError("candidate jobs columns do not preserve v6")
    source_rows = _rows(source, "jobs", source_columns)
    candidate_rows = _rows(candidate, "jobs", source_columns)
    if source_rows != candidate_rows:
        raise CandidateVerificationError("candidate jobs values differ from v6")
    try:
        build_job_id_map(source, candidate)
    except BaseException:
        raise CandidateVerificationError("candidate canonical JobIds are invalid") from None

    job_count = _table_count(candidate, "jobs")
    locator_count = _table_count(candidate, "job_locators")
    if locator_count != job_count:
        raise CandidateVerificationError("candidate has an invalid posting locator count")
    invalid_locators = int(
        candidate.execute(
            """
            SELECT COUNT(*)
            FROM job_locators AS locator
            LEFT JOIN jobs AS job
              ON job.tenant_id = locator.tenant_id
             AND job.job_id = locator.job_id
             AND job.url = locator.locator_value
            WHERE locator.locator_kind <> 'posting_url'
               OR locator.is_current IS NOT 1
               OR locator.retired_at IS NOT NULL
               OR job.job_id IS NULL
            """
        ).fetchone()[0]
    )
    if invalid_locators:
        raise CandidateVerificationError("candidate posting locators are invalid")
    return job_count, locator_count


def _assert_job_id_references(candidate: sqlite3.Connection) -> None:
    for table in sorted(target_tables()):
        columns = _table_columns(candidate, table)
        job_id_columns = tuple(
            column for column in columns if classify_column(table, column, "target") is ColumnRole.JOB_ID
        )
        if not job_id_columns:
            continue
        if "tenant_id" not in columns:
            raise CandidateVerificationError("candidate JobId target is missing tenant_id")
        for column in job_id_columns:
            unresolved = int(
                candidate.execute(
                    f"""
                    SELECT COUNT(*)
                    FROM {_quote_identifier(table)} AS dependent
                    LEFT JOIN jobs AS root
                      ON root.tenant_id = dependent.tenant_id
                     AND root.job_id = dependent.{_quote_identifier(column)}
                    WHERE dependent.{_quote_identifier(column)} IS NOT NULL
                      AND root.job_id IS NULL
                    """
                ).fetchone()[0]
            )
            if unresolved:
                raise CandidateVerificationError("candidate JobId reference is unresolved")


def _assert_sequences(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    population: CandidatePopulationResult,
) -> tuple[tuple[str, int | None], ...]:
    source_sequences = _sequence_values(source)
    candidate_sequences = _sequence_values(candidate)
    if set(candidate_sequences) - set(_SEQUENCE_OWNED_TABLES):
        raise CandidateVerificationError("candidate has an undeclared sequence row")

    high_watermarks = tuple((table, candidate_sequences.get(table)) for table in _SEQUENCE_OWNED_TABLES)
    for table, candidate_high_water in high_watermarks:
        if source_sequences.get(table) != candidate_high_water:
            raise CandidateVerificationError("candidate sequence high-water differs")
    if population.event_sequence_high_water != candidate_sequences.get("job_events"):
        raise CandidateVerificationError("candidate event sequence high-water differs")
    return high_watermarks


def _target_table_counts(candidate: sqlite3.Connection) -> tuple[tuple[str, int], ...]:
    return tuple((table, _table_count(candidate, table)) for table in sorted(target_tables()))


def _table_count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_quote_identifier(table)}").fetchone()[0])


def _table_columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    return tuple(str(row[1]) for row in conn.execute(f"PRAGMA table_info({_quote_identifier(table)})"))


def _rows(
    conn: sqlite3.Connection,
    table: str,
    columns: tuple[str, ...],
) -> tuple[tuple[object, ...], ...]:
    selected = ", ".join(_quote_identifier(column) for column in columns)
    return tuple(
        tuple(row)
        for row in conn.execute(f"SELECT {selected} FROM {_quote_identifier(table)} ORDER BY rowid").fetchall()
    )


def _sequence_values(conn: sqlite3.Connection) -> dict[str, int]:
    exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").fetchone()
    if exists is None:
        return {}
    return {
        str(name): int(sequence)
        for name, sequence in conn.execute("SELECT name, seq FROM sqlite_sequence ORDER BY name").fetchall()
    }


def _query_only(source: sqlite3.Connection) -> int:
    return int(source.execute("PRAGMA query_only").fetchone()[0])


def _set_query_only(source: sqlite3.Connection, enabled: bool) -> None:
    source.execute(f"PRAGMA query_only = {1 if enabled else 0}")


def _restore_query_only(source: sqlite3.Connection, original_query_only: int) -> None:
    try:
        _set_query_only(source, bool(original_query_only))
    except BaseException:
        raise CandidateVerificationError("source query-only setting could not be restored") from None


def _rollback_stamp(candidate: sqlite3.Connection) -> None:
    try:
        candidate.execute(f"ROLLBACK TO SAVEPOINT {_STAMP_SAVEPOINT}")
        candidate.execute(f"RELEASE SAVEPOINT {_STAMP_SAVEPOINT}")
    except BaseException:
        raise CandidateVerificationError("candidate stamp rollback failed") from None


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


__all__ = [
    "CandidateVerificationError",
    "CandidateVerificationResult",
    "verify_and_stamp_v7_candidate",
    "verify_v7_candidate",
]
