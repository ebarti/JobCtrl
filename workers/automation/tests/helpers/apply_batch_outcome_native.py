"""Real Temporal and authenticated native Apply outcome QA.

External ports are synthetic. The refusal case injects a parent-side failure
after real native proof to test reporting without claiming a native defect.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys
import uuid
from datetime import timedelta

source_arg, app_arg, evidence_arg, workers_arg = sys.argv[1:]
source = Path(source_arg)
sys.path[:0] = [str(source), str(source.parent)]
app, evidence = Path(app_arg).resolve(), Path(evidence_arg).resolve()
if workers_arg not in ("1", "2", "1-progress", "1-refuse"):
    raise ValueError("unknown synthetic native fixture scenario")
workers = 2 if workers_arg == "2" else 1
refuse = workers_arg == "1-refuse"
completed = 1 if workers_arg in ("1-progress", "1-refuse") else 0
os.environ["JOBCTRL_DIR"] = str(app)
os.environ["LANGFUSE_DISABLE"] = "1"
os.environ["OTEL_SDK_DISABLED"] = "true"

from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker  # noqa: E402
from jobctrl import config, database  # noqa: E402
from jobctrl.apply.activities import apply_activity  # noqa: E402
from jobctrl.apply import execution  # noqa: E402
from jobctrl.apply.process_birth import CustodyUnverified  # noqa: E402
from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput  # noqa: E402
from jobctrl.infrastructure.temporal.finalize import record_workflow_started, record_workflow_outcome  # noqa: E402
from jobctrl.llm import check_spend_budget  # noqa: E402
from tests.temporal_env import local_env  # noqa: E402


async def run():
    config.ensure_dirs()
    database.init_db()
    refusal_job = None
    if refuse:
        from tests.test_apply_regressions import _insert_ready_job
        refusal_job = _insert_ready_job(database.get_connection(), url="https://example.test/native-refusal",
                                         application_url="https://example.test/apply")
    marker = app / "qa-batch-worker-crash"
    marker.write_text("one_dry_run" if refuse else "after_progress" if completed else "all")
    invocations = app / "apply-invocations"
    invocations.mkdir(mode=0o700, exist_ok=True)
    before = {path.name for path in invocations.iterdir()}
    original_verify = execution.verify_native_completion
    observed_before_verification = []

    if refuse:
        def refuse_completion(binding, root):
            created = {path.name for path in invocations.iterdir()} - before
            if len(created) != 1:
                raise RuntimeError("native refusal did not own exactly one invocation")
            request_id = next(iter(created))
            rows = database.get_connection().execute(
                "SELECT outcome FROM operational_attempt_metrics WHERE stage='apply' AND attempt_kind='apply_batch' "
                "AND run_id=? ORDER BY metric_id", (f"apply:{request_id}",),
            ).fetchall()
            observed_before_verification.extend(row["outcome"] for row in rows)
            original_verify(binding, root)
            raise CustodyUnverified("synthetic refusal after authenticated native proof")
        execution.verify_native_completion = refuse_completion
    queue = "native-batch-" + uuid.uuid4().hex
    workflow_id = "native-batch-" + uuid.uuid4().hex
    try:
        async with local_env() as env:
            async with Worker(env.client, task_queue=queue, workflows=[ApplyWorkflow],
                    activities=[apply_activity, check_spend_budget, record_workflow_started, record_workflow_outcome],
                    workflow_runner=UnsandboxedWorkflowRunner()):
                handle = await env.client.start_workflow(
                    ApplyWorkflow.run,
                    ApplyWorkflowInput(tenant_id="local", expected_app_dir=str(app), expected_db_path=str(config.DB_PATH),
                                       job_id=refusal_job, limit=1 if refuse else 2, workers=workers,
                                       dry_run=refuse, approval_required=False),
                    id=workflow_id, task_queue=queue,
                    execution_timeout=timedelta(seconds=90),
                )
                result = await asyncio.wait_for(handle.result(), 90)
                history = await handle.fetch_history()
            await Replayer(workflows=[ApplyWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
        if refuse:
            if (result.ok or result.status != "failed" or "apply_launcher_cleanup_incomplete" not in result.error
                    or (result.applied, result.failed, result.worker_crashes, result.counts_known) != (0, 0, None, False)):
                raise RuntimeError(f"native refusal exposed unverified counts: {result}")
            if observed_before_verification != ["started"]:
                raise RuntimeError("native child published a terminal metric before attestation")
        elif (result.ok or result.status != "failed" or result.error != "apply_worker_crashed"
                or (result.applied, result.failed, result.worker_crashes, result.counts_known) != (completed, 0, workers, True)):
            raise RuntimeError(f"native worker-crash result was not truthful: {result}")
        conn = database.get_connection()
        projection = conn.execute("SELECT status FROM workflow_run_projections WHERE workflow_id=?", (workflow_id,)).fetchone()
        metric = conn.execute(
            "SELECT outcome, error_class, metadata_json, total_count FROM operational_attempt_metrics "
            "WHERE stage='apply' AND attempt_kind='apply_batch' ORDER BY metric_id DESC LIMIT 1"
        ).fetchone()
        metadata = json.loads(metric["metadata_json"])
        expected_metric = ("failed", "failed", "ApplyLauncherCleanupIncomplete", None, None, None, None) if refuse else (
            "failed", "failed", "apply_worker_crashed", completed, completed, 0, workers,
        )
        if (projection["status"], metric["outcome"], metric["error_class"], metric["total_count"],
                metadata["applied"], metadata["failedJobs"], metadata["workerCrashes"]) != expected_metric:
            raise RuntimeError("native batch metric lost the actual job and worker outcomes")
        if refuse and metadata["countsKnown"] is not False:
            raise RuntimeError("native refusal presented unverified counts as known")
        starts = [event.activity_task_started_event_attributes for event in history.events
                  if event.HasField("activity_task_started_event_attributes")]
        if len(starts) != 1 or starts[0].attempt != 1:
            raise RuntimeError("native worker-crash batch retried")
        after = {path.name for path in invocations.iterdir()}
        created = after - before
        if len(created) != 1:
            raise RuntimeError("native worker-crash batch did not own exactly one invocation")
        request_id = created.pop()
        value = json.loads((invocations / request_id / "result.json").read_text())
        expected = {"code": "apply_worker_crashed", "counts": {"applied": completed, "failed": 0, "worker_crashes": workers}}
        if refuse and (value["error"] is not None or value["output"] != [0, 0]):
            raise RuntimeError("native refusal fixture did not complete its synthetic child work")
        if refuse:
            job_id = refusal_job
            claim_row = conn.execute(
                "SELECT payload_json FROM job_events WHERE job_id=? AND event_type='ApplyClaimAcquired' "
                "ORDER BY event_id DESC LIMIT 1", (job_id,),
            ).fetchone()
            claim = json.loads(claim_row["payload_json"])
            custody = json.loads((app / "apply-runs" / request_id / "custody.json").read_text())
            if (claim["launcher_id"] != request_id or not any(
                    item["job_id"] == job_id and item["run_id"] == claim["run_id"] for item in custody["jobs"])):
                raise RuntimeError("native refusal did not retain its actual claimed job custody")
        if not refuse and (value["error"] != expected or value["output"] is not None):
            raise RuntimeError("native result lost structured failure counts")
        (evidence / "native-batch-outcome.json").write_text(json.dumps({
            "request_id": request_id, "scope_id": value["native_custody"]["scope"]["id"]
        }))
    finally:
        execution.verify_native_completion = original_verify
        marker.unlink(missing_ok=True)
        database.close_thread_connections()


asyncio.run(run())
