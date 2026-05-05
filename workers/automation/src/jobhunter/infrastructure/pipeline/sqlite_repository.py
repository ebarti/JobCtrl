"""SqlitePipelineStateRepository — adapter for persisting JobPipelineState in SQLite.

Maps domain StageState PascalCase variants to/from the lowercase serialized
strings stored in the ``job_stage_states`` table.  Implements optimistic
locking via the ``version`` column (ddd-target.md S8.6).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from jobhunter.domain.pipeline.aggregate import JobPipelineState, OptimisticLockError
from jobhunter.domain.pipeline_types import (
    Blocked,
    Canceled,
    Exhausted,
    Failed,
    Pending,
    Queued,
    Running,
    Skipped,
    Stage,
    StageState,
    Stale,
    Succeeded,
    deserialize_stage,
    serialize_stage,
    serialize_stage_state,
)
from jobhunter.domain.tenant import TenantId


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


def _json_dumps(value: Any) -> str | None:
    if value in (None, "", [], {}, ()):
        return None
    return json.dumps(value, sort_keys=True)


# ---------------------------------------------------------------------------
# Row -> domain mapping
# ---------------------------------------------------------------------------


def _row_to_stage_state(row: dict[str, Any]) -> StageState:
    """Convert one ``job_stage_states`` row into a domain StageState."""
    state_str: str = row["state"]
    kind = state_str[0].upper() + state_str[1:]  # pending -> Pending

    # Map by kind to the correct frozen dataclass
    if kind == "Pending":
        return Pending(
            attempt_count=row.get("attempt_count") or 0,
            max_attempts=row.get("max_attempts") or 0,
            next_action=row.get("next_action"),
        )
    if kind == "Queued":
        return Queued(queued_at=row.get("started_at") or "")
    if kind == "Running":
        return Running(
            attempt_count=row.get("attempt_count") or 0,
            started_at=row.get("started_at") or "",
        )
    if kind == "Succeeded":
        return Succeeded(
            attempt_count=row.get("attempt_count") or 0,
            finished_at=row.get("finished_at") or "",
            duration_ms=row.get("duration_ms") or 0,
        )
    if kind == "Failed":
        return Failed(
            attempt_count=row.get("attempt_count") or 0,
            max_attempts=row.get("max_attempts") or 0,
            error_code=row.get("error_code") or "",
            error_message=row.get("error_message") or "",
            retryable=bool(row.get("retryable", 1)),
            next_action=row.get("next_action"),
        )
    if kind == "Blocked":
        blocked_by_raw = _json_loads(row.get("blocked_by_json"), [])
        blocked_by = tuple(deserialize_stage(s) for s in blocked_by_raw) if blocked_by_raw else ()
        return Blocked(
            blocked_by=blocked_by,
            error_code=row.get("error_code") or "",
            error_message=row.get("error_message") or "",
        )
    if kind == "Skipped":
        return Skipped(reason=row.get("error_message") or "")
    if kind == "Exhausted":
        return Exhausted(
            attempt_count=row.get("attempt_count") or 0,
            max_attempts=row.get("max_attempts") or 0,
            error_code=row.get("error_code") or "",
            error_message=row.get("error_message") or "",
            next_action=row.get("next_action"),
        )
    if kind == "Stale":
        return Stale(reason=row.get("error_message") or "")
    if kind == "Canceled":
        return Canceled(
            canceled_at=row.get("finished_at") or "",
            reason=row.get("error_message") or None,
        )
    # Fallback — treat unknown as Pending
    return Pending()


def _stage_state_to_row(stage: Stage, state: StageState, job_url: str) -> dict[str, Any]:
    """Convert a domain Stage + StageState into a dict suitable for SQL INSERT."""
    now = _utc_now()
    base: dict[str, Any] = {
        "job_url": job_url,
        "stage": serialize_stage(stage),
        "state": serialize_stage_state(state),
        "updated_at": now,
        "attempt_count": 0,
        "max_attempts": None,
        "started_at": None,
        "finished_at": None,
        "duration_ms": None,
        "error_code": None,
        "error_message": None,
        "retryable": 1,
        "blocked_by_json": None,
        "next_action": None,
        "metadata_json": None,
    }

    if isinstance(state, Pending):
        base["attempt_count"] = state.attempt_count
        base["max_attempts"] = state.max_attempts if state.max_attempts != 0 else None
        base["next_action"] = state.next_action
    elif isinstance(state, Queued):
        base["started_at"] = state.queued_at if state.queued_at else None
    elif isinstance(state, Running):
        base["attempt_count"] = state.attempt_count
        base["started_at"] = state.started_at if state.started_at else None
    elif isinstance(state, Succeeded):
        base["attempt_count"] = state.attempt_count
        base["finished_at"] = state.finished_at if state.finished_at else None
        base["duration_ms"] = state.duration_ms  # preserve 0
    elif isinstance(state, Failed):
        base["attempt_count"] = state.attempt_count
        base["max_attempts"] = state.max_attempts if state.max_attempts != 0 else None
        base["error_code"] = state.error_code if state.error_code else None
        base["error_message"] = state.error_message if state.error_message else None
        base["retryable"] = int(state.retryable)
        base["next_action"] = state.next_action
    elif isinstance(state, Blocked):
        base["blocked_by_json"] = _json_dumps([serialize_stage(s) for s in state.blocked_by])
        base["error_code"] = state.error_code if state.error_code else None
        base["error_message"] = state.error_message if state.error_message else None
        base["retryable"] = 0
    elif isinstance(state, Skipped):
        base["error_message"] = state.reason if state.reason else None
        base["retryable"] = 0
    elif isinstance(state, Exhausted):
        base["attempt_count"] = state.attempt_count
        base["max_attempts"] = state.max_attempts if state.max_attempts != 0 else None
        base["error_code"] = state.error_code if state.error_code else None
        base["error_message"] = state.error_message if state.error_message else None
        base["next_action"] = state.next_action
    elif isinstance(state, Stale):
        base["error_message"] = state.reason if state.reason else None
    elif isinstance(state, Canceled):
        base["finished_at"] = state.canceled_at if state.canceled_at else None
        base["error_message"] = state.reason
        base["retryable"] = 0

    return base


# ---------------------------------------------------------------------------
# Repository implementation
# ---------------------------------------------------------------------------


class SqlitePipelineStateRepository:
    """SQLite adapter for PipelineStateRepository.

    Reads/writes the existing ``job_stage_states`` table.
    Optimistic locking uses the ``version`` column.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # -- port methods ---------------------------------------------------------

    def load(self, tenant_id: TenantId, job_url: str) -> JobPipelineState | None:
        rows = self._conn.execute(
            "SELECT * FROM job_stage_states WHERE job_url = ?",
            (job_url,),
        ).fetchall()
        if not rows:
            return None

        stages: dict[Stage, StageState] = {}
        version = 0
        for row in rows:
            data = self._row_to_dict(row)
            try:
                stage = deserialize_stage(data["stage"])
            except ValueError:
                continue
            stages[stage] = _row_to_stage_state(data)
            # version is per-aggregate; take max across rows
            row_ver = data.get("version") or 0
            if row_ver > version:
                version = row_ver

        return JobPipelineState(
            tenant_id=tenant_id,
            job_url=job_url,
            stages=stages,
            version=version,
        )

    def save(self, state: JobPipelineState) -> None:
        """Persist all stage rows for the aggregate.

        Optimistic locking: each row is written with ``version = old + 1``
        and a WHERE guard on the current version.  If any row fails the guard,
        ``OptimisticLockError`` is raised and no changes are committed.
        """
        new_version = state.version + 1

        for stage, stage_state in state.stages.items():
            row = _stage_state_to_row(stage, stage_state, state.job_url)

            # Try UPDATE with version guard first
            cur = self._conn.execute(
                """
                UPDATE job_stage_states
                SET state = ?, attempt_count = ?, max_attempts = ?,
                    started_at = COALESCE(?, started_at),
                    updated_at = ?, finished_at = COALESCE(?, finished_at),
                    duration_ms = COALESCE(?, duration_ms),
                    error_code = ?, error_message = ?,
                    retryable = ?, blocked_by_json = ?,
                    next_action = ?, metadata_json = ?,
                    version = ?
                WHERE job_url = ? AND stage = ? AND version = ?
                """,
                (
                    row["state"],
                    row["attempt_count"],
                    row["max_attempts"],
                    row["started_at"],
                    row["updated_at"],
                    row["finished_at"],
                    row["duration_ms"],
                    row["error_code"],
                    row["error_message"],
                    row["retryable"],
                    row["blocked_by_json"],
                    row["next_action"],
                    row["metadata_json"],
                    new_version,
                    state.job_url,
                    serialize_stage(stage),
                    state.version,
                ),
            )

            if cur.rowcount == 0:
                # Either the row doesn't exist (INSERT) or version mismatch (conflict).
                # Check if the row exists to distinguish.
                existing = self._conn.execute(
                    "SELECT version FROM job_stage_states WHERE job_url = ? AND stage = ?",
                    (state.job_url, serialize_stage(stage)),
                ).fetchone()

                if existing is not None:
                    actual_ver = existing[0] if isinstance(existing[0], int) else (existing["version"] or 0)
                    raise OptimisticLockError(state.job_url, state.version, actual_ver)

                # Row doesn't exist — insert
                self._conn.execute(
                    """
                    INSERT INTO job_stage_states (
                        job_url, stage, state, attempt_count, max_attempts,
                        started_at, updated_at, finished_at, duration_ms,
                        error_code, error_message, retryable,
                        blocked_by_json, next_action, metadata_json, version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        row["job_url"],
                        row["stage"],
                        row["state"],
                        row["attempt_count"],
                        row["max_attempts"],
                        row["started_at"],
                        row["updated_at"],
                        row["finished_at"],
                        row["duration_ms"],
                        row["error_code"],
                        row["error_message"],
                        row["retryable"],
                        row["blocked_by_json"],
                        row["next_action"],
                        row["metadata_json"],
                        new_version,
                    ),
                )

        state.version = new_version

    def list_by_stage(
        self,
        tenant_id: TenantId,
        stage: str,
        state_filter: str | None = None,
    ) -> list[JobPipelineState]:
        if state_filter:
            rows = self._conn.execute(
                "SELECT DISTINCT job_url FROM job_stage_states WHERE stage = ? AND state = ?",
                (stage, state_filter),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT DISTINCT job_url FROM job_stage_states WHERE stage = ?",
                (stage,),
            ).fetchall()

        results: list[JobPipelineState] = []
        for row in rows:
            job_url = row[0] if not isinstance(row, dict) else row["job_url"]
            agg = self.load(tenant_id, job_url)
            if agg is not None:
                results.append(agg)
        return results

    # -- helpers --------------------------------------------------------------

    @staticmethod
    def _row_to_dict(row: Any) -> dict[str, Any]:
        if isinstance(row, dict):
            return dict(row)
        return {key: row[key] for key in row.keys()}
