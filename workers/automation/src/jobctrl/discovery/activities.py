"""Temporal activities for decomposed discovery execution."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from jobctrl.domain.discovery.execution import (
    DiscoveryExecutionCohortKind,
    DiscoveryExecutionRef,
)
from jobctrl.domain.errors import JobCtrlError, to_application_error
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class PlanDiscoverySourcesInput:
    tenant_id: str
    limit: int = 0
    source_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class PlanDiscoverySourcesOutput:
    families: list[str]
    progress_total: int
    start_count: int
    # R9 Phase 3 — how many source families the workflow may crawl concurrently.
    # Resolved from the env at planning time (in the activity) so the workflow
    # stays deterministic on replay. Default 1 = sequential (current behavior).
    max_parallel_families: int = 1
    next_run_settings: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DiscoverySourceActivityInput:
    tenant_id: str
    family: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    workers: int = 1
    limit: int = 0
    source_ids: tuple[str, ...] = ()
    start_count: int = 0
    progress_completed: int = 0
    progress_total: int = 0
    next_run_settings: dict[str, Any] = field(default_factory=dict)
    discovery_execution: DiscoveryExecutionRef | None = None


@dataclass(frozen=True)
class DiscoverySourceActivityOutput:
    family: str
    status: str
    result: dict[str, Any] = field(default_factory=dict)
    source_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DiscoveryEnrichmentActivityInput:
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    workers: int = 1
    limit: int = 0
    progress_completed: int = 0
    progress_total: int = 0
    # R9 Phase 2 — per-job handoff. When True, each job that reaches
    # ``pending_score`` during this enrichment pass immediately starts its own
    # SCORE_JOB preparation workflow (deterministic id + USE_EXISTING), so a job
    # is scored the moment it is enriched rather than after its whole family.
    # The prep params below mirror the fan-out so the per-job start and the
    # reconciling fan-outs converge on exactly one workflow per job.
    per_job_handoff: bool = False
    min_score: int = 7
    validation_mode: str = "normal"
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float | None = None
    discovery_execution: DiscoveryExecutionRef | None = None


@dataclass(frozen=True)
class DiscoveryEnrichmentActivityOutput:
    status: str
    passes: int = 0
    pending: int = 0
    error_class: str | None = None
    error_message: str | None = None
    site_errors: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DiscoveryPreparationFanoutInput:
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    min_score: int = 7
    limit: int = 0
    workers: int = 1
    validation_mode: str = "normal"
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float | None = None
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    progress_completed: int = 0
    progress_total: int = 0
    # When False, only fresh ``pending_score`` jobs are fanned out; the
    # ``pending_tailor`` straggler branch is skipped. Per-family streaming
    # (R9 Phase 1) sweeps stragglers on the first fan-out only, then derives
    # score-only, so a fresh job never gets a duplicate TAILOR_RESUME workflow.
    include_pending_tailor: bool = True
    discovery_execution: DiscoveryExecutionRef | None = None
    cohort_kind: DiscoveryExecutionCohortKind = "observed_this_run"
    finalize_observed_work_plans: bool = False


@dataclass(frozen=True)
class DiscoveryPreparationFanoutOutput:
    started: int = 0
    queued: int = 0
    targets: int = 0


@activity.defn(name="plan_discovery_sources")
def plan_discovery_sources(payload: PlanDiscoverySourcesInput) -> PlanDiscoverySourcesOutput:
    """Plan the source-family activities for ``DiscoverWorkflow``."""
    from jobctrl.pipeline.runner import plan_discovery_source_families

    plan = plan_discovery_source_families(
        limit=payload.limit,
        source_ids=payload.source_ids,
    )
    return PlanDiscoverySourcesOutput(
        families=list(plan.get("families") or []),
        progress_total=int(plan.get("progress_total") or 0),
        start_count=int(plan.get("start_count") or 0),
        max_parallel_families=max(1, int(plan.get("max_parallel_families") or 1)),
        next_run_settings=dict(plan.get("next_run_settings") or {}),
    )


@activity.defn(name="discovery_source_family")
async def discovery_source_family_activity(
    payload: DiscoverySourceActivityInput,
) -> DiscoverySourceActivityOutput:
    """Run one discovery source family with real cancellation and heartbeats."""
    from jobctrl.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobctrl.pipeline.runner import run_discovery_source_family

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    cancel_event = threading.Event()

    try:
        result = await run_blocking_with_heartbeat(
            lambda: run_discovery_source_family(
                payload.family,
                workers=payload.workers,
                limit=payload.limit,
                source_ids=payload.source_ids,
                start_count=payload.start_count,
                progress_completed=payload.progress_completed,
                progress_total=payload.progress_total,
                cancel_event=cancel_event,
                next_run_settings=payload.next_run_settings,
                discovery_execution=payload.discovery_execution,
            ),
            starting_message=f"discover {payload.family} starting",
            progress_message=f"discover {payload.family} still running",
            on_cancel=cancel_event.set,
            activity_name=f"discover:{payload.family}",
        )
        status = str(result.get("status") or "ok")
        if not _is_success_status(status):
            raise _stage_failure_error(f"discover:{payload.family}", result)
        return DiscoverySourceActivityOutput(
            family=str(result.get("family") or payload.family),
            status=status,
            result=dict(result.get("result") or {}),
            source_ids=[str(item) for item in (result.get("source_ids") or [])],
        )
    except ApplicationError:
        raise
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


@activity.defn(name="discovery_enrichment")
async def discovery_enrichment_activity(
    payload: DiscoveryEnrichmentActivityInput,
) -> DiscoveryEnrichmentActivityOutput:
    """Drain detail enrichment after source-family discovery completes."""
    from jobctrl.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobctrl.pipeline.runner import run_discovery_enrichment_stage, run_discovery_hygiene

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    cancel_event = threading.Event()
    on_job_enriched = _build_per_job_handoff(payload)

    try:
        result = await run_blocking_with_heartbeat(
            lambda: run_discovery_enrichment_stage(
                workers=payload.workers,
                limit=payload.limit,
                cancel_event=cancel_event,
                progress_completed=payload.progress_completed,
                progress_total=payload.progress_total,
                on_job_enriched=on_job_enriched,
            ),
            starting_message="discovery enrichment starting",
            progress_message="discovery enrichment still running",
            on_cancel=cancel_event.set,
            activity_name="discover:enrichment",
        )
        activity.heartbeat({"status": result.get("status", "ok")})
        run_discovery_hygiene("after")
        status = str(result.get("status") or "ok")
        if not _is_success_status(status):
            raise _stage_failure_error("discover:enrichment", result)
        return DiscoveryEnrichmentActivityOutput(
            status=status,
            passes=int(result.get("passes") or 0),
            pending=int(result.get("pending") or 0),
            error_class=result.get("error_class"),
            error_message=result.get("error_message"),
            site_errors=dict(result.get("site_errors") or {}),
        )
    except ApplicationError:
        raise
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


def _build_per_job_handoff(
    payload: DiscoveryEnrichmentActivityInput,
) -> Callable[[str], None] | None:
    """Build the R9 Phase 2 per-job preparation handoff, or ``None`` when off.

    The returned callback is fired by the enrichment worker as each job reaches
    ``pending_score``. It starts that job's SCORE_JOB preparation workflow with
    the deterministic id + ``USE_EXISTING`` so it converges with the per-family /
    terminal fan-outs on exactly one execution per job. Starts are serialized by
    a lock because ``_run_detail_scraper`` may enrich sites in parallel threads
    and the workflow starter writes + refreshes projections on SQLite.
    """
    if not payload.per_job_handoff:
        return None

    from jobctrl.domain.tenant import TenantId
    from jobctrl.pipeline.preparation import start_job_preparation_workflow

    handoff_lock = threading.Lock()

    def _handoff(job_url: str) -> None:
        with handoff_lock:
            start_job_preparation_workflow(
                job_url,
                min_score=payload.min_score,
                workers=payload.workers,
                validation_mode=payload.validation_mode,
                llm_model=payload.llm_model,
                tailor_models=payload.tailor_models,
                tailor_judge_model=payload.tailor_judge_model,
                tailor_judge_min_score=payload.tailor_judge_min_score,
                tenant_id=TenantId(payload.tenant_id),
                discovery_execution=payload.discovery_execution,
                discovery_cohort_kind="observed_this_run",
            )

    return _handoff


@activity.defn(name="discovery_preparation_fanout")
async def discovery_preparation_fanout_activity(
    payload: DiscoveryPreparationFanoutInput,
) -> DiscoveryPreparationFanoutOutput:
    """Fan out per-job preparation as ROOT workflows after discovery.

    Reuses the P3 fan-out (`start_discovery_preparation_workflows`) so
    preparation runs as independent root workflows via the Temporal client
    (`USE_EXISTING` dedup). Starting them here — rather than as children of
    ``DiscoverWorkflow`` — is what keeps them alive after discovery completes:
    child workflows default to ``ParentClosePolicy.TERMINATE``.
    """
    from jobctrl.domain.tenant import TenantId
    from jobctrl.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobctrl.pipeline.preparation import start_discovery_preparation_workflows

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    def _run_fanout() -> dict[str, Any]:
        _record_preparation_progress(
            "StageStarted",
            "info",
            "Discovery preparation started",
            progress_message="Preparation started",
            completed=payload.progress_completed,
            total=payload.progress_total,
        )
        try:
            fanout_stats = start_discovery_preparation_workflows(
                min_score=payload.min_score,
                limit=payload.limit,
                workers=payload.workers,
                validation_mode=payload.validation_mode,
                llm_model=payload.llm_model,
                tailor_models=payload.tailor_models,
                tailor_judge_model=payload.tailor_judge_model,
                tailor_judge_min_score=payload.tailor_judge_min_score,
                tenant_id=TenantId(payload.tenant_id),
                include_pending_tailor=payload.include_pending_tailor,
                discovery_execution=payload.discovery_execution,
                discovery_cohort_kind=payload.cohort_kind,
                finalize_observed_work_plans=payload.finalize_observed_work_plans,
            )
        except Exception as exc:
            _record_preparation_progress(
                "StageFailed",
                "error",
                f"Discovery preparation failed: {exc}",
                progress_message="Preparation failed",
                completed=payload.progress_completed + 1,
                total=payload.progress_total,
                status="failed",
            )
            raise
        _record_preparation_progress(
            "StageCompleted",
            "info",
            "Discovery preparation complete",
            progress_message="Preparation complete",
            completed=payload.progress_completed + 1,
            total=payload.progress_total,
        )
        return fanout_stats

    try:
        stats = await run_blocking_with_heartbeat(
            _run_fanout,
            starting_message="discovery preparation fan-out starting",
            progress_message="discovery preparation fan-out still running",
            activity_name="discover:preparation",
        )
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc

    started = int((stats.get("started") or {}).get("job_preparation") or 0)
    queued = int((stats.get("queued") or {}).get("job_preparation") or 0)
    return DiscoveryPreparationFanoutOutput(
        started=started,
        queued=queued,
        targets=int(stats.get("targets") or 0),
    )


def _record_preparation_progress(
    event_type: str,
    level: str,
    message: str,
    *,
    progress_message: str,
    completed: int,
    total: int,
    status: str = "running",
) -> None:
    """Emit the Preparation step's discover progress on the Temporal path.

    Mirrors the legacy ``finish_discovery`` event shapes exactly so the
    dashboard progress reducer needs no changes. Without this step the
    progress bar of a successful discover run would freeze one step short of
    100% — the same frozen-progress family as the incident's stale 67%.
    """
    if total <= 0:
        return
    from jobctrl.pipeline.runner import (
        _discovery_progress_payload,
        _record_pipeline_event,
    )

    _record_pipeline_event(
        "discover",
        event_type,
        level,
        message,
        _discovery_progress_payload(
            completed=completed,
            total=total,
            current_step="Preparation",
            status=status,
            message=progress_message,
        ),
    )


_SUCCESS_STATUSES = {"ok", "partial", "skipped", "already_done"}


def _is_success_status(status: str) -> bool:
    """Treat every ``skipped*`` variant as success.

    ``_skip_status`` emits ``skipped_disabled`` / ``skipped_quality`` /
    ``skipped_limit`` for families that were intentionally not run; those must
    not be mistaken for failures. ``stuck:*`` and ``failed`` remain failures.
    """
    normalized = str(status or "ok").lower()
    if normalized in _SUCCESS_STATUSES:
        return True
    return normalized.startswith("skipped")


def _stage_failure_error(stage: str, result: dict[str, Any]) -> ApplicationError:
    """Build a fully-typed ``ApplicationError`` from a stage's real failure.

    Preserves the runner's captured ``error_class`` / ``error_message`` /
    ``error_code`` / ``retryable`` so the workflow (and the durable outcome
    event) surface the true cause instead of collapsing to "failed: failed".
    """
    error_class = result.get("error_class")
    error_message = result.get("error_message")
    status = str(result.get("status") or "failed")
    if error_class and error_message:
        message = f"{stage} failed: {error_class}: {error_message}"
    elif error_message:
        message = f"{stage} failed: {error_message}"
    elif error_class:
        message = f"{stage} failed: {error_class} (status: {status})"
    elif status.lower() == "failed":
        # Never render the bare status when it is the word "failed" — that is
        # exactly the "failed: failed" collapse this helper exists to prevent.
        message = f"{stage} failed with no recorded error detail"
    else:
        message = f"{stage} failed: {status}"
    error_type = str(result.get("error_code") or "stage_failed")
    retryable = bool(result.get("retryable", True))
    details = {
        "errorClass": error_class,
        "errorMessage": error_message,
        "passes": result.get("passes"),
        "pending": result.get("pending"),
        "siteErrors": result.get("site_errors") or {},
        "traceback": result.get("error_traceback"),
    }
    return ApplicationError(
        message,
        details,
        type=error_type,
        non_retryable=not retryable,
    )
