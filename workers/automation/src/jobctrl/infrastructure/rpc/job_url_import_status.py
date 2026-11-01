"""Read one acknowledged import execution without waiting for running work."""

from __future__ import annotations

import asyncio
import hashlib
import re
from uuid import UUID

from temporalio.client import WorkflowExecutionStatus

from jobctrl.infrastructure.rpc.server import invalid_params
from jobctrl.infrastructure.runtime_identity import assert_expected_runtime
from jobctrl.infrastructure.temporal.client import get_temporal_client
from jobctrl.workflow_specs import workflow_result_to_dict


def job_url_import_status(params, *, client_factory=None):
    allowed = {"tenantId", "expectedAppDir", "expectedDbPath", "workflowId", "executionId"}
    if set(params) - allowed:
        raise invalid_params("unsupported import status parameter")
    for field in ("expectedAppDir", "expectedDbPath", "workflowId", "executionId"):
        if not isinstance(params.get(field), str) or not params[field].strip():
            raise invalid_params(f"missing required param: {field}")
    assert_expected_runtime(
        expected_app_dir=params["expectedAppDir"],
        expected_db_path=params["expectedDbPath"],
    )
    tenant_id = params.get("tenantId", "local")
    if not isinstance(tenant_id, str) or not tenant_id:
        raise invalid_params("invalid tenantId")
    workflow_id, execution_id = params["workflowId"], params["executionId"]
    prefix = "job-url-import-" + hashlib.sha256(tenant_id.encode()).hexdigest() + "-"
    if not re.fullmatch(re.escape(prefix) + r"[0-9a-f]{64}", workflow_id):
        raise invalid_params("workflow does not belong to this tenant's URL imports")
    try:
        if str(UUID(execution_id)) != execution_id:
            raise ValueError("noncanonical execution ID")
    except ValueError as exc:
        raise invalid_params("invalid executionId") from exc

    async def read():
        client = await (client_factory or get_temporal_client)()
        handle = client.get_workflow_handle(workflow_id, run_id=execution_id)
        description = await handle.describe()
        if (description.id, description.run_id, description.workflow_type) != (
            workflow_id,
            execution_id,
            "JobUrlImportWorkflow",
        ):
            raise invalid_params("import execution identity mismatch")
        result = {"workflowId": workflow_id, "executionId": execution_id}
        if description.status == WorkflowExecutionStatus.RUNNING:
            return {**result, "status": "pending"}
        if description.status == WorkflowExecutionStatus.COMPLETED:
            return {
                **result,
                "status": "succeeded",
                "result": workflow_result_to_dict(await handle.result(follow_runs=False)),
            }
        terminal = {
            WorkflowExecutionStatus.FAILED: "failed",
            WorkflowExecutionStatus.CANCELED: "canceled",
            WorkflowExecutionStatus.TIMED_OUT: "timed_out",
            WorkflowExecutionStatus.TERMINATED: "terminated",
        }
        if description.status not in terminal:
            raise invalid_params("unsupported import execution status")
        return {**result, "status": terminal[description.status]}

    return asyncio.run(asyncio.wait_for(read(), timeout=10))
