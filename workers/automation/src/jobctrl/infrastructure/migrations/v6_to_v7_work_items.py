"""Structured v6-to-v7 candidate copy for quarantine and preparation rows."""

from __future__ import annotations

import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.preparation import (
    PreparationWorkItemKind,
    make_preparation_idempotency_key,
)
from jobctrl.domain.tenant import TenantId
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


class CandidateWorkItemsCopyError(RuntimeError):
    """Raised when structured work-item rows cannot safely enter the candidate."""


@dataclass(frozen=True)
class CandidateWorkItemsCopyResult:
    """Counts of structured rows copied into the exact-v7 candidate."""

    copied_quarantine_entries: int
    copied_preparation_work_items: int


_SOURCE_QUARANTINE_COLUMNS = (
    "tenant_id",
    "job_id",
    "job_key",
    "title",
    "company",
    "source_id",
    "posting_url",
    "reason",
    "confidence",
    "snapshot_version",
    "captured_at",
    "notice_text",
    "status",
    "decision_reason",
    "decided_at",
)
_TARGET_QUARANTINE_COLUMNS = tuple(
    column for column in _SOURCE_QUARANTINE_COLUMNS if column != "job_key"
)
_WORK_ITEM_COLUMNS = (
    "item_id",
    "tenant_id",
    "job_id",
    "kind",
    "target_version",
    "source_event_id",
    "state",
    "idempotency_key",
    "attempts",
    "last_error",
    "created_at",
    "updated_at",
    "available_at",
)


def copy_structured_work_items(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
) -> CandidateWorkItemsCopyResult:
    """Copy the two structured work-item tables into a hydrated v7 candidate.

    This copier deliberately accepts the root-copy result rather than rebuilding
    identity from v6 rows. It independently verifies that the supplied map is
    the exact map already represented by candidate roots before any child row
    is written.
    """
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_authoritative_roots(source, candidate, job_ids)
    _assert_empty_target_tables(candidate)
    _assert_columns(
        source,
        "discovery_quarantine_entries",
        _SOURCE_QUARANTINE_COLUMNS,
    )
    _assert_columns(
        candidate,
        "discovery_quarantine_entries",
        _TARGET_QUARANTINE_COLUMNS,
    )
    _assert_columns(source, "preparation_work_items", _WORK_ITEM_COLUMNS)
    _assert_columns(candidate, "preparation_work_items", _WORK_ITEM_COLUMNS)

    quarantine_rows = _source_rows(
        source,
        "discovery_quarantine_entries",
        _SOURCE_QUARANTINE_COLUMNS,
    )
    work_item_rows = _source_rows(
        source,
        "preparation_work_items",
        _WORK_ITEM_COLUMNS,
    )

    candidate.execute("SAVEPOINT v6_structured_work_items_copy")
    try:
        _copy_quarantine_entries(candidate, quarantine_rows, job_ids)
        _copy_preparation_work_items(candidate, work_item_rows, job_ids)
        _verify_copy_counts(
            candidate,
            quarantine_entries=len(quarantine_rows),
            preparation_work_items=len(work_item_rows),
        )
        _verify_foreign_keys(candidate)
        candidate.execute("RELEASE SAVEPOINT v6_structured_work_items_copy")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_structured_work_items_copy")
        candidate.execute("RELEASE SAVEPOINT v6_structured_work_items_copy")
        raise

    return CandidateWorkItemsCopyResult(
        copied_quarantine_entries=len(quarantine_rows),
        copied_preparation_work_items=len(work_item_rows),
    )


def _assert_authoritative_roots(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        candidate_job_ids = build_job_id_map(source, candidate)
    except CandidateCopyError as error:
        raise CandidateWorkItemsCopyError(
            "structured work-item copy requires hydrated candidate roots"
        ) from error
    if dict(candidate_job_ids.by_locator) != dict(job_ids.by_locator):
        raise CandidateWorkItemsCopyError(
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
    if (
        current_locators != dict(job_ids.by_locator)
        or _row_count(candidate, "job_locators") != len(current_locators)
    ):
        raise CandidateWorkItemsCopyError(
            "structured work-item copy requires hydrated candidate root locators"
        )


def _assert_empty_target_tables(candidate: sqlite3.Connection) -> None:
    for table in ("discovery_quarantine_entries", "preparation_work_items"):
        if _row_count(candidate, table):
            raise CandidateWorkItemsCopyError(
                f"candidate table must be empty: {table}"
            )


def _copy_quarantine_entries(
    candidate: sqlite3.Connection,
    source_rows: tuple[Mapping[str, object], ...],
    job_ids: JobIdMap,
) -> None:
    target_rows: list[tuple[object, ...]] = []
    for row in source_rows:
        tenant_id = _tenant_id(row["tenant_id"])
        legacy_job_id = _legacy_locator(row["job_id"], "quarantine job_id")
        legacy_job_key = _legacy_locator(row["job_key"], "quarantine job_key")
        if legacy_job_id != legacy_job_key:
            raise CandidateWorkItemsCopyError(
                "v6 quarantine job_id and job_key disagree"
            )
        job_id = _resolve_job_id(job_ids, tenant_id, legacy_job_id)
        posting_url = _optional_locator(row["posting_url"], "quarantine posting_url")
        target_rows.append(
            (
                tenant_id,
                job_id,
                row["title"],
                row["company"],
                row["source_id"],
                posting_url,
                row["reason"],
                row["confidence"],
                row["snapshot_version"],
                row["captured_at"],
                row["notice_text"],
                row["status"],
                row["decision_reason"],
                row["decided_at"],
            )
        )
    _insert_rows(
        candidate,
        "discovery_quarantine_entries",
        _TARGET_QUARANTINE_COLUMNS,
        target_rows,
    )


def _copy_preparation_work_items(
    candidate: sqlite3.Connection,
    source_rows: tuple[Mapping[str, object], ...],
    job_ids: JobIdMap,
) -> None:
    target_rows: list[tuple[object, ...]] = []
    for row in source_rows:
        tenant_id = _tenant_id(row["tenant_id"])
        job_id = _resolve_job_id(
            job_ids,
            tenant_id,
            _legacy_locator(row["job_id"], "preparation work-item job_id"),
        )
        kind = _work_item_kind(row["kind"])
        target_version = _nonnegative_integer(row["target_version"], "target_version")
        source_event_id = _text(
            row["source_event_id"],
            "source_event_id",
            allow_empty=True,
        )
        state = _work_item_state(row["state"])
        target_rows.append(
            (
                _required_text(row["item_id"], "item_id"),
                tenant_id,
                job_id,
                kind.value,
                target_version,
                source_event_id,
                state,
                make_preparation_idempotency_key(
                    tenant_id=TenantId(tenant_id),
                    job_id=JobId(job_id),
                    kind=kind,
                    target_version=target_version,
                    source_event_id=source_event_id,
                ),
                _nonnegative_integer(row["attempts"], "attempts"),
                _text(row["last_error"], "last_error", allow_empty=True),
                _required_text(row["created_at"], "created_at"),
                _required_text(row["updated_at"], "updated_at"),
                _required_text(row["available_at"], "available_at"),
            )
        )
    _insert_rows(
        candidate,
        "preparation_work_items",
        _WORK_ITEM_COLUMNS,
        target_rows,
    )


def _verify_copy_counts(
    candidate: sqlite3.Connection,
    *,
    quarantine_entries: int,
    preparation_work_items: int,
) -> None:
    expected = {
        "discovery_quarantine_entries": quarantine_entries,
        "preparation_work_items": preparation_work_items,
    }
    for table, expected_count in expected.items():
        if _row_count(candidate, table) != expected_count:
            raise CandidateWorkItemsCopyError(
                f"candidate copy changed row count for {table}"
            )


def _verify_foreign_keys(candidate: sqlite3.Connection) -> None:
    violations = candidate.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise CandidateWorkItemsCopyError(
            "candidate structured work-item copy left a foreign-key violation: "
            f"{tuple(violations[0])!r}"
        )


def _source_rows(
    source: sqlite3.Connection,
    table: str,
    columns: tuple[str, ...],
) -> tuple[Mapping[str, object], ...]:
    rows = source.execute(
        f"SELECT {_identifiers(columns)} FROM {_identifier(table)} ORDER BY rowid"
    ).fetchall()
    return tuple(dict(zip(columns, row, strict=True)) for row in rows)


def _insert_rows(
    candidate: sqlite3.Connection,
    table: str,
    columns: tuple[str, ...],
    rows: list[tuple[object, ...]],
) -> None:
    if not rows:
        return
    placeholders = ", ".join("?" for _ in columns)
    candidate.executemany(
        f"INSERT INTO {_identifier(table)} ({_identifiers(columns)}) "
        f"VALUES ({placeholders})",
        rows,
    )


def _resolve_job_id(job_ids: JobIdMap, tenant_id: str, locator: str) -> str:
    try:
        resolved = job_ids.resolve(tenant_id=tenant_id, locator=locator)
    except CandidateCopyError as error:
        raise CandidateWorkItemsCopyError(
            f"cannot resolve legacy job locator: {locator!r}"
        ) from error
    if resolved is None:
        raise CandidateWorkItemsCopyError(
            f"cannot resolve legacy job locator: {locator!r}"
        )
    return str(resolved)


def _work_item_kind(value: object) -> PreparationWorkItemKind:
    try:
        return PreparationWorkItemKind(_required_text(value, "kind"))
    except ValueError as error:
        raise CandidateWorkItemsCopyError("preparation work item has invalid kind") from error


_VALID_WORK_ITEM_STATES = frozenset({"queued", "running", "completed", "failed"})


def _work_item_state(value: object) -> str:
    state = _required_text(value, "state")
    if state not in _VALID_WORK_ITEM_STATES:
        raise CandidateWorkItemsCopyError("preparation work item has invalid state")
    return state


def _nonnegative_integer(value: object, column: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CandidateWorkItemsCopyError(
            f"preparation work item has invalid {column}"
        )
    return value


def _tenant_id(value: object) -> str:
    if value is None:
        return "local"
    tenant_id = _text(value, "tenant_id", allow_empty=True)
    return tenant_id or "local"


def _legacy_locator(value: object, column: str) -> str:
    locator = _required_text(value, column)
    if locator != locator.strip():
        raise CandidateWorkItemsCopyError(f"malformed legacy locator: {column}")
    return locator


def _optional_locator(value: object, column: str) -> str | None:
    if value is None:
        return None
    return _legacy_locator(value, column)


def _required_text(value: object, column: str) -> str:
    return _text(value, column, allow_empty=False)


def _text(value: object, column: str, *, allow_empty: bool) -> str:
    if not isinstance(value, str):
        raise CandidateWorkItemsCopyError(f"malformed {column}")
    if not allow_empty and not value:
        raise CandidateWorkItemsCopyError(f"malformed {column}")
    return value


def _assert_columns(
    conn: sqlite3.Connection,
    table: str,
    expected: tuple[str, ...],
) -> None:
    observed = tuple(
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({_identifier(table)})").fetchall()
    )
    if observed != expected:
        raise CandidateWorkItemsCopyError(
            f"candidate copy found unexpected columns for {table}"
        )


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return int(
        conn.execute(f"SELECT COUNT(*) FROM {_identifier(table)}").fetchone()[0]
    )


def _identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def _identifiers(values: tuple[str, ...]) -> str:
    return ", ".join(_identifier(value) for value in values)


__all__ = [
    "CandidateWorkItemsCopyError",
    "CandidateWorkItemsCopyResult",
    "copy_structured_work_items",
]
