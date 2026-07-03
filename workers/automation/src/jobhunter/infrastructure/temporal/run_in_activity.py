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
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import logging
from typing import Callable, TypeVar

from temporalio import activity

_T = TypeVar("_T")
log = logging.getLogger(__name__)
_ACTIVITY_EXECUTOR: ThreadPoolExecutor | None = None


def set_activity_executor(executor: ThreadPoolExecutor | None) -> None:
    """Set the bounded executor owned by the Temporal worker."""
    global _ACTIVITY_EXECUTOR
    _ACTIVITY_EXECUTOR = executor


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
    task = loop.run_in_executor(_ACTIVITY_EXECUTOR, fn)
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
        from jobhunter.database import get_connection
        from jobhunter.operational_metrics import record_operational_attempt_metric
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


__all__ = ["run_blocking_with_heartbeat", "set_activity_executor"]
