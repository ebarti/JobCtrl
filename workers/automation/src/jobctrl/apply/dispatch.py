"""Bind an Apply workflow dispatch to the durable Skip/reset frontier."""
from __future__ import annotations

from dataclasses import replace


def bind_apply_dispatch_spec(spec):
    """Freeze a new Apply request before its Temporal start crosses processes."""
    from jobctrl.apply.workflow import ApplyWorkflowInput
    from jobctrl.pipeline.workflow import JobPipelineWorkflowInput

    payload = spec.args[0] if spec.args else None
    if not isinstance(payload, (ApplyWorkflowInput, JobPipelineWorkflowInput)):
        return spec
    if isinstance(payload, JobPipelineWorkflowInput) and 'apply' not in payload.stages:
        return spec
    if payload.dispatch_frontier is not None:
        return spec  # Already bound by the immediately preceding dispatch boundary.
    from jobctrl.database import get_connection
    from jobctrl.infrastructure.apply_controls import capture_apply_dispatch_frontier
    from jobctrl.infrastructure.runtime_identity import assert_expected_runtime

    assert_expected_runtime(expected_app_dir=payload.expected_app_dir, expected_db_path=payload.expected_db_path)
    conn = get_connection()
    if conn.in_transaction:
        raise RuntimeError('Apply dispatch cannot cross a caller-owned database transaction')
    frontier, generation = capture_apply_dispatch_frontier(
        conn, tenant_id=payload.tenant_id, job_id=payload.job_id,
    )
    # Preserve same-generation deduplication while allowing an explicit new
    # targeted request to coexist with the fenced pre-reset execution.
    workflow_id = spec.workflow_id
    if workflow_id and payload.job_id is not None and generation:
        workflow_id = f'{workflow_id}-skip-{generation}'
    return replace(spec, args=(replace(payload, dispatch_frontier=frontier), *spec.args[1:]), workflow_id=workflow_id)
