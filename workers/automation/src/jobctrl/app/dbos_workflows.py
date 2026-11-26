"""Registered DBOS workflows. External effects run only in feature-owned steps."""

from __future__ import annotations

from datetime import datetime
import time
from typing import TYPE_CHECKING

from dbos import DBOS

from jobctrl.app.worker_identity import ACTION_WORKFLOW, READY_WORKFLOW, SCHEDULE_WORKFLOW, SEARCH_WORKFLOW, STOP_TOPIC

if TYPE_CHECKING:
    import asyncio
    from collections.abc import Callable
    from jobctrl.app.actions import Application


class WorkerBinding:
    """A worker process hosts exactly one workspace, selected before DBOS launch."""

    application: Application
    registration: str
    stopping: Callable[[], bool]
    action_slots: asyncio.Semaphore


binding = WorkerBinding()


@DBOS.workflow(name=READY_WORKFLOW)
def worker_ready():
    return binding.registration


@DBOS.step(name="jobctrl.execute.v1", preemptible=True)
async def action_step(run_id: str):
    # The assessment and ordinary queues share the configured action capacity.
    async with binding.action_slots:
        return await binding.application.execute_turn(run_id, DBOS.workflow_id, search=False, stopping=binding.stopping)


@DBOS.workflow(name=ACTION_WORKFLOW)
async def run_action(run_id: str):
    await action_step(run_id)
    return run_id


@DBOS.step(name="jobctrl.search.turn.v1", preemptible=True)
async def search_step(run_id: str):
    return await binding.application.execute_turn(run_id, DBOS.workflow_id, search=True, stopping=binding.stopping)


@DBOS.workflow(name=SEARCH_WORKFLOW)
async def run_search(run_id: str):
    while True:
        turn = await search_step(run_id)
        if turn["done"]:
            return run_id
        wake_at = turn.get("wakeAt", 0.0)
        if wake_at or turn.get("waitSeconds", 0) > 0:
            # Replay the same interruptible receive even when overdue. For older
            # turns DBOS reuses its recorded timer, or rechecks the board immediately.
            await DBOS.recv_async(topic=STOP_TOPIC, timeout_seconds=max(0.0, wake_at - time.time()))


@DBOS.step(name="jobctrl.schedule.admit.v1")
def schedule_step(timestamp, context):
    from jobctrl.app.scheduling import admit_tick
    return admit_tick(binding.application, timestamp, context, DBOS.workflow_id)


@DBOS.workflow(name=SCHEDULE_WORKFLOW)
def scheduled_action(timestamp: datetime, context: dict):
    return schedule_step(timestamp, context)
