"""Temporal workflow that drives the JobCtrl pipeline stages serially in batch mode."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

from jobctrl.domain.identifiers import JobId, canonical_job_id

with workflow.unsafe.imports_passed_through():
    from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
    from jobctrl.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
    from jobctrl.domain.identifiers import JobId, canonical_job_id
    from jobctrl.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )
    from jobctrl.llm import SpendBudgetInput, check_spend_budget
    from jobctrl.enrichment.activities import (
        EnrichActivityInput,
        enrich_activity,
    )
    from jobctrl.materials.activities import (
        CoverActivityInput,
        TailorActivityInput,
        cover_activity,
        tailor_activity,
    )
    from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
    from jobctrl.infrastructure.preparation_recovery import (
        RecoverPreparationStateInput,
        recover_preparation_state_activity,
    )
    from jobctrl.scoring.activities import ScoreActivityInput, score_activity


@dataclass(frozen=True)
class JobPipelineWorkflowInput:
    """Input for ``JobPipelineWorkflow``.

    Drives the requested stage list in batch mode against eligible jobs in the
    local DB. Preparation stages can also be constrained to ``job_id`` /
    ``job_ids`` for retry-continuation flows, while discovery remains a
    batch/source-oriented stage.

    The apply step is delegated to ``ApplyWorkflow`` as a child workflow so
    mixed requests such as ``score -> tailor -> apply`` preserve request-order
    semantics while all work still runs under Temporal.
    """

    tenant_id: str
    stages: list[str]
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    min_score: int = 7
    workers: int = 1
    limit: int = 0
    validation_mode: str = "normal"
    dry_run: bool = False
    rescore: bool = False
    retailor: bool = False
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float | None = None
    job_id: JobId | None = None
    job_ids: tuple[JobId, ...] = ()
    apply_selector_keys: tuple[str, ...] = ()
    source_ids: tuple[str, ...] = ()
    score_current_policy_only: bool = False
    tailor_current_policy_only: bool = False
    suppress_existing_artifacts: bool = False
    allow_low_fit_override: bool = False
    headless: bool = False
    model: str = "default"
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    continuous: bool = False

    def __post_init__(self) -> None:
        if self.job_id is not None:
            object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))
        object.__setattr__(self, "job_ids", _canonical_job_ids(self.job_ids))


@dataclass(frozen=True)
class JobPipelineWorkflowResult:
    stages_completed: list[str] = field(default_factory=list)
    stages_failed: list[str] = field(default_factory=list)
    failure: str | None = None
    error_code: str | None = None


_NON_RETRYABLE_ERROR_TYPES = ["configuration", "authentication", "missing_input", "budget_exceeded"]
_SPENDFUL_STAGES = {"discover", "enrich", "score", "tailor", "cover", "apply"}
_ENRICH_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=5),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=60),
    maximum_attempts=3,
    non_retryable_error_types=_NON_RETRYABLE_ERROR_TYPES,
)
_SCORE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=5),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=60),
    maximum_attempts=3,
    non_retryable_error_types=_NON_RETRYABLE_ERROR_TYPES,
)
_TAILOR_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=120),
    maximum_attempts=3,
    non_retryable_error_types=_NON_RETRYABLE_ERROR_TYPES,
)
_COVER_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=120),
    maximum_attempts=3,
    non_retryable_error_types=_NON_RETRYABLE_ERROR_TYPES,
)
_DEFAULT_TIMEOUT = timedelta(minutes=30)
# Discovery does long-running external crawls and owns source-level retry,
# dedupe, and progress persistence below the workflow boundary. Retrying the
# entire activity can overlap with a still-running adapter thread after timeout
# cancellation, which creates duplicate in-flight crawls.
# 2 minutes gives the activity ~8 cycles of the 15s heartbeat poll inside
# ``run_blocking_with_heartbeat`` before Temporal would consider the
# activity dead. Without this knob Temporal never times out a stuck
# activity and the workflow waits the full ``start_to_close_timeout``.
_DEFAULT_HEARTBEAT_TIMEOUT = timedelta(minutes=2)


@workflow.defn(name="JobPipelineWorkflow")
class JobPipelineWorkflow:
    """Drives the configured pipeline stages serially in batch mode.

    Stage eligibility (``Pending`` / ``Queued`` / ``Running`` validity per job)
    is owned by the underlying stage runner via ``state.set_stage_state``, not
    by the workflow. The workflow simply dispatches each requested stage and
    surfaces ``ActivityError`` failures.
    """

    @workflow.run
    async def run(self, payload: JobPipelineWorkflowInput) -> JobPipelineWorkflowResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type="JobPipelineWorkflow",
            input_summary=_pipeline_input_summary(payload),
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        try:
            if _pipeline_spends(payload):
                await _check_spend(payload)
            result = await self._execute_stages(payload)
        except CancelledError:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="JobPipelineWorkflow",
                status="canceled",
                started_at=started_at,
                error_code="workflow_canceled",
                error_message="Workflow canceled by request.",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise
        except Exception as exc:  # noqa: BLE001 — record then re-raise
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="JobPipelineWorkflow",
                status="failed",
                started_at=started_at,
                error_code=_exception_error_code(exc) or "workflow_error",
                error_message=str(exc),
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise

        if result.failure:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="JobPipelineWorkflow",
                status="failed",
                started_at=started_at,
                error_code=result.error_code or "workflow_stage_failed",
                error_message=result.failure,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
        else:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="JobPipelineWorkflow",
                status="succeeded",
                started_at=started_at,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
        return result

    async def _execute_stages(self, payload: JobPipelineWorkflowInput) -> JobPipelineWorkflowResult:
        completed: list[str] = []
        failed: list[str] = []
        failure: str | None = None
        error_code: str | None = None
        derived_cover_job_ids: tuple[JobId, ...] | None = None

        for stage in payload.stages:
            stage_payload = payload
            if stage == "cover" and derived_cover_job_ids is not None and not _has_selected_job_scope(payload):
                if not derived_cover_job_ids:
                    completed.append(stage)
                    derived_cover_job_ids = None
                    continue
                stage_payload = replace(payload, job_ids=derived_cover_job_ids, limit=0)

            try:
                result = await _execute_stage(stage, stage_payload)
            except ActivityError as exc:
                if _activity_error_was_cancelled(exc):
                    raise CancelledError("Workflow canceled by request.") from exc
                if stage in {"score", "tailor", "cover"}:
                    await _recover_stage_state(stage, stage_payload)
                failed.append(stage)
                error_code = _activity_error_code(exc)
                failure = f"{stage}: {exc.cause if exc.cause else exc}"
                break

            result_failure = _stage_result_failure(stage, result)
            if result_failure is not None:
                failed.append(stage)
                error_code = "stage_result_failed"
                failure = result_failure
                break

            completed.append(stage)
            if stage == "tailor" and not _has_selected_job_scope(payload):
                derived_cover_job_ids = _approved_tailor_job_ids(result)
            elif stage != "cover":
                derived_cover_job_ids = None

        return JobPipelineWorkflowResult(
            stages_completed=completed,
            stages_failed=failed,
            failure=failure,
            error_code=error_code,
        )


async def _recover_stage_state(
    stage: str,
    payload: JobPipelineWorkflowInput,
) -> None:
    """Close rows owned by an exhausted batch activity."""
    await workflow.execute_activity(
        recover_preparation_state_activity,
        RecoverPreparationStateInput(
            tenant_id=payload.tenant_id,
            workflow_id=workflow.info().run_id,
            stage=stage,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        ),
        start_to_close_timeout=timedelta(seconds=30),
        retry_policy=RetryPolicy(maximum_attempts=0),
        cancellation_type=workflow.ActivityCancellationType.ABANDON,
    )


async def _execute_stage(stage: str, payload: JobPipelineWorkflowInput) -> Any:
    """Dispatch one stage to its Temporal activity."""
    workflow_id = workflow.info().workflow_id
    activity_owner = workflow.info().run_id
    if stage == "discover":
        return await workflow.execute_child_workflow(
            DiscoverWorkflow.run,
            DiscoverWorkflowInput(
                tenant_id=payload.tenant_id,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                workers=payload.workers,
                limit=payload.limit,
                min_score=payload.min_score,
                validation_mode=payload.validation_mode,
                tailor_models=payload.tailor_models,
                tailor_judge_model=payload.tailor_judge_model,
                tailor_judge_min_score=payload.tailor_judge_min_score,
                source_ids=payload.source_ids,
                llm_model=payload.llm_model,
            ),
            id=f"{workflow_id}-discover",
        )
    if stage == "enrich":
        workflow_run_id = workflow.info().run_id
        return await workflow.execute_activity(
            enrich_activity,
            EnrichActivityInput(
                tenant_id=payload.tenant_id,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                workers=payload.workers,
                limit=payload.limit,
                dry_run=payload.dry_run,
                job_ids=_selected_job_ids(payload),
                workflow_id=workflow_id,
                workflow_run_id=workflow_run_id,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_ENRICH_RETRY,
        )
    if stage == "score":
        return await workflow.execute_activity(
            score_activity,
            ScoreActivityInput(
                tenant_id=payload.tenant_id,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                workers=payload.workers,
                limit=payload.limit,
                dry_run=payload.dry_run,
                rescore=payload.rescore,
                job_ids=_selected_job_ids(payload),
                current_policy_only=payload.score_current_policy_only,
                llm_model=payload.llm_model,
                workflow_id=activity_owner,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_SCORE_RETRY,
        )
    if stage == "tailor":
        return await workflow.execute_activity(
            tailor_activity,
            TailorActivityInput(
                tenant_id=payload.tenant_id,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                min_score=payload.min_score,
                workers=payload.workers,
                limit=payload.limit,
                validation_mode=payload.validation_mode,
                dry_run=payload.dry_run,
                retailor=payload.retailor,
                job_ids=_selected_job_ids(payload),
                current_policy_only=payload.tailor_current_policy_only,
                suppress_existing_artifacts=payload.suppress_existing_artifacts,
                allow_low_fit_override=payload.allow_low_fit_override,
                tailor_models=payload.tailor_models,
                tailor_judge_model=payload.tailor_judge_model,
                tailor_judge_min_score=payload.tailor_judge_min_score,
                llm_model=payload.llm_model,
                workflow_id=activity_owner,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_TAILOR_RETRY,
        )
    if stage == "cover":
        return await workflow.execute_activity(
            cover_activity,
            CoverActivityInput(
                tenant_id=payload.tenant_id,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                min_score=payload.min_score,
                limit=payload.limit,
                validation_mode=payload.validation_mode,
                dry_run=payload.dry_run,
                job_ids=_selected_job_ids(payload),
                llm_model=payload.llm_model,
                workflow_id=activity_owner,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_COVER_RETRY,
        )
    if stage == "apply":
        apply_job_id = _apply_child_job_id(payload)
        return await workflow.execute_child_workflow(
            ApplyWorkflow.run,
            ApplyWorkflowInput(
                tenant_id=payload.tenant_id,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
                job_id=apply_job_id,
                dry_run=payload.dry_run,
                headless=payload.headless,
                model=payload.model,
                min_score=payload.min_score,
                workers=payload.workers,
                limit=payload.limit,
                continuous=payload.continuous,
            ),
            id=f"{workflow.info().workflow_id}-apply",
        )
    raise ApplicationError(
        f"Unknown stage: {stage}",
        non_retryable=True,
    )


async def _check_spend(payload: JobPipelineWorkflowInput) -> None:
    await workflow.execute_activity(
        check_spend_budget,
        SpendBudgetInput(tenant_id=payload.tenant_id),
        start_to_close_timeout=timedelta(seconds=30),
        retry_policy=RetryPolicy(maximum_attempts=1),
    )


def _pipeline_spends(payload: JobPipelineWorkflowInput) -> bool:
    return any(stage in _SPENDFUL_STAGES for stage in payload.stages)


def _pipeline_input_summary(payload: JobPipelineWorkflowInput) -> dict[str, Any]:
    """Compact, camelCase input summary for the workflow-run read-model."""
    return {
        "stages": list(payload.stages),
        "dryRun": payload.dry_run,
        "limit": payload.limit,
        "jobId": str(payload.job_id) if payload.job_id is not None else None,
        "jobIds": [str(job_id) for job_id in payload.job_ids],
    }


def _activity_error_code(exc: ActivityError) -> str | None:
    cause = exc.cause
    if isinstance(cause, ApplicationError):
        return cause.type or None
    return None


def _exception_error_code(exc: Exception) -> str | None:
    if isinstance(exc, ActivityError):
        return _activity_error_code(exc)
    if isinstance(exc, ApplicationError):
        return exc.type or None
    return None


def _activity_error_was_cancelled(exc: ActivityError) -> bool:
    cause: BaseException | None = exc
    seen: set[int] = set()
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        if isinstance(cause, CancelledError):
            return True
        nested = getattr(cause, "cause", None) or getattr(cause, "__cause__", None)
        cause = nested if isinstance(nested, BaseException) else None
    return False


def _selected_job_ids(payload: JobPipelineWorkflowInput) -> tuple[JobId, ...]:
    if payload.job_ids:
        return payload.job_ids
    if payload.job_id is not None:
        return (payload.job_id,)
    return ()


def _has_selected_job_scope(payload: JobPipelineWorkflowInput) -> bool:
    return payload.job_id is not None or bool(payload.job_ids)


def _apply_child_job_id(payload: JobPipelineWorkflowInput) -> JobId | None:
    """Validate the preserved selector shape before starting an Apply child."""

    selector_keys = tuple(payload.apply_selector_keys)
    if not selector_keys:
        if payload.job_id is None and not payload.job_ids:
            return None
    elif selector_keys == ("jobId",):
        if payload.job_id is not None and not payload.job_ids:
            return canonical_job_id(str(payload.job_id))

    raise ApplicationError(
        "apply accepts only a canonical jobId; omit all selector keys for batch apply",
        non_retryable=True,
    )


def _approved_tailor_job_ids(result: Any) -> tuple[JobId, ...] | None:
    stages = _result_value(result, "stages")
    if not isinstance(stages, list):
        return None
    for stage_result in stages:
        if not isinstance(stage_result, dict):
            continue
        if stage_result.get("stage") != "tailor":
            continue
        if "approvedJobIds" not in stage_result:
            return None
        raw_job_ids = stage_result.get("approvedJobIds")
        if not isinstance(raw_job_ids, list):
            return ()
        return _canonical_job_ids(tuple(canonical_job_id(str(job_id)) for job_id in raw_job_ids))
    return None


def _canonical_job_ids(job_ids: tuple[JobId, ...]) -> tuple[JobId, ...]:
    return tuple(dict.fromkeys(canonical_job_id(str(job_id)) for job_id in job_ids))


_SUCCESS_STAGE_STATUSES = frozenset({"ok", "partial", "skipped"})


def _stage_result_failure(stage: str, result: Any) -> str | None:
    """Return a workflow failure message for non-exception stage failures."""
    errors = _result_value(result, "errors")
    if errors:
        return f"{stage}: {_format_result_error(stage, errors)}"

    ok = _result_value(result, "ok")
    if ok is False:
        status = _result_value(result, "status") or "failed"
        error = _result_value(result, "error")
        detail = f"{status}: {error}" if error else str(status)
        return f"{stage}: {detail}"

    status = _result_value(result, "status")
    if status is None:
        return None

    normalized_status = str(status).lower()
    if normalized_status in _SUCCESS_STAGE_STATUSES:
        return None
    return f"{stage}: {status}"


def _result_value(result: Any, key: str) -> Any:
    if isinstance(result, dict):
        return result.get(key)
    return getattr(result, key, None)


def _format_result_error(stage: str, errors: Any) -> str:
    if isinstance(errors, dict):
        if set(errors) == {stage}:
            return str(errors[stage])
        return "; ".join(f"{key}: {value}" for key, value in errors.items())
    return str(errors)


__all__ = [
    "JobPipelineWorkflow",
    "JobPipelineWorkflowInput",
    "JobPipelineWorkflowResult",
]
