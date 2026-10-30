"""Exercise abandoned blocking pools using only owned, synthetic events."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
import threading
from types import SimpleNamespace

import pytest

from jobctrl.infrastructure.temporal import run_in_activity as ria


@pytest.mark.asyncio
async def test_repeated_abandonment_refuses_then_recovers_after_actual_return(monkeypatch, tmp_path):
    from jobctrl.infrastructure import runtime_identity

    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", tmp_path / "jobctrl.db")
    monkeypatch.setattr(ria.activity, "heartbeat", lambda *_: None)
    monkeypatch.setattr(ria.activity, "info", lambda: SimpleNamespace(activity_type="synthetic"))
    monkeypatch.setattr(ria, "_record_abandoned_thread_metric", lambda *_: None)
    starts = [threading.Event() for _ in range(3)]
    releases = [threading.Event() for _ in range(3)]
    finished = [threading.Event() for _ in range(3)]
    canceled = [threading.Event() for _ in range(3)]
    calls = []
    ria.set_activity_executor(ThreadPoolExecutor(max_workers=1))

    def blocking(index):
        starts[index].set()
        try:
            if not releases[index].wait(10):
                raise TimeoutError("synthetic call was not released")
            return index
        finally:
            finished[index].set()

    async def invoke(index):
        return await ria.run_blocking_with_heartbeat(
            lambda: blocking(index), starting_message="synthetic",
            activity_name="synthetic", poll_interval=0.01,
            on_cancel=canceled[index].set, cancel_wait_seconds=0.01,
        )

    try:
        for index in range(3):
            task = asyncio.create_task(invoke(index))
            calls.append(task)
            assert await asyncio.to_thread(starts[index].wait, 2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert canceled[index].is_set()
            assert not finished[index].is_set()

        called = threading.Event()
        with pytest.raises(ria.ActivityExecutorCapacityExhausted, match="activity_executor_capacity_exhausted"):
            await ria.run_blocking_with_heartbeat(
                lambda: called.set(), starting_message="refused", activity_name="synthetic",
                poll_interval=0.01,
            )
        assert not called.is_set()
        assert not any(event.is_set() for event in finished)
        runtime_identity.write_worker_heartbeat(task_queue="synthetic", worker_id="owned")
        with sqlite3.connect(tmp_path / "jobctrl.db") as conn:
            observed = json.loads(conn.execute(
                "SELECT task_queue_observation_json FROM worker_runtime_heartbeats WHERE worker_id = 'owned'"
            ).fetchone()[0])["blockingExecutor"]
        assert observed == {
            "version": 1, "unfinishedRetiredGenerations": 3, "unfinishedRetiredCalls": 3,
            "generationLimit": 3, "nextSubmission": "refusing",
            "controlUnfinishedCalls": 0, "controlNextSubmission": "accepting",
        }

        releases[0].set()
        assert await asyncio.to_thread(finished[0].wait, 2)
        result = await asyncio.wait_for(
            ria.run_blocking_with_heartbeat(
                lambda: "healthy", starting_message="healthy", activity_name="synthetic",
                poll_interval=0.01,
            ),
            timeout=2,
        )
        assert result == "healthy"
        assert not finished[1].is_set()
        assert not finished[2].is_set()
        runtime_identity.write_worker_heartbeat(task_queue="synthetic", worker_id="owned")
        with sqlite3.connect(tmp_path / "jobctrl.db") as conn:
            recovered = json.loads(conn.execute(
                "SELECT task_queue_observation_json FROM worker_runtime_heartbeats WHERE worker_id = 'owned'"
            ).fetchone()[0])["blockingExecutor"]
        assert recovered["nextSubmission"] == "accepting"
        assert recovered["unfinishedRetiredGenerations"] == 2
        assert recovered["unfinishedRetiredCalls"] == 2
    finally:
        for event in releases:
            event.set()
        await asyncio.gather(*calls, return_exceptions=True)
        await ria.drain_activity_executors()
        ria.set_activity_executor(None)


async def wait_for_status(predicate):
    async def poll():
        while True:
            status = ria.activity_executor_status()
            if predicate(status):
                return status
            await asyncio.sleep(0.001)

    return await asyncio.wait_for(poll(), 2)


@pytest.mark.asyncio
async def test_peer_keeps_retired_generation_occupied_until_it_returns(monkeypatch, caplog):
    monkeypatch.setattr(ria.activity, "heartbeat", lambda *_: None)
    monkeypatch.setattr(ria.activity, "info", lambda: SimpleNamespace(activity_type="synthetic"))
    monkeypatch.setattr(ria, "_record_abandoned_thread_metric", lambda *_: None)
    starts = [threading.Event() for _ in range(4)]
    releases = [threading.Event() for _ in range(4)]
    completed = [threading.Event() for _ in range(4)]
    canceled = [threading.Event() for _ in range(4)]
    accepted = {"value": "previous accepted result"}
    tasks = []
    ria.set_activity_executor(ThreadPoolExecutor(max_workers=2))

    def blocking(index):
        starts[index].set()
        try:
            if not releases[index].wait(10):
                raise TimeoutError("synthetic call was not released")
            if index == 1:
                accepted["value"] = "peer result"
            return index
        finally:
            completed[index].set()

    async def invoke(index):
        return await ria.run_blocking_with_heartbeat(
            lambda: blocking(index), starting_message="synthetic",
            activity_name="synthetic", poll_interval=0.01,
            on_cancel=canceled[index].set, cancel_wait_seconds=0.01,
        )

    async def start(index):
        task = asyncio.create_task(invoke(index))
        tasks.append(task)
        assert await asyncio.to_thread(starts[index].wait, 2)
        return task

    async def cancel(task):
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    try:
        first = await start(0)
        peer = await start(1)
        await cancel(first)
        await cancel(await start(2))
        await cancel(await start(3))
        status = ria.activity_executor_status()
        assert (status.unfinished_retired_generations, status.unfinished_retired_calls) == (3, 4)
        assert status.next_submission == "refusing"
        assert status.generation_limit == 3
        assert [event.is_set() for event in canceled] == [True, False, True, True]

        releases[0].set()
        assert await asyncio.to_thread(completed[0].wait, 2)
        status = await wait_for_status(lambda value: value.unfinished_retired_calls == 3)
        assert status.unfinished_retired_generations == 3
        assert status.next_submission == "refusing"
        with pytest.raises(ria.ActivityExecutorCapacityExhausted) as error:
            await ria.run_blocking_with_heartbeat(
                lambda: accepted.update(value="unexpected"), starting_message="refused",
                activity_name="synthetic", poll_interval=0.01,
            )
        assert error.value.retryable
        assert error.value.code == "activity_executor_capacity_exhausted"
        assert "Cancellation did not prove the calls stopped" in str(error.value)
        assert accepted["value"] == "previous accepted result"
        log_record = next(record for record in caplog.records if record.message == error.value.code)
        assert (log_record.unfinished_retired_generations, log_record.unfinished_retired_calls) == (3, 3)
        assert log_record.next_submission == "refusing"

        releases[1].set()
        assert await asyncio.wait_for(peer, 2) == 1
        status = await wait_for_status(lambda value: value.next_submission == "accepting")
        assert (status.unfinished_retired_generations, status.unfinished_retired_calls) == (2, 2)
        assert accepted["value"] == "peer result"
        assert await ria.run_blocking_with_heartbeat(
            lambda: "healthy", starting_message="healthy", activity_name="synthetic", poll_interval=0.01,
        ) == "healthy"
        assert not completed[2].is_set() and not completed[3].is_set()
    finally:
        for event in releases:
            event.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await ria.drain_activity_executors()
        ria.set_activity_executor(None)


@pytest.mark.asyncio
async def test_nonblocking_shutdown_cannot_discard_outstanding_generation_ownership(monkeypatch):
    monkeypatch.setattr(ria.activity, "heartbeat", lambda *_: None)
    monkeypatch.setattr(ria.activity, "info", lambda: SimpleNamespace(activity_type="synthetic"))
    monkeypatch.setattr(ria, "_record_abandoned_thread_metric", lambda *_: None)
    starts = [threading.Event() for _ in range(3)]
    releases = [threading.Event() for _ in range(3)]
    tasks = []
    ria.set_activity_executor(ThreadPoolExecutor(max_workers=1))

    def blocking(index):
        starts[index].set()
        if not releases[index].wait(10):
            raise TimeoutError("synthetic call was not released")

    try:
        for index in range(3):
            task = asyncio.create_task(ria.run_blocking_with_heartbeat(
                lambda index=index: blocking(index), starting_message="synthetic",
                activity_name="synthetic", poll_interval=0.01, cancel_wait_seconds=0.01,
            ))
            tasks.append(task)
            assert await asyncio.to_thread(starts[index].wait, 2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        ria.shutdown_activity_executors()
        assert ria.activity_executor_status().next_submission == "refusing"
        replacement = ThreadPoolExecutor(max_workers=1)
        try:
            with pytest.raises(ria.ActivityExecutorCapacityExhausted):
                ria.set_activity_executor(replacement)
        finally:
            replacement.shutdown(wait=True)
        ria.set_activity_executor(None)
        status = ria.activity_executor_status()
        assert status.next_submission == "refusing"
        assert status.unfinished_retired_generations == 3
        with pytest.raises(ria.ActivityExecutorCapacityExhausted):
            await ria.run_blocking_with_heartbeat(
                lambda: None, starting_message="refused", activity_name="synthetic", poll_interval=0.01,
            )
        releases[0].set()
        await wait_for_status(lambda value: value.unfinished_retired_generations == 2)
        ria.set_activity_executor(ThreadPoolExecutor(max_workers=1))
        assert await ria.run_blocking_with_heartbeat(
            lambda: "new worker", starting_message="healthy", activity_name="synthetic", poll_interval=0.01,
        ) == "new worker"
        assert ria.activity_executor_status().unfinished_retired_calls == 2
    finally:
        for event in releases:
            event.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await ria.drain_activity_executors()
        ria.set_activity_executor(None)


@pytest.mark.asyncio
async def test_temporal_activity_context_reports_refusal_then_accepts_recovery(monkeypatch):
    from temporalio.testing import ActivityEnvironment

    monkeypatch.setattr(ria, "_record_abandoned_thread_metric", lambda *_: None)
    starts = [threading.Event() for _ in range(3)]
    releases = [threading.Event() for _ in range(3)]
    tokens = [threading.Event() for _ in range(3)]
    calls = []
    heartbeats = []
    ria.set_activity_executor(ThreadPoolExecutor(max_workers=1))

    def blocking(index):
        starts[index].set()
        if not releases[index].wait(10):
            raise TimeoutError("synthetic call was not released")

    async def synthetic_activity(index):
        return await ria.run_blocking_with_heartbeat(
            lambda: blocking(index), starting_message="started", activity_name="synthetic",
            poll_interval=0.01, cancel_wait_seconds=0.01, on_cancel=tokens[index].set,
        )

    async def healthy_activity():
        return await ria.run_blocking_with_heartbeat(
            lambda: "healthy", starting_message="healthy", activity_name="synthetic",
            poll_interval=0.01,
        )

    try:
        for index in range(3):
            env = ActivityEnvironment()
            env.on_heartbeat = lambda *details: heartbeats.append(details)
            task = asyncio.create_task(env.run(synthetic_activity, index))
            calls.append(task)
            assert await asyncio.to_thread(starts[index].wait, 2)
            env.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert tokens[index].is_set()

        with pytest.raises(ria.ActivityExecutorCapacityExhausted):
            await ActivityEnvironment().run(healthy_activity)
        assert len([details for details in heartbeats if details == ("started",)]) == 3
        releases[0].set()
        await wait_for_status(lambda value: value.next_submission == "accepting")
        assert await ActivityEnvironment().run(healthy_activity) == "healthy"
        assert not releases[1].is_set() and not releases[2].is_set()
    finally:
        for event in releases:
            event.set()
        await asyncio.gather(*calls, return_exceptions=True)
        await ria.drain_activity_executors()
        ria.set_activity_executor(None)


@pytest.mark.asyncio
async def test_failed_drain_keeps_current_generation_owned(monkeypatch):
    monkeypatch.setattr(ria.activity, "heartbeat", lambda *_: None)
    monkeypatch.setattr(ria.activity, "info", lambda: SimpleNamespace(activity_type="synthetic"))
    started = threading.Event()
    release = threading.Event()

    class JoinFailsExecutor(ThreadPoolExecutor):
        def shutdown(self, wait=True, *, cancel_futures=False):
            if wait:
                raise RuntimeError("synthetic join failure")
            return super().shutdown(wait=wait, cancel_futures=cancel_futures)

    executor = JoinFailsExecutor(max_workers=1)
    ria.set_activity_executor(executor)

    def blocking():
        started.set()
        if not release.wait(10):
            raise TimeoutError("synthetic call was not released")
        return "finished"

    task = asyncio.create_task(ria.run_blocking_with_heartbeat(
        blocking, starting_message="synthetic", activity_name="synthetic", poll_interval=0.01,
    ))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        with pytest.raises(RuntimeError, match="synthetic join failure"):
            await ria.drain_activity_executors()
        status = ria.activity_executor_status()
        assert status.next_submission == "draining"
        assert (status.unfinished_retired_generations, status.unfinished_retired_calls) == (1, 1)
        ria.set_activity_executor(None)
        with pytest.raises(ria.ActivityExecutorCapacityExhausted):
            await ria.run_blocking_with_heartbeat(
                lambda: None, starting_message="refused", activity_name="synthetic",
            )
        release.set()
        assert await asyncio.wait_for(task, 2) == "finished"
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        executor.shutdown(wait=False, cancel_futures=True)
        await ria.drain_activity_executors()
        ria.set_activity_executor(None)
