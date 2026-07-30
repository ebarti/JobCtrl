"""Durable application-dispatch control for the stable JobId cutover.

Every direct application-owned Temporal start reserves a local launch record before
contacting Temporal. A shared filesystem lock covers that reservation and the
remote start call. Cutover orchestration takes the corresponding exclusive
lock before blocking starts, so it cannot race an in-flight dispatch.

Temporal-owned schedules do not pass through this boundary; cutover
orchestration must pause them separately before it blocks direct dispatch.
The durable launch inventory deliberately treats client errors as uncertain: Temporal
may have accepted a start even when the response was lost. A later preflight
must reconcile every reserved, uncertain, or dispatched launch with an exact
``DescribeWorkflowExecution`` call before declaring quiescence.
"""

from __future__ import annotations

import asyncio
import fcntl
import os
import sqlite3
import uuid
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Iterator,
    TypeVar,
)

from jobctrl import config

_CONTROL_KEY = "stable-job-id-cutover"
_LOCK_SUFFIX = ".workflow-dispatch.lock"
_FenceResult = TypeVar("_FenceResult")


class WorkflowDispatchFencedError(RuntimeError):
    """Raised before dispatch while the identity cutover owns the start gate."""


class UnregisteredWorkflowDispatchError(RuntimeError):
    """Raised when a workflow has no explicit identity-cutover policy."""


@dataclass
class WorkflowDispatchReservation:
    launch_id: str
    workflow_id: str
    workflow_type: str
    temporal_run_id: str | None = None
    dispatch_confirmed: bool = False

    def mark_dispatched(self, handle: Any) -> None:
        """Record the exact run ID returned by Temporal when it is available."""

        run_id = (
            getattr(handle, "first_execution_run_id", None)
            or getattr(handle, "result_run_id", None)
            or getattr(handle, "run_id", None)
        )
        self.temporal_run_id = str(run_id) if run_id else None
        self.dispatch_confirmed = True


def ensure_workflow_dispatch_control_tables(
    conn: sqlite3.Connection,
) -> tuple[str, str, str]:
    """Create the operational gate and durable launch inventory."""

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS workflow_dispatch_control (
            control_key TEXT PRIMARY KEY,
            reason      TEXT NOT NULL,
            blocked_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workflow_dispatch_registry (
            launch_id       TEXT PRIMARY KEY,
            workflow_id     TEXT NOT NULL,
            temporal_run_id TEXT,
            workflow_type   TEXT NOT NULL,
            state           TEXT NOT NULL
                CHECK (state IN ('reserved', 'dispatched', 'uncertain')),
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_registry_execution
        ON workflow_dispatch_registry(workflow_id, temporal_run_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_registry_state
        ON workflow_dispatch_registry(state, workflow_type, created_at);

        CREATE TABLE IF NOT EXISTS workflow_identity_cutover_inventory_proof (
            control_key                TEXT PRIMARY KEY,
            proof_version              INTEGER NOT NULL,
            fence_blocked_at            TEXT NOT NULL,
            registry_inventory_digest  TEXT NOT NULL,
            registry_entry_count       INTEGER NOT NULL,
            worker_inventory_digest    TEXT NOT NULL,
            worker_entry_count         INTEGER NOT NULL,
            worker_quiescent_at         TEXT NOT NULL,
            created_at                  TEXT NOT NULL
        );
        """
    )
    return (
        "workflow_dispatch_control",
        "workflow_dispatch_registry",
        "workflow_identity_cutover_inventory_proof",
    )


@asynccontextmanager
async def workflow_dispatch_read_lock(
    *,
    db_path: Path | str | None = None,
) -> AsyncIterator[Path]:
    """Hold the shared side of the cutover fence for dispatch-adjacent work."""

    resolved_path = _resolve_db_path(db_path)
    lock_fd = await _acquire_lock_async(
        _lock_path(resolved_path),
        fcntl.LOCK_SH,
    )
    try:
        yield resolved_path
    finally:
        _release_lock(lock_fd)


@asynccontextmanager
async def reserve_workflow_dispatch(
    *,
    workflow: type,
    workflow_id: str,
    db_path: Path | str | None = None,
) -> AsyncIterator[WorkflowDispatchReservation]:
    """Reserve and audit one start while sharing the cutover dispatch lock."""

    from jobctrl.infrastructure.temporal.registry import (
        WORKFLOW_IDENTITY_CUTOVER_POLICIES,
    )

    policy = WORKFLOW_IDENTITY_CUTOVER_POLICIES.get(workflow)
    if policy is None:
        raise UnregisteredWorkflowDispatchError(
            f"{getattr(workflow, '__name__', workflow)!s} is not declared "
            "in the Temporal identity-cutover registry"
        )
    resolved_id = str(workflow_id or "").strip()
    if not resolved_id:
        raise ValueError("workflow_id must be non-empty")
    reservation: WorkflowDispatchReservation | None = None
    async with workflow_dispatch_read_lock(
        db_path=db_path,
    ) as resolved_path:
        reservation = _create_reservation(
            resolved_path,
            workflow_id=resolved_id,
            workflow_type=policy.workflow_type,
        )
        try:
            yield reservation
        except BaseException:
            _finish_reservation(
                resolved_path,
                reservation,
                state="uncertain",
            )
            raise
        else:
            _finish_reservation(
                resolved_path,
                reservation,
                state=(
                    "dispatched"
                    if reservation.dispatch_confirmed
                    else "uncertain"
                ),
            )


def set_workflow_dispatches_blocked(
    *,
    blocked: bool,
    reason: str,
    db_path: Path | str | None = None,
) -> bool:
    """Atomically change the durable gate after all in-flight starts drain."""

    resolved_path = _resolve_db_path(db_path)
    with _locked(_lock_path(resolved_path), fcntl.LOCK_EX):
        _write_workflow_dispatch_gate(
            resolved_path,
            blocked=blocked,
            reason=reason,
        )
    return blocked


async def activate_workflow_dispatch_fence(
    *,
    reason: str,
    after_blocked: Callable[[], Awaitable[_FenceResult]],
    db_path: Path | str | None = None,
) -> _FenceResult:
    """Block direct dispatch and run schedule fencing under one write lock.

    The durable gate is intentionally left blocked when ``after_blocked``
    raises. That fail-closed state prevents direct dispatch while an operator
    retries or abandons the schedule pause.
    """

    resolved_path = _resolve_db_path(db_path)
    lock_fd = await _acquire_lock_async(
        _lock_path(resolved_path),
        fcntl.LOCK_EX,
    )
    try:
        _write_workflow_dispatch_gate(
            resolved_path,
            blocked=True,
            reason=reason,
        )
        return await after_blocked()
    finally:
        _release_lock(lock_fd)


def workflow_dispatches_blocked(
    db_path: Path | str | None = None,
) -> bool:
    """Return the current durable gate state."""

    resolved_path = _resolve_db_path(db_path)
    conn = _open_control_connection(resolved_path)
    try:
        ensure_workflow_dispatch_control_tables(conn)
        row = conn.execute(
            """
            SELECT 1
            FROM workflow_dispatch_control
            WHERE control_key = ?
            """,
            (_CONTROL_KEY,),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def _create_reservation(
    db_path: Path,
    *,
    workflow_id: str,
    workflow_type: str,
) -> WorkflowDispatchReservation:
    conn = _open_control_connection(db_path)
    launch_id = uuid.uuid4().hex
    now = _utc_now()
    try:
        ensure_workflow_dispatch_control_tables(conn)
        with conn:
            row = conn.execute(
                """
                SELECT 1
                FROM workflow_dispatch_control
                WHERE control_key = ?
                """,
                (_CONTROL_KEY,),
            ).fetchone()
            if row is not None:
                raise WorkflowDispatchFencedError(
                    "workflow dispatches are blocked for the stable JobId cutover"
                )
            conn.execute(
                """
                INSERT INTO workflow_dispatch_registry (
                    launch_id, workflow_id, temporal_run_id,
                    workflow_type, state, created_at, updated_at
                ) VALUES (?, ?, NULL, ?, 'reserved', ?, ?)
                """,
                (
                    launch_id,
                    workflow_id,
                    workflow_type,
                    now,
                    now,
                ),
            )
    finally:
        conn.close()
    return WorkflowDispatchReservation(
        launch_id=launch_id,
        workflow_id=workflow_id,
        workflow_type=workflow_type,
    )


def _write_workflow_dispatch_gate(
    db_path: Path,
    *,
    blocked: bool,
    reason: str,
) -> None:
    conn = _open_control_connection(db_path)
    try:
        ensure_workflow_dispatch_control_tables(conn)
        with conn:
            # A proof is bound to one exact fence epoch. Re-activating or
            # releasing the fence invalidates it before any later preflight can
            # mistake stale recovery evidence for the current handoff.
            conn.execute(
                """
                DELETE FROM workflow_identity_cutover_inventory_proof
                WHERE control_key = ?
                """,
                (_CONTROL_KEY,),
            )
            if blocked:
                conn.execute(
                    """
                    INSERT INTO workflow_dispatch_control (
                        control_key, reason, blocked_at
                    ) VALUES (?, ?, ?)
                    ON CONFLICT(control_key) DO UPDATE SET
                        reason = excluded.reason,
                        blocked_at = excluded.blocked_at
                    """,
                    (
                        _CONTROL_KEY,
                        str(reason or ""),
                        _utc_now(),
                    ),
                )
            else:
                conn.execute(
                    """
                    DELETE FROM workflow_dispatch_control
                    WHERE control_key = ?
                    """,
                    (_CONTROL_KEY,),
                )
    finally:
        conn.close()


def _finish_reservation(
    db_path: Path,
    reservation: WorkflowDispatchReservation,
    *,
    state: str,
) -> None:
    conn = _open_control_connection(db_path)
    try:
        with conn:
            updated = conn.execute(
                """
                UPDATE workflow_dispatch_registry
                SET temporal_run_id = ?,
                    state = ?,
                    updated_at = ?
                WHERE launch_id = ?
                  AND state = 'reserved'
                """,
                (
                    reservation.temporal_run_id,
                    state,
                    _utc_now(),
                    reservation.launch_id,
                ),
            )
            if updated.rowcount != 1:
                raise RuntimeError(
                    "workflow launch reservation changed unexpectedly"
                )
    finally:
        conn.close()


def _open_control_connection(
    db_path: Path,
) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def _resolve_db_path(
    db_path: Path | str | None,
) -> Path:
    return Path(db_path if db_path is not None else config.DB_PATH)


def _lock_path(db_path: Path) -> Path:
    return db_path.with_name(f".{db_path.name}{_LOCK_SUFFIX}")


def _acquire_lock(path: Path, operation: int) -> int:
    fd = _open_lock_file(path)
    try:
        fcntl.flock(fd, operation)
    except BaseException:
        os.close(fd)
        raise
    return fd


async def _acquire_lock_async(
    path: Path,
    operation: int,
) -> int:
    fd = _open_lock_file(path)
    try:
        while True:
            try:
                fcntl.flock(
                    fd,
                    operation | fcntl.LOCK_NB,
                )
                return fd
            except BlockingIOError:
                await asyncio.sleep(0.05)
    except BaseException:
        os.close(fd)
        raise


def _open_lock_file(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0)
    return os.open(path, flags, 0o600)


def _release_lock(fd: int) -> None:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


@contextmanager
def _locked(
    path: Path,
    operation: int,
) -> Iterator[None]:
    fd = _acquire_lock(path, operation)
    try:
        yield
    finally:
        _release_lock(fd)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


__all__ = [
    "UnregisteredWorkflowDispatchError",
    "WorkflowDispatchReservation",
    "WorkflowDispatchFencedError",
    "activate_workflow_dispatch_fence",
    "ensure_workflow_dispatch_control_tables",
    "reserve_workflow_dispatch",
    "set_workflow_dispatches_blocked",
    "workflow_dispatch_read_lock",
    "workflow_dispatches_blocked",
]
