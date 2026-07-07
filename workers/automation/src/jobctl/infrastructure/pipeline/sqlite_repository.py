"""SqlitePipelineStateRepository — adapter for persisting JobPipelineState in SQLite.

Maps domain StageState PascalCase variants to/from the lowercase serialized
strings stored in the ``job_stage_states`` table.  Persistence is delegated
to :func:`jobctl.state.set_stage_state` so all stage-state writes share
the same SQL, validation, and per-row event emission.  Optimistic locking
uses the ``version`` column (ddd-target.md S8.6) via the helper's
``expected_version`` parameter.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobctl.domain.pipeline.aggregate import JobPipelineState
from jobctl.domain.pipeline_types import (
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
from jobctl.domain.tenant import TenantId
from jobctl.state import reconcile_dependency_blockers, record_job_event, set_stage_state


def _json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


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


# ---------------------------------------------------------------------------
# Stage-state -> set_stage_state kwargs
# ---------------------------------------------------------------------------


def _stage_state_to_kwargs(state: StageState) -> dict[str, Any]:
    """Translate a domain StageState into ``set_stage_state`` keyword args."""
    if isinstance(state, Pending):
        return {
            "attempt_count": state.attempt_count,
            "max_attempts": state.max_attempts if state.max_attempts != 0 else None,
            "next_action": state.next_action,
        }
    if isinstance(state, Queued):
        return {"started_at": state.queued_at or None}
    if isinstance(state, Running):
        return {
            "attempt_count": state.attempt_count,
            "started_at": state.started_at or None,
        }
    if isinstance(state, Succeeded):
        return {
            "attempt_count": state.attempt_count,
            "finished_at": state.finished_at or None,
            "duration_ms": state.duration_ms,
        }
    if isinstance(state, Failed):
        return {
            "attempt_count": state.attempt_count,
            "max_attempts": state.max_attempts if state.max_attempts != 0 else None,
            "error_code": state.error_code or None,
            "error_message": state.error_message or None,
            "retryable": state.retryable,
            "next_action": state.next_action,
        }
    if isinstance(state, Blocked):
        blocked = [serialize_stage(s) for s in state.blocked_by]
        return {
            "blocked_by": blocked or None,
            "error_code": state.error_code or None,
            "error_message": state.error_message or None,
            "retryable": False,
        }
    if isinstance(state, Skipped):
        return {
            "error_message": state.reason or None,
            "retryable": False,
        }
    if isinstance(state, Exhausted):
        return {
            "attempt_count": state.attempt_count,
            "max_attempts": state.max_attempts if state.max_attempts != 0 else None,
            "error_code": state.error_code or None,
            "error_message": state.error_message or None,
        }
    if isinstance(state, Stale):
        return {"error_message": state.reason or None}
    if isinstance(state, Canceled):
        return {
            "finished_at": state.canceled_at or None,
            "error_message": state.reason,
            "retryable": False,
        }
    return {}


# ---------------------------------------------------------------------------
# State-kind -> (event_type, level) for repository-driven event emission.
# Mirrors the per-stage events that runners emit through ``record_job_event``
# (see e.g. scoring/scorer.py, enrichment/detail.py).
# ---------------------------------------------------------------------------


_EVENTS_BY_KIND: dict[str, tuple[str, str]] = {
    "Queued": ("StageQueued", "info"),
    "Running": ("StageStarted", "info"),
    "Succeeded": ("StageCompleted", "info"),
    "Failed": ("StageFailed", "error"),
    "Blocked": ("StageBlocked", "warn"),
    "Skipped": ("StageSkipped", "info"),
    "Exhausted": ("StageExhausted", "error"),
    "Stale": ("StageStale", "info"),
    "Canceled": ("StageCanceled", "info"),
    "Pending": ("StageReset", "info"),
}


def _event_message(state: StageState) -> str:
    """Short message attached to the per-stage event."""
    if isinstance(state, Failed):
        return state.error_message or state.error_code or "Stage failed"
    if isinstance(state, Exhausted):
        return state.error_message or "Stage attempts exhausted"
    if isinstance(state, Blocked):
        return state.error_message or "Stage blocked"
    if isinstance(state, Skipped):
        return state.reason or "Stage skipped"
    if isinstance(state, Stale):
        return state.reason or "Stage marked stale"
    if isinstance(state, Canceled):
        return state.reason or "Stage canceled"
    return f"Stage {state.kind.lower()}"


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
        """Persist all stage rows for the aggregate via the canonical writer.

        Each stage is written through :func:`jobctl.state.set_stage_state`
        with ``expected_version=state.version`` to preserve optimistic-lock
        semantics; on version mismatch the helper raises
        ``OptimisticLockError`` and no further rows are written.  When a row's
        persisted state actually changes, a per-stage event is emitted via
        :func:`jobctl.state.record_job_event` so the read-model stays in
        sync with the same fan-out used by the per-stage runners.
        """
        existing_states = self._existing_state_strings(state.job_url)

        completed_stages: list[str] = []
        for stage, stage_state in state.stages.items():
            stage_str = serialize_stage(stage)
            new_state_str = serialize_stage_state(stage_state)

            set_stage_state(
                self._conn,
                state.job_url,
                stage_str,
                new_state_str,
                expected_version=state.version,
                validate_transition=False,
                **_stage_state_to_kwargs(stage_state),
            )

            if existing_states.get(stage_str) == new_state_str:
                continue
            event_type, level = _EVENTS_BY_KIND[stage_state.kind]
            record_job_event(
                self._conn,
                state.job_url,
                stage_str,
                event_type,
                level=level,
                message=_event_message(stage_state),
            )
            if new_state_str == "succeeded":
                completed_stages.append(stage_str)

        for stage_str in completed_stages:
            reconcile_dependency_blockers(self._conn, job_url=state.job_url, completed_stage=stage_str)
        state.version = state.version + 1

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

    def _existing_state_strings(self, job_url: str) -> dict[str, str]:
        """Return the persisted ``stage -> state`` map for change detection."""
        rows = self._conn.execute(
            "SELECT stage, state FROM job_stage_states WHERE job_url = ?",
            (job_url,),
        ).fetchall()
        return {row["stage"]: row["state"] for row in rows}

    @staticmethod
    def _row_to_dict(row: Any) -> dict[str, Any]:
        if isinstance(row, dict):
            return dict(row)
        return {key: row[key] for key in row.keys()}
