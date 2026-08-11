"""Lease-fenced scheduling state for automatic compensation benchmarks."""

from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from jobctrl.domain.compensation import (
    BenchmarkGeography,
    canonical_benchmark_timestamp,
    classify_role,
    resolve_country_code,
)


BenchmarkRefreshStatus = Literal[
    "missing",
    "queued",
    "refreshing",
    "succeeded",
    "insufficient_evidence",
    "failed",
]
BenchmarkResultKind = Literal["none", "direct", "extrapolated"]


@dataclass(frozen=True)
class CompensationBenchmarkSlice:
    tenant_id: str
    taxonomy_version: str
    role_family_code: str
    seniority_label: str
    geography: BenchmarkGeography
    component: str = "total_compensation"
    title_hint: str = ""
    location_hint: str = ""

    @property
    def key(self) -> tuple[str, ...]:
        return (
            self.tenant_id,
            self.taxonomy_version,
            self.role_family_code,
            self.seniority_label,
            self.geography.country_code,
            self.geography.subdivision_code,
            self.geography.locality,
            self.component,
        )


@dataclass(frozen=True)
class CompensationSliceDiscovery:
    slices: tuple[CompensationBenchmarkSlice, ...]
    jobs_considered: int
    jobs_without_role_family: int
    jobs_without_country: int


@dataclass(frozen=True)
class CompensationRefreshState:
    benchmark_slice: CompensationBenchmarkSlice
    refresh_status: BenchmarkRefreshStatus
    last_result_kind: BenchmarkResultKind
    last_direct_fact_id: str | None
    last_extrapolated_fact_id: str | None
    last_requested_at: str | None
    last_checked_at: str | None
    next_refresh_at: str | None
    lease_owner: str | None
    lease_expires_at: str | None
    attempt_count: int
    last_error_code: str | None
    updated_at: str


@dataclass(frozen=True)
class CompensationRefreshLease:
    benchmark_slice: CompensationBenchmarkSlice
    token: str
    expires_at: str


class StaleCompensationRefreshLease(RuntimeError):
    """Raised when a worker tries to finish a lease it no longer owns."""


class SqliteCompensationRefreshStateRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def discover_active_job_slices(self, tenant_id: str) -> CompensationSliceDiscovery:
        rows = _fetchall_mappings(
            self._conn.execute(
                """
                SELECT jobs.title, jobs.location
                FROM jobs
                LEFT JOIN jobctrl_deleted_jobs AS deleted
                  ON deleted.tenant_id = jobs.tenant_id
                 AND deleted.job_id = jobs.job_id
                 AND (
                       deleted.restored_at IS NULL
                       OR julianday(deleted.restored_at) <= julianday(deleted.deleted_at)
                 )
                WHERE jobs.tenant_id = ?
                  AND deleted.job_id IS NULL
                ORDER BY jobs.discovered_at, jobs.job_id
                """,
                (tenant_id,),
            )
        )
        slices: dict[tuple[str, ...], CompensationBenchmarkSlice] = {}
        without_role = 0
        without_country = 0
        for row in rows:
            title = str(row["title"] or "").strip()
            location = str(row["location"] or "").strip()
            classification = classify_role(title)
            if classification.role_family_code is None:
                without_role += 1
                continue
            country_code = resolve_country_code(location)
            if country_code is None:
                without_country += 1
                continue
            benchmark_slice = CompensationBenchmarkSlice(
                tenant_id=tenant_id,
                taxonomy_version=classification.taxonomy_version,
                role_family_code=classification.role_family_code,
                seniority_label=classification.seniority_label,
                geography=BenchmarkGeography(country_code),
                title_hint=title,
                location_hint=location,
            )
            slices.setdefault(benchmark_slice.key, benchmark_slice)
        return CompensationSliceDiscovery(
            slices=tuple(slices[key] for key in sorted(slices)),
            jobs_considered=len(rows),
            jobs_without_role_family=without_role,
            jobs_without_country=without_country,
        )

    def ensure_slices(
        self,
        slices: tuple[CompensationBenchmarkSlice, ...],
        *,
        now: str,
    ) -> None:
        canonical_now = canonical_benchmark_timestamp(now, "now")
        self._conn.executemany(
            """
            INSERT OR IGNORE INTO compensation_market_refresh_state (
                tenant_id, taxonomy_version, role_family_code, seniority_label,
                country_code, subdivision_code, locality, geography_scope,
                component, refresh_status, last_result_kind, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing', 'none', ?)
            """,
            (
                (
                    item.tenant_id,
                    item.taxonomy_version,
                    item.role_family_code,
                    item.seniority_label,
                    item.geography.country_code,
                    item.geography.subdivision_code,
                    item.geography.locality,
                    item.geography.scope,
                    item.component,
                    canonical_now,
                )
                for item in slices
            ),
        )
        self._conn.commit()

    def claim_due(
        self,
        slices: tuple[CompensationBenchmarkSlice, ...],
        *,
        owner: str,
        now: str,
        lease_expires_at: str,
    ) -> tuple[CompensationRefreshLease, ...]:
        if not owner.strip():
            raise ValueError("compensation refresh lease owner is required")
        canonical_now = canonical_benchmark_timestamp(now, "now")
        canonical_expiry = canonical_benchmark_timestamp(
            lease_expires_at,
            "lease_expires_at",
        )
        if canonical_expiry <= canonical_now:
            raise ValueError("compensation refresh lease must expire after now")
        claimed: list[CompensationRefreshLease] = []
        for item in slices:
            lease_token = f"{owner.strip()}:{uuid.uuid4()}"
            cursor = self._conn.execute(
                """
                UPDATE compensation_market_refresh_state
                SET refresh_status = 'refreshing',
                    last_requested_at = ?,
                    lease_owner = ?,
                    lease_expires_at = ?,
                    attempt_count = attempt_count + 1,
                    last_error_code = NULL,
                    updated_at = ?
                WHERE tenant_id = ?
                  AND taxonomy_version = ?
                  AND role_family_code = ?
                  AND seniority_label = ?
                  AND country_code = ?
                  AND subdivision_code = ?
                  AND locality = ?
                  AND component = ?
                  AND (next_refresh_at IS NULL OR next_refresh_at <= ?)
                  AND (
                        lease_owner IS NULL
                        OR lease_expires_at <= ?
                  )
                """,
                (
                    canonical_now,
                    lease_token,
                    canonical_expiry,
                    canonical_now,
                    *_slice_key_values(item),
                    canonical_now,
                    canonical_now,
                ),
            )
            if cursor.rowcount == 1:
                claimed.append(
                    CompensationRefreshLease(
                        benchmark_slice=item,
                        token=lease_token,
                        expires_at=canonical_expiry,
                    )
                )
        self._conn.commit()
        return tuple(claimed)

    def mark_result(
        self,
        lease: CompensationRefreshLease,
        *,
        completed_at: str,
        next_refresh_at: str,
        result_kind: Literal["direct", "extrapolated"],
        fact_id: str,
        actionable: bool = True,
    ) -> None:
        benchmark_slice = lease.benchmark_slice
        self._assert_result_matches_slice(
            benchmark_slice,
            result_kind=result_kind,
            fact_id=fact_id,
        )
        status = "succeeded" if actionable else "insufficient_evidence"
        direct_id = fact_id if result_kind == "direct" else None
        extrapolated_id = fact_id if result_kind == "extrapolated" else None
        self._finish(
            benchmark_slice,
            lease=lease,
            completed_at=completed_at,
            next_refresh_at=next_refresh_at,
            refresh_status=status,
            result_kind=result_kind,
            direct_fact_id=direct_id,
            extrapolated_fact_id=extrapolated_id,
            error_code=(None if actionable else "factor_out_of_bounds"),
            preserve_result=False,
        )

    def mark_insufficient(
        self,
        lease: CompensationRefreshLease,
        *,
        completed_at: str,
        next_refresh_at: str,
        error_code: str,
    ) -> None:
        self._finish(
            lease.benchmark_slice,
            lease=lease,
            completed_at=completed_at,
            next_refresh_at=next_refresh_at,
            refresh_status="insufficient_evidence",
            result_kind="none",
            direct_fact_id=None,
            extrapolated_fact_id=None,
            error_code=error_code,
            preserve_result=True,
        )

    def mark_failed(
        self,
        lease: CompensationRefreshLease,
        *,
        completed_at: str,
        retry_at: str,
        error_code: str,
    ) -> None:
        self._finish(
            lease.benchmark_slice,
            lease=lease,
            completed_at=completed_at,
            next_refresh_at=retry_at,
            refresh_status="failed",
            result_kind="none",
            direct_fact_id=None,
            extrapolated_fact_id=None,
            error_code=error_code,
            preserve_result=True,
        )

    def get(self, benchmark_slice: CompensationBenchmarkSlice) -> CompensationRefreshState | None:
        row = _fetchone_mapping(
            self._conn.execute(
                """
                SELECT *
                FROM compensation_market_refresh_state
                WHERE tenant_id = ?
                  AND taxonomy_version = ?
                  AND role_family_code = ?
                  AND seniority_label = ?
                  AND country_code = ?
                  AND subdivision_code = ?
                  AND locality = ?
                  AND component = ?
                """,
                _slice_key_values(benchmark_slice),
            )
        )
        return _state_from_row(row, benchmark_slice) if row is not None else None

    def _finish(
        self,
        benchmark_slice: CompensationBenchmarkSlice,
        *,
        lease: CompensationRefreshLease,
        completed_at: str,
        next_refresh_at: str,
        refresh_status: BenchmarkRefreshStatus,
        result_kind: BenchmarkResultKind,
        direct_fact_id: str | None,
        extrapolated_fact_id: str | None,
        error_code: str | None,
        preserve_result: bool,
    ) -> None:
        canonical_completed = canonical_benchmark_timestamp(completed_at, "completed_at")
        canonical_next = canonical_benchmark_timestamp(next_refresh_at, "next_refresh_at")
        if preserve_result:
            result_sql = ""
            result_params: tuple[Any, ...] = ()
        else:
            result_sql = """
                last_result_kind = ?,
                last_direct_fact_id = ?,
                last_extrapolated_fact_id = ?,
            """
            result_params = (result_kind, direct_fact_id, extrapolated_fact_id)
        cursor = self._conn.execute(
            f"""
            UPDATE compensation_market_refresh_state
            SET refresh_status = ?,
                {result_sql}
                last_checked_at = ?,
                next_refresh_at = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error_code = ?,
                updated_at = ?
            WHERE tenant_id = ?
              AND taxonomy_version = ?
              AND role_family_code = ?
              AND seniority_label = ?
              AND country_code = ?
              AND subdivision_code = ?
              AND locality = ?
              AND component = ?
              AND lease_owner = ?
              AND lease_expires_at = ?
              AND lease_expires_at > ?
            """,
            (
                refresh_status,
                *result_params,
                canonical_completed,
                canonical_next,
                error_code,
                canonical_completed,
                *_slice_key_values(benchmark_slice),
                lease.token,
                lease.expires_at,
                canonical_completed,
            ),
        )
        if cursor.rowcount != 1:
            self._conn.rollback()
            raise StaleCompensationRefreshLease("compensation refresh lease expired or changed owner")
        self._conn.commit()

    def _assert_result_matches_slice(
        self,
        benchmark_slice: CompensationBenchmarkSlice,
        *,
        result_kind: Literal["direct", "extrapolated"],
        fact_id: str,
    ) -> None:
        if result_kind == "direct":
            row = _fetchone_mapping(
                self._conn.execute(
                    """
                    SELECT taxonomy_version, role_family_code, seniority_label,
                           country_code, subdivision_code, locality,
                           geography_scope, component, market_scope
                    FROM compensation_direct_benchmark_facts
                    WHERE tenant_id = ? AND fact_id = ?
                    """,
                    (benchmark_slice.tenant_id, fact_id),
                )
            )
            if row is None or str(row["market_scope"]) != "market":
                raise ValueError("direct refresh result must be a market benchmark for the slice")
            country_field = "country_code"
            subdivision_field = "subdivision_code"
            locality_field = "locality"
            scope_field = "geography_scope"
        else:
            row = _fetchone_mapping(
                self._conn.execute(
                    """
                    SELECT taxonomy_version, role_family_code, seniority_label,
                           target_country_code, target_subdivision_code,
                           target_locality, target_geography_scope, component
                    FROM compensation_extrapolated_benchmark_facts
                    WHERE tenant_id = ? AND fact_id = ?
                    """,
                    (benchmark_slice.tenant_id, fact_id),
                )
            )
            if row is None:
                raise ValueError("extrapolated refresh result must exist for the slice")
            country_field = "target_country_code"
            subdivision_field = "target_subdivision_code"
            locality_field = "target_locality"
            scope_field = "target_geography_scope"
        assert row is not None
        expected_values = (
            benchmark_slice.taxonomy_version,
            benchmark_slice.role_family_code,
            benchmark_slice.geography.country_code,
            benchmark_slice.geography.subdivision_code,
            benchmark_slice.geography.locality,
            benchmark_slice.geography.scope,
            benchmark_slice.component,
        )
        actual_values = (
            str(row["taxonomy_version"]),
            str(row["role_family_code"]),
            str(row[country_field]),
            str(row[subdivision_field]),
            str(row[locality_field]),
            str(row[scope_field]),
            str(row["component"]),
        )
        if actual_values != expected_values or str(row["seniority_label"]) not in {
            benchmark_slice.seniority_label,
            "unknown",
        }:
            raise ValueError("compensation refresh result does not match the benchmark slice")


def _slice_key_values(item: CompensationBenchmarkSlice) -> tuple[str, ...]:
    return item.key


def _state_from_row(
    row: Mapping[str, Any],
    benchmark_slice: CompensationBenchmarkSlice,
) -> CompensationRefreshState:
    return CompensationRefreshState(
        benchmark_slice=benchmark_slice,
        refresh_status=str(row["refresh_status"]),  # type: ignore[arg-type]
        last_result_kind=str(row["last_result_kind"]),  # type: ignore[arg-type]
        last_direct_fact_id=_optional_text(row["last_direct_fact_id"]),
        last_extrapolated_fact_id=_optional_text(row["last_extrapolated_fact_id"]),
        last_requested_at=_optional_text(row["last_requested_at"]),
        last_checked_at=_optional_text(row["last_checked_at"]),
        next_refresh_at=_optional_text(row["next_refresh_at"]),
        lease_owner=_optional_text(row["lease_owner"]),
        lease_expires_at=_optional_text(row["lease_expires_at"]),
        attempt_count=int(row["attempt_count"]),
        last_error_code=_optional_text(row["last_error_code"]),
        updated_at=str(row["updated_at"]),
    )


def _optional_text(value: Any) -> str | None:
    return str(value) if value is not None else None


def _fetchone_mapping(cursor: sqlite3.Cursor) -> Mapping[str, Any] | None:
    row = cursor.fetchone()
    if row is None:
        return None
    if isinstance(row, sqlite3.Row):
        return dict(row)
    return dict(zip((column[0] for column in cursor.description), row, strict=True))


def _fetchall_mappings(cursor: sqlite3.Cursor) -> tuple[Mapping[str, Any], ...]:
    columns = tuple(column[0] for column in cursor.description)
    return tuple(
        dict(row) if isinstance(row, sqlite3.Row) else dict(zip(columns, row, strict=True)) for row in cursor.fetchall()
    )


__all__ = [
    "CompensationBenchmarkSlice",
    "CompensationRefreshLease",
    "CompensationRefreshState",
    "CompensationSliceDiscovery",
    "SqliteCompensationRefreshStateRepository",
    "StaleCompensationRefreshLease",
]
