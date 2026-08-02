"""Copy immutable v6 job events into the exact-v7 migration candidate."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from jobctrl.infrastructure.migrations.identity_upcast import (
    EVENT_IDENTITY_VERSION,
    EventIdentityUpcastError,
    upcast_v6_event_identity,
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
from jobctrl.infrastructure.migrations.v6_to_v7_duplicate_links import (
    DuplicateLinkIdentityResolver,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    assert_v6_migration_preflight,
)

_SOURCE_COLUMNS = (
    "event_id",
    "job_url",
    "stage",
    "event_type",
    "level",
    "message",
    "occurred_at",
    "payload_json",
    "entity_kind",
    "entity_ref",
    "idempotency_key",
)
_TARGET_COLUMNS = (
    "event_id",
    "tenant_id",
    "job_id",
    "identity_version",
    "stage",
    "event_type",
    "level",
    "message",
    "occurred_at",
    "payload_json",
    "entity_kind",
    "entity_ref",
    "idempotency_key",
)


class CandidateEventCopyError(RuntimeError):
    """Raised when historical event identity cannot be copied exactly."""


@dataclass(frozen=True)
class CandidateEventCopyResult:
    """Verified append-only event copy result for the migration coordinator."""

    copied_events: int
    sequence_high_water: int | None


def copy_job_events(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
) -> CandidateEventCopyResult:
    """Copy v6 events into the already-root-copied exact-v7 candidate.

    This is a candidate-only transform. The admitted v6 source is read but
    never rebuilt, altered, or otherwise written by this function.
    """
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_candidate_job_ids(source, candidate, job_ids)
    if _columns(source, "job_events") != _SOURCE_COLUMNS:
        raise CandidateEventCopyError("source job_events columns do not match admitted v6")
    if _columns(candidate, "job_events") != _TARGET_COLUMNS:
        raise CandidateEventCopyError("candidate job_events columns do not match exact v7")
    if _row_count(candidate, "job_events"):
        raise CandidateEventCopyError("candidate job_events must be empty")
    if _sequence_value(candidate, "job_events") is not None:
        raise CandidateEventCopyError("candidate job_events must not have a sequence cursor")

    source_rows = tuple(
        tuple(row)
        for row in source.execute(
            f"SELECT {', '.join(_quote(column) for column in _SOURCE_COLUMNS)} "
            "FROM job_events ORDER BY event_id"
        ).fetchall()
    )
    source_sequence = _sequence_value(source, "job_events")
    duplicate_links = DuplicateLinkIdentityResolver(
        source,
        candidate,
        job_ids=job_ids,
    )
    candidate_rows = _candidate_rows(source_rows, job_ids, duplicate_links)
    _validate_source_sequence(source_rows, source_sequence)

    candidate.execute("SAVEPOINT v6_job_events_candidate_copy")
    try:
        if candidate_rows:
            placeholders = ", ".join("?" for _ in _TARGET_COLUMNS)
            candidate.executemany(
                f"INSERT INTO job_events ({', '.join(_quote(column) for column in _TARGET_COLUMNS)}) "
                f"VALUES ({placeholders})",
                candidate_rows,
            )
        _copy_sequence_cursor(candidate, source_sequence)
        _verify_candidate(
            source=source,
            candidate=candidate,
            expected_source_rows=source_rows,
            expected_candidate_rows=candidate_rows,
            expected_sequence=source_sequence,
        )
        candidate.execute("RELEASE SAVEPOINT v6_job_events_candidate_copy")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_job_events_candidate_copy")
        candidate.execute("RELEASE SAVEPOINT v6_job_events_candidate_copy")
        raise

    return CandidateEventCopyResult(
        copied_events=len(candidate_rows),
        sequence_high_water=source_sequence,
    )


def _assert_candidate_job_ids(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        persisted = build_job_id_map(source, candidate)
    except CandidateCopyError as error:
        raise CandidateEventCopyError("candidate JobIdMap is not hydrated") from error
    if dict(persisted.by_locator) != dict(job_ids.by_locator):
        raise CandidateEventCopyError("candidate JobIdMap does not match root copy")


def _candidate_rows(
    source_rows: tuple[tuple[object, ...], ...],
    job_ids: JobIdMap,
    duplicate_links: DuplicateLinkIdentityResolver,
) -> tuple[tuple[object, ...], ...]:
    copied: list[tuple[object, ...]] = []
    for row in source_rows:
        values = dict(zip(_SOURCE_COLUMNS, row, strict=True))
        try:
            identity = upcast_v6_event_identity(
                job_ids=job_ids,
                duplicate_links=duplicate_links,
                event_type=values["event_type"],
                event_job_locator=values["job_url"],
                payload_json=values["payload_json"],
                entity_kind=values["entity_kind"],
                entity_ref=values["entity_ref"],
            )
        except EventIdentityUpcastError as error:
            raise CandidateEventCopyError(str(error)) from error
        copied.append(
            (
                values["event_id"],
                "local",
                identity.job_id,
                EVENT_IDENTITY_VERSION,
                values["stage"],
                values["event_type"],
                values["level"],
                values["message"],
                values["occurred_at"],
                identity.payload_json,
                values["entity_kind"],
                identity.entity_ref,
                values["idempotency_key"],
            )
        )
    return tuple(copied)


def _validate_source_sequence(
    source_rows: tuple[tuple[object, ...], ...],
    source_sequence: int | None,
) -> None:
    highest_event_id = max((int(row[0]) for row in source_rows), default=0)
    if source_sequence is None:
        if highest_event_id:
            raise CandidateEventCopyError("source job_events is missing its sequence cursor")
        return
    if source_sequence < highest_event_id:
        raise CandidateEventCopyError("source job_events sequence cursor is below its event IDs")


def _copy_sequence_cursor(
    candidate: sqlite3.Connection,
    source_sequence: int | None,
) -> None:
    if source_sequence is None:
        if _sequence_value(candidate, "job_events") is not None:
            raise CandidateEventCopyError("candidate copy synthesized a sequence cursor")
        return
    updated = candidate.execute(
        "UPDATE sqlite_sequence SET seq = ? WHERE name = 'job_events'",
        (source_sequence,),
    )
    if updated.rowcount == 0:
        candidate.execute(
            "INSERT INTO sqlite_sequence(name, seq) VALUES ('job_events', ?)",
            (source_sequence,),
        )


def _verify_candidate(
    *,
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    expected_source_rows: tuple[tuple[object, ...], ...],
    expected_candidate_rows: tuple[tuple[object, ...], ...],
    expected_sequence: int | None,
) -> None:
    candidate_rows = tuple(
        tuple(row)
        for row in candidate.execute(
            f"SELECT {', '.join(_quote(column) for column in _TARGET_COLUMNS)} "
            "FROM job_events ORDER BY event_id"
        ).fetchall()
    )
    if candidate_rows != expected_candidate_rows:
        raise CandidateEventCopyError("candidate copy changed event ordering or scalars")
    if _sequence_value(candidate, "job_events") != expected_sequence:
        raise CandidateEventCopyError("candidate copy changed the event sequence high-water")
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateEventCopyError("candidate copy left a foreign-key violation")
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    source_rows_after = tuple(
        tuple(row)
        for row in source.execute(
            f"SELECT {', '.join(_quote(column) for column in _SOURCE_COLUMNS)} "
            "FROM job_events ORDER BY event_id"
        ).fetchall()
    )
    if source_rows_after != expected_source_rows:
        raise CandidateEventCopyError("candidate copy mutated the v6 source events")


def _columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    rows = conn.execute(f"PRAGMA table_info({_quote(table)})").fetchall()
    if not rows:
        raise CandidateEventCopyError(f"missing required table: {table}")
    return tuple(str(row[1]) for row in rows)


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_quote(table)}").fetchone()[0])


def _sequence_value(conn: sqlite3.Connection, table: str) -> int | None:
    row = conn.execute("SELECT seq FROM sqlite_sequence WHERE name = ?", (table,)).fetchone()
    return None if row is None else int(row[0])


def _quote(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


__all__ = [
    "CandidateEventCopyError",
    "CandidateEventCopyResult",
    "copy_job_events",
]
