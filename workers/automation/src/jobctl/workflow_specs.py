"""Shared Temporal workflow spec builders and start/wait helpers."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any

from jobctl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobctl.contact.activities import ResearchSourceInput
from jobctl.contact.workflow import (
    ContactResearchWorkflow,
    ContactResearchWorkflowInput,
    contact_research_workflow_id,
)
from jobctl.discovery.workflow import (
    DiscoverWorkflow,
    DiscoverWorkflowInput,
    discover_workflow_id,
)
from jobctl.domain.rpc.messages import WorkflowStartSpec
from jobctl.domain.tenant import LOCAL_TENANT
from jobctl.interview.workflow import InterviewPrepWorkflow, InterviewPrepWorkflowInput
from jobctl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctl.pipeline.runner import PRIMARY_STAGE_ORDER
from jobctl.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput

WORKFLOW_STAGES = {"discover", "enrich", "score", "tailor", "cover", "apply"}
_WORKFLOW_STAGE_ORDER = ("discover", "enrich", "score", "tailor", "cover", "apply")
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
            tailor_judge_min_score=(
                float(raw_judge_min_score) if raw_judge_min_score is not None else None
            ),
            source_ids=_source_ids(params),
            llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        )
        return WorkflowStartSpec(
            workflow=DiscoverWorkflow,
            args=(payload,),
            workflow_id=discover_workflow_id(tenant_id),
        )
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
        job_url=params.get("jobUrl") if params.get("jobUrl") else None,
        job_urls=_job_urls(params),
        source_ids=_source_ids(params),
        headless=bool(params.get("headless", False)),
        model=str(params.get("model", "default")),
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        continuous=bool(params.get("continuous", False)),
    )
    return WorkflowStartSpec(workflow=JobPipelineWorkflow, args=(payload,))


def build_pipeline_workflow_spec(
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
        tailor_judge_model=str(params["tailorJudgeModel"]) if params.get("tailorJudgeModel") else None,
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


def build_apply_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = _tenant_id(params)
    job_url = params.get("jobUrl")
    payload = ApplyWorkflowInput(
        tenant_id=tenant_id,
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        job_url=job_url,
        dry_run=bool(params.get("dryRun", False)),
        headless=bool(params.get("headless", False)),
        model=str(params.get("model", "default")),
        min_score=int(params.get("minScore", 7)),
        workers=int(params.get("workers", 1)),
        limit=int(params.get("limit", 1)),
        continuous=bool(params.get("continuous", False)),
        approval_required=bool(params.get("applyApprovalRequired", True)),
    )
    workflow_id = apply_workflow_id(tenant_id, str(job_url)) if job_url else None
    return WorkflowStartSpec(workflow=ApplyWorkflow, args=(payload,), workflow_id=workflow_id)


def build_interview_prep_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    payload = InterviewPrepWorkflowInput(
        tenant_id=tenant_id,
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        job_url=job_url,
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
    )
    return WorkflowStartSpec(
        workflow=InterviewPrepWorkflow,
        args=(payload,),
        workflow_id=interview_prep_workflow_id(tenant_id, job_url),
    )


def build_contact_research_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    """Build the spec for a supervised ``ContactResearchWorkflow`` run.

    The caller (TS API) supplies a fresh ``taskId`` so it can return it and the
    UI can poll the task immediately. At least one of ``employer`` / ``jobUrl``
    is required (a task must be scoped to a company or an application).
    """
    tenant_id = _tenant_id(params)
    task_id = str(_require(params, "taskId"))
    employer = str(params.get("employer") or "").strip() or None
    job_url = str(params.get("jobUrl") or "").strip() or None
    if not employer and not job_url:
        raise ValueError("provide at least one of employer or jobUrl")
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
        job_url=job_url,
        sources=sources,
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
    )
    return WorkflowStartSpec(
        workflow=ContactResearchWorkflow,
        args=(payload,),
        workflow_id=contact_research_workflow_id(task_id),
    )


def build_single_job_workflow_spec(
    url: str,
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
            "jobUrl": url,
            "validationMode": validation_mode,
            "model": model,
            "headless": headless,
            "dryRun": dry_run,
            "limit": 1,
        }
    )


def build_compensation_refresh_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    from jobctl.infrastructure.compensation.workflow import (
        CompensationRefreshWorkflow,
        CompensationRefreshWorkflowInput,
    )

    tenant_id = _tenant_id(params)
    job_url_param = params.get("jobUrl")
    all_jobs = params.get("allJobs") is True
    if job_url_param and all_jobs:
        raise ValueError("provide exactly one of jobUrl or allJobs")
    if not job_url_param and not all_jobs:
        raise ValueError("provide exactly one of jobUrl or allJobs")
    payload = CompensationRefreshWorkflowInput(
        tenant_id=tenant_id,
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        job_url=str(job_url_param) if job_url_param else None,
        limit=int(params.get("limit") or 0),
        include_euro_top_tech=(
            bool(params["includeEuroTopTech"])
            if params.get("includeEuroTopTech") is not None
            else True
        ),
        observations_json_path=(
            str(params["observationsJsonPath"])
            if params.get("observationsJsonPath")
            else None
        ),
        euro_top_tech_max_pages=int(params.get("euroTopTechMaxPages") or 10),
    )
    return WorkflowStartSpec(workflow=CompensationRefreshWorkflow, args=(payload,))


def build_profile_import_workflow_spec(params: dict[str, Any]) -> WorkflowStartSpec:
    from jobctl.profile.workflow import ProfileImportWorkflow, ProfileImportWorkflowInput

    payload = ProfileImportWorkflowInput(
        tenant_id=_tenant_id(params),
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
        pdf_path=str(_require(params, "pdfPath")),
        import_profile=bool(params.get("importProfile", True)),
        import_style=bool(params.get("importStyle", True)),
    )
    return WorkflowStartSpec(workflow=ProfileImportWorkflow, args=(payload,))


def apply_workflow_id(tenant_id: str, job_key: str) -> str:
    return f"apply-{tenant_id}-{job_key}"


def interview_prep_workflow_id(tenant_id: str, job_key: str) -> str:
    return f"interview-prep-{tenant_id}-{job_key}"


async def start_workflow_spec_and_wait(spec: WorkflowStartSpec) -> StartedWorkflowResult:
    from jobctl.infrastructure.rpc.workflow_starter import default_workflow_starter

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


def _job_urls(params: dict[str, Any]) -> tuple[str, ...]:
    raw = params.get("jobUrls") or ()
    if not raw:
        return ()
    if not isinstance(raw, list):
        raise ValueError("jobUrls must be an array")
    return tuple(str(item).strip() for item in raw if str(item).strip())


def _source_ids(params: dict[str, Any]) -> tuple[str, ...]:
    raw = params.get("sourceIds") or params.get("source_ids") or ()
    if not raw:
        return ()
    if not isinstance(raw, list):
        raise ValueError("sourceIds must be an array")
    return tuple(dict.fromkeys(str(item).strip() for item in raw if str(item).strip()))
