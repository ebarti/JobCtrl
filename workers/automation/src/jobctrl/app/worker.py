"""Temporal host for explicit feature actions in the canonical Python application."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import uuid
from datetime import timedelta
from pathlib import Path

from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError
from temporalio.worker import Worker

with workflow.unsafe.imports_passed_through():
    from jobctrl.app.actions import Application, task_queue
    from jobctrl.app.bootstrap import create_application
    from jobctrl.app.contracts import ActionContext
    from jobctrl.app.errors import AppError
    from jobctrl.app.events import now


@workflow.defn(name="JobCtrlAction")
class ActionWorkflow:
    @workflow.run
    async def run(self, value: dict) -> dict:
        try:
            return await workflow.execute_activity(
                "jobctrl.execute_action", value, start_to_close_timeout=timedelta(days=7),
                heartbeat_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=1)),
                cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
            )
        except ActivityError:
            # A killed worker cannot acknowledge cancellation. Temporal then
            # closes the activity on its heartbeat timeout; preserve the
            # explicit workflow cancellation instead of mislabelling it failed.
            if workflow.cancellation_reason() is not None:
                raise asyncio.CancelledError from None
            raise


class Actions:
    def __init__(self, application: Application):
        self.application = application

    @activity.defn(name="jobctrl.execute_action")
    async def execute(self, value: dict):
        info = activity.info()
        run_id = value.get("run_id") or str(uuid.uuid5(uuid.NAMESPACE_URL, info.workflow_id))
        request_id = value.get("request_id") or run_id

        def cancelled():
            try:
                return activity.is_cancelled() or self.application.action_run(run_id)["cancellationRequested"]
            except AppError:
                return activity.is_cancelled()

        def heartbeat(details=None):
            activity.heartbeat({"runId": run_id, **(details or {})})

        async def pulse():
            while True:
                heartbeat()
                await asyncio.sleep(5)

        pulse_task = asyncio.create_task(pulse())
        try:
            return await self.application.execute(
                value["action"], value["payload"], run_id=run_id, request_id=request_id,
                context=ActionContext(run_id, request_id, cancelled, heartbeat),
                workflow_id=info.workflow_id, temporal_run_id=info.workflow_run_id,
            )
        except AppError as error:
            raise ApplicationError(error.message, type=error.code, non_retryable=True) from None
        except asyncio.CancelledError:
            raise
        except Exception:
            raise ApplicationError("The application action failed.", type="action_failed", non_retryable=True) from None
        finally:
            pulse_task.cancel()
            await asyncio.gather(pulse_task, return_exceptions=True)


async def run_worker(workspace: Path, *, enabled_features=None):
    application = create_application(workspace, enabled_features=enabled_features)
    client = await application.temporal()
    worker_id = str(uuid.uuid4())
    queue = task_queue(application.runtime.workspace)
    started = now()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for name in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(name, stop.set)
        except (NotImplementedError, RuntimeError):
            pass

    async def pulse():
        while not stop.is_set():
            with application.runtime.database.transaction() as connection:
                connection.execute(
                    "INSERT INTO app_worker_heartbeats VALUES(?,?,?,?,?,?) ON CONFLICT(worker_id) "
                    "DO UPDATE SET heartbeat_at=excluded.heartbeat_at,status=excluded.status",
                    (worker_id, os.getpid(), queue, started, now(), "running"),
                )
            try:
                await asyncio.wait_for(stop.wait(), timeout=3)
            except TimeoutError:
                pass

    async def recover():
        cursor = ""
        while not stop.is_set():
            try:
                cursor = await application.reconcile_runs(after=cursor)
            except Exception as error:
                logging.getLogger(__name__).warning("Action recovery unavailable error_type=%s", type(error).__name__)
            try:
                await asyncio.wait_for(stop.wait(), timeout=3)
            except TimeoutError:
                pass

    try:
        async with Worker(client, task_queue=queue, workflows=[ActionWorkflow], activities=[Actions(application).execute],
                          max_concurrent_activities=application.runtime.settings.get("workerActivitySlots", 4),
                          graceful_shutdown_timeout=timedelta(seconds=10)):
            pulse_task = asyncio.create_task(pulse())
            recovery_task = asyncio.create_task(recover())
            from jobctrl.app.scheduling import maintain
            schedule_task = asyncio.create_task(maintain(application, stop))
            try:
                await stop.wait()
            finally:
                stop.set()
                # Maintenance RPCs may be waiting for an unavailable Temporal
                # server. They must not prevent the worker/provider shutdown
                # boundary from running; their persisted identities recover.
                recovery_task.cancel()
                schedule_task.cancel()
                await asyncio.gather(pulse_task, recovery_task, schedule_task, return_exceptions=True)
    finally:
        from jobctrl.app.model_providers import close_provider_runtimes
        await asyncio.to_thread(close_provider_runtimes)
        with application.runtime.database.transaction() as connection:
            connection.execute("UPDATE app_worker_heartbeats SET status='stopped',heartbeat_at=? WHERE worker_id=?", (now(), worker_id))


def main():
    parser = argparse.ArgumentParser(description="Run the JobCtrl durable Python application worker")
    parser.add_argument("--workspace", type=Path, default=Path(os.environ.get("JOBCTRL_DIR", "~/.jobctrl")).expanduser())
    parser.add_argument("--temporal-address", default=os.environ.get("JOBCTRL_TEMPORAL_ADDRESS", "127.0.0.1:7233"))
    parser.add_argument("--features", default=os.environ.get("JOBCTRL_FEATURES"))
    args = parser.parse_args()
    os.environ["JOBCTRL_DIR"] = str(args.workspace.expanduser().resolve())
    os.environ["JOBCTRL_TEMPORAL_ADDRESS"] = args.temporal_address
    asyncio.run(run_worker(args.workspace, enabled_features=args.features.split(",") if args.features else None))


if __name__ == "__main__":
    main()
