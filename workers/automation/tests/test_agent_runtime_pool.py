"""Resource/lifecycle contracts for the public kit runtime boundary; no provider calls."""
from __future__ import annotations

import asyncio
import contextvars
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from agent_runtime_kit import AgentResult, AgentTask

from jobctrl.infrastructure.llm.agent_runtime_pool import AgentRuntimePool, AgentRuntimeService


class Runtime:
    def __init__(self, hook=None):
        self.hook = hook
        self.tasks = []
        self.closed = False
        self.loops = []

    async def run(self, task):
        assert not self.closed
        self.tasks.append(task)
        self.loops.append(asyncio.get_running_loop())
        if self.hook is not None:
            return await self.hook(task)
        return AgentResult(output=task.task_id)

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_repeated_calls_share_runtime_without_reusing_task_identity():
    pool = AgentRuntimePool(2)
    made = []
    def factory():
        made.append(Runtime())
        return made[-1]
    first, second = AgentTask(goal='first'), AgentTask(goal='second')
    try:
        assert (await pool.run('codex-config', factory, first)).output == first.task_id
        assert (await pool.run('codex-config', factory, second)).output == second.task_id
        assert len(made) == 1 and made[0].tasks == [first, second]
        assert first.session_id is second.session_id is None
    finally:
        await pool.aclose()
    assert made[0].closed


@pytest.mark.asyncio
async def test_idle_retention_limit_does_not_serialize_admitted_calls():
    pool = AgentRuntimePool(2)
    both_started = asyncio.Event()
    release = asyncio.Event()
    started = []
    made = []
    async def hook(task):
        started.append(task.task_id)
        if len(started) == 3:
            both_started.set()
        await release.wait()
        return AgentResult(output=task.task_id)
    def factory():
        made.append(Runtime(hook))
        return made[-1]
    tasks = [asyncio.create_task(pool.run('same-config', factory, AgentTask(goal=str(i)))) for i in range(3)]
    try:
        await asyncio.wait_for(both_started.wait(), 2)
        await asyncio.sleep(0)
        assert len(started) == len(made) == 3
        release.set()
        results = await asyncio.gather(*tasks)
        assert len(results) == len(made) == 3
        assert sum(not runtime.closed for runtime in made) == 2
    finally:
        release.set()
        await pool.aclose()


@pytest.mark.asyncio
async def test_changed_configuration_evicts_idle_runtime_without_growing_pool():
    pool = AgentRuntimePool(1)
    made = []
    def factory():
        assert not made or made[-1].closed
        made.append(Runtime())
        return made[-1]
    try:
        await pool.run(('codex', 'auth-1', 'permission-1'), factory, AgentTask(goal='first'))
        await pool.run(('codex', 'auth-2', 'permission-1'), factory, AgentTask(goal='second'))
        await pool.run(('codex', 'auth-2', 'permission-2'), factory, AgentTask(goal='third'))
        assert len(made) == 3 and all(r.closed for r in made[:2])
    finally:
        await pool.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize('returned_failure', [False, True])
async def test_failed_runtime_is_evicted_and_exception_identity_is_preserved(returned_failure):
    pool = AgentRuntimePool(1)
    made = []
    original = RuntimeError('typed failure')
    async def failed(_task):
        if returned_failure:
            return AgentResult(output='', finish_reason='failed', error='safe error')
        raise original
    def factory():
        made.append(Runtime(failed if not made else None))
        return made[-1]
    try:
        if returned_failure:
            assert not (await pool.run('config', factory, AgentTask(goal='first'))).is_success
        else:
            with pytest.raises(RuntimeError) as caught:
                await pool.run('config', factory, AgentTask(goal='first'))
            assert caught.value is original
        assert made[0].closed
        assert (await pool.run('config', factory, AgentTask(goal='second'))).is_success
        assert len(made) == 2
    finally:
        await pool.aclose()


def test_service_preserves_context_and_one_loop_across_sync_caller_threads():
    service = AgentRuntimeService(capacity=2)
    lane = contextvars.ContextVar('test_product_lane')
    observed = []
    made = []
    async def hook(task):
        observed.append((task.goal, lane.get(), asyncio.get_running_loop()))
        return AgentResult(output=task.goal)
    def factory():
        made.append(Runtime(hook))
        return made[-1]
    def caller(index):
        with_value = f'lane-{index}'
        token = lane.set(with_value)
        try:
            return service.run('config', factory, AgentTask(goal=with_value)).output
        finally:
            lane.reset(token)
    try:
        with ThreadPoolExecutor(3) as executor:
            assert sorted(executor.map(caller, range(3))) == ['lane-0', 'lane-1', 'lane-2']
        assert all(goal == captured for goal, captured, _ in observed)
        assert len({id(loop) for _, _, loop in observed}) == 1
        assert len(made) <= 2
    finally:
        service.close()
    assert all(runtime.closed for runtime in made)


@pytest.mark.asyncio
async def test_async_cancellation_settles_cleanup_before_the_next_call():
    service = AgentRuntimeService(capacity=1)
    started = threading.Event()
    cleaned = threading.Event()
    made = []
    async def hook(_task):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0.02)
            cleaned.set()
    def factory():
        if made:
            assert cleaned.is_set() and made[-1].closed
        made.append(Runtime(hook if not made else None))
        return made[-1]
    running = asyncio.create_task(service.run_async('config', factory, AgentTask(goal='cancel')))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(running, 2)
        assert cleaned.is_set() and made[0].closed
        second = AgentTask(goal='next')
        assert (await service.run_async('config', factory, second)).output == second.task_id
        assert len(made) == 2
    finally:
        await asyncio.to_thread(service.close)


@pytest.mark.asyncio
async def test_pool_shutdown_cancels_active_calls_then_closes_resources():
    pool = AgentRuntimePool(1)
    started = asyncio.Event()
    made = []
    async def hook(_task):
        started.set()
        await asyncio.Event().wait()
    def factory():
        made.append(Runtime(hook))
        return made[-1]
    running = [asyncio.create_task(pool.run('config', factory, AgentTask(goal=str(i)))) for i in range(2)]
    await asyncio.wait_for(started.wait(), 2)
    await asyncio.sleep(0)
    await pool.aclose()
    assert all(task.cancelled() for task in running)
    assert len(made) == 2 and all(runtime.closed for runtime in made)
    with pytest.raises(RuntimeError, match='closed'):
        await pool.run('config', factory, AgentTask(goal='after-close'))


@pytest.mark.parametrize('capacity', [0, -1, True, 1.5])
def test_invalid_capacity_is_rejected_without_starting_a_thread(capacity):
    with pytest.raises(ValueError):
        AgentRuntimePool(capacity)
    with pytest.raises(ValueError):
        AgentRuntimeService(capacity=capacity)


def test_sdk_originated_cancellation_keeps_its_original_exception():
    service = AgentRuntimeService(capacity=1)
    original = asyncio.CancelledError('owned cancellation marker')
    runtime = None
    async def hook(_task):
        raise original
    def factory():
        nonlocal runtime
        runtime = Runtime(hook)
        return runtime
    try:
        with pytest.raises(asyncio.CancelledError) as caught:
            service.run('config', factory, AgentTask(goal='synthetic cancellation'))
        assert caught.value is original
        assert runtime.closed
    finally:
        service.close()
