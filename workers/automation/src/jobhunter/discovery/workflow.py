"""Temporal workflow for discovery source decomposition."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

with workflow.unsafe.imports_passed_through():
    from jobhunter.discovery.activities import (
        DiscoveryEnrichmentActivityInput,
        DiscoveryEnrichmentActivityOutput,
        DiscoveryPreparationFanoutInput,
        DiscoverySourceActivityInput,
        PlanDiscoverySourcesInput,
        discovery_enrichment_activity,
        discovery_preparation_fanout_activity,
        discovery_source_family_activity,
        plan_discovery_sources,
    )
    from jobhunter.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )
    from jobhunter.llm import SpendBudgetInput, check_spend_budget
    from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class DiscoverWorkflowInput:
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    workers: int = 1
    limit: int = 0
    min_score: int = 7
    validation_mode: str = "normal"
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float | None = None
    source_ids: tuple[str, ...] = ()
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class DiscoverWorkflowResult:
    families_completed: list[str] = field(default_factory=list)
    families_failed: list[str] = field(default_factory=list)
    preparation_started: int = 0
    enrichment_status: str = "ok"
    enrichment_site_errors: dict[str, Any] = field(default_factory=dict)
    failure: str | None = None
    error_code: str | None = None


def discover_workflow_id(tenant_id: str) -> str:
    return f"discover-{tenant_id}"


_NON_RETRYABLE_ERROR_TYPES = ["configuration", "authentication", "missing_input", "budget_exceeded"]
_SOURCE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=5),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=60),
    maximum_attempts=3,
    non_retryable_error_types=_NON_RETRYABLE_ERROR_TYPES,
)
_ENRICH_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=5),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=60),
    maximum_attempts=3,
    non_retryable_error_types=_NON_RETRYABLE_ERROR_TYPES,
)
_DEFAULT_TIMEOUT = timedelta(minutes=30)
_DISCOVERY_TIMEOUT = timedelta(hours=6)
_DEFAULT_HEARTBEAT_TIMEOUT = timedelta(minutes=2)


@workflow.defn(name="DiscoverWorkflow")
class DiscoverWorkflow:
    """Run source-family discovery, enrichment, and preparation fan-out."""

    @workflow.run
    async def run(self, payload: DiscoverWorkflowInput) -> DiscoverWorkflowResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type="DiscoverWorkflow",
            input_summary=_input_summary(payload),
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        try:
            await _check_spend(payload)
            result = await self._execute(payload)
        except CancelledError:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="DiscoverWorkflow",
                status="canceled",
                started_at=started_at,
                error_code="workflow_canceled",
                error_message="Workflow canceled by request.",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise
        except Exception as exc:  # noqa: BLE001
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="DiscoverWorkflow",
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
                workflow_type="DiscoverWorkflow",
                status="failed",
                started_at=started_at,
                error_code=result.error_code or "discovery_source_failed",
                error_message=result.failure,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise ApplicationError(
                result.failure,
                type=result.error_code or "discovery_source_failed",
                non_retryable=True,
            )
        await emit_workflow_outcome(
            tenant_id=payload.tenant_id,
            workflow_type="DiscoverWorkflow",
            status="succeeded",
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        return result

    async def _execute(self, payload: DiscoverWorkflowInput) -> DiscoverWorkflowResult:
        plan = await workflow.execute_activity(
            plan_discovery_sources,
            PlanDiscoverySourcesInput(
                tenant_id=payload.tenant_id,
                limit=payload.limit,
                source_ids=payload.source_ids,
            ),
            start_to_close_timeout=_DEFAULT_TIMEOUT,
            heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
            retry_policy=_SOURCE_RETRY,
        )
        completed: list[str] = []
        failed: list[str] = []
        failures: list[str] = []
        # R9 Phase 1 — score-as-you-discover. After each family COMPLETES we
        # drain that family's fresh jobs through enrichment and fan out their
        # preparation immediately, instead of waiting for the whole run. These
        # streaming passes are progress-silent (``progress_total=0``); the Runs
        # progress bar advances on the family spine + the terminal reconcile
        # below, so it stays monotonic. Scores still surface incrementally via
        # ``job_events`` -> projections -> SSE. ``stragglers_swept`` tracks
        # whether the one-time ``pending_tailor`` sweep has run: the first
        # successful fan-out derives the full set (fresh + pre-existing
        # stragglers); every later pass is score-only so a fresh job that
        # crosses ``pending_score`` -> ``pending_tailor`` mid-tailor is never
        # double-fanned (I1/I4).
        stragglers_swept = False
        for index, family in enumerate(plan.families):
            try:
                await workflow.execute_activity(
                    discovery_source_family_activity,
                    DiscoverySourceActivityInput(
                        tenant_id=payload.tenant_id,
                        family=family,
                        expected_app_dir=payload.expected_app_dir,
                        expected_db_path=payload.expected_db_path,
                        workers=payload.workers,
                        limit=payload.limit,
                        source_ids=payload.source_ids,
                        start_count=plan.start_count,
                        progress_completed=index,
                        progress_total=plan.progress_total,
                    ),
                    start_to_close_timeout=_DISCOVERY_TIMEOUT,
                    heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
                    retry_policy=_SOURCE_RETRY,
                )
                completed.append(family)
            except ActivityError as exc:
                if _activity_error_was_cancelled(exc):
                    raise CancelledError() from exc
                failed.append(family)
                failures.append(f"{family}: {exc.cause if exc.cause else exc}")
                continue
            stragglers_swept = await self._stream_family_preparation(
                payload, stragglers_swept=stragglers_swept
            )

        # Legacy semantics: per-source failures are tolerated. The TERMINAL
        # reconcile enrichment + preparation below ALWAYS run so the healthy
        # sources' jobs still flow through the pipeline (and any job a streaming
        # pass missed is swept up); the workflow only fails as a source failure
        # when EVERY family failed. This terminal pass is authoritative for the
        # failure folding and the progress finalization — the streaming passes
        # above are additive and best-effort.
        enrichment_failure: str | None = None
        enrichment_error_code: str | None = None
        enrichment_status = "ok"
        enrichment_site_errors: dict[str, Any] = {}
        try:
            enrichment_result = await _run_enrichment_activity(
                payload,
                progress_completed=len(plan.families),
                progress_total=plan.progress_total,
            )
            enrichment_status = enrichment_result.status
            enrichment_site_errors = dict(enrichment_result.site_errors)
        except ActivityError as exc:
            if _activity_error_was_cancelled(exc):
                raise CancelledError() from exc
            enrichment_failure = str(exc.cause) if exc.cause else str(exc)
            enrichment_error_code = _activity_error_code(exc)

        preparation_started = 0
        preparation_error: ActivityError | None = None
        try:
            preparation_started = await _start_preparation_workflows(
                payload,
                include_pending_tailor=not stragglers_swept,
                progress_completed=len(plan.families) + 1,
                progress_total=plan.progress_total,
            )
        except ActivityError as exc:
            if _activity_error_was_cancelled(exc):
                raise CancelledError() from exc
            preparation_error = exc

        all_families_failed = bool(failed) and not completed
        if all_families_failed:
            return DiscoverWorkflowResult(
                families_completed=completed,
                families_failed=failed,
                preparation_started=preparation_started,
                enrichment_status=enrichment_status,
                enrichment_site_errors=enrichment_site_errors,
                failure="; ".join(failures),
                error_code="discovery_source_failed",
            )
        if enrichment_failure is not None:
            message = enrichment_failure
            if preparation_error is not None:
                prep_cause = (
                    str(preparation_error.cause)
                    if preparation_error.cause
                    else str(preparation_error)
                )
                message = f"{enrichment_failure}; preparation also failed: {prep_cause}"
            return DiscoverWorkflowResult(
                families_completed=completed,
                families_failed=failed,
                preparation_started=preparation_started,
                enrichment_status=enrichment_status,
                enrichment_site_errors=enrichment_site_errors,
                failure=message,
                error_code=enrichment_error_code or "discovery_enrichment_failed",
            )
        if preparation_error is not None:
            raise preparation_error
        return DiscoverWorkflowResult(
            families_completed=completed,
            families_failed=failed,
            preparation_started=preparation_started,
            enrichment_status=enrichment_status,
            enrichment_site_errors=enrichment_site_errors,
        )

    async def _stream_family_preparation(
        self, payload: DiscoverWorkflowInput, *, stragglers_swept: bool
    ) -> bool:
        """Drain + fan out the just-completed family's jobs now (R9 Phase 1).

        Progress-silent (``progress_total=0``) so the Runs bar stays monotonic
        on the terminal spine; scores still stream via ``job_events``. This is
        best-effort: any non-cancellation failure is left for the authoritative
        terminal reconcile pass (which re-drains and re-derives, deduped by the
        deterministic ``prep-{idempotency_key}`` id), so streaming never changes
        the run's terminal status or folding. Cancellation always propagates.

        Returns the (possibly updated) ``stragglers_swept`` flag: the first
        successful fan-out sweeps ``pending_tailor`` stragglers once; thereafter
        fan-out is score-only.
        """
        try:
            await _run_enrichment_activity(payload, progress_completed=0, progress_total=0)
        except ActivityError as exc:
            if _activity_error_was_cancelled(exc):
                raise CancelledError() from exc
            return stragglers_swept
        try:
            await _start_preparation_workflows(
                payload,
                include_pending_tailor=not stragglers_swept,
                progress_completed=0,
                progress_total=0,
            )
        except ActivityError as exc:
            if _activity_error_was_cancelled(exc):
                raise CancelledError() from exc
            return stragglers_swept
        return True


async def _run_enrichment_activity(
    payload: DiscoverWorkflowInput,
    *,
    progress_completed: int,
    progress_total: int,
) -> DiscoveryEnrichmentActivityOutput:
    return await workflow.execute_activity(
        discovery_enrichment_activity,
        DiscoveryEnrichmentActivityInput(
            tenant_id=payload.tenant_id,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
            workers=payload.workers,
            limit=payload.limit,
            progress_completed=progress_completed,
            progress_total=progress_total,
        ),
        start_to_close_timeout=_DISCOVERY_TIMEOUT,
        heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
        retry_policy=_ENRICH_RETRY,
    )


async def _start_preparation_workflows(
    payload: DiscoverWorkflowInput,
    *,
    include_pending_tailor: bool = True,
    progress_completed: int = 0,
    progress_total: int = 0,
) -> int:
    result = await workflow.execute_activity(
        discovery_preparation_fanout_activity,
        DiscoveryPreparationFanoutInput(
            tenant_id=payload.tenant_id,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
            min_score=payload.min_score,
            limit=payload.limit,
            workers=payload.workers,
            validation_mode=payload.validation_mode,
            tailor_models=payload.tailor_models,
            tailor_judge_model=payload.tailor_judge_model,
            tailor_judge_min_score=payload.tailor_judge_min_score,
            llm_model=payload.llm_model,
            progress_completed=progress_completed,
            progress_total=progress_total,
            include_pending_tailor=include_pending_tailor,
        ),
        start_to_close_timeout=_DEFAULT_TIMEOUT,
        heartbeat_timeout=_DEFAULT_HEARTBEAT_TIMEOUT,
        retry_policy=_SOURCE_RETRY,
    )
    return result.started + result.queued


async def _check_spend(payload: DiscoverWorkflowInput) -> None:
    await workflow.execute_activity(
        check_spend_budget,
        SpendBudgetInput(tenant_id=payload.tenant_id),
        start_to_close_timeout=timedelta(seconds=30),
        retry_policy=RetryPolicy(maximum_attempts=1),
    )


def _input_summary(payload: DiscoverWorkflowInput) -> dict[str, Any]:
    return {
        "limit": payload.limit,
        "workers": payload.workers,
        "sourceIds": list(payload.source_ids),
    }


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
