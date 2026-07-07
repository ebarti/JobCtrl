"""Default Temporal-backed implementations of the workflow start / cancel seams.

The JSON-RPC server depends on these via constructor injection so unit tests
can substitute stubs without booting a Temporal cluster.

The Temporal :class:`Client` is intentionally NOT cached at module scope.
The earlier cache broke on the second JSON-RPC call because each request
opens a fresh event loop via ``asyncio.run(...)``, and Temporal's cached
``Client`` (plus the module-scope ``asyncio.Lock``) is bound to the loop
that constructed it; reusing it from a new loop raises
``RuntimeError: <Lock ...> is bound to a different event loop`` and
defeats every gRPC retry. Reconnecting per request costs a single
TCP+TLS+namespace-describe round-trip — a few ms against localhost.
``jobctrl rpc`` is the only caller and runs in the user's loopback
worker, so the optimisation isn't worth the correctness cost.

The proper long-term fix is to host one process-wide event loop inside
``JsonRpcServer.serve()`` (so dispatch can ``loop.run_until_complete(...)``
instead of opening a fresh loop per request), at which point the cache
becomes safe again. That is tracked as a follow-up; for now we err on the
side of correctness.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Coroutine
from uuid import uuid4

from temporalio.client import WorkflowHandle
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy

from jobctrl.domain.rpc.messages import WorkflowStartSpec
from jobctrl.infrastructure.temporal.client import get_temporal_client
from jobctrl.infrastructure.temporal.task_queues import JOBCTRL_TASK_QUEUE

log = logging.getLogger(__name__)

# ``Coroutine[Any, Any, T]`` rather than ``Awaitable[T]`` so ``asyncio.run``
# accepts the return value without a static-type complaint. Only async-def
# callables satisfy this — adapters that return a hand-rolled
# ``Awaitable`` (e.g., a custom ``__await__`` object) would need wrapping
# in ``asyncio.ensure_future`` first; the local Temporal-backed defaults
# are async-def so the constraint is free.
WorkflowStarter = Callable[[WorkflowStartSpec], Coroutine[Any, Any, WorkflowHandle]]
WorkflowCanceler = Callable[[str], Coroutine[Any, Any, None]]


async def default_workflow_starter(spec: WorkflowStartSpec) -> WorkflowHandle:
    client = await get_temporal_client()
    workflow_id = spec.workflow_id or f"run-{uuid4().hex}"
    # USE_EXISTING makes a double-start of a deterministic id (e.g.
    # ``apply-{jobKey}``) return the already-running handle instead of a
    # duplicate execution; ALLOW_DUPLICATE lets a fresh run reuse the id once
    # the prior run has closed. For unique ``run-{uuid}`` ids these never
    # trigger, so they are safe as global defaults.
    id_conflict_policy = spec.id_conflict_policy or WorkflowIDConflictPolicy.USE_EXISTING
    id_reuse_policy = spec.id_reuse_policy or WorkflowIDReusePolicy.ALLOW_DUPLICATE
    handle = await client.start_workflow(
        spec.workflow,
        *spec.args,
        id=workflow_id,
        task_queue=JOBCTRL_TASK_QUEUE,
        retry_policy=spec.retry_policy,
        id_conflict_policy=id_conflict_policy,
        id_reuse_policy=id_reuse_policy,
    )
    _record_dispatch_started(spec, workflow_id, handle)
    return handle


async def default_workflow_canceler(run_id: str) -> None:
    client = await get_temporal_client()
    await client.get_workflow_handle(run_id).cancel()


def _record_dispatch_started(
    spec: WorkflowStartSpec,
    workflow_id: str,
    handle: WorkflowHandle,
) -> None:
    """Create an open run row at dispatch time so pre-start-marker deaths show in /runs."""
    try:
        from jobctrl.database import get_connection
        from jobctrl.domain.events.workflow import (
            WorkflowStartedPayload,
            create_workflow_started,
        )
        from jobctrl.domain.tenant import LOCAL_TENANT
        from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
        from jobctrl.state import record_job_event, utc_now

        payload = spec.args[0] if spec.args else None
        tenant_id = str(getattr(payload, "tenant_id", LOCAL_TENANT) or LOCAL_TENANT)
        event = create_workflow_started(
            tenant_id,
            WorkflowStartedPayload(
                workflow_id=workflow_id,
                workflow_type=getattr(spec.workflow, "__name__", str(spec.workflow)),
                input_summary=_dispatch_input_summary(payload),
                started_at=utc_now(),
                temporal_run_id=(
                    getattr(handle, "first_execution_run_id", None)
                    or getattr(handle, "result_run_id", None)
                    or getattr(handle, "run_id", None)
                ),
            ),
        )
        conn = get_connection()
        record_job_event(conn, None, "workflow", event.event_type, payload=dict(event.payload))
        conn.commit()
        ProjectionBuilder(conn_factory=get_connection).refresh()
    except Exception:
        log.warning("Failed to write dispatch-time workflow start row", exc_info=True)


def _dispatch_input_summary(payload: object | None) -> dict[str, Any]:
    if payload is None:
        return {}
    summary: dict[str, Any] = {}
    for attr, key in (
        ("stages", "stages"),
        ("dry_run", "dryRun"),
        ("limit", "limit"),
        ("job_url", "jobUrl"),
        ("continuous", "continuous"),
        ("auto_apply_loop", "autoApplyLoop"),
    ):
        if not hasattr(payload, attr):
            continue
        value = getattr(payload, attr)
        if isinstance(value, tuple):
            value = list(value)
        summary[key] = value
    return summary


__all__ = [
    "WorkflowCanceler",
    "WorkflowStarter",
    "default_workflow_canceler",
    "default_workflow_starter",
]
