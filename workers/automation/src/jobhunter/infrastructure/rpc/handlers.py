"""Default JSON-RPC handler registry.

Per S-11 the initial method set covers:

* Simple state-transition commands — ``reset_stage``, ``mark_applied``,
  ``mark_skipped``, ``cancel_stage``.  These mutate ``job_stage_states``
  through the same write API the TS surface uses (``state.reset_job_stage``
  / ``state.set_stage_state``).
* Existing local-action wrappers — ``profile_import`` delegates to
  ``actions.run_local_action``.
* Workflow starters — ``apply`` returns a :class:`WorkflowStartSpec` for
  :class:`ApplyWorkflow`; ``run_stage`` and the current-policy maintenance
  methods return one for :class:`JobPipelineWorkflow`. The server starts them
  on the Temporal task queue and ships back
  ``{"runId", "workflowId", "firstExecutionRunId"}``.
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
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
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


def _bool_param(params: dict[str, Any], name: str, *, default: bool = False) -> bool:
    raw = params.get(name, default)
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return default
    if isinstance(raw, str):
        return raw.strip().lower() not in {"", "0", "false", "no", "off"}
    return bool(raw)


def _job_urls(params: dict[str, Any]) -> tuple[str, ...]:
    raw = params.get("jobUrls") or ()
    if not raw:
        return ()
    if not isinstance(raw, list):
        raise invalid_params("jobUrls must be an array")
    return tuple(str(item).strip() for item in raw if str(item).strip())


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
    raw_judge_min_score = params.get("tailorJudgeMinScore")
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
        tailor_models=tuple(str(item) for item in (params.get("tailorModels") or ())),
        tailor_judge_model=(
            str(params["tailorJudgeModel"])
            if params.get("tailorJudgeModel")
            else None
        ),
        tailor_judge_min_score=(
            float(raw_judge_min_score) if raw_judge_min_score is not None else None
        ),
        job_url=params.get("jobUrl") if params.get("jobUrl") else None,
        headless=bool(params.get("headless", False)),
        model=str(params.get("model", "default")),
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        continuous=bool(params.get("continuous", False)),
    )
    return WorkflowStartSpec(workflow=JobPipelineWorkflow, args=(payload,))


def rescore_job(params: dict[str, Any]) -> WorkflowStartSpec:
    job_url = str(_require(params, "jobUrl"))
    return _pipeline_workflow_spec(
        params,
        stages=["score"],
        limit=1,
        rescore=True,
        job_url=job_url,
    )


def rescore_jobs_not_on_current_scoring_policy(params: dict[str, Any]) -> WorkflowStartSpec:
    return _pipeline_workflow_spec(
        params,
        stages=["score"],
        limit=int(params.get("limit", 100)),
        rescore=True,
        job_urls=_job_urls(params),
        score_current_policy_only=True,
    )


def retailor_job(params: dict[str, Any]) -> WorkflowStartSpec:
    job_url = str(_require(params, "jobUrl"))
    return _pipeline_workflow_spec(
        params,
        stages=["tailor", "cover"],
        limit=1,
        retailor=True,
        job_url=job_url,
        suppress_existing_artifacts=_bool_param(
            params, "suppressExistingArtifacts", default=True
        ),
    )


def tailor_job(params: dict[str, Any]) -> WorkflowStartSpec:
    job_url = str(_require(params, "jobUrl"))
    return _pipeline_workflow_spec(
        params,
        stages=["tailor", "cover"],
        limit=1,
        retailor=False,
        job_url=job_url,
        allow_low_fit_override=_bool_param(
            params, "allowLowFitOverride", default=True
        ),
    )


def analyze_job(params: dict[str, Any]) -> dict[str, Any]:
    """Produce/inspect the canonical employer analysis for one job (D-10).

    Synchronous: runs the 2-SDK ensemble to completion (NO wall-clock timeout —
    D-19) and persists the canonical analysis, superseding prior generations
    (D-13). ``force`` bypasses the snapshot+version cache to recompute. Returns
    the persisted record's identity + the degraded-ensemble signal so a caller
    can see a degraded run immediately (D-08).
    """
    tenant_id = _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    force = _bool_param(params, "force", default=False)

    from jobhunter.database import get_connection, load_job_with_enrichment
    from jobhunter.domain.tenant import TenantId
    from jobhunter.scoring.tailor import _build_analyze_use_case

    conn = get_connection()
    job = load_job_with_enrichment(conn, job_url)
    if job is None:
        raise invalid_params(f"unknown jobUrl: {job_url}")
    if not (job.get("full_description") or job.get("description")):
        raise invalid_params(
            f"job {job_url} has no description to analyze; enrich it first"
        )

    use_case = _build_analyze_use_case(conn=conn)
    outcome = use_case.execute(job=job, tenant_id=TenantId(tenant_id), force=force)
    record = outcome.analysis
    return {
        "jobUrl": job_url,
        "generation": record.generation,
        "cacheKey": record.cache_key,
        "cached": outcome.cached,
        "legsAttempted": record.legs_attempted,
        "legsSucceeded": record.legs_succeeded,
        "degraded": record.is_degraded,
    }


def retailor_current_policy(params: dict[str, Any]) -> WorkflowStartSpec:
    return _pipeline_workflow_spec(
        params,
        stages=["tailor", "cover"],
        limit=int(params.get("limit", 100)),
        retailor=True,
        job_urls=_job_urls(params),
        tailor_current_policy_only=True,
        suppress_existing_artifacts=_bool_param(
            params, "suppressExistingArtifacts", default=True
        ),
    )


def _pipeline_workflow_spec(
    params: dict[str, Any],
    *,
    stages: list[str],
    limit: int,
    rescore: bool = False,
    retailor: bool = False,
    job_url: str | None = None,
    job_urls: tuple[str, ...] = (),
    score_current_policy_only: bool = False,
    tailor_current_policy_only: bool = False,
    suppress_existing_artifacts: bool = False,
    allow_low_fit_override: bool = False,
) -> WorkflowStartSpec:
    tenant_id = _tenant_id(params)
    raw_judge_min_score = params.get("tailorJudgeMinScore")
    payload = JobPipelineWorkflowInput(
        tenant_id=tenant_id,
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        stages=stages,
        min_score=int(params.get("minScore", 7)),
        workers=int(params.get("workers", 1)),
        limit=limit,
        validation_mode=str(params.get("validationMode", "normal")),
        dry_run=bool(params.get("dryRun", False)),
        rescore=rescore,
        retailor=retailor,
        tailor_models=tuple(str(item) for item in (params.get("tailorModels") or ())),
        tailor_judge_model=(
            str(params["tailorJudgeModel"])
            if params.get("tailorJudgeModel")
            else None
        ),
        tailor_judge_min_score=(
            float(raw_judge_min_score) if raw_judge_min_score is not None else None
        ),
        job_url=job_url,
        job_urls=job_urls,
        score_current_policy_only=score_current_policy_only,
        tailor_current_policy_only=tailor_current_policy_only,
        suppress_existing_artifacts=suppress_existing_artifacts,
        allow_low_fit_override=allow_low_fit_override,
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
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
    server.register("rescore_job", rescore_job, mode="workflow")
    server.register(
        "rescore_jobs_not_on_current_scoring_policy",
        rescore_jobs_not_on_current_scoring_policy,
        mode="workflow",
    )
    server.register("tailor_job", tailor_job, mode="workflow")
    server.register("retailor_job", retailor_job, mode="workflow")
    server.register("retailor_current_policy", retailor_current_policy, mode="workflow")
    # Standalone employer-analysis trigger (D-10) — synchronous; runs the
    # ensemble inline (no timeout, D-19) and persists the canonical analysis.
    server.register("analyze_job", analyze_job, mode="sync")
    server.register("apply", apply_action, mode="workflow")
    # Cooperative cancellation of in-flight workflows.
    server.register("cancel_run", make_cancel_run(canceler), mode="sync")
