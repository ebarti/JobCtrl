"""Ambient canonical workflow ownership for events emitted during a run.

The workflow-run read model, the activity log, and the run drawer's
"Review activity" query all identify a Temporal run by its canonical
``workflow_id``. Worker code that persists durable events (``record_job_event``)
runs far below the activity boundary — in the blocking executor thread and in
per-stage fan-out threads — where ``temporalio.activity.info()`` is not
available. This module carries the owning workflow id across those thread
hops so every event emitted while a run is executing can be stamped with its
canonical run ownership.

Resolution order for :func:`current_workflow_id`:

1. an explicit binding made with :func:`workflow_run_context` (set when work
   crosses a thread boundary), then
2. the enclosing Temporal activity context, when the caller is still on a
   thread that has one.

Outside any Temporal run both sources are empty and the helpers are no-ops,
so CLI one-offs and unit tests keep their existing event payloads.
"""

from __future__ import annotations

import contextvars
from contextlib import contextmanager
from typing import Callable, Iterator, TypeVar

_T = TypeVar("_T")

_WORKFLOW_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "jobctrl_workflow_run_context",
    default=None,
)


def current_workflow_id() -> str | None:
    """Canonical Temporal workflow id owning the current work, if any."""
    bound = _WORKFLOW_ID.get()
    if bound:
        return bound
    try:
        from temporalio import activity

        info = activity.info()
    except Exception:  # noqa: BLE001 — no activity context on this thread
        return None
    workflow_id = getattr(info, "workflow_id", None)
    return str(workflow_id) if workflow_id else None


@contextmanager
def workflow_run_context(workflow_id: str | None) -> Iterator[None]:
    """Bind ``workflow_id`` as the owning run for the enclosed work."""
    if not workflow_id:
        yield
        return
    token = _WORKFLOW_ID.set(str(workflow_id))
    try:
        yield
    finally:
        _WORKFLOW_ID.reset(token)


def carry_workflow_run_context(fn: Callable[..., _T]) -> Callable[..., _T]:
    """Bind the caller's resolved workflow id into work run on other threads.

    The id is resolved once, on the calling thread (which may still have the
    Temporal activity context). The returned callable re-binds it wherever it
    executes, so executor fan-out keeps the owning run of the submitting
    activity. Safe to share across pool threads: the binding is scoped to each
    invocation's thread context.
    """
    workflow_id = current_workflow_id()

    def bound(*args: object, **kwargs: object) -> _T:
        with workflow_run_context(workflow_id):
            return fn(*args, **kwargs)

    return bound


__all__ = [
    "carry_workflow_run_context",
    "current_workflow_id",
    "workflow_run_context",
]
