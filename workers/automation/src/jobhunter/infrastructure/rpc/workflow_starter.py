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
``jobhunter rpc`` is the only caller and runs in the user's loopback
worker, so the optimisation isn't worth the correctness cost.

The proper long-term fix is to host one process-wide event loop inside
``JsonRpcServer.serve()`` (so dispatch can ``loop.run_until_complete(...)``
instead of opening a fresh loop per request), at which point the cache
becomes safe again. That is tracked as a follow-up; for now we err on the
side of correctness.
"""

from __future__ import annotations

from typing import Any, Callable, Coroutine
from uuid import uuid4

from temporalio.client import WorkflowHandle

from jobhunter.domain.rpc.messages import WorkflowStartSpec
from jobhunter.infrastructure.temporal.client import get_temporal_client
from jobhunter.infrastructure.temporal.task_queues import JOBHUNTER_TASK_QUEUE

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
    return await client.start_workflow(
        spec.workflow,
        *spec.args,
        id=workflow_id,
        task_queue=JOBHUNTER_TASK_QUEUE,
        retry_policy=spec.retry_policy,
    )


async def default_workflow_canceler(run_id: str) -> None:
    client = await get_temporal_client()
    await client.get_workflow_handle(run_id).cancel()


__all__ = [
    "WorkflowCanceler",
    "WorkflowStarter",
    "default_workflow_canceler",
    "default_workflow_starter",
]
