"""Default JSON-RPC handler registry.

Per S-11 the initial method set covers:

* Simple state-transition commands — ``reset_stage``, ``mark_applied``,
  ``mark_skipped``, ``cancel_stage``.  These mutate ``job_stage_states``
  through the same write API the TS surface uses (``state.reset_job_stage``
  / ``state.set_stage_state``).
* Existing local-action wrappers — ``profile_import`` delegates to
  ``actions.run_local_action``.
* Workflow starters — ``apply`` returns a :class:`WorkflowStartSpec` for
  :class:`ApplyWorkflow`; ``run_stage`` returns one for
  :class:`JobPipelineWorkflow`. The server starts them on the Temporal task
  queue and ships back ``{"runId", "workflowId", "firstExecutionRunId"}``.
* Cooperative cancellation — ``cancel_run`` cancels an in-flight workflow
  via the injected canceler.

Every method accepts ``params.tenantId``; if it is missing the handler logs
a warning and substitutes ``LOCAL_TENANT`` (single-user / local-first per
target §6.5).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from jobhunter.actions import LocalActionRequest, run_local_action
from jobhunter.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobhunter.database import get_connection
from jobhunter.domain.rpc.messages import WorkflowStartSpec
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.rpc.server import JsonRpcServer, invalid_params
from jobhunter.infrastructure.rpc.workflow_starter import WorkflowCanceler
from jobhunter.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
from jobhunter.state import record_job_event, reset_job_stage, set_stage_state, utc_now

logger = logging.getLogger(__name__)
WORKFLOW_STAGES = {"discover", "enrich", "score", "tailor", "cover", "apply"}


def _tenant_id(params: dict[str, Any]) -> str:
    raw = params.get("tenantId")
    if not raw:
        logger.warning("JSON-RPC call missing 'tenantId' — defaulting to LOCAL_TENANT")
        return LOCAL_TENANT
    return str(raw)


def _require(params: dict[str, Any], name: str) -> Any:
    if name not in params or params[name] in (None, ""):
        raise invalid_params(f"missing required param: {name}")
    return params[name]


# ---------------------------------------------------------------------------
# Simple state-transition handlers
# ---------------------------------------------------------------------------


def reset_stage(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    stage = str(_require(params, "stage"))
    reset_attempts = bool(params.get("resetAttempts", False))

    conn = get_connection()
    canonical = reset_job_stage(conn, job_url, stage, reset_attempts=reset_attempts)
    return {"jobUrl": canonical, "stage": stage, "state": "pending"}


def mark_applied(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    now = utc_now()

    conn = get_connection()
    set_stage_state(
        conn,
        job_url,
        "apply",
        "succeeded",
        finished_at=now,
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_url,
        "apply",
        "ApplicationManuallyMarked",
        message="Marked applied via RPC",
    )
    conn.commit()
    return {"jobUrl": job_url, "state": "succeeded"}


def mark_skipped(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    stage = str(_require(params, "stage"))
    reason = str(params.get("reason", "manual_skip"))

    conn = get_connection()
    set_stage_state(
        conn,
        job_url,
        stage,
        "skipped",
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_url,
        stage,
        "StageSkipped",
        message=reason,
        payload={"reason": reason},
    )
    conn.commit()
    return {"jobUrl": job_url, "stage": stage, "state": "skipped"}


# Post-hoc state-flip path — marks the stage canceled in SQLite without
# touching the workflow runtime.  Pair with ``cancel_run`` for the
# cooperative path that signals an in-flight workflow.
def cancel_stage(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    stage = str(_require(params, "stage"))
    now = utc_now()

    conn = get_connection()
    set_stage_state(
        conn,
        job_url,
        stage,
        "canceled",
        finished_at=now,
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_url,
        stage,
        "StageCanceled",
        message="Stage canceled via RPC",
    )
    conn.commit()
    return {"jobUrl": job_url, "stage": stage, "state": "canceled"}


# ---------------------------------------------------------------------------
# Local-action wrappers (sync — return LocalActionResult dict)
# ---------------------------------------------------------------------------


def _stage_list(params: dict[str, Any]) -> list[str]:
    raw_stages = params.get("stages")
    if isinstance(raw_stages, list) and raw_stages:
        stages = [str(stage) for stage in raw_stages]
    else:
        stages = [str(_require(params, "stage"))]
    invalid = [stage for stage in stages if stage not in WORKFLOW_STAGES]
    if invalid:
        raise invalid_params(f"unsupported pipeline stage for workflow: {', '.join(invalid)}")
    return stages


def run_stage(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = _tenant_id(params)
    stages = _stage_list(params)
    payload = JobPipelineWorkflowInput(
        tenant_id=tenant_id,
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        stages=stages,
        min_score=int(params.get("minScore", 7)),
        workers=int(params.get("workers", 1)),
        limit=int(params.get("limit", 0)),
        validation_mode=str(params.get("validationMode", "normal")),
        dry_run=bool(params.get("dryRun", False)),
        rescore=bool(params.get("rescore", False)),
        retailor=bool(params.get("retailor", False)),
        job_url=params.get("jobUrl") if params.get("jobUrl") else None,
        headless=bool(params.get("headless", False)),
        model=str(params.get("model", "default")),
        continuous=bool(params.get("continuous", False)),
    )
    return WorkflowStartSpec(workflow=JobPipelineWorkflow, args=(payload,))


def profile_import(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    pdf_path = str(_require(params, "pdfPath"))
    request = LocalActionRequest(
        stage="profile_import",
        pdf_path=pdf_path,
        import_profile=bool(params.get("importProfile", True)),
        import_style=bool(params.get("importStyle", True)),
    )
    return run_local_action(request).to_dict()


# ---------------------------------------------------------------------------
# Workflow handlers
# ---------------------------------------------------------------------------


def apply_action(params: dict[str, Any]) -> WorkflowStartSpec:
    """Build a :class:`WorkflowStartSpec` for :class:`ApplyWorkflow`."""
    tenant_id = _tenant_id(params)
    payload = ApplyWorkflowInput(
        tenant_id=tenant_id,
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        job_url=params.get("jobUrl"),
        dry_run=bool(params.get("dryRun", False)),
        headless=bool(params.get("headless", False)),
        model=str(params.get("model", "default")),
        min_score=int(params.get("minScore", 7)),
        workers=int(params.get("workers", 1)),
        limit=int(params.get("limit", 1)),
        continuous=bool(params.get("continuous", False)),
    )
    return WorkflowStartSpec(workflow=ApplyWorkflow, args=(payload,))


def make_cancel_run(canceler: WorkflowCanceler):
    """Build a ``cancel_run`` handler bound to *canceler*.

    Cooperative cancellation path — signals the workflow runtime to cancel
    the in-flight run.  See :func:`cancel_stage` for the post-hoc state-flip
    path that does not touch the workflow runtime.
    """

    def cancel_run(params: dict[str, Any]) -> dict[str, Any]:
        _tenant_id(params)
        run_id = str(_require(params, "runId"))
        asyncio.run(canceler(run_id))
        return {"runId": run_id, "status": "canceling"}

    return cancel_run


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def register_default_handlers(server: JsonRpcServer, *, canceler: WorkflowCanceler) -> None:
    """Wire the default JobHunter method set onto *server*."""
    # Simple state-transition commands — synchronous.
    server.register("reset_stage", reset_stage, mode="sync")
    server.register("mark_applied", mark_applied, mode="sync")
    server.register("mark_skipped", mark_skipped, mode="sync")
    server.register("cancel_stage", cancel_stage, mode="sync")
    # Local-action wrapper — synchronous import until the profile workflow
    # becomes the API path.
    server.register("profile_import", profile_import, mode="sync")
    # Workflow starters.
    server.register("run_stage", run_stage, mode="workflow")
    server.register("apply", apply_action, mode="workflow")
    # Cooperative cancellation of in-flight workflows.
    server.register("cancel_run", make_cancel_run(canceler), mode="sync")
