import pytest
from temporalio.testing import WorkflowEnvironment

from jobhunter.infrastructure.temporal import (
    JOBHUNTER_TASK_QUEUE,
    build_worker,
)


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
