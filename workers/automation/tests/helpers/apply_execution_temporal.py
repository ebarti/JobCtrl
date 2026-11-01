"""Real Temporal → fixed native scope → actual Apply/saga, external ports controlled.

The Go test supplies a verified local payload whose Python fixture installs only
apply_execution_ports. Every path, listener, writer and SQLite row is synthetic.
Arguments: WORKER_SOURCE APP_DIR EVIDENCE_DIR. No provider/account/application.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import json
import os
from pathlib import Path
import sys
import uuid

source_arg, app_arg, evidence_arg = sys.argv[1:]
source = Path(source_arg)
sys.path[:0] = [str(source), str(source.parent)]
app, evidence = Path(app_arg).resolve(), Path(evidence_arg).resolve()
os.environ["JOBCTRL_DIR"] = str(app)
os.environ["LANGFUSE_DISABLE"] = "1"
os.environ["OTEL_SDK_DISABLED"] = "true"

from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker  # noqa: E402
from jobctrl import config, database  # noqa: E402
from jobctrl.apply.activities import apply_activity  # noqa: E402
from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput  # noqa: E402
from jobctrl.infrastructure.temporal import run_in_activity  # noqa: E402
from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started  # noqa: E402
from jobctrl.llm import check_spend_budget  # noqa: E402
from tests.temporal_env import local_env  # noqa: E402
from tests.test_apply_regressions import _insert_ready_job  # noqa: E402


def events(job):
    return [tuple(row) for row in database.get_connection().execute(
        "SELECT event_type,payload_json FROM job_events WHERE job_id=? ORDER BY event_id", (job,))]


async def ready(path):
    deadline = asyncio.get_running_loop().time() + 30
    while not path.exists():
        if asyncio.get_running_loop().time() > deadline:
            raise RuntimeError(f"actual native activity did not publish owned {path.name}")
        await asyncio.sleep(.01)
    return json.loads(path.read_text())


async def iterate(histories):
    for history in histories:
        yield history


async def run():
    config.ensure_dirs()
    conn = database.init_db()
    controls = app / "qa-native-controls"
    controls.mkdir(mode=0o700, exist_ok=True)
    cases = []
    # Seed source-only fixture metadata through the source catalog. The worker
    # uses the corresponding catalog copied into its authenticated payload.
    from jobctrl.browser_capabilities import enable_system_browser_capability, load_browser_capability_catalog
    browser = evidence / "owned-version-browser"
    catalog = load_browser_capability_catalog(path=source.parent.parent.parent / "packaging/distribution/capability-policy.json")
    enable_system_browser_capability("auto-apply-browser", browser, app_dir=app, catalog=catalog)
    for terminal in ("complete", "fail", "cancel"):
        first = _insert_ready_job(conn, url=f"https://example.com/native-{terminal}-first")
        second = _insert_ready_job(conn, url=f"https://example.com/native-{terminal}-second")
        cases.append((terminal, first, second))
    executor = ThreadPoolExecutor(max_workers=4)
    run_in_activity.set_activity_executor(executor)
    original = run_in_activity.run_blocking_with_heartbeat
    async def responsive(fn, **kwargs):
        return await original(fn, **{**kwargs, "poll_interval": .05, "cancel_wait_seconds": .02})
    run_in_activity.run_blocking_with_heartbeat = responsive
    histories, outcomes = [], []
    queue = "native-apply-" + uuid.uuid4().hex
    handles = []
    try:
        async with local_env() as env:
            async with Worker(env.client, task_queue=queue, workflows=[ApplyWorkflow],
                    activities=[apply_activity, check_spend_budget, record_workflow_started, record_workflow_outcome],
                    workflow_runner=UnsandboxedWorkflowRunner(), max_concurrent_activities=2,
                    max_heartbeat_throttle_interval=timedelta(milliseconds=20)):
                def payload(job):
                    return ApplyWorkflowInput(tenant_id="local", job_id=job, dry_run=True,
                        expected_app_dir=str(app), expected_db_path=str(config.DB_PATH), approval_required=False)
                for terminal, first, second in cases:
                    one = await env.client.start_workflow(ApplyWorkflow.run, payload(first), id="native-owner-"+uuid.uuid4().hex, task_queue=queue)
                    handles.append(one)
                    owner = await ready(controls / f"ready-{first}.json")
                    two = await env.client.start_workflow(ApplyWorkflow.run, payload(second), id="native-peer-"+uuid.uuid4().hex, task_queue=queue)
                    handles.append(two)
                    peer = await ready(controls / f"ready-{second}.json")
                    before = events(second)
                    stage_before = tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='apply'", (second,)).fetchone())
                    accepted = Path(peer["work_dir"]) / "accepted-native-bytes"
                    if owner["worker_id"] == peer["worker_id"] or owner["scope_id"] == peer["scope_id"] or owner["port"] == peer["port"]:
                        raise RuntimeError("native peers shared ownership identities")
                    if terminal == "cancel":
                        await one.cancel()
                        if (await asyncio.wait_for(one.result(), 30)).ok:
                            raise RuntimeError("cancelled native workflow reported success")
                    else:
                        (controls / f"release-{first}").write_text("fail" if terminal == "fail" else "complete")
                        if (await asyncio.wait_for(one.result(), 30)).ok != (terminal == "complete"):
                            raise RuntimeError("native owner outcome did not match controlled external result")
                    os.kill(peer["pid"], 0)
                    if accepted.read_bytes() != b"accepted owned native Apply bytes" or events(second) != before:
                        raise RuntimeError("native peer files/events changed with owner termination")
                    if tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='apply'", (second,)).fetchone()) != stage_before:
                        raise RuntimeError("native peer canonical ownership changed")
                    (controls / f"release-{second}").write_text("complete")
                    if not (await asyncio.wait_for(two.result(), 30)).ok:
                        raise RuntimeError("native peer failed after independent owner termination")
                    histories.extend([await one.fetch_history(), await two.fetch_history()])
                    # The same accepted job can rehearse again only after the
                    # actual native controller verified escaped descendants.
                    if terminal == "complete":
                        (controls / f"ready-{first}.json").unlink()
                        (controls / f"release-{first}").unlink()
                        again = await env.client.start_workflow(ApplyWorkflow.run, payload(first), id="native-next-"+uuid.uuid4().hex, task_queue=queue)
                        handles.append(again)
                        successor = await ready(controls / f"ready-{first}.json")
                        if successor["worker_id"] == owner["worker_id"] or successor["scope_id"] == owner["scope_id"]:
                            raise RuntimeError("same-job successor reused prior resources")
                        (controls / f"release-{first}").write_text("complete")
                        if not (await asyncio.wait_for(again.result(), 30)).ok:
                            raise RuntimeError("ordinary same-job native retry failed")
                        histories.append(await again.fetch_history())
                    outcomes.append({"terminal": terminal, "owner": owner, "peer": peer})
            await Replayer(workflows=[ApplyWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflows(
                iterate(histories), raise_on_replay_failure=True)
        trace = []
        for history in histories:
            (evidence / ("history-" + history.workflow_id + ".json")).write_text(history.to_json())
            scheduled = {event.event_id: event.activity_task_scheduled_event_attributes.activity_type.name
                         for event in history.events if event.HasField("activity_task_scheduled_event_attributes")}
            starts = []
            for event in history.events:
                if event.HasField("activity_task_started_event_attributes"):
                    started = event.activity_task_started_event_attributes
                    failure = started.last_failure
                    chain = []
                    while failure.message:
                        chain.append({"message": failure.message, "type": failure.application_failure_info.type})
                        failure = failure.cause
                    starts.append({"activity": scheduled.get(started.scheduled_event_id), "attempt": started.attempt,
                                   "last_failure": chain})
            trace.append({"workflow_id": history.workflow_id, "activities": starts})
        (evidence / "temporal-native-attempts.json").write_text(json.dumps(trace))
        print(json.dumps({"native_activity_attempts": trace}), flush=True)
        (evidence / "temporal-native-results.json").write_text(json.dumps(outcomes))
    finally:
        for _, first, second in cases:
            for job in (first, second):
                (controls / f"release-{job}").write_text("complete")
        run_in_activity.shutdown_activity_executors()
        executor.shutdown(wait=True, cancel_futures=True)
        database.close_thread_connections()


asyncio.run(run())
