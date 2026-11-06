"""Explicit durable schedules and committed-event follow-up for product owners."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import timedelta

from temporalio.client import (
    Schedule, ScheduleActionStartWorkflow, ScheduleAlreadyRunningError,
    ScheduleIntervalSpec, SchedulePolicy, ScheduleSpec, ScheduleState, ScheduleUpdate,
)
from temporalio.service import RPCError, RPCStatusCode

from jobctrl.app.actions import Application, task_queue

log = logging.getLogger(__name__)
SCHEMA = """
CREATE TABLE app_schedule_cursors (consumer TEXT PRIMARY KEY, event_id INTEGER NOT NULL);
"""


async def _save_schedule(client, schedule_id: str, schedule: Schedule):
    try:
        await client.create_schedule(schedule_id, schedule)
    except ScheduleAlreadyRunningError:
        await client.get_schedule_handle(schedule_id).update(lambda _current: ScheduleUpdate(schedule))


async def _pause_removed(client, schedule_id):
    try:
        await client.get_schedule_handle(schedule_id).pause(note="The owning feature is not selected.")
    except RPCError as error:
        if error.status != RPCStatusCode.NOT_FOUND:
            raise


async def maintain(application: Application, stop: asyncio.Event):
    """Read public owner controls; persist replay cursors only after dispatch."""
    runtime = application.runtime
    runtime.database.initialize_feature("runtime_schedules", SCHEMA)
    client = await application.temporal()
    queue = task_queue(runtime.workspace)
    previous = {}
    while not stop.is_set():
        try:
            discovery = application.services.get("discovery")
            definition = discovery.schedule_definition() if discovery is not None else None
            fingerprint = hashlib.sha256(json.dumps(definition, sort_keys=True).encode()).hexdigest()
            if previous.get("discovery") != fingerprint:
                schedule_id = f"{queue}-discovery"
                if definition is None:
                    await _pause_removed(client, schedule_id)
                else:
                    await _save_schedule(client, schedule_id, Schedule(
                        action=ScheduleActionStartWorkflow("JobCtrlAction", {
                            "action": "discovery.search", "payload": definition["payload"],
                        }, id=f"{queue}-scheduled-discovery", task_queue=queue),
                        spec=ScheduleSpec(cron_expressions=[definition["cron"]], time_zone_name=definition.get("timezone", "UTC")),
                        policy=SchedulePolicy(catchup_window=timedelta(minutes=5)),
                        state=ScheduleState(paused=not definition["enabled"]),
                    ))
                previous["discovery"] = fingerprint
            settings = runtime.settings.snapshot()
            compensation_enabled = settings["compensationAutomationEnabled"]
            if previous.get("compensation") != compensation_enabled:
                schedule_id = f"{queue}-compensation"
                if "compensation.refresh_stale" not in application.actions:
                    await _pause_removed(client, schedule_id)
                else:
                    await _save_schedule(client, schedule_id, Schedule(
                        action=ScheduleActionStartWorkflow("JobCtrlAction", {
                            "action": "compensation.refresh_stale", "payload": {"automatic": True},
                        }, id=f"{queue}-scheduled-compensation", task_queue=queue),
                        spec=ScheduleSpec(intervals=[ScheduleIntervalSpec(every=timedelta(days=1))]),
                        policy=SchedulePolicy(catchup_window=timedelta(minutes=5)),
                        state=ScheduleState(paused=not compensation_enabled),
                    ))
                previous["compensation"] = compensation_enabled
            apply_policy = (settings["applyAutomationEnabled"], settings["applyAutomationIntervalMinutes"],
                            "applications.run_approved" in application.actions)
            if previous.get("apply") != apply_policy:
                schedule_id = f"{queue}-approved-applications"
                if not apply_policy[2]:
                    await _pause_removed(client, schedule_id)
                else:
                    await _save_schedule(client, schedule_id, Schedule(
                        action=ScheduleActionStartWorkflow("JobCtrlAction", {
                            "action": "applications.run_approved", "payload": {"limit": 25},
                        }, id=f"{queue}-scheduled-approved-applications", task_queue=queue),
                        spec=ScheduleSpec(intervals=[ScheduleIntervalSpec(every=timedelta(minutes=apply_policy[1]))]),
                        policy=SchedulePolicy(catchup_window=timedelta(minutes=1)),
                        state=ScheduleState(paused=not apply_policy[0]),
                    ))
                previous["apply"] = apply_policy
            if "compensation.refresh_stale" in application.actions:
                with runtime.database.connect() as connection:
                    row = connection.execute("SELECT event_id FROM app_schedule_cursors WHERE consumer='compensation'").fetchone()
                after = row[0] if row else 0
                events = runtime.events.since(after)
                if events:
                    latest = int(events[-1]["eventId"])
                    if compensation_enabled and any(event["type"] in {"JobCaptured", "JobSourceObserved"} for event in events):
                        await application.submit("compensation.refresh_stale", {"automatic": True}, idempotency_key=f"compensation-events:{latest}")
                    with runtime.database.transaction() as connection:
                        connection.execute("INSERT INTO app_schedule_cursors VALUES('compensation',?) ON CONFLICT(consumer) DO UPDATE SET event_id=excluded.event_id", (latest,))
        except Exception as error:
            # Recovery is bounded, visible and never advances the event cursor.
            # A later successful Temporal reconnect retries the same identities.
            log.warning("Schedule reconciliation failed error_type=%s", type(error).__name__)
        try:
            await asyncio.wait_for(stop.wait(), timeout=10)
        except TimeoutError:
            pass
