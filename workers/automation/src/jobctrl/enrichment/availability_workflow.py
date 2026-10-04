"""Explicit and recurring saved-posting checks through the real Temporal worker."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio import activity, workflow
from temporalio.common import RetryPolicy, WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.exceptions import CancelledError

with workflow.unsafe.imports_passed_through():
    from jobctrl.domain.identifiers import canonical_job_id
    from jobctrl.infrastructure.temporal.finalize import emit_workflow_started, emit_workflow_outcome


@dataclass(frozen=True)
class AvailabilityWorkflowInput:
    tenant_id: str
    job_id: str | None = None
    expected_app_dir: str | None = None
    expected_db_path: str | None = None

    def __post_init__(self) -> None:
        if self.job_id is not None:
            object.__setattr__(self, "job_id", str(canonical_job_id(self.job_id)))


@activity.defn(name="check_saved_posting_availability")
async def check_saved_posting_availability_activity(payload: AvailabilityWorkflowInput) -> dict[str, Any]:
    from jobctrl.database import get_connection
    from jobctrl.enrichment.availability import check_availability, due_jobs
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat

    assert_activity_runtime(expected_app_dir=payload.expected_app_dir, expected_db_path=payload.expected_db_path)

    def run() -> dict[str, Any]:
        conn = get_connection()
        if payload.job_id:
            return check_availability(payload.job_id, tenant_id=payload.tenant_id, conn=conn)
        jobs = due_jobs(conn, tenant_id=payload.tenant_id)
        results = [check_availability(job_id, tenant_id=payload.tenant_id, conn=conn, automatic=True)
                   for job_id in jobs]
        return {"checked": len(results), "results": results}

    return await run_blocking_with_heartbeat(run, starting_message="availability starting",
                                            progress_message="availability checking",
                                            activity_name="check_saved_posting_availability")


@workflow.defn(name="SavedPostingAvailabilityWorkflow")
class SavedPostingAvailabilityWorkflow:
    @workflow.run
    async def run(self, payload: AvailabilityWorkflowInput) -> dict[str, Any]:
        started_at = workflow.now()
        await emit_workflow_started(tenant_id=payload.tenant_id,
                                    workflow_type="SavedPostingAvailabilityWorkflow",
                                    input_summary={"jobId": payload.job_id, "sweepLimit": 25},
                                    started_at=started_at, expected_app_dir=payload.expected_app_dir,
                                    expected_db_path=payload.expected_db_path)
        try:
            result = await workflow.execute_activity(check_saved_posting_availability_activity, payload,
                                                     start_to_close_timeout=timedelta(minutes=30),
                                                     heartbeat_timeout=timedelta(minutes=2),
                                                     retry_policy=RetryPolicy(maximum_attempts=1))
        except CancelledError:
            await emit_workflow_outcome(tenant_id=payload.tenant_id,
                                        workflow_type="SavedPostingAvailabilityWorkflow", status="canceled",
                                        started_at=started_at, expected_app_dir=payload.expected_app_dir,
                                        expected_db_path=payload.expected_db_path)
            raise
        except Exception:
            await emit_workflow_outcome(tenant_id=payload.tenant_id,
                                        workflow_type="SavedPostingAvailabilityWorkflow", status="failed",
                                        started_at=started_at, error_code="availability_activity_failed",
                                        error_message="Availability observation could not be persisted.",
                                        expected_app_dir=payload.expected_app_dir,
                                        expected_db_path=payload.expected_db_path)
            raise
        await emit_workflow_outcome(tenant_id=payload.tenant_id,
                                    workflow_type="SavedPostingAvailabilityWorkflow", status="succeeded",
                                    started_at=started_at, expected_app_dir=payload.expected_app_dir,
                                    expected_db_path=payload.expected_db_path)
        return result


def availability_workflow_spec(params: dict[str, Any]):
    from jobctrl.domain.rpc.messages import WorkflowStartSpec
    from jobctrl.infrastructure.runtime_identity import assert_expected_runtime, current_runtime_identity
    allowed = {"tenantId", "jobId", "expectedAppDir", "expectedDbPath"}
    if set(params) != allowed or any(not isinstance(params.get(key), str) or not params[key].strip() for key in allowed):
        raise ValueError("availability requires canonical jobId, tenantId and exact runtime identity; extra fields are unsupported")
    assert_expected_runtime(expected_app_dir=params.get("expectedAppDir"),
                                       expected_db_path=params.get("expectedDbPath"))
    identity = current_runtime_identity()
    payload = AvailabilityWorkflowInput(tenant_id=params.get("tenantId", "local"),
                                        job_id=params["jobId"], expected_app_dir=str(identity.app_dir),
                                        expected_db_path=str(identity.db_path))
    from jobctrl.database import get_connection
    conn = get_connection()
    if conn.execute("SELECT 1 FROM jobs WHERE tenant_id = ? AND job_id = ?", (payload.tenant_id, payload.job_id)).fetchone() is None:
        raise ValueError("unknown jobId")
    return WorkflowStartSpec(workflow=SavedPostingAvailabilityWorkflow, args=(payload,),
                             workflow_id=f"availability-{payload.tenant_id}-{payload.job_id}",
                             id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
                             id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE)


async def reconcile_saved_posting_availability(client: Any, task_queue: str, identity: Any) -> bool:
    from jobctrl.database import get_connection
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.enrichment.availability import _begin, _event, _instant, _latest, _now
    conn = get_connection()
    now = _now()
    tenant_id = str(LOCAL_TENANT)
    _begin(conn)
    try:
        last = _latest(conn, tenant_id, "availability_sweep", "workspace")
        previous = _instant(last.get("admittedAt"))
        if previous and now - previous < timedelta(minutes=1):
            conn.rollback()
            return False
        _event(conn, tenant_id, "availability_sweep", "workspace", {"admittedAt": now.isoformat()}, now=now)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    await client.start_workflow(SavedPostingAvailabilityWorkflow.run,
                                AvailabilityWorkflowInput(tenant_id=tenant_id, expected_app_dir=str(identity.app_dir),
                                                          expected_db_path=str(identity.db_path)),
                                id=f"availability-sweep-{tenant_id}", task_queue=task_queue,
                                id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
                                id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE)
    return True
