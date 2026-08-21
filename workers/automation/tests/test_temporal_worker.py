from types import SimpleNamespace

import pytest
from .temporal_env import local_env, time_skipping_env

import jobctrl.infrastructure.temporal.worker as temporal_worker_module
from jobctrl.infrastructure.temporal import (
    JOBCTRL_TASK_QUEUE,
    build_worker,
)
from jobctrl.infrastructure.temporal.registry import ACTIVITIES, WORKFLOWS
from jobctrl.infrastructure.temporal.run_in_activity import (
    shutdown_activity_executors,
)


def test_build_worker_separates_temporal_and_blocking_activity_executors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executors: list[object] = []
    blocking: list[object] = []

    class _Executor:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs
            executors.append(self)

    def _worker(client, **kwargs):
        return SimpleNamespace(client=client, **kwargs)

    monkeypatch.setattr(temporal_worker_module, "ThreadPoolExecutor", _Executor)
    monkeypatch.setattr(temporal_worker_module, "Worker", _worker)
    monkeypatch.setattr(
        temporal_worker_module,
        "set_activity_executor",
        blocking.append,
    )

    worker = temporal_worker_module.build_worker(
        SimpleNamespace(),
        workflows=[],
        activities=[],
        max_concurrent_activities=4,
    )

    assert len(executors) == 2
    assert worker.activity_executor is executors[0]
    assert blocking == [executors[1]]
    assert worker.activity_executor is not blocking[0]
    assert executors[0].kwargs["thread_name_prefix"] == ("jobctrl-temporal-sync-activity")
    assert executors[1].kwargs["thread_name_prefix"] == ("jobctrl-blocking-activity")


@pytest.mark.asyncio
async def test_build_worker_binds_to_jobctrl_task_queue():
    async with time_skipping_env() as env:
        worker = build_worker(env.client, workflows=[], activities=[])
        try:
            async with worker:
                assert JOBCTRL_TASK_QUEUE == "jobctrl-default"
                assert worker.task_queue == JOBCTRL_TASK_QUEUE
        finally:
            shutdown_activity_executors()
        assert worker.is_shutdown


@pytest.mark.asyncio
async def test_build_worker_accepts_explicit_task_queue_override():
    async with time_skipping_env() as env:
        worker = build_worker(
            env.client,
            workflows=[],
            activities=[],
            task_queue="custom-queue",
        )
        try:
            async with worker:
                assert worker.task_queue == "custom-queue"
        finally:
            shutdown_activity_executors()
        assert worker.is_shutdown


@pytest.mark.asyncio
async def test_build_worker_validates_real_registry_under_production_sandbox():
    """Pin the sandbox-passthrough policy: the real registry must boot.

    Uses the production ``SandboxedWorkflowRunner`` (not the unsandboxed
    runner the per-workflow tests use) so any future narrowing of the
    ``with_passthrough_modules("jobctrl")`` scope, or any new workflow
    module that imports something the proxy cannot handle, surfaces as a
    test failure here instead of a boot-time ``RuntimeError`` against a live
    Temporal server.
    """
    async with local_env() as env:
        worker = build_worker(
            env.client,
            workflows=WORKFLOWS,
            activities=ACTIVITIES,
        )
        try:
            async with worker:
                assert worker.task_queue == JOBCTRL_TASK_QUEUE
        finally:
            shutdown_activity_executors()
        assert worker.is_shutdown
