import pytest
from temporalio.testing import WorkflowEnvironment

from jobhunter.infrastructure.temporal import (
    JOBHUNTER_TASK_QUEUE,
    build_worker,
)
from jobhunter.infrastructure.temporal.registry import ACTIVITIES, WORKFLOWS


@pytest.mark.asyncio
async def test_build_worker_binds_to_jobhunter_task_queue():
    async with await WorkflowEnvironment.start_time_skipping() as env:
        worker = build_worker(env.client, workflows=[], activities=[])

        assert worker.task_queue == JOBHUNTER_TASK_QUEUE


@pytest.mark.asyncio
async def test_build_worker_accepts_explicit_task_queue_override():
    async with await WorkflowEnvironment.start_time_skipping() as env:
        worker = build_worker(
            env.client,
            workflows=[],
            activities=[],
            task_queue="custom-queue",
        )

        assert worker.task_queue == "custom-queue"


@pytest.mark.asyncio
async def test_build_worker_validates_real_registry_under_production_sandbox():
    """Pin the sandbox-passthrough policy: the real registry must boot.

    Uses the production ``SandboxedWorkflowRunner`` (not the unsandboxed
    runner the per-workflow tests use) so any future narrowing of the
    ``with_passthrough_modules("jobhunter")`` scope, or any new workflow
    module that imports something the proxy cannot handle, surfaces as a
    test failure here instead of a boot-time ``RuntimeError`` against a live
    Temporal server.
    """
    async with await WorkflowEnvironment.start_local() as env:
        worker = build_worker(
            env.client,
            workflows=WORKFLOWS,
            activities=ACTIVITIES,
        )

        assert worker.task_queue == JOBHUNTER_TASK_QUEUE
