"""Local DBOS executor for one PostgreSQL-backed workspace."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import uuid
from pathlib import Path

from dbos import DBOS, DBOSPortableJSONSerializer

from jobctrl.app.actions import encode
from jobctrl.app.bootstrap import create_application
from jobctrl.app.credentials import read_process_identity
from jobctrl.app.dbos_workflows import binding
from jobctrl.app.errors import AppError
from jobctrl.app.events import now
from jobctrl.app.execution import ExecutionCustody
from jobctrl.app.scheduling import SCHEMA as SCHEDULE_SCHEMA, maintain
from jobctrl.app.worker_identity import DBOS_APPLICATION, DBOS_SCHEMA, READY_WORKFLOW
from jobctrl.app.workflow_compat import inspect_pending

log = logging.getLogger(__name__)


async def run_worker(workspace: Path, *, enabled_features=None):
    if os.environ.get("DBOS__CLOUD") == "true":
        raise AppError("local_executor_required", "This workspace requires a local DBOS executor.", 409)
    application = create_application(workspace, enabled_features=enabled_features)
    identity = application.identity
    executor = identity["taskQueue"]
    worker_id = str(uuid.uuid4())
    process = read_process_identity(os.getpid())
    if process.get("state") != "alive":
        application.close()
        raise AppError("worker_identity_unavailable", "The worker process identity could not be established.", 503)
    registration = encode({**identity, "processBirth": process["identity"]})
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass

    def start():
        # Holding the workspace executor lock proves the previous worker is gone.
        # Fence delayed public admissions and inspect their committed work under the
        # same database writer lock before DBOS can dequeue or recover anything.
        with application.runtime.database.transaction() as connection:
            connection.execute("UPDATE app_worker_heartbeats SET status='stopped' WHERE task_queue=? AND status='running'",
                               (executor,))
            compatibility = inspect_pending(application, connection)
        if not compatibility["compatible"]:
            raise AppError("workflow_contract_incompatible",
                           "Pending work requires a compatible worker and feature selection. Drain or reconcile it before upgrading.",
                           409, compatibility)
        application.runtime.database.initialize_feature("runtime_schedules", SCHEDULE_SCHEMA)
        binding.application = application
        binding.registration = worker_id
        binding.stopping = stop.is_set
        DBOS(config={
            "name": DBOS_APPLICATION, "system_database_engine": application.runtime.database.engine,
            "dbos_system_schema": DBOS_SCHEMA, "serializer": DBOSPortableJSONSerializer(),
            "application_version": identity["workflowVersion"], "executor_id": executor,
            "enable_otlp": False, "use_listen_notify": False, "scheduler_polling_interval_sec": 2.0,
        })
        DBOS.listen_queues([identity[key] for key in ("taskQueue", "searchQueue", "scheduleQueue")])
        DBOS.launch()
        # Scheduled ticks target the latest version. The single desktop executor
        # may also be a deliberately restored compatible build.
        if DBOS.get_latest_application_version()["version_name"] != identity["workflowVersion"]:
            DBOS.set_latest_application_version(identity["workflowVersion"])
        slots = application.runtime.settings.get("workerActivitySlots", 4)
        for queue, capacity in (("taskQueue", slots), ("searchQueue", 1), ("scheduleQueue", 1)):
            DBOS.register_queue(identity[queue], worker_concurrency=capacity, polling_interval_sec=0.15)

    started = now()

    def heartbeat(status):
        with application.runtime.database.transaction() as connection:
            connection.execute(
                "INSERT INTO app_worker_heartbeats VALUES(?,?,?,?,?,?) ON CONFLICT(worker_id) "
                "DO UPDATE SET heartbeat_at=excluded.heartbeat_at,status=excluded.status",
                (worker_id, os.getpid(), executor, started, now(), status),
            )
            connection.execute(
                "INSERT INTO app_worker_registrations VALUES(?,?,?) ON CONFLICT(worker_id) DO NOTHING",
                (worker_id, registration, encode(sorted(application.actions))),
            )

    async def interval():
        try:
            await asyncio.wait_for(stop.wait(), timeout=3)
        except TimeoutError:
            pass

    async def pulse():
        while not stop.is_set():
            try:
                await asyncio.to_thread(heartbeat, "running")
            except Exception as error:
                log.warning("Worker heartbeat unavailable error_type=%s", type(error).__name__)
            await interval()

    async def recover():
        cursor = ""
        while not stop.is_set():
            try:
                cursor = await application.reconcile_runs(after=cursor)
            except Exception as error:
                log.warning("Action recovery unavailable error_type=%s", type(error).__name__)
            await interval()

    custody = ExecutionCustody(application.runtime.workspace, "dbos-executor-" + executor)
    try:
        if not custody.try_acquire():
            raise AppError("worker_already_running", "This workspace already has a live DBOS worker.", 409)
        try:
            await asyncio.to_thread(start)
            # Publish readiness only after this process executes a real queue probe.
            # The control queue remains available when an action or search is waiting.
            probe = await application.dbos.enqueue_async({
                "workflow_name": READY_WORKFLOW, "workflow_id": "ready-" + worker_id,
                "queue_name": identity["scheduleQueue"], "app_version": identity["workflowVersion"],
            })
            async with asyncio.timeout(30):
                observed = await probe.get_result(polling_interval_sec=0.1)
            if observed != worker_id:
                raise AppError("worker_incompatible", "A different process consumed the workspace readiness probe.", 409)
            maintenance = [asyncio.create_task(task) for task in (pulse(), recover(), maintain(application, stop))]
            try:
                await stop.wait()
            finally:
                stop.set()
                await asyncio.gather(*maintenance, return_exceptions=True)
        finally:
            stop.set()
            try:
                await asyncio.to_thread(heartbeat, "stopped")
            finally:
                await asyncio.to_thread(DBOS.destroy, workflow_completion_timeout_sec=2)
                from jobctrl.app.model_providers import close_provider_runtimes
                await asyncio.to_thread(close_provider_runtimes)
    finally:
        custody.close()
        application.close()


def main():
    parser = argparse.ArgumentParser(description="Run the local JobCtrl DBOS worker")
    parser.add_argument("--workspace", type=Path, default=Path(os.environ.get("JOBCTRL_DIR", "~/.jobctrl")).expanduser())
    parser.add_argument("--features", default=os.environ.get("JOBCTRL_FEATURES"))
    args = parser.parse_args()
    os.environ["JOBCTRL_DIR"] = str(args.workspace.expanduser().resolve())
    asyncio.run(run_worker(args.workspace, enabled_features=args.features.split(",") if args.features else None))


if __name__ == "__main__":
    main()
