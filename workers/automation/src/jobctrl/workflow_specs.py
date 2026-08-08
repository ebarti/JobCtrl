"""Shared Temporal workflow spec builders and start/wait helpers."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any

from temporalio.common import WorkflowIDReusePolicy

from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobctrl.contact.activities import ResearchSourceInput
from jobctrl.contact.workflow import (
    ContactResearchWorkflow,
    ContactResearchWorkflowInput,
    contact_research_workflow_id,
)
from jobctrl.discovery.workflow import (
    DiscoverWorkflow,
    DiscoverWorkflowInput,
    discover_workflow_id,
)
from jobctrl.domain.discovery.source_registry import ManualCaptureMode
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.rpc.messages import WorkflowStartSpec
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.interview.workflow import InterviewPrepWorkflow, InterviewPrepWorkflowInput
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctrl.pipeline.runner import PRIMARY_STAGE_ORDER
from jobctrl.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput

WORKFLOW_STAGES = {"discover", "enrich", "score", "tailor", "cover", "apply"}
_WORKFLOW_STAGE_ORDER = ("discover", "enrich", "score", "tailor", "cover", "apply")
_APPLY_SELECTOR_KEYS = ("jobId", "jobIds", "jobUrl", "jobUrls")
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class StartedWorkflowResult:
    run_id: str
    workflow_id: str
    first_execution_run_id: str | None
    result: Any

    def to_dict(self) -> dict[str, Any]:
        return {
            "runId": self.run_id,
            "workflowId": self.workflow_id,
            "firstExecutionRunId": self.first_execution_run_id,
            "result": workflow_result_to_dict(self.result),
        }


def build_run_stage_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = _tenant_id(params)
    stages = _stage_list(params)
    apply_selector = _apply_selector(params) if "apply" in stages else None
    if "apply" in stages:
        _require_auto_apply_browser_capability()
    params, material_selection_resolved = _scope_global_material_batch(
        params,
        stages=stages,
        tenant_id=tenant_id,
    )
    raw_judge_min_score = params.get("tailorJudgeMinScore")
    if stages == ["discover"]:
        payload = DiscoverWorkflowInput(
            tenant_id=tenant_id,
            expected_app_dir=params.get("expectedAppDir"),
            expected_db_path=params.get("expectedDbPath"),
            min_score=int(params.get("minScore", 7)),
            workers=int(params.get("workers", 1)),
            limit=int(params.get("limit", 0)),
            validation_mode=str(params.get("validationMode", "normal")),
            tailor_models=tuple(str(item) for item in (params.get("tailorModels") or ())),
            tailor_judge_model=str(params["tailorJudgeModel"]) if params.get("tailorJudgeModel") else None,
            tailor_judge_min_score=(float(raw_judge_min_score) if raw_judge_min_score is not None else None),
            source_ids=_source_ids(params),
            llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        )
        return WorkflowStartSpec(
            workflow=DiscoverWorkflow,
            args=(payload,),
            workflow_id=discover_workflow_id(tenant_id),
        )
    _reject_legacy_pipeline_job_urls(params)
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
        tailor_judge_model=str(params["tailorJudgeModel"]) if params.get("tailorJudgeModel") else None,
        tailor_judge_min_score=(
            float(raw_judge_min_score) if raw_judge_min_score is not None else None
        ),
        job_id=(
            apply_selector.job_id
            if apply_selector is not None and apply_selector.job_id is not None
            else _optional_job_id(params, "jobId")
        ),
        job_ids=(
            ()
            if apply_selector is not None and apply_selector.job_id is not None
            else _job_ids(params)
        ),
        # ``coverJobIds`` is an internal key written only by the material
        # cohort freeze above; ignore it on unresolved requests.
        cover_job_ids=(
            _job_ids(params, key="coverJobIds") if material_selection_resolved else ()
        ),
        apply_selector_keys=apply_selector.keys if apply_selector else (),
        material_selection_resolved=material_selection_resolved,
        source_ids=_source_ids(params),
        headless=bool(params.get("headless", False)),
        model=str(params.get("model", "default")),
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        continuous=bool(params.get("continuous", False)),
    )
    workflow_id, id_reuse_policy = _run_stage_workflow_identity(params)
    return WorkflowStartSpec(
        workflow=JobPipelineWorkflow,
        args=(payload,),
        workflow_id=workflow_id,
        id_reuse_policy=id_reuse_policy,
    )


def _scope_global_material_batch(
    params: dict[str, Any],
    *,
    stages: list[str],
    tenant_id: str,
) -> tuple[dict[str, Any], bool]:
    """Freeze a global Tailor/Cover pickup into per-stage workflow cohorts.

    Material activities need an exact cohort so their bounded per-job fan-out,
    cancellation fence, and scaled timeout apply. Leaving ``jobIds`` empty
    selects the legacy global runner, whose blocking work can outlive a Temporal
    timeout and write after a newer owner has taken over.

    Each requested material stage freezes its own backlog when the command
    starts, wherever the material stages sit in the run: the first material
    stage's cohort rides in ``jobIds`` and a Cover stage that follows Tailor
    keeps its independently frozen ``pending_cover`` backlog in
    ``coverJobIds``. Queue growth inside the run flows through stage-output
    unions instead of an unscoped fallback — Score's ``scoredJobIds`` join the
    frozen Tailor cohort and Tailor's ``approvedJobIds`` join the frozen Cover
    cohort. Enrich-led runs are not frozen here because the Enrich stage
    already hands its enriched subset to every later preparation stage.
    """

    if not any(stage in {"tailor", "cover"} for stage in stages):
        return params, False
    if "enrich" in stages:
        return params, False
    if params.get("jobId") or params.get("jobIds"):
        return params, False

    from jobctrl.database import get_connection, get_jobs_by_stage

    conn = get_connection()

    def frozen_cohort(queue_stage: str, *, retailor: bool) -> list[str]:
        jobs = get_jobs_by_stage(
            conn=conn,
            stage=queue_stage,
            min_score=int(params.get("minScore", 7)),
            limit=int(params.get("limit", 0)),
            retailor=retailor,
        )
        return list(
            dict.fromkeys(
                str(canonical_job_id(str(job["job_id"])))
                for job in jobs
                if str(job.get("tenant_id") or tenant_id) == tenant_id
            )
        )

    scoped = dict(params)
    if "tailor" in stages:
        scoped["jobIds"] = frozen_cohort(
            "pending_tailor",
            retailor=bool(params.get("retailor", False)),
        )
        if "cover" in stages:
            scoped["coverJobIds"] = frozen_cohort("pending_cover", retailor=False)
    else:
        scoped["jobIds"] = frozen_cohort("pending_cover", retailor=False)
    return scoped, True


def build_pipeline_workflow_spec(
    params: dict[str, Any],
    *,
    stages: list[str],
    limit: int,
    rescore: bool = False,
    retailor: bool = False,
    job_id: JobId | None = None,
    job_ids: tuple[JobId, ...] = (),
    score_current_policy_only: bool = False,
    tailor_current_policy_only: bool = False,
    material_selection_resolved: bool = False,
    suppress_existing_artifacts: bool = False,
    allow_low_fit_override: bool = False,
) -> WorkflowStartSpec:
    apply_selector = (
        _apply_selector(params, job_id=job_id, job_ids=job_ids)
        if "apply" in stages
        else None
    )
    if "apply" in stages:
        _require_auto_apply_browser_capability()
    _reject_legacy_pipeline_job_urls(params)
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
        tailor_judge_model=str(params["tailorJudgeModel"]) if params.get("tailorJudgeModel") else None,
        tailor_judge_min_score=(
            float(raw_judge_min_score) if raw_judge_min_score is not None else None
        ),
        job_id=apply_selector.job_id if apply_selector is not None else job_id,
        job_ids=() if apply_selector is not None else job_ids,
        apply_selector_keys=apply_selector.keys if apply_selector else (),
        score_current_policy_only=score_current_policy_only,
        tailor_current_policy_only=tailor_current_policy_only,
        material_selection_resolved=material_selection_resolved,
        suppress_existing_artifacts=suppress_existing_artifacts,
        allow_low_fit_override=allow_low_fit_override,
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
    )
    return WorkflowStartSpec(workflow=JobPipelineWorkflow, args=(payload,))


def build_apply_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = _tenant_id(params)
    selector = _apply_selector(params)
    _require_auto_apply_browser_capability()
    payload = ApplyWorkflowInput(
        tenant_id=tenant_id,
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        job_id=selector.job_id,
        dry_run=bool(params.get("dryRun", False)),
        headless=bool(params.get("headless", False)),
        model=str(params.get("model", "default")),
        min_score=int(params.get("minScore", 7)),
        workers=int(params.get("workers", 1)),
        limit=int(params.get("limit", 1)),
        continuous=bool(params.get("continuous", False)),
        approval_required=bool(params.get("applyApprovalRequired", True)),
    )
    workflow_id = (
        apply_workflow_id(tenant_id, str(selector.job_id))
        if selector.job_id is not None
        else None
    )
    return WorkflowStartSpec(workflow=ApplyWorkflow, args=(payload,), workflow_id=workflow_id)


@dataclass(frozen=True)
class _ApplySelector:
    """The only selector shape permitted to start an Apply workflow."""

    keys: tuple[str, ...] = ()
    job_id: JobId | None = None


def _apply_selector(
    params: dict[str, Any],
    *,
    job_id: JobId | None = None,
    job_ids: tuple[JobId, ...] = (),
) -> _ApplySelector:
    """Preserve selector key presence so invalid scopes cannot become batch Apply.

    Batch Apply is intentional only when callers supplied none of the known
    selector keys. A canonical singular ``jobId`` is the sole targeted shape;
    URL selectors and plural ``jobIds`` cannot safely cross the Apply boundary.
    """

    keys = tuple(key for key in _APPLY_SELECTOR_KEYS if key in params)
    if job_id is not None and "jobId" not in keys:
        keys += ("jobId",)
    if job_ids and "jobIds" not in keys:
        keys += ("jobIds",)

    if not keys:
        return _ApplySelector()
    if keys != ("jobId",):
        raise ValueError(
            "apply accepts only a canonical jobId; omit all selector keys for batch apply"
        )

    raw_job_id = job_id if job_id is not None else params["jobId"]
    if not isinstance(raw_job_id, str) or not raw_job_id.strip():
        raise ValueError("apply jobId must be a non-empty canonical UUID")
    selected_job_id = canonical_job_id(raw_job_id)
    if job_id is not None and "jobId" in params:
        supplied_job_id = params["jobId"]
        if not isinstance(supplied_job_id, str) or not supplied_job_id.strip():
            raise ValueError("apply jobId must be a non-empty canonical UUID")
        if canonical_job_id(supplied_job_id) != selected_job_id:
            raise ValueError("conflicting apply jobId selectors")
    return _ApplySelector(keys=keys, job_id=selected_job_id)


def _require_auto_apply_browser_capability() -> None:
    """Guard every non-Temporal apply workflow start request."""

    from jobctrl.browser_capabilities import require_system_browser_capability

    require_system_browser_capability("auto-apply-browser")


def build_interview_prep_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = _tenant_id(params)
    if "jobUrl" in params:
        raise ValueError(
            "interview prep requires jobId; jobUrl is only a locator at the RPC boundary"
        )
    job_id = canonical_job_id(str(_require(params, "jobId")))
    payload = InterviewPrepWorkflowInput(
        tenant_id=tenant_id,
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        job_id=job_id,
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
    )
    return WorkflowStartSpec(
        workflow=InterviewPrepWorkflow,
        args=(payload,),
        workflow_id=interview_prep_workflow_id(tenant_id, str(job_id)),
    )


def build_contact_research_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    """Build the spec for a supervised ``ContactResearchWorkflow`` run.

    The caller (TS API) supplies a fresh ``taskId`` so it can return it and the
    UI can poll the task immediately. At least one of ``employer`` / ``jobId``
    is required (a task must be scoped to a company or an application).
    """
    tenant_id = _tenant_id(params)
    if "jobUrl" in params:
        raise ValueError(
            "contact research requires jobId; jobUrl is only a locator at the RPC boundary"
        )
    task_id = str(_require(params, "taskId"))
    employer = str(params.get("employer") or "").strip() or None
    raw_job_id = params.get("jobId")
    job_id = canonical_job_id(str(raw_job_id)) if raw_job_id not in (None, "") else None
    if not employer and job_id is None:
        raise ValueError("provide at least one of employer or jobId")
    raw_sources = params.get("sources") or []
    if not isinstance(raw_sources, list):
        raise ValueError("sources must be an array")
    sources = tuple(
        ResearchSourceInput(
            category=str(source.get("category") or ""),
            url=str(source.get("url") or ""),
            label=str(source.get("label") or ""),
        )
        for source in raw_sources
        if isinstance(source, dict) and source.get("category")
    )
    payload = ContactResearchWorkflowInput(
        tenant_id=tenant_id,
        task_id=task_id,
        employer=employer,
        job_id=job_id,
        sources=sources,
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
    )
    return WorkflowStartSpec(
        workflow=ContactResearchWorkflow,
        args=(payload,),
        workflow_id=contact_research_workflow_id(tenant_id, task_id),
    )


def build_single_job_workflow_spec(
    job_id: str,
    *,
    do_tailor: bool = True,
    do_apply: bool = True,
    validation_mode: str = "normal",
    model: str = "default",
    headless: bool = False,
    dry_run: bool = False,
    expected_app_dir: str | None = None,
    expected_db_path: str | None = None,
) -> WorkflowStartSpec:
    stages: list[str] = []
    if do_tailor:
        stages.extend(["enrich", "score", "tailor", "cover"])
    if do_apply:
        stages.append("apply")
    if not stages:
        stages = ["enrich"]
    return build_run_stage_workflow_spec(
        {
            "tenantId": LOCAL_TENANT,
            "expectedAppDir": expected_app_dir,
            "expectedDbPath": expected_db_path,
            "stages": stages,
            "jobId": job_id,
            "validationMode": validation_mode,
            "model": model,
            "headless": headless,
            "dryRun": dry_run,
            "limit": 1,
        }
    )


def build_compensation_refresh_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    from jobctrl.infrastructure.compensation.workflow import (
        CompensationRefreshWorkflow,
        CompensationRefreshWorkflowInput,
    )

    tenant_id = _tenant_id(params)
    job_id_param = params.get("jobId")
    all_jobs = params.get("allJobs") is True
    if job_id_param and all_jobs:
        raise ValueError("provide exactly one of jobId or allJobs")
    if not job_id_param and not all_jobs:
        raise ValueError("provide exactly one of jobId or allJobs")
    payload = CompensationRefreshWorkflowInput(
        tenant_id=tenant_id,
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        job_id=canonical_job_id(str(job_id_param)) if job_id_param else None,
        limit=int(params.get("limit") or 0),
        include_euro_top_tech=(
            bool(params["includeEuroTopTech"]) if params.get("includeEuroTopTech") is not None else True
        ),
        observations_json_path=(str(params["observationsJsonPath"]) if params.get("observationsJsonPath") else None),
        euro_top_tech_max_pages=int(params.get("euroTopTechMaxPages") or 10),
    )
    return WorkflowStartSpec(workflow=CompensationRefreshWorkflow, args=(payload,))


def build_profile_import_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    from jobctrl.profile.workflow import ProfileImportWorkflow, ProfileImportWorkflowInput

    payload = ProfileImportWorkflowInput(
        tenant_id=_tenant_id(params),
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        pdf_path=str(_require(params, "pdfPath")),
        import_profile=bool(params.get("importProfile", True)),
        import_style=bool(params.get("importStyle", True)),
    )
    return WorkflowStartSpec(workflow=ProfileImportWorkflow, args=(payload,))


def build_manual_capture_import_workflow_spec(
    params: dict[str, Any],
) -> WorkflowStartSpec:
    from jobctrl.discovery.manual_capture_workflow import (
        ManualCaptureImportWorkflow,
        ManualCaptureImportWorkflowInput,
        manual_capture_import_workflow_id,
    )

    tenant_id = _tenant_id(params)
    item_id = _required_string(params, "itemId")
    capture_mode = _required_string(params, "captureMode")
    try:
        ManualCaptureMode(capture_mode)
    except ValueError as exc:
        raise ValueError(f"unsupported manual capture mode: {capture_mode}") from exc
    content_text = _optional_string(params, "contentText", allow_empty=True)
    content_html_base64 = _optional_string(
        params,
        "contentHtmlBase64",
        allow_empty=True,
    )
    captured_url = _optional_string(params, "capturedUrl")
    if content_text is None and content_html_base64 is None and captured_url is None:
        raise ValueError("one of contentText, contentHtmlBase64, or capturedUrl is required")
    future_manual_action_required = params.get("futureManualActionRequired", False)
    if not isinstance(future_manual_action_required, bool):
        raise ValueError("futureManualActionRequired must be a boolean")
    payload = ManualCaptureImportWorkflowInput(
        tenant_id=tenant_id,
        item_id=item_id,
        capture_mode=capture_mode,
        expected_app_dir=_optional_string(params, "expectedAppDir"),
        expected_db_path=_optional_string(params, "expectedDbPath"),
        content_text=content_text,
        content_html_base64=content_html_base64,
        captured_url=captured_url,
        note=_optional_string(params, "note", allow_empty=True),
        future_manual_action_required=future_manual_action_required,
    )
    return WorkflowStartSpec(
        workflow=ManualCaptureImportWorkflow,
        args=(payload,),
        workflow_id=manual_capture_import_workflow_id(tenant_id, item_id),
    )


def apply_workflow_id(tenant_id: str, job_id: str) -> str:
    return f"apply-{tenant_id}-{canonical_job_id(job_id)}"


def interview_prep_workflow_id(tenant_id: str, job_id: str) -> str:
    return f"interview-prep-{tenant_id}-{canonical_job_id(job_id)}"


async def start_workflow_spec_and_wait(spec: WorkflowStartSpec) -> StartedWorkflowResult:
    from jobctrl.infrastructure.rpc.workflow_starter import default_workflow_starter

    handle = await default_workflow_starter(spec)
    workflow_id = spec.workflow_id or getattr(handle, "id", None) or getattr(handle, "workflow_id", "")
    if not workflow_id:
        workflow_id = getattr(handle, "run_id", "")
    result = await handle.result()
    run_id = str(getattr(handle, "run_id", None) or workflow_id)
    return StartedWorkflowResult(
        run_id=run_id,
        workflow_id=str(workflow_id or run_id),
        first_execution_run_id=(
            getattr(handle, "first_execution_run_id", None)
            or getattr(handle, "result_run_id", None)
            or getattr(handle, "run_id", None)
        ),
        result=result,
    )


def start_workflow_spec_and_wait_sync(spec: WorkflowStartSpec) -> StartedWorkflowResult:
    return asyncio.run(start_workflow_spec_and_wait(spec))


def workflow_result_to_dict(result: Any) -> Any:
    if is_dataclass(result):
        return asdict(result)
    if hasattr(result, "to_dict") and callable(result.to_dict):
        return result.to_dict()
    if isinstance(result, dict):
        return dict(result)
    return result


def _tenant_id(params: dict[str, Any]) -> str:
    raw = params.get("tenantId")
    if not raw:
        logger.warning("JSON-RPC call missing 'tenantId' — defaulting to LOCAL_TENANT")
        return LOCAL_TENANT
    return str(raw)


def _require(params: dict[str, Any], name: str) -> Any:
    if name not in params or params[name] in (None, ""):
        raise ValueError(f"missing required param: {name}")
    return params[name]


def _stage_list(params: dict[str, Any]) -> list[str]:
    raw_stages = params.get("stages")
    if isinstance(raw_stages, list) and raw_stages:
        requested = [str(stage) for stage in raw_stages]
    elif params.get("stage"):
        requested = [str(params["stage"])]
    else:
        requested = list(PRIMARY_STAGE_ORDER)
    invalid = [stage for stage in requested if stage != "all" and stage not in WORKFLOW_STAGES]
    if invalid:
        raise ValueError(f"unsupported pipeline stage for workflow: {', '.join(invalid)}")
    if "all" in requested:
        return list(PRIMARY_STAGE_ORDER)
    unique = list(dict.fromkeys(requested))
    return [stage for stage in _WORKFLOW_STAGE_ORDER if stage in unique]


def _job_ids(params: dict[str, Any], key: str = "jobIds") -> tuple[JobId, ...]:
    raw = params.get(key) or ()
    if not raw:
        return ()
    if not isinstance(raw, list):
        raise ValueError(f"{key} must be an array")
    return tuple(dict.fromkeys(canonical_job_id(str(item)) for item in raw))


def _optional_job_id(params: dict[str, Any], name: str) -> JobId | None:
    value = params.get(name)
    if value is None or value == "":
        return None
    return canonical_job_id(str(value))


def _reject_legacy_pipeline_job_urls(params: dict[str, Any]) -> None:
    if "jobUrl" in params or "jobUrls" in params:
        raise ValueError("pipeline job selection requires jobId or jobIds")


def _source_ids(params: dict[str, Any]) -> tuple[str, ...]:
    raw = params.get("sourceIds") or params.get("source_ids") or ()
    if not raw:
        return ()
    if not isinstance(raw, list):
        raise ValueError("sourceIds must be an array")
    return tuple(dict.fromkeys(str(item).strip() for item in raw if str(item).strip()))


def _run_stage_workflow_identity(
    params: dict[str, Any],
) -> tuple[str | None, WorkflowIDReusePolicy | None]:
    reason = str(params.get("reason") or "").strip()
    if reason.startswith("condition_resolved:"):
        prefix = "condition-recovery"
        reuse_policy = WorkflowIDReusePolicy.ALLOW_DUPLICATE
    elif reason.startswith("profile_updated:"):
        prefix = "profile-continuation"
        reuse_policy = WorkflowIDReusePolicy.REJECT_DUPLICATE
    else:
        return None, None
    digest = hashlib.sha256(reason.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}-{digest}", reuse_policy


def _optional_string(
    params: dict[str, Any],
    name: str,
    *,
    allow_empty: bool = False,
) -> str | None:
    value = params.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string")
    if not allow_empty and not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _required_string(params: dict[str, Any], name: str) -> str:
    value = _require(params, name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value.strip()
