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
from datetime import UTC, datetime
import logging
from pathlib import Path
from typing import Any

from jobctrl.database import get_connection
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.rpc.messages import WorkflowStartSpec
from jobctrl.domain.preparation import PreparationWorkItemKind
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader
from jobctrl.infrastructure.learning.sqlite_repository import (
    SqliteLearningRecommendationRepository,
)
from jobctrl.infrastructure.materials import (
    LearningRecommendationReviewError,
    SqliteLearningRecommendationReviewRepository,
    SqliteTailoringPolicyRepository,
    TailoringPolicyRevisionError,
)
from jobctrl.infrastructure.rpc.server import JsonRpcServer, invalid_params
from jobctrl.infrastructure.rpc.workflow_starter import WorkflowCanceler
from jobctrl.infrastructure.runtime_identity import assert_expected_runtime
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
    build_job_url_import_workflow_spec,
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


def _reject_job_url_params(params: dict[str, Any]) -> None:
    if "jobUrl" in params:
        raise invalid_params("jobUrl is not supported; use canonical jobId")
    if "jobUrls" in params:
        raise invalid_params("jobUrls is not supported; use canonical jobIds")


def _job_ids(params: dict[str, Any]) -> tuple[JobId, ...]:
    _reject_job_url_params(params)
    if "jobId" in params:
        raise invalid_params("jobId is not supported on a bulk selector; use jobIds")
    raw = params.get("jobIds", ())
    if not isinstance(raw, list):
        raise invalid_params("jobIds must be an array")
    if not raw:
        return ()
    try:
        return tuple(
            dict.fromkeys(
                canonical_job_id(str(item))
                for item in raw
            )
        )
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def _source_ids(params: dict[str, Any]) -> tuple[str, ...]:
    raw = params.get("sourceIds") or params.get("source_ids") or ()
    if not raw:
        return ()
    if not isinstance(raw, list):
        raise invalid_params("sourceIds must be an array")
    return tuple(dict.fromkeys(str(item).strip() for item in raw if str(item).strip()))


def _load_current_job_by_id(
    conn: Any,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> dict[str, Any]:
    """Load a non-deleted canonical target without accepting a URL locator."""
    job = SqlitePreparationTargetReader(conn).load(tenant_id, job_id)
    if job is None:
        raise invalid_params(f"unknown or inactive jobId: {job_id}")
    return job


def _required_job_id(params: dict[str, Any]) -> JobId:
    _reject_job_url_params(params)
    if "jobIds" in params:
        raise invalid_params("jobIds is not supported on a single-job command; use jobId")
    try:
        return canonical_job_id(str(_require(params, "jobId")))
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def _job_id(job: dict[str, Any]) -> JobId:
    return canonical_job_id(str(job["job_id"]))


def _current_job_url(job: dict[str, Any]) -> str:
    job_url = str(job.get("url") or "").strip()
    if not job_url:
        raise invalid_params(f"jobId {job.get('job_id')} has no current posting URL")
    return job_url


def _selected_job_ids(params: dict[str, Any]) -> tuple[JobId | None, tuple[JobId, ...]]:
    _reject_job_url_params(params)
    if "jobId" in params and "jobIds" in params:
        raise invalid_params("provide jobId or jobIds, not both")
    if "jobId" in params:
        try:
            return canonical_job_id(str(_require(params, "jobId"))), ()
        except ValueError as exc:
            raise invalid_params(str(exc)) from exc
    if "jobIds" not in params:
        return None, ()
    raw_many = params["jobIds"]
    if not isinstance(raw_many, list):
        raise invalid_params("jobIds must be an array")
    if not raw_many:
        return None, ()
    try:
        return None, tuple(
            dict.fromkeys(
                canonical_job_id(str(item))
                for item in raw_many
            )
        )
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def _load_current_job_urls_by_id(
    conn: Any,
    *,
    tenant_id: TenantId,
    job_ids: tuple[JobId, ...],
) -> tuple[str, ...]:
    return tuple(
        _current_job_url(
            _load_current_job_by_id(conn, tenant_id=tenant_id, job_id=job_id)
        )
        for job_id in job_ids
    )


def _legacy_workflow_locator_params(params: dict[str, Any]) -> dict[str, Any]:
    """Adapt canonical RPC IDs to the pre-#623/#628 workflow input contract.

    The current URL is loaded by tenant-scoped ``JobId`` here; no caller URL
    crosses JSON-RPC. The mapped runtime PRs remove this adapter after rebase.
    """

    tenant_id = TenantId(_tenant_id(params))
    job_id, job_ids = _selected_job_ids(params)
    adapted = {
        key: value
        for key, value in params.items()
        if key not in {"jobId", "jobIds"}
    }
    if job_id is None and not job_ids:
        return adapted
    conn = get_connection()
    if job_id is not None:
        job = _load_current_job_by_id(conn, tenant_id=tenant_id, job_id=job_id)
        adapted["jobUrl"] = _current_job_url(job)
    else:
        adapted["jobUrls"] = list(
            _load_current_job_urls_by_id(
                conn,
                tenant_id=tenant_id,
                job_ids=job_ids,
            )
        )
    return adapted


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
        _reject_job_url_params(params)
        return build_run_stage_workflow_spec(params)
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def rescore_job(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = TenantId(_tenant_id(params))
    requested_job_id = _required_job_id(params)
    conn = get_connection()
    job_id = _job_id(
        _load_current_job_by_id(
            conn,
            tenant_id=tenant_id,
            job_id=requested_job_id,
        )
    )
    return build_preparation_workflow_spec(
        tenant_id=tenant_id,
        job_id=job_id,
        steps=["score"],
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=current_scoring_policy_version(conn, tenant_id),
        source_event_id=latest_source_event_id(
            conn,
            tenant_id=tenant_id,
            job_id=job_id,
        ),
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
        job_ids=_job_ids(params),
        score_current_policy_only=True,
    )


def retailor_job(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = TenantId(_tenant_id(params))
    requested_job_id = _required_job_id(params)
    conn = get_connection()
    job_id = _job_id(
        _load_current_job_by_id(
            conn,
            tenant_id=tenant_id,
            job_id=requested_job_id,
        )
    )
    raw_judge_min_score = params.get("tailorJudgeMinScore")
    return build_preparation_workflow_spec(
        tenant_id=tenant_id,
        job_id=job_id,
        steps=["tailor", "cover", "pdf"],
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=current_tailoring_policy_version(conn, tenant_id),
        source_event_id=latest_source_event_id(
            conn,
            tenant_id=tenant_id,
            job_id=job_id,
        ),
        min_score=int(params.get("minScore", 7)),
        workers=int(params.get("workers", 1)),
        validation_mode=str(params.get("validationMode", "normal")),
        retailor=True,
        suppress_existing_artifacts=_bool_param(params, "suppressExistingArtifacts", default=False),
        tailor_models=tuple(str(item) for item in (params.get("tailorModels") or ())),
        tailor_judge_model=(str(params["tailorJudgeModel"]) if params.get("tailorJudgeModel") else None),
        tailor_judge_min_score=(float(raw_judge_min_score) if raw_judge_min_score is not None else None),
        llm_model=str(params.get("llmModel") or DEFAULT_PIPELINE_LLM_MODEL_SPEC),
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
    )


def tailor_job(params: dict[str, Any]) -> WorkflowStartSpec:
    tenant_id = TenantId(_tenant_id(params))
    requested_job_id = _required_job_id(params)
    conn = get_connection()
    job_id = _job_id(
        _load_current_job_by_id(
            conn,
            tenant_id=tenant_id,
            job_id=requested_job_id,
        )
    )
    raw_judge_min_score = params.get("tailorJudgeMinScore")
    return build_preparation_workflow_spec(
        tenant_id=tenant_id,
        job_id=job_id,
        steps=["tailor", "cover", "pdf"],
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=current_tailoring_policy_version(conn, tenant_id),
        source_event_id=latest_source_event_id(
            conn,
            tenant_id=tenant_id,
            job_id=job_id,
        ),
        min_score=int(params.get("minScore", 7)),
        workers=int(params.get("workers", 1)),
        validation_mode=str(params.get("validationMode", "normal")),
        retailor=False,
        allow_low_fit_override=_bool_param(params, "allowLowFitOverride", default=True),
        tailor_models=tuple(str(item) for item in (params.get("tailorModels") or ())),
        tailor_judge_model=(str(params["tailorJudgeModel"]) if params.get("tailorJudgeModel") else None),
        tailor_judge_min_score=(float(raw_judge_min_score) if raw_judge_min_score is not None else None),
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
    tenant_id = TenantId(_tenant_id(params))
    job_id = _required_job_id(params)
    force = _bool_param(params, "force", default=False)

    from jobctrl.scoring.tailor import _build_analyze_use_case

    conn = get_connection()
    job = _load_current_job_by_id(conn, tenant_id=tenant_id, job_id=job_id)
    if not (job.get("full_description") or job.get("description")):
        raise invalid_params(
            f"jobId {job_id} has no description to analyze; enrich it first"
        )

    use_case = _build_analyze_use_case(conn=conn)
    outcome = use_case.execute(job=job, tenant_id=tenant_id, force=force)
    record = outcome.analysis
    return {
        "jobId": str(job_id),
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
    """Reuse and verify Codex CLI auth without making a model-generation call."""

    provider = str(_require(params, "provider")).strip().lower()
    if provider != "codex":
        raise invalid_params("provider_verify currently supports only codex")
    from jobctrl.infrastructure.setup_probes import reuse_and_verify_codex_connection

    ok, status, message = reuse_and_verify_codex_connection()
    return {
        "provider": "codex",
        "ok": ok,
        "status": status,
        "message": message,
    }


def _browser_status_payload(status: Any) -> dict[str, object]:
    """Serialize capability state without returning executable or profile paths."""

    return {
        "id": status.id,
        "status": status.status,
        "detail": status.detail,
        "mutable": status.id != "core-browser",
        "enabled": status.id == "core-browser" or status.status != "disabled",
        "profileCopyReady": status.id == "authenticated-linkedin-browser" and status.status == "ready",
    }


def _browser_capabilities_payload() -> dict[str, object]:
    """Serialize capability state and transient candidates without local paths."""

    from jobctrl.browser_capabilities import (
        detect_browser_profiles,
        detect_supported_browsers,
        list_browser_capabilities,
    )

    detected_browsers = detect_supported_browsers()
    detected_profiles = {
        browser.id: detect_browser_profiles(browser.id) for browser in detected_browsers
    }

    return {
        "capabilities": [_browser_status_payload(item) for item in list_browser_capabilities()],
        "detectedBrowsers": [
            {
                "id": browser.id,
                "label": browser.label,
                "defaultProfileAvailable": any(
                    profile.directory_name == "Default"
                    for profile in detected_profiles[browser.id]
                ),
                "profiles": [
                    {"id": profile.id, "label": profile.label}
                    for profile in detected_profiles[browser.id]
                ],
            }
            for browser in detected_browsers
        ],
    }


def browser_capabilities_list(params: dict[str, Any]) -> dict[str, object]:
    """List safe capability status and candidates without adopting host browsers."""

    if params:
        raise invalid_params("browser_capabilities_list does not accept parameters")
    return _browser_capabilities_payload()


def browser_capability_enable(params: dict[str, Any]) -> dict[str, object]:
    """Adopt one explicitly selected manual path or transient detected candidate."""

    capability_id = str(_require(params, "capabilityId"))
    has_executable_path = "executablePath" in params
    has_detected_browser_id = "detectedBrowserId" in params
    if has_executable_path == has_detected_browser_id:
        raise invalid_params("Select exactly one browser executable or detected browser.")
    from jobctrl.browser_capabilities import (
        BrowserCapabilityError,
        DetectedBrowserUnavailableError,
        enable_detected_browser_capability,
        enable_system_browser_capability,
    )

    try:
        if has_detected_browser_id:
            detected_browser_id = str(_require(params, "detectedBrowserId"))
            enable_detected_browser_capability(capability_id, detected_browser_id)
        else:
            executable_path = str(_require(params, "executablePath"))
            enable_system_browser_capability(capability_id, executable_path)
    except DetectedBrowserUnavailableError as exc:
        raise invalid_params("The selected detected browser is no longer available.") from exc
    except BrowserCapabilityError as exc:
        raise invalid_params("The selected browser capability could not be enabled.") from exc
    return _browser_capabilities_payload()


def browser_capability_disable(params: dict[str, Any]) -> dict[str, object]:
    """Hot-revoke one optional capability without touching an owned profile copy."""

    capability_id = str(_require(params, "capabilityId"))
    from jobctrl.browser_capabilities import BrowserCapabilityError, disable_browser_capability

    try:
        disable_browser_capability(capability_id)
    except BrowserCapabilityError as exc:
        raise invalid_params("The selected browser capability could not be disabled.") from exc
    return _browser_capabilities_payload()


def browser_profile_copy(params: dict[str, Any]) -> dict[str, object]:
    """Copy a caller-selected profile only through the versioned explicit UI consent arm."""

    has_source_profile_path = "sourceProfilePath" in params
    has_detected_browser_id = "detectedBrowserId" in params
    if has_source_profile_path == has_detected_browser_id:
        raise invalid_params("Select exactly one detected browser profile or manual profile path.")
    consent = params.get("consent")
    consent_method = params.get("consentMethod")
    if consent is not True or consent_method != "explicit-ui-v1":
        raise invalid_params("A separate explicit profile-copy consent is required.")
    from jobctrl.browser_capabilities import (
        BrowserCapabilityError,
        DetectedBrowserProfileUnavailableError,
        copy_authenticated_linkedin_profile,
        copy_detected_authenticated_linkedin_profile,
    )

    try:
        if has_detected_browser_id:
            copy_detected_authenticated_linkedin_profile(
                str(_require(params, "detectedBrowserId")),
                detected_profile_id=(
                    str(_require(params, "detectedProfileId"))
                    if "detectedProfileId" in params
                    else None
                ),
                consent=True,
                consent_method="explicit-ui-v1",
                replace_existing="detectedProfileId" in params,
            )
        else:
            copy_authenticated_linkedin_profile(
                str(_require(params, "sourceProfilePath")),
                consent=True,
                consent_method="explicit-ui-v1",
            )
    except DetectedBrowserProfileUnavailableError as exc:
        raise invalid_params("The selected detected browser profile is no longer available.") from exc
    except BrowserCapabilityError as exc:
        raise invalid_params("The selected browser profile could not be copied.") from exc
    return _browser_capabilities_payload()


def refresh_compensation(params: dict[str, Any]) -> WorkflowStartSpec:
    """Build a workflow spec for compensation refresh."""
    try:
        return build_compensation_refresh_workflow_spec(params)
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def retailor_current_policy(params: dict[str, Any]) -> WorkflowStartSpec:
    requested_job_ids = _job_ids(params)
    material_selection_resolved = not requested_job_ids
    job_ids = requested_job_ids
    if material_selection_resolved:
        from jobctrl.pipeline.current_policy_selectors import (
            tailoring_current_policy_job_ids,
        )

        job_ids = tailoring_current_policy_job_ids(
            get_connection(),
            tenant_id=_tenant_id(params),
            min_score=int(params.get("minScore", 7)),
            limit=int(params.get("limit", 100)),
        )
    return _pipeline_workflow_spec(
        params,
        stages=["tailor", "cover"],
        limit=int(params.get("limit", 100)),
        retailor=True,
        job_ids=job_ids,
        tailor_current_policy_only=True,
        material_selection_resolved=material_selection_resolved,
        suppress_existing_artifacts=_bool_param(params, "suppressExistingArtifacts", default=False),
    )


def _pipeline_workflow_spec(
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
    try:
        return build_pipeline_workflow_spec(
            params,
            stages=stages,
            limit=limit,
            rescore=rescore,
            retailor=retailor,
            job_id=job_id,
            job_ids=job_ids,
            score_current_policy_only=score_current_policy_only,
            tailor_current_policy_only=tailor_current_policy_only,
            material_selection_resolved=material_selection_resolved,
            suppress_existing_artifacts=suppress_existing_artifacts,
            allow_low_fit_override=allow_low_fit_override,
        )
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


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


def job_url_import(params: dict[str, Any]) -> WorkflowStartSpec:
    try:
        return build_job_url_import_workflow_spec(params)
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


# ---------------------------------------------------------------------------
# Workflow handlers
# ---------------------------------------------------------------------------


def _apply_workflow_id(tenant_id: str, job_id: str) -> str:
    """Deterministic ``apply-{tenant}-{jobId}`` id so a double-click apply for one job
    attaches to the running workflow (USE_EXISTING) instead of double-submitting.
    """
    return apply_workflow_id(tenant_id, job_id)


def apply_action(params: dict[str, Any]) -> WorkflowStartSpec:
    """Build a :class:`WorkflowStartSpec` for :class:`ApplyWorkflow`."""
    try:
        _reject_job_url_params(params)
        if "jobIds" in params:
            raise invalid_params("jobIds is not supported by apply; use jobId")
        return build_apply_workflow_spec(params)
    except ValueError as exc:
        raise invalid_params(str(exc)) from exc


def generate_interview_prep(params: dict[str, Any]) -> WorkflowStartSpec:
    """Build a workflow spec for user-triggered stored interview prep."""
    try:
        tenant_id = TenantId(_tenant_id(params))
        job_id = _required_job_id(params)
        _load_current_job_by_id(
            get_connection(),
            tenant_id=tenant_id,
            job_id=job_id,
        )
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
        _reject_job_url_params(params)
        if "jobIds" in params:
            raise invalid_params("jobIds is not supported by contact research; use jobId")
        tenant_id = TenantId(_tenant_id(params))
        spec_params = dict(params)
        spec_params["tenantId"] = str(tenant_id)
        if "jobId" in params:
            requested_job_id = _required_job_id(params)
            job_id = _job_id(
                _load_current_job_by_id(
                    get_connection(),
                    tenant_id=tenant_id,
                    job_id=requested_job_id,
                )
            )
            spec_params["jobId"] = str(job_id)
        return build_contact_research_workflow_spec(spec_params)
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
        tenant_id = _tenant_id(params)
        run_id = str(_require(params, "runId"))
        requested_by = str(params.get("requestedBy") or "local_operator")[:160]
        source = str(params.get("source") or "jobctrl_rpc")[:80]
        raw_reason = params.get("reason")
        reason = str(raw_reason)[:500] if raw_reason is not None else None
        from jobctrl.database import get_connection
        from jobctrl.infrastructure.temporal.cancellation_audit import (
            record_workflow_cancellation_requested,
        )
        from jobctrl.state import utc_now

        # A local intent becomes a cancellation request only after Temporal
        # accepts delivery. The immutable history requester is reconciled as a
        # separate evidence fact, so neither source can suppress the other.
        asyncio.run(canceler(run_id))
        try:
            record_workflow_cancellation_requested(
                get_connection(),
                workflow_id=run_id,
                requested_by=requested_by,
                source=source,
                requested_at=utc_now(),
                evidence_kind="request_intent",
                reason=reason,
                tenant_id=tenant_id,
            )
        except Exception:
            # Temporal already accepted the cancel: the run IS canceling, so
            # the RPC must report success. A failed intent write degrades to a
            # logged warning; the reconciler's temporal_history /
            # recovered_temporal_history facts still capture the immutable
            # requester from the execution's history.
            logger.warning(
                "cancel_run: recording the request_intent audit fact failed for %s; "
                "the cancel was delivered and history-evidence reconciliation will still run",
                run_id,
                exc_info=True,
            )
        return {"runId": run_id, "status": "canceling"}

    return cancel_run


def render_resume_pdf(params: dict[str, Any]) -> dict[str, Any]:
    """Render pre-built resume HTML to a paginated PDF for the TS API.

    Runs inside the long-lived rpc child so the API's event loop keeps
    serving during Chromium renders; the API persists database rows only
    after this returns.
    """

    html_path_raw = str(_require(params, "htmlPath")).strip()
    pdf_path = str(_require(params, "pdfPath")).strip()
    if not pdf_path:
        raise invalid_params("pdfPath must be non-empty")
    html_path = Path(html_path_raw)
    if not html_path.is_file():
        raise invalid_params(f"htmlPath does not exist: {html_path_raw}")
    from jobctrl.infrastructure.materials.html_resume_pdf import (
        render_resume_html_to_pdf,
    )

    render_resume_html_to_pdf(html_path.read_text(encoding="utf-8"), pdf_path)
    return {"status": "succeeded", "pdfPath": pdf_path}


def gmail_feedback_scan(params: dict[str, Any]) -> dict[str, Any]:
    """Run the bounded Gmail outcome scan for the TS API.

    The result dict passes through verbatim - auth failures travel as
    ``{"ok": False, "message": ...}`` so the API's status mapping keeps the
    same behavior it had over the old one-shot subprocess protocol.
    """

    assert_expected_runtime(
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
    )
    from jobctrl.config import DB_PATH
    from jobctrl.infrastructure.gmail.feedback import scan_gmail_feedback

    kwargs: dict[str, Any] = {}
    recipient = str(params.get("recipientEmail") or "").strip()
    if recipient:
        kwargs["recipient_email"] = recipient
    for param_name, kwarg_name in (
        ("limit", "limit"),
        ("maxResultsPerAnchor", "max_results_per_anchor"),
        ("windowDays", "window_days"),
    ):
        value = params.get(param_name)
        if value is not None:
            kwargs[kwarg_name] = int(value)
    try:
        return scan_gmail_feedback(db_path=DB_PATH, **kwargs)
    except Exception as exc:  # noqa: BLE001 - protocol boundary, see docstring
        # scan_gmail_feedback raises on failure; only the deleted CLI main()
        # converted exceptions into the ok:false envelope. Without this the
        # RPC server flattens every failure to a generic "Internal error"
        # and the API's message-based 400/503 mapping goes dead.
        return {"ok": False, "message": str(exc)}


def rederive_learning_recommendations(params: dict[str, Any]) -> dict[str, Any]:
    """Refresh pending Materials proposals after an explicit signal review."""

    tenant_id = TenantId(_tenant_id(params))
    assert_expected_runtime(
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
    )
    recommendations = SqliteLearningRecommendationRepository(
        get_connection()
    ).rederive_tailoring(
        tenant_id,
        source_changes=None,
        rederived_at=datetime.now(UTC).isoformat(),
    )
    return {
        "status": "succeeded",
        "recommendationCount": len(recommendations),
        "recommendationIds": [
            recommendation.recommendation_id for recommendation in recommendations
        ],
    }


def review_learning_recommendation(params: dict[str, Any]) -> dict[str, Any]:
    """Record one explicit recommendation decision and its policy effect."""

    tenant_id = TenantId(_tenant_id(params))
    recommendation_id = str(_require(params, "recommendationId")).strip()
    decision = str(_require(params, "decision")).strip()
    if decision not in {"accepted", "rejected"}:
        raise invalid_params("decision must be accepted or rejected")
    assert_expected_runtime(
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
    )
    try:
        review = SqliteLearningRecommendationReviewRepository(
            get_connection()
        ).review(
            tenant_id,
            recommendation_id=recommendation_id,
            decision=decision,
            reviewed_at=datetime.now(UTC).isoformat(),
        )
    except LearningRecommendationReviewError as exc:
        raise invalid_params(str(exc)) from exc
    return {
        "status": "succeeded",
        "reviewId": review.review_id,
        "recommendationId": review.recommendation_id,
        "revision": review.revision,
        "decision": review.decision,
        "context": review.context,
        "policyKind": review.policy_kind,
        "policyVersion": review.policy_version,
        "reviewedAt": review.reviewed_at,
    }


def rollback_tailoring_policy(params: dict[str, Any]) -> dict[str, Any]:
    """Append a Materials policy revision that restores a prior version."""

    tenant_id = TenantId(_tenant_id(params))
    target_version = _require(params, "targetVersion")
    if (
        not isinstance(target_version, int)
        or isinstance(target_version, bool)
        or target_version < 1
    ):
        raise invalid_params("targetVersion must be a positive integer")
    assert_expected_runtime(
        expected_app_dir=params.get("expectedAppDir"),
        expected_db_path=params.get("expectedDbPath"),
    )
    try:
        policy = SqliteTailoringPolicyRepository(get_connection()).rollback_to(
            tenant_id,
            target_version=target_version,
            reason="user_requested",
            rolled_back_at=datetime.now(UTC).isoformat(),
        )
    except TailoringPolicyRevisionError as exc:
        raise invalid_params(str(exc)) from exc
    return {
        "status": "succeeded",
        "context": "materials",
        "policyKind": "tailoring_rule",
        "policyVersion": policy.version,
        "rollbackOfVersion": policy.rollback_of_version,
        "rollbackReasonCode": policy.rollback_reason,
        "learnedRules": [
            {"ruleKey": rule_key, "ruleValue": rule_value}
            for rule_key, rule_value in policy.learned_tailoring_rules.rules
        ],
        "rolledBackAt": policy.created_at,
    }


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def register_default_handlers(server: JsonRpcServer, *, canceler: WorkflowCanceler) -> None:
    """Wire the default JobCtrl method set onto *server*."""
    server.register("profile_import", profile_import, mode="workflow")
    server.register("job_url_import", job_url_import, mode="workflow")
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
    server.register("browser_capabilities_list", browser_capabilities_list, mode="sync")
    server.register("browser_capability_enable", browser_capability_enable, mode="sync")
    server.register("browser_capability_disable", browser_capability_disable, mode="sync")
    server.register("browser_profile_copy", browser_profile_copy, mode="sync")
    server.register(
        "rederive_learning_recommendations",
        rederive_learning_recommendations,
        mode="sync",
    )
    server.register(
        "review_learning_recommendation",
        review_learning_recommendation,
        mode="sync",
    )
    server.register("rollback_tailoring_policy", rollback_tailoring_policy, mode="sync")
    server.register("render_resume_pdf", render_resume_pdf, mode="sync")
    server.register("gmail_feedback_scan", gmail_feedback_scan, mode="sync")
    server.register("refresh_compensation", refresh_compensation, mode="workflow")
    server.register("generate_interview_prep", generate_interview_prep, mode="workflow")
    server.register("run_contact_research", run_contact_research, mode="workflow")
    # Outreach draft generation/revision — synchronous (LLM + gate stack inline,
    # like analyze_job); persists a gated draft. No send path (INV-1).
    server.register("generate_outreach_draft", generate_outreach_draft, mode="sync")
    server.register("apply", apply_action, mode="workflow")
    # Cooperative cancellation of in-flight workflows.
    server.register("cancel_run", make_cancel_run(canceler), mode="sync")
