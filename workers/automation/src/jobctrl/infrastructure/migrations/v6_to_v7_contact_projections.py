"""Candidate copy for v6 contact-and-outreach projection rows."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable, Mapping
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


class CandidateContactProjectionsCopyError(RuntimeError):
    """Raised when contact projection rows cannot safely enter v7."""


@dataclass(frozen=True)
class CandidateContactProjectionsCopyResult:
    """Counts of contact-and-outreach projection rows copied into v7."""

    copied_contact_projections: int
    copied_contact_research_task_projections: int
    copied_due_follow_up_projections: int
    copied_outreach_thread_projections: int


JsonItemValidator = Callable[[object], bool]


@dataclass(frozen=True)
class _ProjectionTable:
    name: str
    columns: tuple[str, ...]
    json_item_validators: Mapping[str, JsonItemValidator]


_CONTACT_PROJECTION_COLUMNS = (
    "tenant_id",
    "contact_id",
    "employer",
    "job_id",
    "role",
    "attribute_count",
    "confirmed_count",
    "source_kinds_json",
    "provenance_json",
    "created_at",
    "updated_at",
    "last_updated_at",
)
_CONTACT_RESEARCH_TASK_PROJECTION_COLUMNS = (
    "tenant_id",
    "task_id",
    "employer",
    "job_id",
    "status",
    "candidate_count",
    "needs_review_count",
    "confirmed_count",
    "source_attempts_json",
    "candidates_json",
    "started_at",
    "updated_at",
    "needs_review_at",
    "completed_at",
    "failed_at",
    "error_class",
    "last_updated_at",
)
_DUE_FOLLOW_UP_PROJECTION_COLUMNS = (
    "tenant_id",
    "thread_id",
    "contact_id",
    "job_id",
    "due_at",
    "basis",
    "state",
    "created_at",
    "updated_at",
    "last_updated_at",
)
_OUTREACH_THREAD_PROJECTION_COLUMNS = (
    "tenant_id",
    "thread_id",
    "contact_id",
    "job_id",
    "draft_count",
    "latest_generation",
    "has_approved_draft",
    "approved_draft_id",
    "latest_status",
    "drafts_json",
    "created_at",
    "updated_at",
    "last_updated_at",
)


def copy_contact_projections(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
) -> CandidateContactProjectionsCopyResult:
    """Copy the four closed-shape contact projections into a hydrated v7 candidate.

    The v6 and v7 table layouts are identical, but the legacy values of each
    same-named ``job_id`` column are posting URLs.  The JSON fields are closed
    projection shapes whose production builders carry no job identity; unknown
    shapes fail closed instead of preserving an un-upcast reference.
    """
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_authoritative_roots(source, candidate, job_ids)
    _assert_empty_target_tables(candidate)
    for table in _PROJECTION_TABLES:
        _assert_columns(source, table.name, table.columns)
        _assert_columns(candidate, table.name, table.columns)

    source_rows = {
        table.name: _source_rows(source, table.name, table.columns)
        for table in _PROJECTION_TABLES
    }

    candidate.execute("SAVEPOINT v6_contact_projections_copy")
    try:
        for table in _PROJECTION_TABLES:
            _copy_table(candidate, table, source_rows[table.name], job_ids)
        _verify_copy_counts(candidate, source_rows)
        _verify_foreign_keys(candidate)
        candidate.execute("RELEASE SAVEPOINT v6_contact_projections_copy")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_contact_projections_copy")
        candidate.execute("RELEASE SAVEPOINT v6_contact_projections_copy")
        raise

    return CandidateContactProjectionsCopyResult(
        copied_contact_projections=len(source_rows["contact_projections"]),
        copied_contact_research_task_projections=len(
            source_rows["contact_research_task_projections"]
        ),
        copied_due_follow_up_projections=len(source_rows["due_follow_up_projections"]),
        copied_outreach_thread_projections=len(
            source_rows["outreach_thread_projections"]
        ),
    )


def _assert_authoritative_roots(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        candidate_job_ids = build_job_id_map(source, candidate)
    except CandidateCopyError as error:
        raise CandidateContactProjectionsCopyError(
            "contact projection copy requires hydrated candidate roots"
        ) from error
    if dict(candidate_job_ids.by_locator) != dict(job_ids.by_locator):
        raise CandidateContactProjectionsCopyError(
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
        raise CandidateContactProjectionsCopyError(
            "contact projection copy requires hydrated candidate root locators"
        )


def _assert_empty_target_tables(candidate: sqlite3.Connection) -> None:
    for table in _PROJECTION_TABLES:
        if _row_count(candidate, table.name):
            raise CandidateContactProjectionsCopyError(
                f"candidate table must be empty: {table.name}"
            )


def _copy_table(
    candidate: sqlite3.Connection,
    table: _ProjectionTable,
    source_rows: tuple[Mapping[str, object], ...],
    job_ids: JobIdMap,
) -> None:
    copied_rows: list[tuple[object, ...]] = []
    for row in source_rows:
        tenant_id = _tenant_id(row["tenant_id"])
        job_id = _resolve_optional_job_id(job_ids, tenant_id, row["job_id"])
        for column, item_validator in table.json_item_validators.items():
            _validate_json_array(row[column], f"{table.name}.{column}", item_validator)
        copied_row = dict(row)
        copied_row["tenant_id"] = tenant_id
        copied_row["job_id"] = job_id
        copied_rows.append(
            tuple(copied_row[column] for column in table.columns)
        )
    _insert_rows(candidate, table.name, table.columns, copied_rows)


def _verify_copy_counts(
    candidate: sqlite3.Connection,
    source_rows: Mapping[str, tuple[Mapping[str, object], ...]],
) -> None:
    for table in _PROJECTION_TABLES:
        if _row_count(candidate, table.name) != len(source_rows[table.name]):
            raise CandidateContactProjectionsCopyError(
                f"candidate copy changed row count for {table.name}"
            )


def _verify_foreign_keys(candidate: sqlite3.Connection) -> None:
    violations = candidate.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise CandidateContactProjectionsCopyError(
            "candidate contact projection copy left a foreign-key violation: "
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


def _resolve_optional_job_id(
    job_ids: JobIdMap,
    tenant_id: str,
    value: object,
) -> str | None:
    if value is None:
        return None
    locator = _legacy_locator(value, "projection job_id")
    try:
        resolved = job_ids.resolve(tenant_id=tenant_id, locator=locator)
    except CandidateCopyError as error:
        raise CandidateContactProjectionsCopyError(
            f"cannot resolve legacy job locator: {locator!r}"
        ) from error
    if resolved is None:
        raise CandidateContactProjectionsCopyError(
            f"cannot resolve legacy job locator: {locator!r}"
        )
    return str(resolved)


def _tenant_id(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise CandidateContactProjectionsCopyError("malformed tenant_id")
    return value


def _legacy_locator(value: object, column: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise CandidateContactProjectionsCopyError(
            f"malformed legacy locator: {column}"
        )
    return value


def _validate_json_array(
    value: object,
    column: str,
    item_validator: JsonItemValidator,
) -> None:
    if not isinstance(value, str):
        raise CandidateContactProjectionsCopyError(
            f"unsupported projection JSON shape: {column}"
        )
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise CandidateContactProjectionsCopyError(
            f"unsupported projection JSON shape: {column}"
        ) from error
    if not isinstance(parsed, list):
        raise CandidateContactProjectionsCopyError(
            f"unsupported projection JSON shape: {column}"
        )
    if not all(item_validator(item) for item in parsed):
        raise CandidateContactProjectionsCopyError(
            f"unsupported projection JSON shape: {column}"
        )


def _object_item(shape: Mapping[str, JsonItemValidator]) -> JsonItemValidator:
    expected_keys = frozenset(shape)

    def _matches(value: object) -> bool:
        return isinstance(value, dict) and frozenset(value) == expected_keys and all(
            validator(value[key]) for key, validator in shape.items()
        )

    return _matches


def _is_string(value: object) -> bool:
    return isinstance(value, str)


def _is_optional_string(value: object) -> bool:
    return value is None or isinstance(value, str)


def _is_number(value: object) -> bool:
    return not isinstance(value, bool) and isinstance(value, int | float)


def _is_integer(value: object) -> bool:
    return not isinstance(value, bool) and isinstance(value, int)


def _is_boolean(value: object) -> bool:
    return isinstance(value, bool)


def _is_string_list(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


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
        raise CandidateContactProjectionsCopyError(
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


_PROJECTION_TABLES = (
    _ProjectionTable(
        "contact_projections",
        _CONTACT_PROJECTION_COLUMNS,
        {
            "source_kinds_json": _is_string,
            "provenance_json": _object_item(
                {
                    "attributeId": _is_string,
                    "attributeKind": _is_string,
                    "sourceKind": _is_string,
                    "sourceRef": _is_string,
                    "captureMethod": _is_string,
                    "confidence": _is_number,
                    "userConfirmed": _is_boolean,
                    "recordedAt": _is_string,
                }
            ),
        },
    ),
    _ProjectionTable(
        "contact_research_task_projections",
        _CONTACT_RESEARCH_TASK_PROJECTION_COLUMNS,
        {
            "source_attempts_json": _object_item(
                {
                    "sourceKind": _is_string,
                    "sourceRef": _is_string,
                    "outcome": _is_string,
                    "attemptedAt": _is_string,
                    "detail": _is_string,
                }
            ),
            "candidates_json": _object_item(
                {
                    "candidateId": _is_string,
                    "role": _is_string,
                    "sourceKind": _is_string,
                    "sourceRef": _is_string,
                    "captureMethod": _is_string,
                    "confidence": _is_number,
                    "status": _is_string,
                    "proposedAt": _is_string,
                    "confirmedContactId": _is_optional_string,
                    "confirmedAt": _is_optional_string,
                    "attributeKinds": _is_string_list,
                }
            ),
        },
    ),
    _ProjectionTable(
        "due_follow_up_projections",
        _DUE_FOLLOW_UP_PROJECTION_COLUMNS,
        {},
    ),
    _ProjectionTable(
        "outreach_thread_projections",
        _OUTREACH_THREAD_PROJECTION_COLUMNS,
        {
            "drafts_json": _object_item(
                {
                    "draftId": _is_string,
                    "generation": _is_integer,
                    "kind": _is_string,
                    "status": _is_string,
                    "gatePassed": _is_boolean,
                    "createdAt": _is_string,
                    "approvedAt": _is_optional_string,
                    "rejectedAt": _is_optional_string,
                }
            )
        },
    ),
)


__all__ = [
    "CandidateContactProjectionsCopyError",
    "CandidateContactProjectionsCopyResult",
    "copy_contact_projections",
]
