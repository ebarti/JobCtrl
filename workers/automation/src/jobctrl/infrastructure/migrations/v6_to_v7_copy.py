"""Manifest-driven copy of the non-structured v6-to-v7 candidate tables."""

from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_plan import (
    ColumnRole,
    TABLE_PLANS,
    TableDisposition,
    classify_column,
)


class CandidateCopyError(RuntimeError):
    """Raised when a candidate copy would lose or reinterpret durable data."""


@dataclass(frozen=True)
class JobIdMap:
    """Legacy posting locators mapped to JobIds already written to the candidate."""

    by_locator: Mapping[tuple[str, str], str]

    def resolve(self, *, tenant_id: str, locator: object) -> str | None:
        if locator is None or not str(locator).strip():
            return None
        try:
            return self.by_locator[(tenant_id, str(locator))]
        except KeyError as error:
            raise CandidateCopyError(
                "candidate copy cannot resolve a legacy job locator for "
                f"tenant {tenant_id!r}: {locator!r}"
            ) from error


def build_job_id_map(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> JobIdMap:
    """Verify the candidate root rewrite and expose its locator-to-JobId map."""
    source_columns = _columns(source, "jobs")
    if "url" not in source_columns:
        raise CandidateCopyError("candidate copy requires the v6 jobs.url identity")
    tenant_expression = "tenant_id" if "tenant_id" in source_columns else "'local'"
    source_locators = {
        (_tenant_id(tenant), str(locator or "").strip())
        for tenant, locator in source.execute(
            f"SELECT {tenant_expression}, url FROM jobs ORDER BY rowid"
        ).fetchall()
    }
    if any(not locator for _, locator in source_locators):
        raise CandidateCopyError("candidate copy found a source job with no posting URL")

    values: dict[tuple[str, str], str] = {}
    rows = candidate.execute(
        "SELECT tenant_id, url, job_id FROM jobs ORDER BY tenant_id, url"
    ).fetchall()
    for tenant, locator, job_id in rows:
        normalized_tenant = _tenant_id(tenant)
        normalized_locator = str(locator or "").strip()
        normalized_job_id = str(job_id or "").strip().lower()
        if not normalized_locator:
            raise CandidateCopyError("candidate copy found a job with no posting URL")
        try:
            if str(uuid.UUID(normalized_job_id)) != normalized_job_id:
                raise ValueError("not canonical")
        except ValueError as error:
            raise CandidateCopyError(
                "candidate copy found a non-canonical JobId for "
                f"{normalized_locator!r}"
            ) from error
        key = (normalized_tenant, normalized_locator)
        if key in values and values[key] != normalized_job_id:
            raise CandidateCopyError(
                "candidate copy found conflicting JobIds for "
                f"{normalized_locator!r}"
            )
        values[key] = normalized_job_id
    if set(values) != source_locators:
        raise CandidateCopyError(
            "candidate copy requires an exact hydrated canonical jobs table"
        )
    return JobIdMap(MappingProxyType(values))


def copy_direct_and_scalar_tables(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> tuple[str, ...]:
    """Copy only declared direct/scalar tables into a hydrated exact-v7 candidate.

    The caller owns the root ``jobs`` and ``job_locators`` structured rewrite.
    Requiring its completed job rows here prevents copied references from being
    detached from the canonical aggregate.
    """
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    job_ids = build_job_id_map(source, candidate)
    _validate_source_inventory(source)

    tables = tuple(
        name
        for name, plan in TABLE_PLANS.items()
        if plan.disposition
        in {
            TableDisposition.DIRECT_COPY,
            TableDisposition.SCALAR_JOB_ID_REWRITE,
        }
    )
    ordered_tables = _copy_order(candidate, tables)

    candidate.execute("SAVEPOINT v6_direct_scalar_copy")
    try:
        for table in ordered_tables:
            _copy_table(source, candidate, table, job_ids)
        violations = candidate.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise CandidateCopyError(
                "candidate copy left a foreign-key violation: "
                f"{tuple(violations[0])!r}"
            )
        candidate.execute("RELEASE SAVEPOINT v6_direct_scalar_copy")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_direct_scalar_copy")
        candidate.execute("RELEASE SAVEPOINT v6_direct_scalar_copy")
        raise
    return ordered_tables


def _validate_source_inventory(source: sqlite3.Connection) -> None:
    present = _table_names(source)
    allowed = {name for name, plan in TABLE_PLANS.items() if plan.source_exists}
    unexpected = sorted(present - allowed)
    if unexpected:
        raise CandidateCopyError(
            f"candidate copy found unclassified source tables: {unexpected!r}"
        )

    missing = sorted(
        name
        for name, plan in TABLE_PLANS.items()
        if plan.source_required and name not in present
    )
    if missing:
        raise CandidateCopyError(
            f"candidate copy is missing required source tables: {missing!r}"
        )

    for name, plan in TABLE_PLANS.items():
        if (
            plan.disposition is TableDisposition.RETIRED
            and name in present
            and _row_count(source, name)
        ):
            raise CandidateCopyError(
                f"candidate copy found nonempty retired table: {name}"
            )


def _copy_order(
    candidate: sqlite3.Connection,
    tables: Iterable[str],
) -> tuple[str, ...]:
    pending = set(tables)
    dependencies = {
        table: {
            str(row[2])
            for row in candidate.execute(
                f"PRAGMA foreign_key_list({_identifier(table)})"
            ).fetchall()
            if str(row[2]) in pending
        }
        for table in pending
    }
    ordered: list[str] = []
    while pending:
        ready = sorted(
            table for table in pending if not dependencies[table] & pending
        )
        if not ready:
            raise CandidateCopyError(
                "candidate copy cannot order manifest tables with cyclic foreign keys"
            )
        ordered.extend(ready)
        pending.difference_update(ready)
    return tuple(ordered)


def _copy_table(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    table: str,
    job_ids: JobIdMap,
) -> None:
    plan = TABLE_PLANS[table]
    if _row_count(candidate, table):
        raise CandidateCopyError(f"candidate table must be empty: {table}")
    if table not in _table_names(source):
        if plan.source_required:
            raise CandidateCopyError(
                f"candidate copy is missing required source table: {table}"
            )
        return
    source_columns = _columns(source, table)
    target_columns = _columns(candidate, table)
    bindings = _column_bindings(table, plan.disposition, source_columns, target_columns)
    source_order = tuple(source_columns)
    target_order = tuple(target_columns)
    rows = source.execute(
        f"SELECT {_identifiers(source_order)} FROM {_identifier(table)}"
    ).fetchall()
    values = [
        tuple(
            _bound_value(
                table=table,
                target_column=target_column,
                binding=binding,
                source_row=dict(zip(source_order, row, strict=True)),
                job_ids=job_ids,
            )
            for target_column, binding in zip(target_order, bindings, strict=True)
        )
        for row in rows
    ]
    if values:
        placeholders = ", ".join("?" for _ in target_order)
        candidate.executemany(
            f"INSERT INTO {_identifier(table)} ({_identifiers(target_order)}) "
            f"VALUES ({placeholders})",
            values,
        )
    if _row_count(candidate, table) != len(rows):
        raise CandidateCopyError(f"candidate copy changed row count for {table}")
    if plan.sequence_owned:
        _copy_sequence_cursor(source, candidate, table)


@dataclass(frozen=True)
class _Binding:
    source_column: str | None
    role: ColumnRole


def _column_bindings(
    table: str,
    disposition: TableDisposition,
    source_columns: tuple[str, ...],
    target_columns: tuple[str, ...],
) -> tuple[_Binding, ...]:
    source_set = set(source_columns)
    target_set = set(target_columns)
    if disposition is TableDisposition.DIRECT_COPY and source_set != target_set:
        raise CandidateCopyError(f"direct-copy column drift for {table}")

    bindings: list[_Binding] = []
    consumed: set[str] = set()
    for target_column in target_columns:
        target_role = classify_column(table, target_column, "target")
        if target_role is None:
            raise CandidateCopyError(
                f"candidate copy found unclassified target column: {table}.{target_column}"
            )
        if target_role is ColumnRole.JOB_ID:
            source_column = _legacy_identity_column(
                table, target_column, source_columns
            )
        elif target_role is ColumnRole.DERIVED:
            source_column = "tenant_id" if target_column == "tenant_id" and "tenant_id" in source_set else None
        elif target_column in source_set:
            source_column = target_column
        else:
            raise CandidateCopyError(
                f"candidate copy cannot bind {table}.{target_column}"
            )
        if source_column is not None:
            consumed.add(source_column)
        bindings.append(_Binding(source_column, target_role))

    unconsumed = set(source_columns) - consumed
    if unconsumed:
        raise CandidateCopyError(
            f"candidate copy found unclassified source columns for {table}: "
            f"{sorted(unconsumed)!r}"
        )
    return tuple(bindings)


def _legacy_identity_column(
    table: str,
    target_column: str,
    source_columns: tuple[str, ...],
) -> str:
    source_roles = {
        column: classify_column(table, column, "source")
        for column in source_columns
    }
    legacy = {
        column
        for column, role in source_roles.items()
        if role
        in {
            ColumnRole.LEGACY_URL_IDENTITY,
            ColumnRole.UNCHANGED_SCHEMA_URL_IDENTITY,
        }
    }
    stem = target_column.removesuffix("_id")
    preferred = (
        f"{stem}_key",
        f"{stem}_url",
        target_column,
    )
    matches = [column for column in preferred if column in legacy]
    if len(matches) == 1:
        return matches[0]
    if target_column == "job_id" and len(legacy) == 1:
        return next(iter(legacy))
    raise CandidateCopyError(
        "candidate copy cannot bind legacy identity column for "
        f"{table}.{target_column}"
    )


def _bound_value(
    *,
    table: str,
    target_column: str,
    binding: _Binding,
    source_row: Mapping[str, object],
    job_ids: JobIdMap,
) -> object:
    if binding.role is ColumnRole.DERIVED:
        return _tenant_id(source_row.get("tenant_id"))
    if binding.source_column is None:
        raise CandidateCopyError(
            f"candidate copy has no value source for {table}.{target_column}"
        )
    value = source_row[binding.source_column]
    if binding.role is ColumnRole.JOB_ID:
        return job_ids.resolve(
            tenant_id=_tenant_id(source_row.get("tenant_id")), locator=value
        )
    return value


def _copy_sequence_cursor(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    table: str,
) -> None:
    source_row = source.execute(
        "SELECT seq FROM sqlite_sequence WHERE name = ?", (table,)
    ).fetchone()
    candidate_row = candidate.execute(
        "SELECT seq FROM sqlite_sequence WHERE name = ?", (table,)
    ).fetchone()
    if source_row is None:
        if candidate_row is not None:
            raise CandidateCopyError(
                f"candidate copy synthesized a sequence cursor for {table}"
            )
        return
    updated = candidate.execute(
        "UPDATE sqlite_sequence SET seq = ? WHERE name = ?",
        (int(source_row[0]), table),
    )
    if updated.rowcount == 0:
        candidate.execute(
            "INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)",
            (table, int(source_row[0])),
        )


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }


def _columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    if table not in _table_names(conn):
        raise CandidateCopyError(f"candidate copy is missing table: {table}")
    return tuple(
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({_identifier(table)})").fetchall()
    )


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return int(
        conn.execute(f"SELECT COUNT(*) FROM {_identifier(table)}").fetchone()[0]
    )


def _tenant_id(value: object) -> str:
    return str(value or "").strip() or "local"


def _identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def _identifiers(values: Iterable[str]) -> str:
    return ", ".join(_identifier(value) for value in values)


__all__ = [
    "CandidateCopyError",
    "JobIdMap",
    "build_job_id_map",
    "copy_direct_and_scalar_tables",
]
