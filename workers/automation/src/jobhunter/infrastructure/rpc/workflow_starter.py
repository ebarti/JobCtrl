"""Default Temporal-backed implementations of the workflow start / cancel seams.

The JSON-RPC server depends on these via constructor injection so unit tests
can substitute stubs without booting a Temporal cluster.
"""

from __future__ import annotations

from typing import Awaitable, Callable
from uuid import uuid4

from temporalio.client import WorkflowHandle

from jobhunter.domain.rpc.messages import WorkflowStartSpec
from jobhunter.infrastructure.temporal.client import get_temporal_client
from jobhunter.infrastructure.temporal.task_queues import JOBHUNTER_TASK_QUEUE

WorkflowStarter = Callable[[WorkflowStartSpec], Awaitable[WorkflowHandle]]
WorkflowCanceler = Callable[[str], Awaitable[None]]


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
