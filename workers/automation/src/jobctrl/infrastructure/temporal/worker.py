"""Temporal worker bootstrap."""

from __future__ import annotations

from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from temporalio import workflow
from temporalio.client import Client
from temporalio.contrib.opentelemetry import TracingInterceptor
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import (
    SandboxedWorkflowRunner,
    SandboxRestrictions,
)

from jobctrl.infrastructure.temporal.activity_runtime_telemetry import (
    ActiveActivityInventory,
    ActivityRuntimeTelemetryInterceptor,
)
from jobctrl.infrastructure.temporal.concurrency import (
    activity_executor_max_workers,
    resolve_max_concurrent_activities,
)
from jobctrl.infrastructure.temporal.run_in_activity import set_activity_executor
from jobctrl.infrastructure.temporal.task_queues import JOBCTRL_TASK_QUEUE


@workflow.defn(name="JobCtrlBootstrapNoOp")
class _BootstrapNoOpWorkflow:
    """Placeholder workflow so the worker can boot before pipeline workflows land."""

    @workflow.run
    async def run(self) -> str:
        return "noop"


# Pass the entire ``jobctrl`` package through the workflow sandbox.
#
# Why: workflow code constructs activity-input dataclasses (e.g.
# ``EnrichActivityInput(...)``) at the workflow boundary. Those dataclasses
# live in ``jobctrl.<context>.activities`` modules; without passthrough the
# sandbox proxies them, and constructing instances of frozen dataclasses
# imported through ``imports_passed_through()`` raises
# ``RuntimeError: Restriction state not present. Using subclasses of proxied
# objects is unsupported.``
#
# Why broad: a narrower scope would have to enumerate every activity-input
# dataclass module (and every future one), coupling the worker bootstrap to
# the activity layer. The package-wide passthrough trades that coupling for a
# single-line policy. Activities run outside the sandbox, so determinism is
# preserved on the workflow code that actually executes inside the sandbox.
_PASSTHROUGH_RESTRICTIONS = SandboxRestrictions.default.with_passthrough_modules(
    "jobctrl"
)


def build_worker(
    client: Client,
    *,
    workflows: Sequence[type],
    activities: Sequence[Any],
    task_queue: str = JOBCTRL_TASK_QUEUE,
    max_concurrent_activities: int | None = None,
    activity_inventory: ActiveActivityInventory | None = None,
) -> Worker:
    """Build a ``temporalio.worker.Worker`` bound to the JobCtrl task queue."""
    workflow_list: list[type] = list(workflows)
    activity_list: list[Any] = list(activities)
    if not workflow_list and not activity_list:
        workflow_list.append(_BootstrapNoOpWorkflow)
    active_max_concurrent_activities = (
        max_concurrent_activities
        if max_concurrent_activities is not None
        else _max_concurrent_activities()
    )
    activity_executor = ThreadPoolExecutor(
        max_workers=activity_executor_max_workers(active_max_concurrent_activities)
    )
    set_activity_executor(activity_executor)
    runtime_inventory = activity_inventory or ActiveActivityInventory()
    return Worker(
        client,
        task_queue=task_queue,
        workflows=workflow_list,
        activities=activity_list,
        activity_executor=activity_executor,
        max_concurrent_activities=active_max_concurrent_activities,
        workflow_runner=SandboxedWorkflowRunner(
            restrictions=_PASSTHROUGH_RESTRICTIONS,
        ),
        interceptors=[
            TracingInterceptor(),
            ActivityRuntimeTelemetryInterceptor(runtime_inventory),
        ],
    )


def _max_concurrent_activities() -> int:
    return resolve_max_concurrent_activities().value
