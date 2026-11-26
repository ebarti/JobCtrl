"""DBOS schedules for declared automations and committed job-event follow-up."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime, timedelta, timezone
from math import gcd

from jobctrl.app.actions import Application, encode
from jobctrl.app.errors import AppError
from jobctrl.app.worker_identity import SCHEDULE_ACTIONS, SCHEDULE_WORKFLOW

log = logging.getLogger(__name__)
SCHEMA = """
CREATE TABLE app_schedule_cursors (consumer TEXT PRIMARY KEY, event_id INTEGER NOT NULL);
"""


def _interval_cron(minutes):
    if minutes % 60 == 0 and 24 % (minutes // 60) == 0:
        return f"0 */{minutes // 60} * * *"
    period = gcd(60, minutes)
    return f"*/{period} * * * *" if period != 60 else "0 * * * *"


def _definitions(application, settings):
    definitions = {}
    if discovery := application.services.get("discovery"):
        saved = discovery.schedule_definition()
        if saved:
            definitions["discovery"] = {
                "action": SCHEDULE_ACTIONS["discovery"], "payload": saved["payload"], "enabled": saved["enabled"],
                "cron": saved["cron"], "timezone": saved.get("timezone", "UTC"),
                "revision": saved["revision"], "catchup": 300,
            }
    if "compensation.refresh_stale" in application.actions:
        definitions["compensation"] = {
            "action": SCHEDULE_ACTIONS["compensation"], "payload": {"automatic": True},
            "enabled": settings["compensationAutomationEnabled"], "cron": "0 0 * * *", "catchup": 300,
        }
    if "applications.run_approved" in application.actions:
        minutes = settings["applyAutomationIntervalMinutes"]
        definitions["approved-applications"] = {
            "action": SCHEDULE_ACTIONS["approved-applications"], "payload": {"limit": 25}, "enabled": settings["applyAutomationEnabled"],
            "cron": _interval_cron(minutes), "interval": minutes, "catchup": 60,
        }
    return definitions


def _fingerprint(definition):
    return hashlib.sha256(encode(definition).encode()).hexdigest()


def admit_tick(application, timestamp, context, tick_id):
    """A stale schedule dispatch never authorizes work after a policy change."""
    when = datetime.fromisoformat(timestamp) if isinstance(timestamp, str) else timestamp
    with application.runtime.database.transaction() as connection:
        settings = application.runtime.settings.snapshot(connection)
        definition = _definitions(application, settings).get(context["kind"])
        if not definition or not definition["enabled"] or _fingerprint(definition) != context["definition"]:
            return None
        age = (datetime.now(timezone.utc) - when).total_seconds()
        if age > definition["catchup"] or age < -5:
            return None
        if "interval" in definition and int(when.timestamp() // 60) % definition["interval"]:
            return None
        try:
            receipt = application.admit(definition["action"], definition["payload"], connection=connection,
                                        idempotency_key="schedule:" + hashlib.sha256(tick_id.encode()).hexdigest())
        except AppError as error:
            if error.code == "action_scope_busy":
                return None
            raise
        return receipt["runId"]


def _apply(application, definitions, *, startup):
    client = application.dbos
    for kind in SCHEDULE_ACTIONS:
        name = f"{application.identity['taskQueue']}-{kind}"
        old = client.get_schedule(name)
        definition = definitions.get(kind)
        if definition is None:
            if old and old["status"] != "PAUSED":
                client.pause_schedule(name)
            continue
        context = {"kind": kind, "definition": _fingerprint(definition)}
        client.apply_schedules([{
            "schedule_name": name, "workflow_name": SCHEDULE_WORKFLOW, "schedule": definition["cron"],
            "cron_timezone": definition.get("timezone", "UTC"), "queue_name": application.identity["scheduleQueue"],
            "context": context,
        }])
        if not definition["enabled"]:
            client.pause_schedule(name)
            continue
        if old and old["status"] == "PAUSED":
            client.resume_schedule(name)
        elif startup and old and old.get("last_fired_at") and old.get("context") == context:
            # Use DBOS's deterministic tick IDs for only the prior catch-up window.
            end = datetime.now(timezone.utc)
            start = max(datetime.fromisoformat(old["last_fired_at"]), end - timedelta(seconds=definition["catchup"]))
            if start < end:
                client.backfill_schedule(name, start, end)


def _consume_events(application):
    if "compensation.refresh_stale" not in application.actions:
        return
    runtime = application.runtime
    with runtime.database.transaction() as connection:
        row = connection.execute("SELECT event_id FROM app_schedule_cursors WHERE consumer='compensation' FOR UPDATE").fetchone()
        after = row[0] if row else 0
        events = runtime.events.since(after)
        if not events:
            return
        latest = int(events[-1]["eventId"])
        changed = list(dict.fromkeys(event["aggregateId"] for event in events
                       if event["type"] in {"JobCaptured", "JobSourceObserved"} and event["aggregateId"]
                       and event["payload"].get("postingChanged", True)))
        if changed and runtime.settings.snapshot(connection)["compensationAutomationEnabled"]:
            application.admit("compensation.refresh_stale", {"automatic": True, "jobIds": changed},
                              connection=connection, idempotency_key=f"compensation-changes:{after}:{latest}")
        connection.execute(
            "INSERT INTO app_schedule_cursors VALUES('compensation',?) ON CONFLICT(consumer) "
            "DO UPDATE SET event_id=GREATEST(app_schedule_cursors.event_id,excluded.event_id)", (latest,),
        )


async def maintain(application: Application, stop: asyncio.Event):
    runtime = application.runtime
    previous = None
    while not stop.is_set():
        try:
            definitions = await asyncio.to_thread(lambda: _definitions(application, runtime.settings.snapshot()))
            if definitions != previous:
                await asyncio.to_thread(_apply, application, definitions, startup=previous is None)
                previous = definitions
            await asyncio.to_thread(_consume_events, application)
        except AppError as error:
            if error.code != "action_scope_busy":
                log.warning("Schedule reconciliation unavailable error_code=%s", error.code)
        except Exception as error:
            log.warning("Schedule reconciliation unavailable error_type=%s", type(error).__name__)
        try:
            await asyncio.wait_for(stop.wait(), timeout=10)
        except TimeoutError:
            pass
