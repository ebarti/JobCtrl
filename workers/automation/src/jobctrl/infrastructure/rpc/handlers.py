"""Default JSON-RPC handler registry.

The method set covers:

* Workflow starters — ``run_stage``, ``apply``, ``profile_import``,
  ``manual_capture_import``,
  ``refresh_compensation``, and current-policy maintenance methods return
  :class:`WorkflowStartSpec` values. The server starts them on the Temporal task
  queue and ships back
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

from jobctrl.database import get_connection
from jobctrl.domain.rpc.messages import WorkflowStartSpec
from jobctrl.domain.preparation import PreparationWorkItemKind
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.rpc.server import JsonRpcServer, invalid_params
from jobctrl.infrastructure.rpc.workflow_starter import WorkflowCanceler
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctrl.pipeline.preparation import (
    build_preparation_workflow_spec,
    current_scoring_policy_version,
    current_tailoring_policy_version,
    latest_source_event_id,
)
from jobctrl.workflow_specs import (
    apply_workflow_id,
    build_apply_workflow_spec,
    build_compensation_refresh_workflow_spec,
    build_contact_research_workflow_spec,
    build_interview_prep_workflow_spec,
    build_manual_capture_import_workflow_spec,
    build_pipeline_workflow_spec,
    build_profile_import_workflow_spec,
    build_run_stage_workflow_spec,
)

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


def _source_ids(params: dict[str, Any]) -> tuple[str, ...]:
    raw = params.get("sourceIds") or params.get("source_ids") or ()
    if not raw:
        return ()
    if not isinstance(raw, list):
        raise invalid_params("sourceIds must be an array")
    return tuple(dict.fromkeys(str(item).strip() for item in raw if str(item).strip()))


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
    try:
        return build_run_stage_workflow_spec(params)
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def rescore_job(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = TenantId(_tenant_id(params))
    job_url = str(_require(params, "jobUrl"))
    conn = get_connection()
    return build_preparation_workflow_spec(
        tenant_id=tenant_id,
        job_url=job_url,
        steps=["score"],
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=current_scoring_policy_version(conn, tenant_id),
        source_event_id=latest_source_event_id(conn, job_url),
        rescore=True,
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
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
    tenant_id = TenantId(_tenant_id(params))
    job_url = str(_require(params, "jobUrl"))
    conn = get_connection()
    raw_judge_min_score = params.get("tailorJudgeMinScore")
    return build_preparation_workflow_spec(
        tenant_id=tenant_id,
        job_url=job_url,
        steps=["tailor", "cover", "pdf"],
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=current_tailoring_policy_version(conn, tenant_id),
        source_event_id=latest_source_event_id(conn, job_url),
        min_score=int(params.get("minScore", 7)),
        workers=int(params.get("workers", 1)),
        validation_mode=str(params.get("validationMode", "normal")),
        retailor=True,
        suppress_existing_artifacts=_bool_param(
            params, "suppressExistingArtifacts", default=False
        ),
        tailor_models=tuple(str(item) for item in (params.get("tailorModels") or ())),
        tailor_judge_model=(
            str(params["tailorJudgeModel"])
            if params.get("tailorJudgeModel")
            else None
        ),
        tailor_judge_min_score=(
            float(raw_judge_min_score) if raw_judge_min_score is not None else None
        ),
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
    )


def tailor_job(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = TenantId(_tenant_id(params))
    job_url = str(_require(params, "jobUrl"))
    conn = get_connection()
    raw_judge_min_score = params.get("tailorJudgeMinScore")
    return build_preparation_workflow_spec(
        tenant_id=tenant_id,
        job_url=job_url,
        steps=["tailor", "cover", "pdf"],
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=current_tailoring_policy_version(conn, tenant_id),
        source_event_id=latest_source_event_id(conn, job_url),
        min_score=int(params.get("minScore", 7)),
        workers=int(params.get("workers", 1)),
        validation_mode=str(params.get("validationMode", "normal")),
        retailor=False,
        allow_low_fit_override=_bool_param(
            params, "allowLowFitOverride", default=True
        ),
        tailor_models=tuple(str(item) for item in (params.get("tailorModels") or ())),
        tailor_judge_model=(
            str(params["tailorJudgeModel"])
            if params.get("tailorJudgeModel")
            else None
        ),
        tailor_judge_min_score=(
            float(raw_judge_min_score) if raw_judge_min_score is not None else None
        ),
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
    )


def analyze_job(params: dict[str, Any]) -> dict[str, Any]:
    """Produce/inspect the canonical employer analysis for one job (D-10).

    Synchronous: runs the 3-SDK ensemble to completion (NO wall-clock timeout —
    D-19) and persists the canonical analysis, superseding prior generations
    (D-13). ``force`` bypasses the snapshot+version cache to recompute. Returns
    the persisted record's identity + the degraded-ensemble signal so a caller
    can see a degraded run immediately (D-08).
    """
    tenant_id = _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    force = _bool_param(params, "force", default=False)

    from jobctrl.database import get_connection, load_job_with_enrichment
    from jobctrl.domain.tenant import TenantId
    from jobctrl.scoring.tailor import _build_analyze_use_case

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


def provider_status(params: dict[str, Any]) -> dict[str, Any]:
    """Return secret-free readiness for the guided provider settings surface."""

    from jobctrl.infrastructure.setup_probes import provider_status_snapshot

    requested = params.get("provider")
    providers = ("codex", "claude", "google")
    if requested is not None:
        requested = str(requested).strip().lower()
        if requested not in providers:
            raise invalid_params("provider must be codex, claude, or google")
        providers = (requested,)
    return {"providers": [provider_status_snapshot(provider) for provider in providers]}


def provider_models(params: dict[str, Any]) -> dict[str, Any]:
    """Return sanitized ready-provider model catalogs in stable API order."""

    if params:
        raise invalid_params("provider_models does not accept parameters")
    from jobctrl.infrastructure.llm.model_catalog import provider_model_catalog

    return provider_model_catalog()


def provider_verify(params: dict[str, Any]) -> dict[str, Any]:
    """Verify persisted Codex CLI auth without making a model-generation call."""

    provider = str(_require(params, "provider")).strip().lower()
    if provider != "codex":
        raise invalid_params("provider_verify currently supports only codex")
    from jobctrl.infrastructure.setup_probes import verify_codex_connection

    ok, status, message = verify_codex_connection()
    return {
        "provider": "codex",
        "ok": ok,
        "status": status,
        "message": message,
    }


def refresh_compensation(params: dict[str, Any]) -> WorkflowStartSpec:
    """Build a workflow spec for compensation refresh."""
    try:
        return build_compensation_refresh_workflow_spec(params)
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def retailor_current_policy(params: dict[str, Any]) -> WorkflowStartSpec:
    return _pipeline_workflow_spec(
        params,
        stages=["tailor", "cover"],
        limit=int(params.get("limit", 100)),
        retailor=True,
        job_urls=_job_urls(params),
        tailor_current_policy_only=True,
        suppress_existing_artifacts=_bool_param(
            params, "suppressExistingArtifacts", default=False
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
    return build_pipeline_workflow_spec(
        params,
        stages=stages,
        limit=limit,
        rescore=rescore,
        retailor=retailor,
        job_url=job_url,
        job_urls=job_urls,
        score_current_policy_only=score_current_policy_only,
        tailor_current_policy_only=tailor_current_policy_only,
        suppress_existing_artifacts=suppress_existing_artifacts,
        allow_low_fit_override=allow_low_fit_override,
    )


def profile_import(params: dict[str, Any]) -> WorkflowStartSpec:
    try:
        return build_profile_import_workflow_spec(params)
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def manual_capture_import(params: dict[str, Any]) -> WorkflowStartSpec:
    try:
        return build_manual_capture_import_workflow_spec(params)
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


# ---------------------------------------------------------------------------
# Workflow handlers
# ---------------------------------------------------------------------------


def _apply_workflow_id(tenant_id: str, job_key: str) -> str:
    """Deterministic ``apply-{tenant}-{jobKey}`` id so a double-click apply for one job
    attaches to the running workflow (USE_EXISTING) instead of double-submitting.
    """
    return apply_workflow_id(tenant_id, job_key)


def apply_action(params: dict[str, Any]) -> WorkflowStartSpec:
    """Build a :class:`WorkflowStartSpec` for :class:`ApplyWorkflow`."""
    return build_apply_workflow_spec(params)


def generate_interview_prep(params: dict[str, Any]) -> WorkflowStartSpec:
    """Build a workflow spec for user-triggered stored interview prep."""
    try:
        return build_interview_prep_workflow_spec(params)
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def run_contact_research(params: dict[str, Any]) -> WorkflowStartSpec:
    """Build a workflow spec for a supervised contact-research run (Contact & Outreach).

    Research + LLM extraction run on the Python worker via Temporal (plan §4.5);
    fetching routes only through the merged politeness gateway against the
    conservative opt-in allowlist (INV-3). Candidates land ``needs_review`` and
    require an explicit user confirmation before becoming stored facts (INV-4).
    """
    try:
        return build_contact_research_workflow_spec(params)
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def generate_outreach_draft(params: dict[str, Any]) -> dict[str, Any]:
    """Generate or revise a truthful outreach draft (Contact & Outreach, Phase 3).

    Synchronous (like ``analyze_job``): the LLM synthesis + the full truthfulness
    gate stack (deterministic never-fabricate detector, content validator, judge,
    claim -> fact provenance) run inline on the worker and the gated draft is
    persisted as a new generation, superseding prior *candidate* drafts while the
    last approved draft stays readable (INV-5). There is NO send path (INV-1).

    ``editedBodyText`` selects the revise path: the user's edited body becomes a
    new generation and RE-RUNS the identical gates. Approval/rejection are separate
    transitions hosted in the TS API and gated on the persisted gate outcome.
    """
    import uuid

    from jobctrl.database import get_connection, load_job_with_enrichment
    from jobctrl.domain.contact.outreach import OutreachDraftKind
    from jobctrl.domain.contact.outreach_use_cases import (
        GenerateOutreachDraftUseCase,
        OutreachDraftInputError,
        ReviseOutreachDraftUseCase,
    )
    from jobctrl.infrastructure.contact import (
        SqliteContactRepository,
        SqliteOutreachThreadRepository,
    )
    from jobctrl.infrastructure.events import get_default_publisher
    from jobctrl.infrastructure.llm.llm_client import get_llm_adapter
    from jobctrl.infrastructure.profile.factory import get_profile_repository

    tenant = TenantId(_tenant_id(params))
    thread_id = str(_require(params, "threadId"))
    edited_body = str(params.get("editedBodyText") or "").strip()
    application_role = str(params.get("applicationRole") or "").strip()
    model = params.get("llmModel") or None
    try:
        kind = OutreachDraftKind(str(params.get("kind") or "intro_request"))
    except ValueError:
        kind = OutreachDraftKind.INTRO_REQUEST

    conn = get_connection()
    try:
        profile = get_profile_repository().load_snapshot(tenant).as_dict()
    except FileNotFoundError as exc:
        raise invalid_params(str(exc)) from exc

    publisher = get_default_publisher()
    contact_repo = SqliteContactRepository(conn, publisher=publisher)
    thread_repo = SqliteOutreachThreadRepository(conn, publisher=publisher)
    llm = get_llm_adapter()
    new_id = lambda: uuid.uuid4().hex  # noqa: E731 — trivial id seam

    try:
        if edited_body:
            thread = ReviseOutreachDraftUseCase(
                repository=thread_repo,
                contact_repository=contact_repo,
                llm=llm,
                new_id=new_id,
            ).execute(
                tenant,
                thread_id=thread_id,
                edited_body_text=edited_body,
                profile=profile,
                application_role=application_role,
                kind=kind,
                model=model,
            )
        else:
            contact_id = str(_require(params, "contactId"))
            job_id = params.get("jobId") or None
            if not application_role and job_id:
                job = load_job_with_enrichment(conn, str(job_id))
                if job is not None:
                    application_role = str(job.get("title") or "")
            thread = GenerateOutreachDraftUseCase(
                repository=thread_repo,
                contact_repository=contact_repo,
                llm=llm,
                new_id=new_id,
            ).execute(
                tenant,
                thread_id=thread_id,
                contact_id=contact_id,
                job_id=job_id,
                kind=kind,
                profile=profile,
                application_role=application_role,
                model=model,
            )
    except OutreachDraftInputError as exc:
        raise invalid_params(str(exc)) from exc

    draft = thread.latest_draft
    if draft is None:  # pragma: no cover — a save always yields a draft
        raise invalid_params("draft generation produced no draft")
    return {
        "threadId": thread.thread_id,
        "contactId": thread.contact_id,
        "jobId": thread.job_id,
        "draftId": draft.draft_id,
        "generation": draft.generation,
        "kind": draft.kind.value,
        "status": draft.status.value,
        "gatePassed": draft.gate_results.passed,
    }


def make_cancel_run(canceler: WorkflowCanceler):
    """Build a ``cancel_run`` handler bound to *canceler*.

    Cooperative cancellation path — signals the workflow runtime to cancel
    the in-flight run. (The post-hoc state-flip cancel that marks a stage
    ``canceled`` without touching the runtime lives in the TS write-model's
    ``cancelJobAction``, not on this JSON-RPC surface.)
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
    """Wire the default JobCtrl method set onto *server*."""
    server.register("profile_import", profile_import, mode="workflow")
    server.register("manual_capture_import", manual_capture_import, mode="workflow")
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
    server.register("provider_status", provider_status, mode="sync")
    server.register("provider_models", provider_models, mode="sync")
    server.register("provider_verify", provider_verify, mode="sync")
    server.register("refresh_compensation", refresh_compensation, mode="workflow")
    server.register("generate_interview_prep", generate_interview_prep, mode="workflow")
    server.register("run_contact_research", run_contact_research, mode="workflow")
    # Outreach draft generation/revision — synchronous (LLM + gate stack inline,
    # like analyze_job); persists a gated draft. No send path (INV-1).
    server.register("generate_outreach_draft", generate_outreach_draft, mode="sync")
    server.register("apply", apply_action, mode="workflow")
    # Cooperative cancellation of in-flight workflows.
    server.register("cancel_run", make_cancel_run(canceler), mode="sync")
