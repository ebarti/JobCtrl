"""Owned, no-network worker fixture for the Operations HTTP integration test."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
import sys
import threading

from temporalio.testing import ActivityEnvironment

from jobctrl.infrastructure.runtime_identity import write_worker_heartbeat
from jobctrl.infrastructure.temporal import run_in_activity as ria


async def main():
    starts = [threading.Event() for _ in range(3)]
    releases = [threading.Event() for _ in range(3)]
    control_start = threading.Event()
    control_release = threading.Event()
    tasks = []
    ria._record_abandoned_thread_metric = lambda *_args: None
    ria.set_activity_executor(ThreadPoolExecutor(max_workers=1))

    def hold(index):
        starts[index].set()
        if not releases[index].wait(30):
            raise TimeoutError("synthetic stage call was not released")

    def hold_control():
        control_start.set()
        if not control_release.wait(30):
            raise TimeoutError("synthetic control call was not released")

    async def stage(index):
        return await ria.run_blocking_with_heartbeat(
            lambda: hold(index), starting_message="synthetic", activity_name="synthetic-stage",
            poll_interval=0.01, cancel_wait_seconds=0.01,
        )

    async def control():
        return await ria.run_blocking_with_heartbeat(
            hold_control, starting_message="synthetic", activity_name="synthetic-control",
            poll_interval=0.01, control=True,
        )

    async def call(value, *, control_lane=False):
        async def activity():
            return await ria.run_blocking_with_heartbeat(
                lambda: value, starting_message="synthetic", activity_name="synthetic",
                poll_interval=0.01, control=control_lane,
            )
        return await ActivityEnvironment().run(activity)

    def heartbeat(worker_id="synthetic-worker"):
        write_worker_heartbeat(
            task_queue="jobctrl-default", worker_id=worker_id, max_concurrent_activities=4,
        )

    try:
        for index in range(3):
            env = ActivityEnvironment()
            task = asyncio.create_task(env.run(stage, index))
            tasks.append(task)
            if not await asyncio.to_thread(starts[index].wait, 5):
                raise TimeoutError("synthetic stage did not start")
            env.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        control_task = asyncio.create_task(ActivityEnvironment().run(control))
        tasks.append(control_task)
        if not await asyncio.to_thread(control_start.wait, 5):
            raise TimeoutError("synthetic control did not start")
        if await call("control admitted", control_lane=True) != "control admitted":
            raise AssertionError("separate control work did not complete")
        try:
            await call("must refuse")
            raise AssertionError("saturated stage pool admitted work")
        except ria.ActivityExecutorCapacityExhausted:
            pass
        heartbeat()
        print(json.dumps({"phase": "blocked", "heldStages": 3, "heldControls": 1}), flush=True)

        while True:
            command = (await asyncio.to_thread(sys.stdin.readline)).strip()
            if command == "recover":
                releases[0].set()
                async def wait_for_capacity():
                    while ria.activity_executor_status().next_submission != "accepting":
                        await asyncio.sleep(0.001)
                await asyncio.wait_for(wait_for_capacity(), 5)
                if await call("stage admitted") != "stage admitted":
                    raise AssertionError("stage admission did not recover")
                if releases[1].is_set() or releases[2].is_set() or control_release.is_set():
                    raise AssertionError("a peer was released during recovery")
                heartbeat()
                print(json.dumps({"phase": "recovered", "heldStages": 2, "heldControls": 1}), flush=True)
            elif command == "legacy":
                # Model an old writer's heartbeat by removing only the new
                # extension from a second, otherwise real worker heartbeat.
                heartbeat("synthetic-old-worker")
                with sqlite3.connect(sys.argv[1]) as conn:
                    conn.execute(
                        "UPDATE worker_runtime_heartbeats SET task_queue_observation_json = "
                        "json_remove(task_queue_observation_json, '$.blockingExecutor') WHERE worker_id = ?",
                        ("synthetic-old-worker",),
                    )
                print(json.dumps({"phase": "legacy"}), flush=True)
            elif command == "stop" or not command:
                break
            else:
                raise ValueError("unknown synthetic fixture command")
    finally:
        for release in releases:
            release.set()
        control_release.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await ria.drain_activity_executors()
        ria.set_activity_executor(None)


if __name__ == "__main__":
    asyncio.run(main())
