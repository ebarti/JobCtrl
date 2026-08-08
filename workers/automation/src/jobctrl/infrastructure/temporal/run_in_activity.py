"""Run blocking sync work inside a Temporal activity without starving the
worker's event loop.

Several activities still call synchronous domain runners. Calling those
directly from inside the ``async def`` activity body blocks the asyncio event
loop for the entire stage duration, which:

* defeats heartbeating (no other coroutine runs, so any periodic
  heartbeat we'd schedule never fires);
* starves every other activity on the same worker (they can't make
  progress until the blocking call returns);
* exposes the workflow to silent hangs because no
  ``heartbeat_timeout`` can detect the stall.

This helper offloads the synchronous work to the bounded worker-owned
``ThreadPoolExecutor`` and emits a heartbeat every ``poll_interval``
seconds while waiting. Cancellation propagates: workflow ``cancel``
sets the supplied cooperative cancel hook, gives the function a bounded
window to stop, records ignored cancellation, then re-raises
``asyncio.CancelledError`` so the activity's caller can decide what to do.
The blocking executor generation is retired before that grace window so a
server-dispatched retry cannot queue behind the provider call being cancelled.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import logging
import threading
from typing import Callable, TypeVar

from temporalio import activity

_T = TypeVar("_T")
log = logging.getLogger(__name__)
_ACTIVITY_EXECUTOR: ThreadPoolExecutor | None = None
# One (executor, abandoned task) pair per rotation. The task is the future of
# the blocking call that ignored cancellation; once it finishes, the retired
# generation has served its purpose and the entry is pruned on the next
# rotation instead of accumulating until worker shutdown.
_RETIRED_ACTIVITY_EXECUTORS: list[tuple[ThreadPoolExecutor, asyncio.Future]] = []
_ACTIVITY_EXECUTOR_LOCK = threading.Lock()


def set_activity_executor(executor: ThreadPoolExecutor | None) -> None:
    """Set the bounded executor owned by the Temporal worker."""
    global _ACTIVITY_EXECUTOR
    with _ACTIVITY_EXECUTOR_LOCK:
        _ACTIVITY_EXECUTOR = executor


def shutdown_activity_executors() -> None:
    """Stop accepting work on current and retired blocking executors."""

    global _ACTIVITY_EXECUTOR
    with _ACTIVITY_EXECUTOR_LOCK:
        executors = [
            executor
            for executor in [
                _ACTIVITY_EXECUTOR,
                *(executor for executor, _task in _RETIRED_ACTIVITY_EXECUTORS),
            ]
            if executor is not None
        ]
        _ACTIVITY_EXECUTOR = None
        _RETIRED_ACTIVITY_EXECUTORS.clear()
    for executor in dict.fromkeys(executors):
        executor.shutdown(wait=False, cancel_futures=True)


def _activity_executor() -> ThreadPoolExecutor | None:
    with _ACTIVITY_EXECUTOR_LOCK:
        return _ACTIVITY_EXECUTOR


def _prune_retired_activity_executors_locked() -> None:
    """Drop retired generations whose abandoned task has since finished.

    Callers must hold ``_ACTIVITY_EXECUTOR_LOCK``. A finished task means the
    stuck blocking call returned, so the shut-down executor only has winding
    threads left; releasing our reference lets it be collected instead of
    growing one entry per cancellation until worker shutdown.
    """

    _RETIRED_ACTIVITY_EXECUTORS[:] = [
        (executor, task)
        for executor, task in _RETIRED_ACTIVITY_EXECUTORS
        if not task.done()
    ]


def _replacement_max_workers(abandoned_executor: ThreadPoolExecutor) -> int:
    """Size the replacement like the generation it replaces.

    ``ThreadPoolExecutor._max_workers`` is a private attribute; if a future
    Python release drops it, fall back to the worker's own executor sizing
    rule instead of silently collapsing blocking concurrency to one thread.
    """

    raw = getattr(abandoned_executor, "_max_workers", None)
    if isinstance(raw, int) and raw > 0:
        return raw
    from jobctrl.infrastructure.temporal.concurrency import (
        activity_executor_max_workers,
        resolve_max_concurrent_activities,
    )

    return activity_executor_max_workers(resolve_max_concurrent_activities().value)


def _rotate_abandoned_activity_executor(
    abandoned_executor: ThreadPoolExecutor | None,
    abandoned_task: asyncio.Future,
) -> bool:
    """Move future blocking work off an executor containing a stuck thread."""

    global _ACTIVITY_EXECUTOR
    if abandoned_executor is None:
        return False
    with _ACTIVITY_EXECUTOR_LOCK:
        _prune_retired_activity_executors_locked()
        if _ACTIVITY_EXECUTOR is not abandoned_executor:
            return False
        replacement = ThreadPoolExecutor(
            max_workers=_replacement_max_workers(abandoned_executor),
            thread_name_prefix="jobctrl-blocking-activity-recovery",
        )
        _ACTIVITY_EXECUTOR = replacement
        _RETIRED_ACTIVITY_EXECUTORS.append((abandoned_executor, abandoned_task))
    # The retired generation is dedicated to blocking activity helpers. Let its
    # already-submitted functions wind down, but never route new work to it.
    abandoned_executor.shutdown(wait=False, cancel_futures=False)
    return True


async def run_blocking_with_heartbeat(
    fn: Callable[[], _T],
    *,
    starting_message: str,
    progress_message: str = "still running",
    poll_interval: float = 15.0,
    on_cancel: Callable[[], None] | None = None,
    cancel_wait_seconds: float = 30.0,
    activity_name: str | None = None,
    job_context: dict[str, object] | None = None,
) -> _T:
    """Execute ``fn()`` in a worker thread, heartbeating every ``poll_interval``.

    Mirrors the pattern ``apply_activity`` uses, lifted into a reusable
    helper so the non-apply activities stop blocking the event loop.
    """
    activity.heartbeat(starting_message)
    loop = asyncio.get_running_loop()
    blocking_executor = _activity_executor()
    task = loop.run_in_executor(blocking_executor, fn)
    activity_label = activity_name or activity.info().activity_type
    try:
        while True:
            done, _pending = await asyncio.wait({task}, timeout=poll_interval)
            if task in done:
                return await task
            else:
                activity.heartbeat(progress_message)
    except asyncio.CancelledError:
        if on_cancel is not None:
            on_cancel()
        # Temporal records StartToClose timeout before the SDK finishes local
        # cancellation cleanup. Retire this generation synchronously, before
        # the first await below, so an immediate retry cannot queue behind the
        # provider call whose thread may ignore cooperative cancellation.
        executor_rotated = (
            _rotate_abandoned_activity_executor(blocking_executor, task)
            if not task.done()
            else False
        )
        if cancel_wait_seconds > 0:
            try:
                done, _pending = await asyncio.wait({task}, timeout=cancel_wait_seconds)
                if task in done:
                    await task
            except Exception:  # noqa: BLE001 - cancellation cleanup must not mask cancellation
                pass
            if not task.done():
                log.warning(
                    "abandoned_thread",
                    extra={
                        "activity_name": activity_label,
                        "job_context": job_context or {},
                        "activity_executor_rotated": executor_rotated,
                    },
                )
                _record_abandoned_thread_metric(activity_label, job_context or {})
        raise
    finally:
        # Final heartbeat so a future post-loop delay regression doesn't
        # surface as a phantom dead activity. Never raise from cleanup.
        try:
            activity.heartbeat("done")
        except Exception:  # noqa: BLE001 — heartbeat outside activity ctx is fine
            pass


def _record_abandoned_thread_metric(activity_name: str, job_context: dict[str, object]) -> None:
    try:
        from jobctrl.database import get_connection
        from jobctrl.operational_metrics import record_operational_attempt_metric
    except Exception:  # pragma: no cover - optional metrics path
        return
    try:
        conn = get_connection()
        record_operational_attempt_metric(
            conn,
            stage="operations",
            attempt_kind="temporal_activity_thread",
            outcome="failed",
            adapter=activity_name,
            error_class="abandoned_thread",
            error_message="Activity thread ignored cooperative cancellation.",
            metadata={key: str(value) for key, value in job_context.items()},
        )
        conn.commit()
    except Exception:  # pragma: no cover - metrics must never mask cancellation
        log.debug("failed to record abandoned_thread metric", exc_info=True)


__all__ = [
    "run_blocking_with_heartbeat",
    "set_activity_executor",
    "shutdown_activity_executors",
]
