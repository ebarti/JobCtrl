"""Run a blocking sync function inside a Temporal activity without
starving the worker's event loop.

Every non-apply activity (``discover``, ``enrich``, ``score``,
``tailor``, ``cover``, ``pdf``, ``profile_import``) wraps a synchronous
``run_pipeline(...)`` call. Calling that synchronously from inside the
``async def`` activity body blocks the asyncio event loop for the
entire stage duration, which:

* defeats heartbeating (no other coroutine runs, so any periodic
  heartbeat we'd schedule never fires);
* starves every other activity on the same worker (they can't make
  progress until the blocking call returns);
* exposes the workflow to silent hangs because no
  ``heartbeat_timeout`` can detect the stall.

This helper offloads the synchronous work to the default
``ThreadPoolExecutor`` and emits a heartbeat every ``poll_interval``
seconds while waiting. Cancellation propagates: workflow ``cancel``
surfaces as ``asyncio.CancelledError``; the helper re-raises so the
activity's caller can decide what to do.
"""

from __future__ import annotations

import asyncio
from typing import Callable, TypeVar

from temporalio import activity

_T = TypeVar("_T")


async def run_blocking_with_heartbeat(
    fn: Callable[[], _T],
    *,
    starting_message: str,
    progress_message: str = "still running",
    poll_interval: float = 15.0,
) -> _T:
    """Execute ``fn()`` in a worker thread, heartbeating every ``poll_interval``.

    Mirrors the pattern ``apply_activity`` uses, lifted into a reusable
    helper so the six non-apply activities stop blocking the event loop.
    """
    activity.heartbeat(starting_message)
    loop = asyncio.get_running_loop()
    task = loop.run_in_executor(None, fn)
    try:
        while True:
            try:
                return await asyncio.wait_for(asyncio.shield(task), timeout=poll_interval)
            except asyncio.TimeoutError:
                activity.heartbeat(progress_message)
    finally:
        # Final heartbeat so a future post-loop delay regression doesn't
        # surface as a phantom dead activity. Never raise from cleanup.
        try:
            activity.heartbeat("done")
        except Exception:  # noqa: BLE001 — heartbeat outside activity ctx is fine
            pass


__all__ = ["run_blocking_with_heartbeat"]
