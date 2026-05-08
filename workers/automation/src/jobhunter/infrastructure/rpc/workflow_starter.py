"""Default Temporal-backed implementations of the workflow start / cancel seams.

The JSON-RPC server depends on these via constructor injection so unit tests
can substitute stubs without booting a Temporal cluster.

The Temporal :class:`Client` is cached at module scope so repeated ``apply``
and ``cancel_run`` JSON-RPC calls reuse the same gRPC connection — the
``jobhunter rpc`` server is long-lived and a fresh ``Client.connect()`` per
request would burn a TCP / TLS / namespace-describe handshake on every
workflow start.  ``get_temporal_client()`` itself stays as the per-call
factory; caching is a workflow-starter concern.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Coroutine
from uuid import uuid4

from temporalio.client import Client, WorkflowHandle

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


_cached_client: Client | None = None
_cache_lock = asyncio.Lock()


async def _get_or_create_client() -> Client:
    """Return the cached Temporal :class:`Client`, building it on first call."""
    global _cached_client
    if _cached_client is not None:
        return _cached_client
    async with _cache_lock:
        if _cached_client is None:
            _cached_client = await get_temporal_client()
        return _cached_client


async def _reset_cached_client_for_tests() -> None:
    """Drop the cached client so tests can re-exercise the connect path."""
    global _cached_client
    async with _cache_lock:
        _cached_client = None


async def default_workflow_starter(spec: WorkflowStartSpec) -> WorkflowHandle:
    client = await _get_or_create_client()
    workflow_id = spec.workflow_id or f"run-{uuid4().hex}"
    return await client.start_workflow(
        spec.workflow,
        *spec.args,
        id=workflow_id,
        task_queue=JOBHUNTER_TASK_QUEUE,
        retry_policy=spec.retry_policy,
    )


async def default_workflow_canceler(run_id: str) -> None:
    client = await _get_or_create_client()
    await client.get_workflow_handle(run_id).cancel()


__all__ = [
    "WorkflowCanceler",
    "WorkflowStarter",
    "default_workflow_canceler",
    "default_workflow_starter",
]
