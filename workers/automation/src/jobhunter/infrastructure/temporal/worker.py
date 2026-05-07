"""Temporal worker bootstrap."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from temporalio import workflow
from temporalio.client import Client
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import (
    SandboxedWorkflowRunner,
    SandboxRestrictions,
)

from jobhunter.infrastructure.temporal.task_queues import JOBHUNTER_TASK_QUEUE


@workflow.defn(name="JobHunterBootstrapNoOp")
class _BootstrapNoOpWorkflow:
    """Placeholder workflow so the worker can boot before pipeline workflows land."""

    @workflow.run
    async def run(self) -> str:
        return "noop"


# Pass jobhunter through the sandbox: workflow modules import activity dataclasses
# whose modules transitively pull in rich/sqlite/etc. Activities run outside the
# sandbox, so determinism is preserved.
_PASSTHROUGH_RESTRICTIONS = SandboxRestrictions.default.with_passthrough_modules(
    "jobhunter"
)


def build_worker(
    client: Client,
    *,
    workflows: Sequence[type],
    activities: Sequence[Any],
    task_queue: str = JOBHUNTER_TASK_QUEUE,
) -> Worker:
    """Build a ``temporalio.worker.Worker`` bound to the JobHunter task queue."""
    workflow_list: list[type] = list(workflows)
    activity_list: list[Any] = list(activities)
    if not workflow_list and not activity_list:
        workflow_list.append(_BootstrapNoOpWorkflow)
    return Worker(
        client,
        task_queue=task_queue,
        workflows=workflow_list,
        activities=activity_list,
        workflow_runner=SandboxedWorkflowRunner(
            restrictions=_PASSTHROUGH_RESTRICTIONS,
        ),
    )
