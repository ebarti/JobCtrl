"""Populate an unstamped exact-v7 candidate from an admitted v6 database."""

from __future__ import annotations

import hashlib
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Protocol

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v7 import (
    create_unstamped_exact_v7_candidate,
)
from jobctrl.infrastructure.migrations.v6_to_v7_plan import target_tables
from jobctrl.infrastructure.migrations.v6_to_v7_population_steps import (
    CANDIDATE_POPULATION_STEPS,
    CandidatePopulationArgumentProfile,
    CandidatePopulationStep,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    assert_v6_migration_preflight,
)

_OUTER_SAVEPOINT: Final = "v6_to_v7_candidate_population"


class _Digest(Protocol):
    def update(self, data: bytes, /) -> object: ...


class CandidatePopulationError(RuntimeError):
    """Raised when candidate population cannot satisfy its closed contract."""


@dataclass(frozen=True)
class CandidatePopulationStepReceipt:
    """Metadata-only record of one completed candidate population writer."""

    step_id: str
    owned_tables: tuple[str, ...]
    table_row_counts: tuple[tuple[str, int], ...]


@dataclass(frozen=True)
class CandidatePopulationResult:
    """Metadata-only result for an unstamped, validated v7 candidate."""

    migration_at: str
    steps: tuple[CandidatePopulationStepReceipt, ...]
    table_row_counts: tuple[tuple[str, int], ...]
    event_sequence_high_water: int | None


def populate_v7_candidate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    migration_at: str,
    job_id_factory: Callable[[], str] | None = None,
    _after_step: Callable[[str], None] | None = None,
) -> CandidatePopulationResult:
    """Populate and verify an unstamped exact-v7 candidate atomically.

    The returned receipts deliberately contain only table names, counts, and
    the primitive event sequence cursor.  They never retain source rows,
    locators, or the transient JobId map used by the transforms.
    """
    _assert_raw_candidate(source, candidate)
    assert_v6_migration_preflight(source)

    source_total_changes = source.total_changes
    source_digest = _logical_digest(source)
    source_query_only = int(source.execute("PRAGMA query_only").fetchone()[0])
    source_query_only_restored = False
    source.execute("PRAGMA query_only = ON")
    try:
        candidate.execute(f"SAVEPOINT {_OUTER_SAVEPOINT}")
        try:
            create_unstamped_exact_v7_candidate(candidate)
            receipts, event_sequence_high_water = _run_population_steps(
                source,
                candidate,
                migration_at=migration_at,
                job_id_factory=job_id_factory,
                after_step=_after_step,
            )
            final_counts = _target_table_counts(candidate)
            _assert_final_candidate(
                source=source,
                candidate=candidate,
                source_total_changes=source_total_changes,
                source_digest=source_digest,
                receipts=receipts,
                final_counts=final_counts,
            )
            source.execute(f"PRAGMA query_only = {source_query_only}")
            source_query_only_restored = True
            candidate.execute(f"RELEASE SAVEPOINT {_OUTER_SAVEPOINT}")
        except BaseException:
            candidate.execute(f"ROLLBACK TO SAVEPOINT {_OUTER_SAVEPOINT}")
            candidate.execute(f"RELEASE SAVEPOINT {_OUTER_SAVEPOINT}")
            raise
    finally:
        if not source_query_only_restored:
            source.execute(f"PRAGMA query_only = {source_query_only}")

    return CandidatePopulationResult(
        migration_at=migration_at,
        steps=receipts,
        table_row_counts=final_counts,
        event_sequence_high_water=event_sequence_high_water,
    )


def _assert_raw_candidate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> None:
    if source is candidate:
        raise CandidatePopulationError("source and candidate must be distinct")
    if source.in_transaction or candidate.in_transaction:
        raise CandidatePopulationError("candidate population requires connections without active transactions")
    if candidate.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone() is not None:
        raise CandidatePopulationError("candidate population requires a raw empty schema")
    if int(candidate.execute("PRAGMA user_version").fetchone()[0]) != 0:
        raise CandidatePopulationError("candidate population requires candidate user_version 0")


def _run_population_steps(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    migration_at: str,
    job_id_factory: Callable[[], str] | None,
    after_step: Callable[[str], None] | None,
) -> tuple[tuple[CandidatePopulationStepReceipt, ...], int | None]:
    receipts: list[CandidatePopulationStepReceipt] = []
    job_ids: object | None = None
    event_sequence_high_water: int | None = None

    for step in CANDIDATE_POPULATION_STEPS:
        result = _run_step(
            step,
            source,
            candidate,
            job_ids=job_ids,
            migration_at=migration_at,
            job_id_factory=job_id_factory,
        )
        if step.argument_profile is CandidatePopulationArgumentProfile.ROOT:
            job_ids = _root_job_ids(result)
        if step.step_id == "events":
            event_sequence_high_water = _event_sequence_high_water(result)

        receipt = CandidatePopulationStepReceipt(
            step_id=step.step_id,
            owned_tables=tuple(sorted(step.owned_tables)),
            table_row_counts=_table_counts(candidate, step.owned_tables),
        )
        receipts.append(receipt)
        if after_step is not None:
            after_step(step.step_id)

    return tuple(receipts), event_sequence_high_water


def _run_step(
    step: CandidatePopulationStep,
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: object | None,
    migration_at: str,
    job_id_factory: Callable[[], str] | None,
) -> object:
    if step.argument_profile is CandidatePopulationArgumentProfile.PLAIN:
        return step.writer(source, candidate)
    if step.argument_profile is CandidatePopulationArgumentProfile.ROOT:
        return step.writer(
            source,
            candidate,
            job_id_factory=job_id_factory,
            migration_at=migration_at,
        )
    if job_ids is None:
        raise CandidatePopulationError("candidate population is missing root JobIds")
    if step.argument_profile is CandidatePopulationArgumentProfile.JOB_IDS:
        return step.writer(source, candidate, job_ids=job_ids)
    if step.argument_profile is CandidatePopulationArgumentProfile.JOB_IDS_AND_MIGRATION_AT:
        return step.writer(
            source,
            candidate,
            job_ids=job_ids,
            migration_at=migration_at,
        )
    raise CandidatePopulationError("candidate population has an unknown step profile")


def _root_job_ids(result: object) -> object:
    job_ids = getattr(result, "job_ids", None)
    if job_ids is None:
        raise CandidatePopulationError("root population did not produce JobIds")
    return job_ids


def _event_sequence_high_water(result: object) -> int | None:
    sequence_high_water = getattr(result, "sequence_high_water", None)
    if sequence_high_water is None:
        return None
    if isinstance(sequence_high_water, bool) or not isinstance(sequence_high_water, int):
        raise CandidatePopulationError("event population returned an invalid sequence")
    return sequence_high_water


def _assert_final_candidate(
    *,
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    source_total_changes: int,
    source_digest: str,
    receipts: tuple[CandidatePopulationStepReceipt, ...],
    final_counts: tuple[tuple[str, int], ...],
) -> None:
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    if int(candidate.execute("PRAGMA user_version").fetchone()[0]) != 0:
        raise CandidatePopulationError("candidate population must leave user_version 0")
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidatePopulationError("candidate population left foreign-key violations")
    if tuple(candidate.execute("PRAGMA integrity_check").fetchall()) != (("ok",),):
        raise CandidatePopulationError("candidate population failed integrity_check")
    receipt_counts = tuple(sorted((table, count) for receipt in receipts for table, count in receipt.table_row_counts))
    if final_counts != receipt_counts:
        raise CandidatePopulationError("candidate population final table counts differ from step receipts")
    if source.total_changes != source_total_changes or _logical_digest(source) != source_digest:
        raise CandidatePopulationError("candidate population altered the v6 source")


def _target_table_counts(candidate: sqlite3.Connection) -> tuple[tuple[str, int], ...]:
    return _table_counts(candidate, target_tables())


def _table_counts(
    conn: sqlite3.Connection,
    tables: frozenset[str],
) -> tuple[tuple[str, int], ...]:
    return tuple(
        (
            table,
            int(conn.execute(f"SELECT COUNT(*) FROM {_quote_identifier(table)}").fetchone()[0]),
        )
        for table in sorted(tables)
    )


def _logical_digest(conn: sqlite3.Connection) -> str:
    """Hash schema and durable values without interpreting stored content."""
    digest = hashlib.sha256()
    _digest_value(digest, int(conn.execute("PRAGMA user_version").fetchone()[0]))
    dump = schema_dump(conn)
    _digest_value(digest, dump)
    for object_type, table, _, _ in dump:
        if object_type != "table":
            continue
        columns = _table_columns(conn, table)
        _digest_value(digest, table)
        _digest_value(digest, columns)
        select_columns = ", ".join(_quote_identifier(column) for column in columns)
        order_by = ", ".join(_quote_identifier(column) for column in columns)
        rows = conn.execute(f"SELECT {select_columns} FROM {_quote_identifier(table)} ORDER BY {order_by}")
        for row in rows:
            _digest_value(digest, tuple(row))
    _digest_value(digest, _sequence_rows(conn))
    return digest.hexdigest()


def _table_columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    return tuple(str(row[1]) for row in conn.execute(f"PRAGMA table_info({_quote_identifier(table)})"))


def _sequence_rows(conn: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").fetchone()
    if exists is None:
        return ()
    return tuple(tuple(row) for row in conn.execute("SELECT name, seq FROM sqlite_sequence ORDER BY name"))


def _digest_value(digest: _Digest, value: object) -> None:
    if value is None:
        encoded = b"n"
    elif isinstance(value, bytes):
        encoded = b"b" + value
    elif isinstance(value, str):
        encoded = b"s" + value.encode("utf-8")
    elif isinstance(value, int):
        encoded = b"i" + str(value).encode("ascii")
    elif isinstance(value, float):
        encoded = b"f" + value.hex().encode("ascii")
    elif isinstance(value, tuple):
        encoded = b"t"
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
        for item in value:
            _digest_value(digest, item)
        return
    else:
        raise CandidatePopulationError("source contains an unsupported SQLite value")
    digest.update(len(encoded).to_bytes(8, "big"))
    digest.update(encoded)


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


__all__ = [
    "CandidatePopulationError",
    "CandidatePopulationResult",
    "CandidatePopulationStepReceipt",
    "populate_v7_candidate",
]
