"""SQLite adapter for DiscoveryRun persistence."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobctrl.database import ensure_discovery_run_tables
from jobctrl.domain.discovery.scheduler import (
    DiscoveryProviderProgress,
    DiscoveryRun,
    DiscoveryRunCounts,
    DiscoveryRunProgress,
    DiscoveryRunStatus,
)
from jobctrl.domain.tenant import TenantId


class SqliteDiscoveryRunRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_discovery_run_tables(conn)

    def save(self, run: DiscoveryRun) -> None:
        self._conn.execute(
            """
            INSERT INTO discovery_runs (
                tenant_id, run_id, source_ids_json, profile_snapshot_id,
                status, counts_json, progress_json, error_classes_json, started_at,
                updated_at, completed_at, failed_at, workflow_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, run_id) DO UPDATE SET
                source_ids_json     = excluded.source_ids_json,
                profile_snapshot_id = excluded.profile_snapshot_id,
                status              = excluded.status,
                counts_json         = excluded.counts_json,
                progress_json       = excluded.progress_json,
                error_classes_json  = excluded.error_classes_json,
                started_at          = excluded.started_at,
                updated_at          = excluded.updated_at,
                completed_at        = excluded.completed_at,
                failed_at           = excluded.failed_at,
                workflow_id         = excluded.workflow_id
            """,
            (
                str(run.tenant_id),
                run.run_id,
                json.dumps(list(run.source_ids)),
                run.profile_snapshot_id,
                run.status.value,
                json.dumps(run.counts.to_dict()),
                json.dumps(run.progress.to_dict()),
                json.dumps(list(run.error_classes)),
                run.started_at,
                run.updated_at,
                run.completed_at,
                run.failed_at,
                run.workflow_id,
            ),
        )

    def save_progress(
        self,
        *,
        tenant_id: TenantId,
        run_id: str,
        counts: DiscoveryRunCounts,
        progress: DiscoveryRunProgress,
        updated_at: str,
        workflow_id: str | None = None,
    ) -> None:
        self._conn.execute(
            """
            UPDATE discovery_runs
               SET counts_json = ?,
                   progress_json = ?,
                   updated_at = ?,
                   workflow_id = COALESCE(?, workflow_id)
             WHERE tenant_id = ?
               AND run_id = ?
               AND status = 'running'
            """,
            (
                json.dumps(counts.to_dict()),
                json.dumps(progress.to_dict()),
                updated_at,
                workflow_id,
                str(tenant_id),
                run_id,
            ),
        )

    def load(self, tenant_id: TenantId, run_id: str) -> DiscoveryRun | None:
        row = self._conn.execute(
            "SELECT * FROM discovery_runs WHERE tenant_id = ? AND run_id = ?",
            (str(tenant_id), run_id),
        ).fetchone()
        if row is None:
            return None
        return _row_to_run(row)


def _row_to_run(row: sqlite3.Row | tuple[Any, ...]) -> DiscoveryRun:
    def get(key: str, index: int) -> Any:
        return row[key] if isinstance(row, sqlite3.Row) else row[index]

    counts = _json_dict(get("counts_json", 5))
    progress = _json_dict(get("progress_json", 6))
    provider_progress = _provider_progress(
        _first_present(progress, "provider_progress", "providerProgress")
    )
    return DiscoveryRun(
        tenant_id=TenantId(str(get("tenant_id", 0))),
        run_id=str(get("run_id", 1)),
        source_ids=tuple(str(value) for value in _json_list(get("source_ids_json", 2))),
        profile_snapshot_id=_nullable_str(get("profile_snapshot_id", 3)),
        status=DiscoveryRunStatus(str(get("status", 4))),
        counts=DiscoveryRunCounts(
            total=int(counts.get("total") or 0),
            new_jobs=int(counts.get("new_jobs") or 0),
            existing_jobs=int(counts.get("existing_jobs") or 0),
            observed_jobs=int(counts.get("observed_jobs") or 0),
            duplicate_jobs=int(counts.get("duplicate_jobs") or 0),
            rejected_duplicates=int(counts.get("rejected_duplicates") or 0),
        ),
        progress=DiscoveryRunProgress(
            completed=int(progress.get("completed") or 0),
            total=int(progress.get("total") or 0),
            unit=str(progress.get("unit") or ""),
            current_query=_nullable_str(_first_present(progress, "current_query", "currentQuery")),
            current_location=_nullable_str(_first_present(progress, "current_location", "currentLocation")),
            new_jobs=_nullable_int(_first_present(progress, "new_jobs", "newJobs")),
            existing_jobs=_nullable_int(_first_present(progress, "existing_jobs", "existingJobs")),
            filtered_jobs=_nullable_int(_first_present(progress, "filtered_jobs", "filteredJobs")),
            error_count=_nullable_int(_first_present(progress, "error_count", "errorCount")),
            raw_total=_nullable_int(_first_present(progress, "raw_total", "rawTotal")),
            recovered_units=_nullable_int(
                _first_present(progress, "recovered_units", "recoveredUnits")
            ),
            provider_progress=provider_progress,
        ),
        error_classes=tuple(str(value) for value in _json_list(get("error_classes_json", 7))),
        started_at=str(get("started_at", 8)),
        updated_at=_nullable_str(get("updated_at", 9)),
        completed_at=_nullable_str(get("completed_at", 10)),
        failed_at=_nullable_str(get("failed_at", 11)),
        workflow_id=_nullable_str(get("workflow_id", 12)),
    )


def _json_list(raw: object) -> list[object]:
    if not isinstance(raw, str) or not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _json_dict(raw: object) -> dict[str, object]:
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _nullable_str(value: object) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


def _nullable_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _provider_progress(value: object) -> DiscoveryProviderProgress | None:
    if not isinstance(value, dict):
        return None
    site = _nullable_str(value.get("site"))
    phase = _nullable_str(value.get("phase"))
    unit = _nullable_str(value.get("unit"))
    completed_units = _nullable_int(
        _first_present(value, "completed_units", "completedUnits")
    )
    jobs_emitted = _nullable_int(
        _first_present(value, "jobs_emitted", "jobsEmitted")
    )
    if (
        site is None
        or phase is None
        or unit is None
        or completed_units is None
        or jobs_emitted is None
    ):
        return None
    has_more_value = _first_present(value, "has_more", "hasMore")
    has_more = has_more_value if isinstance(has_more_value, bool) else None
    try:
        return DiscoveryProviderProgress(
            site=site,
            phase=phase,
            unit=unit,
            completed_units=completed_units,
            total_units=_nullable_int(
                _first_present(value, "total_units", "totalUnits")
            ),
            raw_items_seen=_nullable_int(
                _first_present(value, "raw_items_seen", "rawItemsSeen")
            ),
            jobs_emitted=jobs_emitted,
            has_more=has_more,
        )
    except ValueError:
        return None


def _first_present(values: dict[str, object], *keys: str) -> object:
    for key in keys:
        if key in values:
            return values[key]
    return None
