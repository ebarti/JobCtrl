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
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
import logging
import threading
from typing import Callable, Literal, TypeVar

from temporalio import activity

from jobctrl.domain.errors import JobCtrlError
from jobctrl.infrastructure.workflow_run_context import carry_workflow_run_context

_T = TypeVar("_T")
log = logging.getLogger(__name__)
_ACTIVITY_EXECUTOR: ThreadPoolExecutor | None = None
# One (executor, abandoned task) pair per rotation. A retired executor remains
# owned while any of its underlying submitted calls is still running.
_RETIRED_ACTIVITY_EXECUTORS: list[tuple[ThreadPoolExecutor, asyncio.Future | None]] = []
_ACTIVITY_EXECUTOR_LOCK = threading.Lock()
_ACTIVITY_EXECUTOR_FUTURES: dict[ThreadPoolExecutor, set[Future]] = {}
_ACTIVITY_DRAINING = False
_ACTIVITY_JOINING = False
# This includes the current generation: the worker can replace a stuck pool
# twice, then must refuse submissions until an entire retired pool has returned.
MAX_OUTSTANDING_ACTIVITY_EXECUTOR_GENERATIONS = 3
_ACTIVITY_RECOVERY_MAX_WORKERS: int | None = None
_CONTROL_EXECUTOR: ThreadPoolExecutor | None = None
_CONTROL_EXECUTOR_RETIRING = False
_CONTROL_MAX_OUTSTANDING_CALLS = 2


class ActivityExecutorCapacityExhausted(JobCtrlError):
    """A retryable refusal; an abandoned call may still be running."""

    code = "activity_executor_capacity_exhausted"


class ControlActivityCapacityExhausted(JobCtrlError):
    """A retryable refusal while the separately bounded control lane is full."""

    code = "control_activity_capacity_exhausted"


@dataclass(frozen=True)
class ActivityExecutorStatus:
    """Process-local admission state, not proof that threads or children stopped."""

    unfinished_retired_generations: int
    unfinished_retired_calls: int
    generation_limit: int
    next_submission: Literal["accepting", "refusing", "draining", "unmanaged"]
    control_unfinished_calls: int = 0
    control_next_submission: Literal["accepting", "refusing", "draining"] = "accepting"

    def to_json_dict(self) -> dict[str, int | str]:
        return {
            "version": 1,
            "unfinishedRetiredGenerations": self.unfinished_retired_generations,
            "unfinishedRetiredCalls": self.unfinished_retired_calls,
            "generationLimit": self.generation_limit,
            "nextSubmission": self.next_submission,
            "controlUnfinishedCalls": self.control_unfinished_calls,
            "controlNextSubmission": self.control_next_submission,
        }


class ActivityThreadPoolExecutor(ThreadPoolExecutor):
    """An activity's SQLite lifetime ends before its pool thread is reused."""

    def submit(self, fn, /, *args, **kwargs):
        return super().submit(_run_activity_with_connection_cleanup, fn, args, kwargs)


def _run_activity_with_connection_cleanup(fn, args, kwargs):
    from jobctrl.database import close_thread_connections

    completed = False
    try:
        result = fn(*args, **kwargs)
        completed = True
        return result
    finally:
        unfinished = close_thread_connections()
        if completed and unfinished:
            raise RuntimeError("activity_transaction_unfinished")


def set_activity_executor(executor: ThreadPoolExecutor | None) -> None:
    """Set the bounded executor owned by the Temporal worker."""
    global _ACTIVITY_EXECUTOR, _ACTIVITY_DRAINING, _ACTIVITY_RECOVERY_MAX_WORKERS
    previous = None
    with _ACTIVITY_EXECUTOR_LOCK:
        if _ACTIVITY_JOINING:
            raise RuntimeError("activity executor is draining")
        _prune_retired_activity_executors_locked()
        previous = _ACTIVITY_EXECUTOR
        if previous is not None and previous is not executor:
            if any(not future.done() for future in _ACTIVITY_EXECUTOR_FUTURES.get(previous, ())):
                raise RuntimeError("cannot replace an activity executor with unfinished calls")
            _ACTIVITY_EXECUTOR_FUTURES.pop(previous, None)
        if executor is not None and executor is not previous:
            if len(_RETIRED_ACTIVITY_EXECUTORS) >= MAX_OUTSTANDING_ACTIVITY_EXECUTOR_GENERATIONS:
                raise _capacity_exhausted_locked()
        _ACTIVITY_EXECUTOR = executor
        _ACTIVITY_DRAINING = False
        _ACTIVITY_RECOVERY_MAX_WORKERS = None
    if previous is not None and previous is not executor:
        previous.shutdown(wait=False, cancel_futures=True)


def shutdown_activity_executors() -> None:
    """Stop accepting work on current and retired blocking executors."""

    global _ACTIVITY_EXECUTOR, _ACTIVITY_RECOVERY_MAX_WORKERS, _CONTROL_EXECUTOR, _CONTROL_EXECUTOR_RETIRING
    with _ACTIVITY_EXECUTOR_LOCK:
        _ACTIVITY_RECOVERY_MAX_WORKERS = None
        _prune_retired_activity_executors_locked()
        if _ACTIVITY_EXECUTOR is not None:
            if any(
                not future.done()
                for future in _ACTIVITY_EXECUTOR_FUTURES.get(_ACTIVITY_EXECUTOR, ())
            ):
                _RETIRED_ACTIVITY_EXECUTORS.append((_ACTIVITY_EXECUTOR, None))
            else:
                _ACTIVITY_EXECUTOR_FUTURES.pop(_ACTIVITY_EXECUTOR, None)
        control_executor = _CONTROL_EXECUTOR
        if control_executor is not None:
            _CONTROL_EXECUTOR_RETIRING = True
            if not any(not future.done() for future in _ACTIVITY_EXECUTOR_FUTURES.get(control_executor, ())):
                _ACTIVITY_EXECUTOR_FUTURES.pop(control_executor, None)
                _CONTROL_EXECUTOR = None
                _CONTROL_EXECUTOR_RETIRING = False
        executors = [
            executor
            for executor in [
                _ACTIVITY_EXECUTOR,
                control_executor,
                *(executor for executor, _task in _RETIRED_ACTIVITY_EXECUTORS),
            ]
            if executor is not None
        ]
        _ACTIVITY_EXECUTOR = None
    for executor in dict.fromkeys(executors):
        executor.shutdown(wait=False, cancel_futures=True)


async def drain_activity_executors() -> None:
    """Fence new helper work and join every retained blocking executor.

    This drains Python threads only; it is not evidence that detached child
    processes have exited. The native launcher must not use it as such.
    """
    global _ACTIVITY_EXECUTOR, _ACTIVITY_DRAINING, _ACTIVITY_JOINING, _ACTIVITY_RECOVERY_MAX_WORKERS
    global _CONTROL_EXECUTOR, _CONTROL_EXECUTOR_RETIRING
    with _ACTIVITY_EXECUTOR_LOCK:
        if _ACTIVITY_JOINING:
            raise RuntimeError("activity executor is already draining")
        _ACTIVITY_DRAINING = True
        _ACTIVITY_JOINING = True
        _ACTIVITY_RECOVERY_MAX_WORKERS = None
        control_executor = _CONTROL_EXECUTOR
        if control_executor is not None:
            _CONTROL_EXECUTOR_RETIRING = True
        if _ACTIVITY_EXECUTOR is not None and any(
            not future.done() for future in _ACTIVITY_EXECUTOR_FUTURES.get(_ACTIVITY_EXECUTOR, ())
        ):
            # Keep the current pool owned if joining raises. A failed join is
            # not evidence that any of its running calls returned.
            _RETIRED_ACTIVITY_EXECUTORS.append((_ACTIVITY_EXECUTOR, None))
        executors = list(dict.fromkeys(
            [executor for executor in [_ACTIVITY_EXECUTOR, control_executor, *(
                retired for retired, _task in _RETIRED_ACTIVITY_EXECUTORS
            )] if executor is not None]
        ))
        _ACTIVITY_EXECUTOR = None
    # Joining can take as long as a blocking provider call. Keep the event loop
    # alive, and finish joining before propagating cancellation to cleanup.
    async def join() -> None:
        for executor in executors:
            await asyncio.to_thread(executor.shutdown, wait=True, cancel_futures=True)

    join_task = asyncio.create_task(join())
    canceled = False
    while not join_task.done():
        try:
            await asyncio.shield(join_task)
        except asyncio.CancelledError:
            canceled = True
        except Exception:
            # Inspect the join failure below so the in-progress drain fence
            # is released without losing the unfinished executor reference.
            break
    try:
        join_task.result()
    except BaseException:
        with _ACTIVITY_EXECUTOR_LOCK:
            _ACTIVITY_JOINING = False
            _prune_retired_activity_executors_locked()
        raise
    with _ACTIVITY_EXECUTOR_LOCK:
        _ACTIVITY_JOINING = False
        if _CONTROL_EXECUTOR is control_executor:
            _CONTROL_EXECUTOR = None
            _CONTROL_EXECUTOR_RETIRING = False
        _RETIRED_ACTIVITY_EXECUTORS[:] = [
            (executor, task)
            for executor, task in _RETIRED_ACTIVITY_EXECUTORS
            if executor not in executors
        ]
        for executor in executors:
            _ACTIVITY_EXECUTOR_FUTURES.pop(executor, None)
    if canceled:
        raise asyncio.CancelledError


def _activity_executor() -> ThreadPoolExecutor | None:
    with _ACTIVITY_EXECUTOR_LOCK:
        return _ACTIVITY_EXECUTOR


def _prune_retired_activity_executors_locked() -> None:
    """Drop retired generations whose abandoned task has since finished.

    Callers must hold ``_ACTIVITY_EXECUTOR_LOCK``. One rotation-triggering task
    may finish before other calls in the same executor, so check all tracked
    underlying futures before releasing its reference.
    """

    retained = []
    for executor, task in _RETIRED_ACTIVITY_EXECUTORS:
        futures = _ACTIVITY_EXECUTOR_FUTURES.get(executor)
        # The concurrent futures are the authority even if their asyncio
        # wrappers are cancelled or their event loop has already closed. The
        # marker-only case supports callers rotating an otherwise idle pool.
        unfinished = (
            any(not future.done() for future in futures)
            if futures is not None
            else task is not None and not task.done()
        )
        if unfinished:
            retained.append((executor, task))
        else:
            _ACTIVITY_EXECUTOR_FUTURES.pop(executor, None)
    _RETIRED_ACTIVITY_EXECUTORS[:] = retained


def _activity_executor_status_locked() -> ActivityExecutorStatus:
    _prune_retired_activity_executors_locked()
    retired_count = len(_RETIRED_ACTIVITY_EXECUTORS)
    unfinished_calls = sum(
        sum(not future.done() for future in _ACTIVITY_EXECUTOR_FUTURES.get(executor, ()))
        for executor, _task in _RETIRED_ACTIVITY_EXECUTORS
    )
    if _ACTIVITY_DRAINING:
        next_submission = "draining"
    elif _ACTIVITY_EXECUTOR is not None:
        next_submission = "accepting"
    elif _ACTIVITY_RECOVERY_MAX_WORKERS is not None:
        next_submission = (
            "accepting" if retired_count < MAX_OUTSTANDING_ACTIVITY_EXECUTOR_GENERATIONS else "refusing"
        )
    elif retired_count:
        # Do not bypass tracked work through asyncio's untracked default pool.
        next_submission = "refusing"
    else:
        next_submission = "unmanaged"
    control_calls = sum(
        not future.done() for future in _ACTIVITY_EXECUTOR_FUTURES.get(_CONTROL_EXECUTOR, ())
    )
    if _ACTIVITY_DRAINING:
        control_next_submission = "draining"
    elif (_CONTROL_EXECUTOR_RETIRING and control_calls) or control_calls >= _CONTROL_MAX_OUTSTANDING_CALLS:
        control_next_submission = "refusing"
    else:
        control_next_submission = "accepting"
    return ActivityExecutorStatus(
        unfinished_retired_generations=retired_count,
        unfinished_retired_calls=unfinished_calls,
        generation_limit=MAX_OUTSTANDING_ACTIVITY_EXECUTOR_GENERATIONS,
        next_submission=next_submission,
        control_unfinished_calls=control_calls,
        control_next_submission=control_next_submission,
    )


def activity_executor_status() -> ActivityExecutorStatus:
    """Return admission state without claiming unfinished work has stopped."""
    with _ACTIVITY_EXECUTOR_LOCK:
        return _activity_executor_status_locked()


def _capacity_exhausted_locked() -> ActivityExecutorCapacityExhausted:
    status = _activity_executor_status_locked()
    return ActivityExecutorCapacityExhausted(
        "activity_executor_capacity_exhausted: "
        f"{status.unfinished_retired_generations} retired blocking executor generations "
        f"contain {status.unfinished_retired_calls} unfinished calls; new blocking work "
        "is refused until a generation finishes. Cancellation did not prove the calls stopped."
    )


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

    global _ACTIVITY_EXECUTOR, _ACTIVITY_RECOVERY_MAX_WORKERS
    if abandoned_executor is None:
        return False
    with _ACTIVITY_EXECUTOR_LOCK:
        _prune_retired_activity_executors_locked()
        if _ACTIVITY_EXECUTOR is not abandoned_executor:
            return False
        max_workers = _replacement_max_workers(abandoned_executor)
        _RETIRED_ACTIVITY_EXECUTORS.append((abandoned_executor, abandoned_task))
        _ACTIVITY_EXECUTOR = None
        if len(_RETIRED_ACTIVITY_EXECUTORS) < MAX_OUTSTANDING_ACTIVITY_EXECUTOR_GENERATIONS:
            _ACTIVITY_EXECUTOR = ActivityThreadPoolExecutor(
                max_workers=max_workers,
                thread_name_prefix="jobctrl-blocking-activity-recovery",
            )
            rotated = True
        else:
            # Keep the width so the next admission can create a fresh pool as
            # soon as an entire retired generation actually finishes.
            _ACTIVITY_RECOVERY_MAX_WORKERS = max_workers
            rotated = False
    # The retired generation is dedicated to blocking activity helpers. Let its
    # already-submitted functions wind down, but never route new work to it.
    abandoned_executor.shutdown(wait=False, cancel_futures=False)
    return rotated


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
    control: bool = False,
) -> _T:
    """Execute ``fn()`` in a worker thread, heartbeating every ``poll_interval``.

    Mirrors the pattern ``apply_activity`` uses, lifted into a reusable
    helper so the non-apply activities stop blocking the event loop.
    """
    global _ACTIVITY_EXECUTOR, _ACTIVITY_RECOVERY_MAX_WORKERS, _CONTROL_EXECUTOR, _CONTROL_EXECUTOR_RETIRING
    heartbeat_supported = not (activity.in_activity() and activity.info().is_local)
    if heartbeat_supported:
        activity.heartbeat(starting_message)
    loop = asyncio.get_running_loop()
    # Submit under the same lock as the drain fence. Keep the actual concurrent
    # futures: cancelling an asyncio wrapper is not proof its thread returned.
    # ``run_in_executor`` does not carry this coroutine's context into the
    # worker thread. Carry canonical workflow ownership and OTel context so
    # durable events and child model/stage spans retain the submitting run.
    # Direct activity runners may use asyncio's default pool rather than the
    # production ActivityThreadPoolExecutor. Enforce the same connection
    # boundary there, before an idle thread can retain a failed writer.
    call = carry_workflow_run_context(lambda: _run_activity_with_connection_cleanup(fn, (), {}))
    with _ACTIVITY_EXECUTOR_LOCK:
        if _ACTIVITY_DRAINING:
            raise RuntimeError("activity executor is draining")
        status = _activity_executor_status_locked()
        if control and status.control_next_submission == "refusing":
            raise ControlActivityCapacityExhausted(
                "control_activity_capacity_exhausted: short-control calls are still running; "
                "new control work is refused until a call returns."
            )
        if not control and status.next_submission == "refusing":
            log.warning(
                "activity_executor_capacity_exhausted",
                extra={
                    "unfinished_retired_generations": status.unfinished_retired_generations,
                    "unfinished_retired_calls": status.unfinished_retired_calls,
                    "generation_limit": status.generation_limit,
                    "next_submission": status.next_submission,
                },
            )
            raise _capacity_exhausted_locked()
        if not control and _ACTIVITY_EXECUTOR is None and _ACTIVITY_RECOVERY_MAX_WORKERS is not None:
            _ACTIVITY_EXECUTOR = ActivityThreadPoolExecutor(
                max_workers=_ACTIVITY_RECOVERY_MAX_WORKERS,
                thread_name_prefix="jobctrl-blocking-activity-recovery",
            )
            _ACTIVITY_RECOVERY_MAX_WORKERS = None
            log.info(
                "activity_executor_capacity_recovered",
                extra={
                    "unfinished_retired_generations": status.unfinished_retired_generations,
                    "unfinished_retired_calls": status.unfinished_retired_calls,
                    "generation_limit": status.generation_limit,
                    "next_submission": "accepting",
                },
            )
        if control:
            if _CONTROL_EXECUTOR_RETIRING and status.control_unfinished_calls == 0:
                _ACTIVITY_EXECUTOR_FUTURES.pop(_CONTROL_EXECUTOR, None)
                _CONTROL_EXECUTOR = None
                _CONTROL_EXECUTOR_RETIRING = False
            if _CONTROL_EXECUTOR is None:
                _CONTROL_EXECUTOR = ActivityThreadPoolExecutor(
                    max_workers=_CONTROL_MAX_OUTSTANDING_CALLS,
                    thread_name_prefix="jobctrl-control-activity",
                )
            blocking_executor = _CONTROL_EXECUTOR
        else:
            blocking_executor = _ACTIVITY_EXECUTOR
        if blocking_executor is not None:
            future = blocking_executor.submit(call)
            _ACTIVITY_EXECUTOR_FUTURES.setdefault(blocking_executor, set()).add(future)
    if blocking_executor is None:
        task = loop.run_in_executor(None, call)
    else:
        def forget(done: Future) -> None:
            global _CONTROL_EXECUTOR, _CONTROL_EXECUTOR_RETIRING
            with _ACTIVITY_EXECUTOR_LOCK:
                pending = _ACTIVITY_EXECUTOR_FUTURES.get(blocking_executor)
                if pending is not None:
                    pending.discard(done)
                    _prune_retired_activity_executors_locked()
                    if control and _CONTROL_EXECUTOR is blocking_executor and _CONTROL_EXECUTOR_RETIRING and not pending:
                        _ACTIVITY_EXECUTOR_FUTURES.pop(blocking_executor, None)
                        _CONTROL_EXECUTOR = None
                        _CONTROL_EXECUTOR_RETIRING = False

        future.add_done_callback(forget)
        task = asyncio.wrap_future(future, loop=loop)
    activity_label = activity_name or activity.info().activity_type
    try:
        while True:
            done, _pending = await asyncio.wait({task}, timeout=poll_interval)
            if task in done:
                return await task
            else:
                if heartbeat_supported:
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
            if not control and not task.done()
            else False
        )
        if cancel_wait_seconds > 0:
            try:
                deadline = loop.time() + cancel_wait_seconds
                while not task.done():
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        break
                    done, _pending = await asyncio.wait(
                        {task}, timeout=min(poll_interval, remaining),
                    )
                    if task in done:
                        break
                    # WAIT_CANCELLATION_COMPLETED still owns the activity
                    # until this drain settles. Keep a short server heartbeat
                    # alive without extending the bounded cleanup deadline.
                    if heartbeat_supported:
                        activity.heartbeat("stopping")
                if task.done():
                    await task
            except Exception:  # noqa: BLE001 - cancellation cleanup must not mask cancellation
                pass
            if not task.done():
                status = activity_executor_status()
                log.warning(
                    "abandoned_thread",
                    extra={
                        "activity_name": activity_label,
                        "job_context": job_context or {},
                        "activity_executor_rotated": executor_rotated,
                        "executor_lane": "control" if control else "blocking_stage",
                        "unfinished_retired_generations": status.unfinished_retired_generations,
                        "unfinished_retired_calls": status.unfinished_retired_calls,
                        "generation_limit": status.generation_limit,
                        "next_submission": status.control_next_submission if control else status.next_submission,
                    },
                )
                _record_abandoned_thread_metric(activity_label, job_context or {})
        raise
    finally:
        # Final heartbeat so a future post-loop delay regression doesn't
        # surface as a phantom dead activity. Never raise from cleanup.
        try:
            if heartbeat_supported:
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
    "ActivityExecutorCapacityExhausted",
    "ActivityExecutorStatus",
    "MAX_OUTSTANDING_ACTIVITY_EXECUTOR_GENERATIONS",
    "activity_executor_status",
    "run_blocking_with_heartbeat",
    "set_activity_executor",
    "shutdown_activity_executors",
    "drain_activity_executors",
]
