"""SQLite adapter for DiscoveryRun persistence."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobhunter.database import ensure_discovery_run_tables
from jobhunter.domain.discovery.scheduler import (
    DiscoveryRun,
    DiscoveryRunCounts,
    DiscoveryRunStatus,
)
from jobhunter.domain.tenant import TenantId


class SqliteDiscoveryRunRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_discovery_run_tables(conn)

    def save(self, run: DiscoveryRun) -> None:
        self._conn.execute(
            """
            INSERT INTO discovery_runs (
                tenant_id, run_id, source_ids_json, profile_snapshot_id,
                status, counts_json, error_classes_json, started_at,
                completed_at, failed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, run_id) DO UPDATE SET
                source_ids_json     = excluded.source_ids_json,
                profile_snapshot_id = excluded.profile_snapshot_id,
                status              = excluded.status,
                counts_json         = excluded.counts_json,
                error_classes_json  = excluded.error_classes_json,
                started_at          = excluded.started_at,
                completed_at        = excluded.completed_at,
                failed_at           = excluded.failed_at
            """,
            (
                str(run.tenant_id),
                run.run_id,
                json.dumps(list(run.source_ids)),
                run.profile_snapshot_id,
                run.status.value,
                json.dumps(run.counts.to_dict()),
                json.dumps(list(run.error_classes)),
                run.started_at,
                run.completed_at,
                run.failed_at,
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
        error_classes=tuple(str(value) for value in _json_list(get("error_classes_json", 6))),
        started_at=str(get("started_at", 7)),
        completed_at=_nullable_str(get("completed_at", 8)),
        failed_at=_nullable_str(get("failed_at", 9)),
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
