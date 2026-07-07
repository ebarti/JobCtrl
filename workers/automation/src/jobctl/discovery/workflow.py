"""Temporal workflow for discovery source decomposition."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

with workflow.unsafe.imports_passed_through():
    from jobctl.discovery.activities import (
        DiscoveryEnrichmentActivityInput,
        DiscoveryEnrichmentActivityOutput,
        DiscoveryPreparationFanoutInput,
        DiscoverySourceActivityInput,
        PlanDiscoverySourcesInput,
        PlanDiscoverySourcesOutput,
        discovery_enrichment_activity,
        discovery_preparation_fanout_activity,
        discovery_source_family_activity,
        plan_discovery_sources,
    )
    from jobctl.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )
    from jobctl.llm import SpendBudgetInput, check_spend_budget
    from jobctl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


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
        # R9 Phase 1/2 — score-as-you-discover. After each family COMPLETES we
        # drain that family's fresh jobs through enrichment (Phase 2 hands each
        # job off to its own SCORE_JOB workflow the moment it is enriched) and
        # fan out any it missed, instead of waiting for the whole run. These
        # streaming passes are progress-silent (``progress_total=0``); the Runs
        # progress bar advances on the family spine + the terminal reconcile
        # below, so it stays monotonic. Scores still surface incrementally via
        # ``job_events`` -> projections -> SSE.
        #
        # The one-time ``pending_tailor`` straggler sweep runs HERE, before any
        # family is enriched — the only moment ``pending_tailor`` cannot contain
        # a fresh job already owned by a this-run SCORE_JOB workflow (per-job
        # handoff and the streaming fan-out both start SCORE_JOB workflows the
        # instant a job is enriched). Every family/terminal fan-out is therefore
        # score-only, so a fresh job crossing ``pending_score`` ->
        # ``pending_tailor`` mid-tailor is never double-fanned (I1/I4). Doing the
        # sweep here also keeps it correct when families run concurrently
        # (Phase 3).
        await self._sweep_preexisting_preparation(payload)
        # R9 Phase 3 — optional parallel source families, GATED. Families are
        # processed in batches of ``plan.max_parallel_families`` (env
        # ``JOBCTL_MAX_PARALLEL_DISCOVERY_FAMILIES``, default 1 = sequential =
        # current behavior). Within a batch the source crawls run concurrently
        # (``asyncio.gather``); the batch's streaming enrichment + fan-out then
        # runs ONCE afterwards, so enrichment is never run concurrently (it
        # drains globally) and concurrent browser use is bounded to the batch's
        # source crawls. Batches are ordered and results folded in submission
        # order, so replay stays deterministic; a canceled source in any batch
        # cooperatively cancels the run.
        indexed_families = list(enumerate(plan.families))
        batch_size = max(1, plan.max_parallel_families)
        for batch in _chunk(indexed_families, batch_size):
            results = await asyncio.gather(
                *(self._run_family_source(payload, index, family, plan) for index, family in batch)
            )
            if any(status == "canceled" for _family, status, _failure in results):
                raise CancelledError()
            batch_completed = False
            for family, status, failure in results:
                if status == "ok":
                    completed.append(family)
                    batch_completed = True
                else:
                    failed.append(family)
                    if failure is not None:
                        failures.append(failure)
            if batch_completed:
                await self._stream_family_preparation(payload)

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
            # Score-only: pre-existing ``pending_tailor`` stragglers were already
            # swept before the loop, and every fresh job is carried through
            # tailor/cover/pdf by its own SCORE_JOB workflow — so a terminal
            # full derive would only risk double-tailoring a fresh job that is
            # mid-tailor right now.
            preparation_started = await _start_preparation_workflows(
                payload,
                include_pending_tailor=False,
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

    async def _run_family_source(
        self,
        payload: DiscoverWorkflowInput,
        index: int,
        family: str,
        plan: PlanDiscoverySourcesOutput,
    ) -> tuple[str, str, str | None]:
        """Run one family's source crawl; return ``(family, status, failure)``.

        Never raises: it folds every outcome into a status
        (``"ok"``/``"failed"``/``"canceled"``) so ``asyncio.gather`` over a
        parallel batch always completes and the caller folds results in a
        deterministic, submission-order pass. Cancellation is surfaced as
        ``"canceled"`` and re-raised by the caller so it fans out to the whole
        run.
        """
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
        except ActivityError as exc:
            if _activity_error_was_cancelled(exc):
                return (family, "canceled", None)
            return (family, "failed", f"{family}: {exc.cause if exc.cause else exc}")
        return (family, "ok", None)

    async def _sweep_preexisting_preparation(self, payload: DiscoverWorkflowInput) -> None:
        """One-time full-derive fan-out for work left over from a PRIOR run.

        Runs before the family loop, when nothing this run has been enriched, so
        ``pending_tailor`` holds only pre-existing stragglers (scored-but-not-
        tailored in an earlier run) — the single moment a ``pending_tailor``
        derive cannot race a fresh job's in-flight SCORE_JOB workflow. Every
        later fan-out is score-only. Progress-silent and best-effort: a
        non-cancellation failure is retried at the activity level and otherwise
        left for the next run's sweep (stragglers are pre-existing, never fresh);
        cancellation always propagates.
        """
        try:
            await _start_preparation_workflows(
                payload,
                include_pending_tailor=True,
                progress_completed=0,
                progress_total=0,
            )
        except ActivityError as exc:
            if _activity_error_was_cancelled(exc):
                raise CancelledError() from exc

    async def _stream_family_preparation(self, payload: DiscoverWorkflowInput) -> None:
        """Drain + fan out the just-completed family's jobs now (R9 Phase 1/2).

        Progress-silent (``progress_total=0``) so the Runs bar stays monotonic
        on the terminal spine; scores still stream via ``job_events``. Phase 2
        enrichment hands each job off to its own SCORE_JOB workflow the moment it
        is enriched; the score-only fan-out here (and the terminal reconcile)
        are the dedup-safe backstop for anything the handoff missed. Best-effort:
        a non-cancellation failure is left for the authoritative terminal
        reconcile (which re-drains and re-derives, deduped by the deterministic
        ``prep-{idempotency_key}`` id), so streaming never changes the run's
        terminal status or folding. Cancellation always propagates.
        """
        try:
            await _run_enrichment_activity(
                payload, progress_completed=0, progress_total=0, per_job_handoff=True
            )
        except ActivityError as exc:
            if _activity_error_was_cancelled(exc):
                raise CancelledError() from exc
            return
        try:
            await _start_preparation_workflows(
                payload,
                include_pending_tailor=False,
                progress_completed=0,
                progress_total=0,
            )
        except ActivityError as exc:
            if _activity_error_was_cancelled(exc):
                raise CancelledError() from exc


async def _run_enrichment_activity(
    payload: DiscoverWorkflowInput,
    *,
    progress_completed: int,
    progress_total: int,
    per_job_handoff: bool = False,
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
            per_job_handoff=per_job_handoff,
            min_score=payload.min_score,
            validation_mode=payload.validation_mode,
            llm_model=payload.llm_model,
            tailor_models=payload.tailor_models,
            tailor_judge_model=payload.tailor_judge_model,
            tailor_judge_min_score=payload.tailor_judge_min_score,
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


def _chunk(items: list[Any], size: int) -> list[list[Any]]:
    """Split ``items`` into ordered sublists of at most ``size`` (>= 1)."""
    step = max(1, size)
    return [items[start : start + step] for start in range(0, len(items), step)]


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
