"""JobCtrl pipeline stage helpers used by Temporal activities."""

from __future__ import annotations

import json
import logging
import inspect
import threading
import time
import traceback
import uuid
from typing import Any, Callable

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from rich.console import Console
from temporalio import activity as temporal_activity

from jobctrl import config
from jobctrl import database as db_module
from jobctrl.database import init_db, get_connection
from jobctrl.domain.discovery.scheduler import (
    DiscoveryRun,
    DiscoveryRunCounts,
    DiscoveryRunProgress,
    DiscoverySchedule,
    DiscoveryScheduler,
    ScheduledSource,
    SourceQualitySnapshot,
)
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.source_registry import SourceKind, SourcePriority, SourceState
from jobctrl.domain.errors import (
    AttemptBudgetExhaustedError,
    LlmTransientError,
    SourceUnavailableError,
    TransientNetworkError,
)
from jobctrl.domain.enrichment import (
    EnrichmentExecutionLease,
    StaleEnrichmentExecutionLease,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.enrichment.execution_lease import (
    claim_enrichment_execution_lease,
    fence_enrichment_execution_lease,
)
from jobctrl.infrastructure.discovery.sqlite_run_repository import (
    SqliteDiscoveryRunRepository,
)
from jobctrl.infrastructure.workflow_run_context import current_workflow_id
from jobctrl.infrastructure.discovery.production_wiring import (
    enqueue_manual_action_for_sources,
    retire_invalid_source_jobs,
    run_scheduled_ats_sources,
    seed_discovery_control_queues,
)
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctrl.operational_metrics import record_operational_attempt_metric
from jobctrl.infrastructure.observability.source_spans import discovery_run_span
from jobctrl.state import (
    record_job_event,
    utc_now,
)

log = logging.getLogger(__name__)
console = Console()

_PIPELINE_JOB_ID = "pipeline"


# ---------------------------------------------------------------------------
# Stage definitions
# ---------------------------------------------------------------------------

PRIMARY_STAGE_ORDER = ("discover",)
MAINTENANCE_STAGE_ORDER = ("score", "tailor", "cover")
STAGE_ORDER = PRIMARY_STAGE_ORDER
SUPPORTED_STAGE_ORDER = (*PRIMARY_STAGE_ORDER, *MAINTENANCE_STAGE_ORDER)
INTERNAL_STAGE_ORDER = ("discover", "enrich", *MAINTENANCE_STAGE_ORDER)

STAGE_META: dict[str, dict] = {
    "discover": {"desc": "Job discovery + detail enrichment"},
    "enrich":   {"desc": "Detail enrichment (full descriptions + apply URLs)"},
    "score":    {"desc": "LLM scoring (fit 1-10)"},
    "tailor":   {"desc": "Resume tailoring (LLM + validation + resume PDF)"},
    "cover":    {"desc": "Cover letter generation + cover PDF"},
}

# ---------------------------------------------------------------------------
# Observability helpers
# ---------------------------------------------------------------------------

def _pipeline_tracer():
    return trace.get_tracer("jobctrl.pipeline")


def _current_workflow_id() -> str | None:
    """Canonical workflow id owning this stage execution, if any.

    Resolved through :mod:`jobctrl.infrastructure.workflow_run_context`, which
    ``run_blocking_with_heartbeat`` binds from the enclosing Temporal activity.
    """
    return current_workflow_id()


def _record_pipeline_event(
    stage: str,
    event_type: str,
    level: str,
    message: str,
    payload: dict[str, Any] | None = None,
    *,
    activity_lease: EnrichmentExecutionLease | None = None,
) -> None:
    """Emit a durable pipeline-level event plus a short Langfuse event observation."""
    now = utc_now()
    enriched = _pipeline_event_payload(stage, event_type, now, payload)
    if activity_lease is None:
        _record_pipeline_observation_event(stage, event_type, level, message, enriched)

    conn = None
    try:
        conn = get_connection()
        if activity_lease is not None:
            fence_enrichment_execution_lease(conn, activity_lease)
            _record_pipeline_observation_event(stage, event_type, level, message, enriched)
        record_job_event(
            conn,
            None,
            stage,
            event_type,
            level=level,
            message=message,
            payload=enriched,
        )
        conn.commit()
    except StaleEnrichmentExecutionLease:
        raise
    except Exception:
        if activity_lease is not None and conn is not None:
            conn.rollback()
        log.exception("Failed to record pipeline event %s for stage %s", event_type, stage)


def _record_operational_attempt(
    *,
    stage: str,
    attempt_kind: str,
    outcome: str,
    source_id: str | None = None,
    source_kind: str | None = None,
    source_priority: str | None = None,
    source_role: str | None = None,
    adapter: str | None = None,
    run_id: str | None = None,
    job_url: str | None = None,
    duration_ms: int | None = None,
    counts: dict[str, Any] | None = None,
    error_class: str | None = None,
    error_message: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    try:
        conn = get_connection()
        record_operational_attempt_metric(
            conn,
            stage=stage,
            attempt_kind=attempt_kind,
            outcome=outcome,
            source_id=source_id,
            source_kind=source_kind,
            source_priority=source_priority,
            source_role=source_role,
            adapter=adapter,
            run_id=run_id,
            job_url=job_url,
            duration_ms=duration_ms,
            counts=counts,
            error_class=error_class,
            error_message=error_message,
            metadata=metadata,
        )
        conn.commit()
    except Exception:
        log.exception("Failed to record operational attempt metric for %s/%s", stage, attempt_kind)


def _pipeline_event_payload(
    stage: str,
    event_type: str,
    occurred_at: str,
    payload: dict[str, Any] | None,
) -> dict[str, Any]:
    enriched: dict[str, Any] = {
        "jobId": _PIPELINE_JOB_ID,
        "stage": stage,
        "component": "pipeline",
        **(payload or {}),
    }
    workflow_id = _current_workflow_id()
    if workflow_id:
        enriched.setdefault("workflowId", workflow_id)
        enriched.setdefault("workflow_id", workflow_id)
    if event_type == "StageStarted":
        enriched.setdefault("attemptNumber", int(enriched.get("passNumber") or 1))
        enriched.setdefault("startedAt", occurred_at)
    elif event_type == "StageCompleted":
        enriched.setdefault("finishedAt", occurred_at)
        enriched.setdefault("durationMs", int(enriched.get("durationMs") or 0))
    elif event_type == "StageFailed":
        enriched.setdefault("errorCode", "pipeline_stage_failed")
        enriched.setdefault("errorMessage", str(enriched.get("error") or "Pipeline stage failed"))
        enriched.setdefault("retryable", True)
        enriched.setdefault("attemptNumber", int(enriched.get("passNumber") or 1))
    return enriched


def _discovery_progress_payload(
    *,
    completed: int,
    total: int,
    current_step: str,
    status: str = "running",
    message: str | None = None,
    source_progress: DiscoveryRunProgress | None = None,
) -> dict[str, Any]:
    bounded_total = max(1, total)
    bounded_completed = min(max(0, completed), bounded_total)
    source_fraction = 0.0
    if source_progress is not None and source_progress.total > 0:
        source_fraction = min(max(0.0, source_progress.completed / source_progress.total), 1.0)
    percent = round(((bounded_completed + source_fraction) / bounded_total) * 100)
    if (
        percent == 0
        and status == "running"
        and source_progress is not None
        and source_progress.completed > 0
        and source_progress.total > 0
    ):
        percent = 1
    progress: dict[str, Any] = {
        "completed": bounded_completed,
        "total": bounded_total,
        "percent": percent,
        "currentStep": current_step,
        "status": status,
    }
    if message:
        progress["message"] = message
    if source_progress is not None:
        progress["sourceProgress"] = source_progress.to_dict()
    return {"progress": progress}


def _record_pipeline_observation_event(
    stage: str,
    event_type: str,
    level: str,
    message: str,
    payload: dict[str, Any],
) -> None:
    try:
        with _pipeline_tracer().start_as_current_span(f"pipeline.event.{stage}.{event_type}") as span:
            _set_pipeline_span_attributes(span, stage, observation_type="event")
            span.set_attribute("jobctrl.pipeline.event_type", event_type)
            span.set_attribute("jobctrl.pipeline.message", message)
            span.set_attribute("langfuse.observation.level", _langfuse_level(level))
            span.set_attribute("langfuse.observation.status_message", message)
            for key, value in payload.items():
                if isinstance(value, str | int | float | bool):
                    span.set_attribute(f"langfuse.observation.metadata.{key}", value)
    except Exception:
        log.debug("Failed to emit pipeline OTel event for %s/%s", stage, event_type, exc_info=True)


def _set_pipeline_span_attributes(span, stage: str, *, observation_type: str = "span") -> None:  # type: ignore[no-untyped-def]
    span.set_attribute("jobctrl.pipeline.stage", stage)
    span.set_attribute("jobctrl.pipeline.job_id", _PIPELINE_JOB_ID)
    span.set_attribute("langfuse.trace.name", "jobctrl.pipeline")
    span.set_attribute("langfuse.observation.type", observation_type)
    span.set_attribute("langfuse.observation.metadata.stage", stage)
    span.set_attribute("langfuse.observation.metadata.job_id", _PIPELINE_JOB_ID)


def _langfuse_level(level: str) -> str:
    normalized = level.strip().lower()
    if normalized == "error":
        return "ERROR"
    if normalized in {"warn", "warning"}:
        return "WARNING"
    if normalized == "debug":
        return "DEBUG"
    return "DEFAULT"


def _stage_status(stage: str, result: dict[str, Any] | None) -> str:
    status = "ok"
    if isinstance(result, dict):
        status = str(result.get("status", "ok"))
        if stage == "discover":
            sub_errors = [
                f"{k}: {v}" for k, v in result.items()
                if isinstance(v, str) and v.startswith(("error", "stuck"))
            ]
            if sub_errors:
                enrichment_status = str(result.get("enrichment", "ok"))
                if enrichment_status.startswith(("error", "stuck")):
                    status = enrichment_status
                else:
                    status = "partial"
    return status


def _stage_counts(result: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {}
    counts = result.get("counts")
    if isinstance(counts, dict):
        return counts
    return result


def _run_stage_observed(
    stage: str,
    runner: _StageRunner,
    kwargs: dict[str, Any],
    *,
    mode: str,
    pass_number: int = 1,
) -> tuple[dict[str, Any], float, str]:
    """Run one pipeline stage with durable events and Langfuse-compatible spans."""
    started = utc_now()
    _record_pipeline_event(
        stage,
        "StageStarted",
        "info",
        f"{stage} stage started",
        {"mode": mode, "passNumber": pass_number, "startedAt": started},
    )
    _record_operational_attempt(
        stage=stage,
        attempt_kind="pipeline_stage",
        outcome="started",
        metadata={"mode": mode, "passNumber": pass_number},
    )
    t0 = time.time()
    with _pipeline_tracer().start_as_current_span(f"pipeline.stage.{stage}") as span:
        _set_pipeline_span_attributes(span, stage)
        span.set_attribute("jobctrl.pipeline.mode", mode)
        span.set_attribute("jobctrl.pipeline.pass_number", pass_number)
        try:
            result = runner(**kwargs)
        except Exception as exc:
            elapsed = time.time() - t0
            duration_ms = int(elapsed * 1000)
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            _record_pipeline_event(
                stage,
                "StageFailed",
                "error",
                f"{stage} stage failed: {exc}",
                {
                    "mode": mode,
                    "passNumber": pass_number,
                    "durationMs": duration_ms,
                    "error": str(exc),
                    "errorCode": type(exc).__name__,
                    "errorMessage": str(exc),
                },
            )
            _record_operational_attempt(
                stage=stage,
                attempt_kind="pipeline_stage",
                outcome="failed",
                duration_ms=duration_ms,
                error_class=type(exc).__name__,
                error_message=str(exc),
                metadata={"mode": mode, "passNumber": pass_number},
            )
            raise

        elapsed = time.time() - t0
        duration_ms = int(elapsed * 1000)
        status = _stage_status(stage, result)
        span.set_attribute("jobctrl.pipeline.status", status)
        span.set_attribute("jobctrl.pipeline.duration_ms", duration_ms)
        if status not in ("ok", "partial", "skipped"):
            span.set_status(Status(StatusCode.ERROR, status))
            error_class = str(result.get("error_class") or "stage_status_failed") if isinstance(result, dict) else "stage_status_failed"
            error_message = str(result.get("error_message") or status) if isinstance(result, dict) else status
            _record_pipeline_event(
                stage,
                "StageFailed",
                "error",
                f"{stage} stage failed: {status}",
                {
                    "mode": mode,
                    "passNumber": pass_number,
                    "durationMs": duration_ms,
                    "error": status,
                    "errorCode": error_class,
                    "errorMessage": error_message,
                },
            )
            _record_operational_attempt(
                stage=stage,
                attempt_kind="pipeline_stage",
                outcome="failed",
                duration_ms=duration_ms,
                counts=_stage_counts(result),
                error_class=error_class,
                error_message=error_message,
                metadata={"mode": mode, "passNumber": pass_number, "status": status},
            )
        else:
            _record_pipeline_event(
                stage,
                "StageCompleted",
                "warn" if status == "partial" else "info",
                f"{stage} stage {status}",
                {
                    "mode": mode,
                    "passNumber": pass_number,
                    "durationMs": duration_ms,
                    "status": status,
                },
            )
            _record_operational_attempt(
                stage=stage,
                attempt_kind="pipeline_stage",
                outcome="partial" if status == "partial" else ("skipped" if status == "skipped" else "succeeded"),
                duration_ms=duration_ms,
                counts=_stage_counts(result),
                metadata={"mode": mode, "passNumber": pass_number, "status": status},
            )
        return result, elapsed, status


def _run_discovery_source(
    source: str,
    label: str,
    scheduled_sources: tuple[ScheduledSource, ...],
    run: Callable[[], Any],
    *,
    progress_completed: int | None = None,
    progress_total: int | None = None,
) -> str:
    runnable = tuple(item for item in scheduled_sources if item.should_run)
    if not runnable:
        reason = scheduled_sources[0].reason if scheduled_sources else "not scheduled"
        return _record_skipped_discovery_run(
            source,
            label,
            scheduled_sources,
            reason,
            progress_completed=progress_completed,
            progress_total=progress_total,
        )

    source_ids = tuple(item.source_id for item in runnable)
    run_id = f"discovery:{source}:{uuid.uuid4().hex}"
    started_at = utc_now()
    conn = get_connection()
    run_repo = SqliteDiscoveryRunRepository(conn)
    workflow_id = _current_workflow_id()
    _record_source_state_changes(conn, scheduled_sources)
    discovery_run = DiscoveryRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=run_id,
        source_ids=source_ids,
        profile_snapshot_id=None,
        started_at=started_at,
        workflow_id=workflow_id,
    )
    run_repo.save(discovery_run)
    _record_discovery_run_event(
        conn,
        "DiscoveryRunStarted",
        {
            "run_id": run_id,
            "runId": run_id,
            "source_ids": list(source_ids),
            "sourceIds": list(source_ids),
            "profile_snapshot_id": None,
            "profileSnapshotId": None,
            "started_at": started_at,
            "startedAt": started_at,
        },
        message=f"Discovery run {run_id} started",
        occurred_at=started_at,
    )

    _record_pipeline_event(
        "discover",
        "StageStarted",
        "info",
        f"Discovery source {source} started",
        {
            "source": source,
            "sourceLabel": label,
            "runId": run_id,
            "sourceIds": list(source_ids),
            **(
                _discovery_progress_payload(
                    completed=progress_completed,
                    total=progress_total,
                    current_step=label,
                    message=f"{label} started",
                )
                if progress_completed is not None and progress_total is not None
                else {}
            ),
        },
    )
    _record_discovery_source_attempts(
        source,
        scheduled_sources,
        "started",
        run_id=run_id,
    )
    t0 = time.time()
    with (
        _pipeline_tracer().start_as_current_span(f"pipeline.source.discover.{source}") as span,
        discovery_run_span(
            tenant_id=str(LOCAL_TENANT),
            run_id=run_id,
            source_ids=source_ids,
            profile_snapshot_id=None,
        ),
    ):
        _set_pipeline_span_attributes(span, "discover")
        span.set_attribute("jobctrl.pipeline.source", source)
        span.set_attribute("jobctrl.discovery.run_id", run_id)
        try:
            result = _call_discovery_source(run, run_id)
        except Exception as exc:
            elapsed = time.time() - t0
            duration_ms = int(elapsed * 1000)
            log.error("%s failed: %s", label, exc)
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            failed_at = utc_now()
            failed_run = discovery_run.fail(
                error_class=type(exc).__name__,
                failed_at=failed_at,
            )
            run_repo.save(failed_run)
            failed_source_ids = _failed_source_ids_from_exception(exc, source_ids)
            for failed_source_id in failed_source_ids:
                _record_discovery_run_event(
                    conn,
                    "DiscoveryRunFailed",
                    {
                        "run_id": run_id,
                        "runId": run_id,
                        "source_id": failed_source_id,
                        "sourceId": failed_source_id,
                        "source_ids": list(source_ids),
                        "sourceIds": list(source_ids),
                        "error_class": type(exc).__name__,
                        "errorClass": type(exc).__name__,
                        "retryable": True,
                        "failed_at": failed_at,
                        "failedAt": failed_at,
                    },
                    level="error",
                    message=f"Discovery run {run_id} failed: {exc}",
                    occurred_at=failed_at,
                )
            _record_discovery_source_attempts(
                source,
                scheduled_sources,
                "failed",
                run_id=run_id,
                duration_ms=duration_ms,
                failed_source_ids=failed_source_ids,
                error_class=type(exc).__name__,
                error_message=str(exc),
            )
            _record_pipeline_event(
                "discover",
                "StageFailed",
                "error",
                f"Discovery source {source} failed: {exc}",
                {
                    "source": source,
                    "sourceLabel": label,
                    "runId": run_id,
                    "sourceIds": list(source_ids),
                    "durationMs": duration_ms,
                    "error": str(exc),
                    "errorCode": type(exc).__name__,
                    "errorMessage": str(exc),
                    **(
                        _discovery_progress_payload(
                            completed=progress_completed + 1,
                            total=progress_total,
                            current_step=label,
                            status="failed",
                            message=f"{label} failed",
                        )
                        if progress_completed is not None and progress_total is not None
                        else {}
                    ),
                },
            )
            raise SourceUnavailableError(f"{label} failed: {exc}") from exc

        elapsed = time.time() - t0
        duration_ms = int(elapsed * 1000)
        counts = DiscoveryRunCounts.from_result(result)
        failed_source_ids = _failed_source_ids_from_result(result)
        completed_at = utc_now()
        completed_run = discovery_run.complete(
            counts=counts,
            error_classes=("partial_source_failure",) if failed_source_ids else (),
            completed_at=completed_at,
        )
        run_repo.save(completed_run)
        _record_discovery_run_event(
            conn,
            "DiscoveryRunCompleted",
            {
                "run_id": run_id,
                "runId": run_id,
                "counts": {
                    **counts.to_dict(),
                    "newJobs": counts.new_jobs,
                    "existingJobs": counts.existing_jobs,
                    "observedJobs": counts.observed_jobs,
                    "duplicateJobs": counts.duplicate_jobs,
                    "rejectedDuplicates": counts.rejected_duplicates,
                },
                "error_classes": ["partial_source_failure"] if failed_source_ids else [],
                "errorClasses": ["partial_source_failure"] if failed_source_ids else [],
                "failed_source_ids": failed_source_ids,
                "failedSourceIds": failed_source_ids,
                "completed_at": completed_at,
                "completedAt": completed_at,
            },
            message=f"Discovery run {run_id} completed",
            occurred_at=completed_at,
        )
        status = "ok"
        span.set_attribute("jobctrl.pipeline.source_status", status)
        span.set_attribute("jobctrl.discovery.result.total", counts.total)
        span.set_attribute("jobctrl.discovery.result.new_jobs", counts.new_jobs)
        _record_discovery_source_attempts(
            source,
            scheduled_sources,
            "partial_failed" if failed_source_ids else "succeeded",
            run_id=run_id,
            duration_ms=duration_ms,
            counts=counts.to_dict(),
            failed_source_ids=failed_source_ids,
            error_class="partial_source_failure" if failed_source_ids else None,
            error_message="One or more scheduled sources failed." if failed_source_ids else None,
        )
        _record_pipeline_event(
            "discover",
            "StageCompleted",
            "info",
            f"Discovery source {source} {status}",
            {
                "source": source,
                "sourceLabel": label,
                "runId": run_id,
                "sourceIds": list(source_ids),
                "durationMs": duration_ms,
                "status": status,
                **(
                    _discovery_progress_payload(
                        completed=progress_completed + 1,
                        total=progress_total,
                        current_step=label,
                        message=f"{label} complete",
                    )
                    if progress_completed is not None and progress_total is not None
                    else {}
                ),
            },
        )
        return status


def _record_discovery_source_attempts(
    adapter: str,
    scheduled_sources: tuple[ScheduledSource, ...],
    outcome: str,
    *,
    run_id: str,
    duration_ms: int | None = None,
    counts: dict[str, Any] | None = None,
    failed_source_ids: list[str] | None = None,
    error_class: str | None = None,
    error_message: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    failed = set(failed_source_ids or [])
    for source in scheduled_sources:
        if not source.should_run and outcome == "started":
            continue
        if not source.should_run:
            terminal_outcome = "skipped"
        elif source.source_id in failed:
            terminal_outcome = "failed"
        else:
            terminal_outcome = outcome
        if outcome == "partial_failed" and source.source_id not in failed and source.should_run:
            terminal_outcome = "succeeded"
        _record_operational_attempt(
            stage="discover",
            attempt_kind="discovery_source",
            outcome=terminal_outcome,
            source_id=source.source_id,
            source_kind=source.source_kind.value,
            source_priority=source.priority.value,
            source_role=_source_role(source),
            adapter=adapter,
            run_id=run_id,
            duration_ms=duration_ms,
            counts=counts,
            error_class=error_class if terminal_outcome in {"failed", "partial_failed"} else None,
            error_message=error_message if terminal_outcome in {"failed", "partial_failed"} else None,
            metadata={
                "decision": source.decision,
                "reason": source.reason,
                **(metadata or {}),
            },
        )


def _record_discovery_source_progress(
    *,
    source: str,
    label: str,
    run_id: str,
    source_ids: tuple[str, ...],
    progress_completed: int,
    progress_total: int,
    source_progress: DiscoveryRunProgress,
    message: str,
) -> None:
    now = utc_now()
    counts = DiscoveryRunCounts(
        total=source_progress.raw_total if source_progress.raw_total is not None else 0,
        new_jobs=source_progress.new_jobs if source_progress.new_jobs is not None else 0,
        existing_jobs=source_progress.existing_jobs if source_progress.existing_jobs is not None else 0,
    )
    try:
        temporal_activity.heartbeat(source_progress.to_dict())
    except RuntimeError:
        pass
    try:
        conn = get_connection()
        SqliteDiscoveryRunRepository(conn).save_progress(
            tenant_id=LOCAL_TENANT,
            run_id=run_id,
            counts=counts,
            progress=source_progress,
            updated_at=now,
            workflow_id=_current_workflow_id(),
        )
        conn.commit()
    except Exception:
        log.exception("Failed to persist discovery source progress for %s", run_id)

    _record_pipeline_event(
        "discover",
        "StageProgress",
        "info",
        message,
        {
            "source": source,
            "sourceLabel": label,
            "runId": run_id,
            "sourceIds": list(source_ids),
            **_discovery_progress_payload(
                completed=progress_completed,
                total=progress_total,
                current_step=label,
                message=message,
                source_progress=source_progress,
            ),
        },
    )


def _source_role(source: ScheduledSource) -> str:
    if source.priority == SourcePriority.LEAD_GENERATOR or source.source_kind == SourceKind.BROAD_BOARD:
        return "lead_generator"
    if source.priority == SourcePriority.CANONICAL or source.source_kind in {SourceKind.ATS_API, SourceKind.OFFICIAL_API}:
        return "canonical_source"
    if source.source_kind == SourceKind.USER_MEDIATED_CAPTURE:
        return "user_mediated"
    return "fallback_source"


def _call_discovery_source(run: Callable[..., Any], run_id: str) -> Any:
    try:
        signature = inspect.signature(run)
    except (TypeError, ValueError):
        return run()
    accepts_run_id = (
        "run_id" in signature.parameters
        or any(
            param.kind is inspect.Parameter.VAR_KEYWORD
            for param in signature.parameters.values()
        )
    )
    if accepts_run_id:
        return run(run_id=run_id)
    return run()


def _failed_source_ids_from_result(result: Any) -> list[str]:
    if not isinstance(result, dict):
        return []
    raw = None
    for key in ("failed_source_ids", "failedSourceIds", "failed_sources", "failedSources"):
        raw = result.get(key)
        if raw:
            break
    if not isinstance(raw, (list, tuple)):
        return []
    return [str(source_id) for source_id in raw if str(source_id)]


def _failed_source_ids_from_exception(exc: Exception, source_ids: tuple[str, ...]) -> list[str]:
    for attr in ("failed_source_ids", "failedSourceIds", "failed_sources", "failedSources", "source_id"):
        raw = getattr(exc, attr, None)
        if not raw:
            continue
        if isinstance(raw, str):
            return [raw]
        if isinstance(raw, (list, tuple, set)):
            return [str(source_id) for source_id in raw if str(source_id)]
    return list(source_ids)


def _record_skipped_discovery_run(
    source: str,
    label: str,
    scheduled_sources: tuple[ScheduledSource, ...],
    reason: str,
    *,
    progress_completed: int | None = None,
    progress_total: int | None = None,
) -> str:
    source_ids = tuple(item.source_id for item in scheduled_sources) or (source,)
    run_id = f"discovery:{source}:{uuid.uuid4().hex}"
    started_at = utc_now()
    completed_at = started_at
    conn = get_connection()
    run_repo = SqliteDiscoveryRunRepository(conn)
    _record_source_state_changes(conn, scheduled_sources)
    discovery_run = DiscoveryRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=run_id,
        source_ids=source_ids,
        profile_snapshot_id=None,
        started_at=started_at,
    )
    completed_run = discovery_run.complete(
        counts=DiscoveryRunCounts(),
        error_classes=("scheduler_skip",),
        completed_at=completed_at,
    )
    run_repo.save(completed_run)
    _record_discovery_run_event(
        conn,
        "DiscoveryRunStarted",
        {
            "run_id": run_id,
            "runId": run_id,
            "source_ids": list(source_ids),
            "sourceIds": list(source_ids),
            "profile_snapshot_id": None,
            "profileSnapshotId": None,
            "started_at": started_at,
            "startedAt": started_at,
        },
        message=f"Discovery run {run_id} started",
        occurred_at=started_at,
    )
    _record_discovery_run_event(
        conn,
        "DiscoveryRunCompleted",
        {
            "run_id": run_id,
            "runId": run_id,
            "counts": {
                "total": 0,
                "new_jobs": 0,
                "existing_jobs": 0,
                "observed_jobs": 0,
                "duplicate_jobs": 0,
                "rejected_duplicates": 0,
                "newJobs": 0,
                "existingJobs": 0,
                "observedJobs": 0,
                "duplicateJobs": 0,
                "rejectedDuplicates": 0,
            },
            "error_classes": ["scheduler_skip"],
            "errorClasses": ["scheduler_skip"],
            "skipped": True,
            "skip_reason": reason,
            "skipReason": reason,
            "completed_at": completed_at,
            "completedAt": completed_at,
        },
        message=f"Discovery run {run_id} skipped: {reason}",
        occurred_at=completed_at,
    )
    _record_discovery_source_attempts(
        source,
        scheduled_sources,
        "skipped",
        run_id=run_id,
        counts={"total": 0, "new_jobs": 0, "existing_jobs": 0, "observed_jobs": 0, "duplicate_jobs": 0},
        metadata={"skipReason": reason, "status": _skip_status(reason)},
    )
    return _skip_discovery_source(
        source,
        label,
        reason,
        run_id=run_id,
        source_ids=source_ids,
        record_metric=False,
        progress_completed=progress_completed,
        progress_total=progress_total,
    )


def _skip_discovery_source(
    source: str,
    label: str,
    reason: str,
    *,
    run_id: str | None = None,
    source_ids: tuple[str, ...] = (),
    record_metric: bool = True,
    progress_completed: int | None = None,
    progress_total: int | None = None,
) -> str:
    status = _skip_status(reason)
    payload: dict[str, Any] = {
        "source": source,
        "sourceLabel": label,
        "status": status,
        "reason": reason,
    }
    if run_id:
        payload["runId"] = run_id
    if source_ids:
        payload["sourceIds"] = list(source_ids)
    if progress_completed is not None and progress_total is not None:
        payload.update(
            _discovery_progress_payload(
                completed=progress_completed + 1,
                total=progress_total,
                current_step=label,
                message=f"{label} skipped: {reason}",
            )
        )
    _record_pipeline_event(
        "discover",
        "StageCompleted",
        "info",
        f"Discovery source {source} skipped: {reason}",
        payload,
    )
    if record_metric:
        _record_operational_attempt(
            stage="discover",
            attempt_kind="discovery_source",
            outcome="skipped",
            adapter=source,
            run_id=run_id,
            counts={"total": 0, "new_jobs": 0, "existing_jobs": 0, "observed_jobs": 0, "duplicate_jobs": 0},
            metadata={"skipReason": reason, "status": status, "sourceIds": list(source_ids)},
        )
    return status


def _skip_status(reason: str) -> str:
    normalized = reason.lower()
    if "disabled" in normalized:
        return "skipped_disabled"
    quality_reasons = ("failure", "active rate", "duplicate rate", "detail success")
    if any(reason in normalized for reason in quality_reasons):
        return "skipped_quality"
    return "skipped_limit"


def _record_source_state_changes(
    conn: Any,
    scheduled_sources: tuple[ScheduledSource, ...],
) -> None:
    changed = False
    for source in scheduled_sources:
        target = _recommended_source_state(source)
        if target is None or target == source.configured_state:
            continue
        if _latest_recorded_source_state(conn, source.source_id) == target.value:
            continue
        changed_at = utc_now()
        record_job_event(
            conn,
            None,
            "discover",
            "SourceStateChanged",
            level="info",
            message=f"Source {source.source_id} state changed to {target.value}: {source.reason}",
            payload={
                "tenantId": str(LOCAL_TENANT),
                "source_id": source.source_id,
                "sourceId": source.source_id,
                "from_state": source.configured_state.value,
                "fromState": source.configured_state.value,
                "to_state": target.value,
                "toState": target.value,
                "reason": source.reason,
                "changed_at": changed_at,
                "changedAt": changed_at,
            },
            occurred_at=changed_at,
        )
        changed = True
    if changed:
        conn.commit()


def _recommended_source_state(source: ScheduledSource) -> SourceState | None:
    if source.recommended_state == SourceState.DISABLED.value:
        return SourceState.DISABLED
    if source.recommended_state == SourceState.QUARANTINED.value:
        return SourceState.QUARANTINED
    return None


def _latest_recorded_source_state(conn: Any, source_id: str) -> str | None:
    rows = conn.execute(
        """
        SELECT payload_json
        FROM job_events
        WHERE event_type = 'SourceStateChanged'
        ORDER BY event_id DESC
        """
    ).fetchall()
    for row in rows:
        payload_json = _row_get(row, "payload_json", 0)
        if not payload_json:
            continue
        try:
            payload = json.loads(str(payload_json))
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        if payload.get("sourceId") == source_id or payload.get("source_id") == source_id:
            value = payload.get("toState") or payload.get("to_state")
            return str(value) if value else None
    return None


def _record_discovery_run_event(
    conn: Any,
    event_type: str,
    payload: dict[str, Any],
    *,
    level: str = "info",
    message: str,
    occurred_at: str,
) -> None:
    record_job_event(
        conn,
        None,
        "discover",
        event_type,
        level=level,
        message=message,
        payload={"tenantId": str(LOCAL_TENANT), **payload},
        occurred_at=occurred_at,
    )
    conn.commit()


def _pipeline_job_count() -> int:
    try:
        conn = get_connection()
        row = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()
        return int(row[0] or 0) if row else 0
    except Exception:
        log.debug("Failed to count jobs for bounded discover limit", exc_info=True)
        return 0


def _discover_limit_reached(start_count: int, limit: int) -> bool:
    return limit > 0 and _pipeline_job_count() - start_count >= limit


def _discovery_new_result_count(result: Any) -> int:
    if not isinstance(result, dict):
        return 0
    count = 0
    for key in ("new", "total_new", "new_jobs"):
        count += int(result.get(key) or 0)
    return count


def _discover_limit_consumed(start_count: int, limit: int, source_result: Any = None) -> bool:
    if limit <= 0:
        return False
    if _discovery_new_result_count(source_result) >= limit:
        return True
    return _discover_limit_reached(start_count, limit)


def _discover_remaining_limit(start_count: int, limit: int) -> int:
    if limit <= 0:
        return 0
    return max(limit - (_pipeline_job_count() - start_count), 0)


def _load_source_quality_snapshots() -> tuple[SourceQualitySnapshot, ...]:
    try:
        conn = get_connection()
        rows = conn.execute(
            """
            SELECT source_id, observed_jobs, new_jobs, existing_jobs,
                   duplicate_jobs, failed_run_count, consecutive_failures,
                   active_verification_rate, full_description_success_rate,
                   duplicate_rate, recommended_state
            FROM source_quality_stats
            """
        ).fetchall()
    except Exception:
        log.debug("Failed to load source quality stats for scheduling", exc_info=True)
        return ()
    snapshots: list[SourceQualitySnapshot] = []
    for row in rows:
        snapshots.append(
            SourceQualitySnapshot(
                source_id=str(_row_get(row, "source_id", 0) or ""),
                observed_jobs=int(_row_get(row, "observed_jobs", 1) or 0),
                new_jobs=int(_row_get(row, "new_jobs", 2) or 0),
                existing_jobs=int(_row_get(row, "existing_jobs", 3) or 0),
                duplicate_jobs=int(_row_get(row, "duplicate_jobs", 4) or 0),
                failed_runs=int(_row_get(row, "failed_run_count", 5) or 0),
                consecutive_failures=int(_row_get(row, "consecutive_failures", 6) or 0),
                active_rate=_optional_float(_row_get(row, "active_verification_rate", 7)),
                detail_success_rate=_optional_float(
                    _row_get(row, "full_description_success_rate", 8)
                ),
                duplicate_rate=_optional_float(_row_get(row, "duplicate_rate", 9)),
                recommended_state=str(_row_get(row, "recommended_state", 10) or "normal"),
            )
        )
    return tuple(snapshots)


def _plan_discovery_schedule(
    limit: int,
    *,
    source_ids: tuple[str, ...] = (),
    search_cfg: dict[str, Any] | None = None,
) -> DiscoverySchedule:
    scheduler = DiscoveryScheduler()
    registry = config.load_source_registry(search_cfg=search_cfg)
    if source_ids:
        selected = set(source_ids)
        registry = [entry for entry in registry if entry.source_id in selected]
    # An explicit manual selection is an operator override of adaptive quality
    # demotion. The configured registry state still applies (so hard-disabled
    # sources remain disabled), but stale failure history must not silently
    # turn a requested production crawl into ``skipped_quality``.
    quality = () if source_ids else _load_source_quality_snapshots()
    return scheduler.plan(
        registry=registry,
        quality=quality,
        global_limit=limit,
    )


def _scheduled_limit(schedule: DiscoverySchedule, prefix: str, user_limit: int) -> int:
    budget = schedule.budget_for_prefix(prefix)
    if user_limit > 0:
        return min(user_limit, budget) if budget > 0 else 0
    return budget


def _scheduled_limit_for_sources(sources: tuple[ScheduledSource, ...], user_limit: int) -> int:
    budget = sum(source.crawl_budget for source in sources if source.should_run)
    if user_limit > 0:
        return min(user_limit, budget) if budget > 0 else 0
    return budget


def _jobspy_config_for_sources(search_cfg: dict, sources: tuple[ScheduledSource, ...]) -> dict:
    boards: list[str] = []
    for source in sources:
        if not source.should_run:
            continue
        board = str(source.adapter_config.get("board") or "").strip()
        if board:
            boards.append(board)
    return {**search_cfg, "boards": boards}


def _workday_employers_for_sources(sources: tuple[ScheduledSource, ...]) -> dict:
    employers_cfg = config.load_employers_config()
    employers = employers_cfg.get("employers", {}) if isinstance(employers_cfg, dict) else {}
    if not isinstance(employers, dict):
        return {}
    selected: dict[str, object] = {}
    for source in sources:
        if not source.should_run:
            continue
        employer_key = str(source.adapter_config.get("employer_key") or "").strip()
        if employer_key and employer_key in employers:
            employer_config = dict(employers[employer_key])
            employer_config["_source_id"] = source.source_id
            selected[employer_key] = employer_config
    return selected


def _smart_extract_sources(schedule: DiscoverySchedule) -> tuple[ScheduledSource, ...]:
    source_ids = {source.source_id for source in schedule.for_prefix("smart_extract")}
    sources = list(schedule.for_prefix("smart_extract"))
    for source in schedule.for_kinds(
        SourceKind.SMART_EXTRACT,
        SourceKind.EMPLOYER_CAREERS_PAGE,
        SourceKind.NICHE_BOARD,
    ):
        if source.source_id not in source_ids:
            sources.append(source)
            source_ids.add(source.source_id)
    return tuple(sources)


def _smart_extract_sites(sources: tuple[ScheduledSource, ...]) -> list[dict]:
    sites: list[dict] = []
    for source in sources:
        if not source.should_run:
            continue
        url = str(
            source.adapter_config.get("url")
            or source.adapter_config.get("seed_url")
            or ""
        ).strip()
        if not url:
            continue
        sites.append(
            {
                "name": str(source.adapter_config.get("name") or source.display_name),
                "url": url,
                "type": _smart_extract_site_type(source.adapter_config, url),
                "query_mode": _smart_extract_query_mode(source.adapter_config, url),
            }
        )
    return sites


def _smart_extract_site_type(adapter_config: dict[str, object], url: str) -> str:
    configured_type = str(adapter_config.get("type") or "").strip()
    if configured_type:
        return configured_type
    if "{query_encoded}" in url or "{query}" in url:
        return "search"
    return "static"


def _smart_extract_query_mode(adapter_config: dict[str, object], url: str) -> str:
    configured_mode = str(adapter_config.get("query_mode") or adapter_config.get("search_mode") or "").strip()
    if configured_mode:
        return configured_mode
    if "{query_encoded}" in url or "{query}" in url:
        return "search_only"
    return "source_first"


def _optional_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _first_present(*values: object) -> object:
    for value in values:
        if value is not None:
            return value
    return None


def _row_get(row: Any, key: str, index: int) -> Any:
    if hasattr(row, "keys") and key in row.keys():
        return row[key]
    return row[index]


DISCOVERY_SOURCE_FAMILIES: tuple[str, ...] = (
    "jobspy",
    "ats_api",
    "workday",
    "smartextract",
)


def plan_discovery_source_families(
    *,
    limit: int = 0,
    source_ids: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Plan the runnable discovery source families in legacy order."""
    conn = init_db()
    search_cfg = config.load_search_config()
    try:
        seed_discovery_control_queues(conn, config.load_source_registry(search_cfg=search_cfg))
    except Exception:
        log.debug("Failed to seed discovery control queues", exc_info=True)

    selected_source_ids = tuple(dict.fromkeys(source_id.strip() for source_id in source_ids if source_id.strip()))
    source_filter_active = bool(selected_source_ids)
    schedule = _plan_discovery_schedule(
        limit,
        source_ids=selected_source_ids,
        search_cfg=search_cfg,
    )
    jobspy_sources = schedule.for_prefix("jobspy")
    ats_sources = tuple(
        source
        for source in schedule.for_kinds(SourceKind.ATS_API)
        if not source.source_id.startswith("workday:")
    )
    workday_sources = schedule.for_prefix("workday")
    smart_extract_sources = _smart_extract_sources(schedule)
    families: list[str] = []
    if not source_filter_active or jobspy_sources:
        families.append("jobspy")
    if ats_sources:
        families.append("ats_api")
    if not source_filter_active or workday_sources:
        families.append("workday")
    if not source_filter_active or smart_extract_sources:
        families.append("smartextract")
    from jobctrl.infrastructure.runtime_identity import latest_active_max_concurrent_activities
    from jobctrl.infrastructure.temporal.concurrency import (
        resolve_max_concurrent_activities,
        resolved_max_parallel_discovery_families,
    )

    active_activity_slots = (
        latest_active_max_concurrent_activities()
        or resolve_max_concurrent_activities().value
    )

    return {
        "families": families,
        "progress_total": len(families) + 2,
        "start_count": _pipeline_job_count() if limit > 0 else 0,
        "max_parallel_families": resolved_max_parallel_discovery_families(
            search_cfg,
            active_activity_slots,
        ),
        "next_run_settings": _snapshot_discovery_next_run_settings(search_cfg),
    }


def run_discovery_hygiene(
    label: str,
    *,
    activity_lease: EnrichmentExecutionLease | None = None,
) -> int:
    conn = get_connection()
    search_cfg = config.load_search_config() or {}
    if activity_lease is not None:
        fence_enrichment_execution_lease(conn, activity_lease)
    try:
        hygiene = retire_invalid_source_jobs(
            conn,
            search_cfg=search_cfg,
            run_id=f"discovery:hygiene:{label}",
            # Exact-schema runtimes already own these tables. Avoid the helper's
            # eager commit so the lease fence and every soft-delete/event remain
            # one SQLite writer transaction.
            ensure_tables=activity_lease is None,
            commit=activity_lease is None,
        )
        if activity_lease is not None:
            conn.commit()
    except Exception:
        if activity_lease is not None:
            conn.rollback()
        raise
    retired = int(hygiene.get("retired_jobs") or 0)
    if retired:
        console.print(f"  [yellow]Discovery hygiene retired {retired} invalid source jobs[/yellow]")
    return retired


def run_discovery_source_family(
    family: str,
    *,
    workers: int = 1,
    limit: int = 0,
    source_ids: tuple[str, ...] = (),
    start_count: int = 0,
    progress_completed: int = 0,
    progress_total: int = 0,
    cancel_event: threading.Event | None = None,
    next_run_settings: dict[str, Any] | None = None,
    discovery_execution: DiscoveryExecutionRef | None = None,
    activity_attempt: int | None = None,
    activity_owner_token: str | None = None,
) -> dict[str, Any]:
    """Run one discovery source family and persist its lifecycle events."""
    selected_source_ids = tuple(dict.fromkeys(source_id.strip() for source_id in source_ids if source_id.strip()))
    source_filter_active = bool(selected_source_ids)
    search_cfg = _apply_discovery_next_run_settings(
        config.load_search_config() or {},
        next_run_settings,
    )
    bounded_workers = max(1, workers)
    provided_cancel_event = cancel_event
    cancel_event = cancel_event or threading.Event()
    conn = get_connection()
    schedule = _plan_discovery_schedule(
        limit,
        source_ids=selected_source_ids,
        search_cfg=search_cfg,
    )
    jobspy_sources = schedule.for_prefix("jobspy")
    ats_sources = tuple(
        source
        for source in schedule.for_kinds(SourceKind.ATS_API)
        if not source.source_id.startswith("workday:")
    )
    workday_sources = schedule.for_prefix("workday")
    smart_extract_sources = _smart_extract_sources(schedule)
    if limit > 0 and family != "jobspy" and _discover_limit_consumed(start_count, limit):
        sources = _sources_for_discovery_family(
            family,
            jobspy_sources=jobspy_sources,
            ats_sources=ats_sources,
            workday_sources=workday_sources,
            smart_extract_sources=smart_extract_sources,
        )
        status = _skip_discovery_source(
            family,
            _discovery_family_label(family),
            "limit reached",
            progress_completed=progress_completed,
            progress_total=progress_total,
        )
        return {"family": family, "status": status, "result": {}, "source_ids": [s.source_id for s in sources]}

    if family == "jobspy":
        if source_filter_active and not jobspy_sources:
            return {"family": family, "status": "skipped", "result": {}, "source_ids": []}

        def run_jobspy(run_id: str | None = None) -> dict:
            if search_cfg.get("disable_jobspy", False):
                console.print("  [dim]Broad-board discovery disabled in settings[/dim]")
                return {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}
            console.print("  [cyan]Broad-board JobStreaming crawl...[/cyan]")
            try:
                from jobctrl.discovery.jobspy import run_discovery
            except ImportError:
                console.print("  [dim]JobStreaming not installed — skipping[/dim]")
                return {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}
            jobspy_cfg = _jobspy_config_for_sources(search_cfg, jobspy_sources)
            if not jobspy_cfg.get("boards"):
                console.print("  [dim]No runnable broad boards scheduled[/dim]")
                return {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}
            run_kwargs: dict[str, Any] = {
                "cfg": jobspy_cfg,
                "limit": _scheduled_limit(schedule, "jobspy", limit),
            }
            if discovery_execution is not None:
                run_kwargs["discovery_execution"] = discovery_execution
                run_kwargs["activity_attempt"] = activity_attempt
                run_kwargs["activity_owner_token"] = activity_owner_token
            _add_supported_discovery_kwargs(
                run_discovery,
                run_kwargs,
                run_id=run_id,
                cancel_event=cancel_event if provided_cancel_event is not None else None,
                progress_callback=_jobspy_progress_callback(
                    run_id=run_id,
                    source_ids=tuple(item.source_id for item in jobspy_sources if item.should_run),
                    progress_completed=progress_completed,
                    progress_total=progress_total,
                ),
            )
            return run_discovery(**run_kwargs)

        result_holder: dict[str, Any] = {}

        def capture_jobstreaming(run_id: str | None = None) -> dict:
            result_holder.update(run_jobspy(run_id))
            return result_holder

        status = _run_discovery_source(
            "jobspy",
            "Broad boards",
            jobspy_sources,
            capture_jobstreaming,
            progress_completed=progress_completed,
            progress_total=progress_total,
        )
        return {
            "family": family,
            "status": status,
            "result": dict(result_holder),
            "source_ids": [s.source_id for s in jobspy_sources],
        }

    if family == "ats_api":
        if not ats_sources:
            return {"family": family, "status": "skipped", "result": {}, "source_ids": []}

        def run_ats(run_id: str | None = None) -> dict:
            console.print("  [cyan]Canonical ATS APIs...[/cyan]")
            result = run_scheduled_ats_sources(
                conn,
                ats_sources,
                search_cfg=search_cfg,
                run_id=run_id or f"discovery:ats_api:{uuid.uuid4().hex}",
                limit=_scheduled_limit_for_sources(
                    ats_sources,
                    _discover_remaining_limit(start_count, limit),
                ),
                **(
                    {"discovery_execution": discovery_execution}
                    if discovery_execution is not None
                    else {}
                ),
                **({"cancel_event": cancel_event} if provided_cancel_event is not None else {}),
            )
            return result

        result_holder: dict[str, Any] = {}

        def capture_ats(run_id: str | None = None) -> dict:
            result_holder.update(run_ats(run_id))
            return result_holder

        status = _run_discovery_source(
            "ats_api",
            "Canonical ATS APIs",
            ats_sources,
            capture_ats,
            progress_completed=progress_completed,
            progress_total=progress_total,
        )
        return {
            "family": family,
            "status": status,
            "result": dict(result_holder),
            "source_ids": [s.source_id for s in ats_sources],
        }

    if family == "workday":
        if source_filter_active and not workday_sources:
            return {"family": family, "status": "skipped", "result": {}, "source_ids": []}

        def run_workday(run_id: str | None = None) -> dict:
            console.print("  [cyan]Workday corporate scraper...[/cyan]")
            from jobctrl.discovery.workday import run_workday_discovery

            workday_kwargs: dict[str, Any] = {
                "employers": _workday_employers_for_sources(workday_sources),
                "workers": bounded_workers,
                "limit": _scheduled_limit(
                    schedule,
                    "workday",
                    _discover_remaining_limit(start_count, limit),
                ),
                "run_id": run_id,
            }
            if discovery_execution is not None:
                workday_kwargs["discovery_execution"] = discovery_execution
            if provided_cancel_event is not None:
                workday_kwargs["cancel_event"] = cancel_event
            return run_workday_discovery(**workday_kwargs)

        result_holder: dict[str, Any] = {}

        def capture_workday(run_id: str | None = None) -> dict:
            result_holder.update(run_workday(run_id))
            return result_holder

        status = _run_discovery_source(
            "workday",
            "Workday scraper",
            workday_sources,
            capture_workday,
            progress_completed=progress_completed,
            progress_total=progress_total,
        )
        return {
            "family": family,
            "status": status,
            "result": dict(result_holder),
            "source_ids": [s.source_id for s in workday_sources],
        }

    if family == "smartextract":
        if source_filter_active and not smart_extract_sources:
            return {"family": family, "status": "skipped", "result": {}, "source_ids": []}

        def run_smart_extract_source(run_id: str | None = None) -> dict:
            console.print("  [cyan]Smart extract (AI-powered scraping)...[/cyan]")
            enqueue_manual_action_for_sources(conn, smart_extract_sources)
            from jobctrl.discovery.smartextract import run_smart_extract

            smart_kwargs: dict[str, Any] = {
                "sites": _smart_extract_sites(smart_extract_sources),
                "workers": bounded_workers,
                "limit": _scheduled_limit_for_sources(
                    smart_extract_sources,
                    _discover_remaining_limit(start_count, limit),
                ),
                "run_id": run_id,
            }
            if discovery_execution is not None:
                smart_kwargs["discovery_execution"] = discovery_execution
            if provided_cancel_event is not None:
                smart_kwargs["cancel_event"] = cancel_event
            return run_smart_extract(**smart_kwargs)

        result_holder: dict[str, Any] = {}

        def capture_smart_extract(run_id: str | None = None) -> dict:
            result_holder.update(run_smart_extract_source(run_id))
            return result_holder

        status = _run_discovery_source(
            "smartextract",
            "Smart extract",
            smart_extract_sources,
            capture_smart_extract,
            progress_completed=progress_completed,
            progress_total=progress_total,
        )
        return {
            "family": family,
            "status": status,
            "result": dict(result_holder),
            "source_ids": [s.source_id for s in smart_extract_sources],
        }

    raise ValueError(f"Unknown discovery source family: {family}")


def _snapshot_discovery_next_run_settings(search_cfg: dict[str, Any]) -> dict[str, Any]:
    """Capture settings whose public activation contract is the next run."""

    defaults = search_cfg.get("defaults")
    defaults = defaults if isinstance(defaults, dict) else {}
    boards = search_cfg.get("boards")
    return {
        "boards": [str(board) for board in boards] if isinstance(boards, list) else [],
        "results_per_site": int(defaults.get("results_per_site") or 50),
        "hours_old": int(defaults.get("hours_old") or 72),
    }


def _apply_discovery_next_run_settings(
    current: dict[str, Any],
    snapshot: dict[str, Any] | None,
) -> dict[str, Any]:
    """Overlay only next-run values; next-source-family fields stay live."""

    if not snapshot:
        return current
    effective = dict(current)
    effective["boards"] = list(snapshot.get("boards") or [])
    defaults = dict(effective.get("defaults") or {})
    defaults["results_per_site"] = int(snapshot.get("results_per_site") or 50)
    defaults["hours_old"] = int(snapshot.get("hours_old") or 72)
    effective["defaults"] = defaults
    return effective


def run_discovery_enrichment_stage(
    *,
    workers: int = 1,
    limit: int = 0,
    cancel_event: threading.Event | None = None,
    progress_completed: int = 0,
    progress_total: int = 0,
    on_job_enriched: Callable[[JobId], None] | None = None,
    stream_while_discovering: bool = False,
    discovery_execution: DiscoveryExecutionRef | None = None,
    recovery_key: str | None = None,
    activity_attempt: int = 1,
    activity_owner_token: str | None = None,
) -> dict[str, Any]:
    emit_progress = progress_total > 0
    result: dict[str, Any] = {}
    discovery_done = threading.Event()
    if stream_while_discovering and discovery_execution is None:
        raise ValueError("streaming discovery enrichment requires an execution scope")
    activity_lease = None
    if discovery_execution is not None and activity_owner_token:
        activity_lease = _claim_execution_enrichment_lease(
            discovery_execution,
            owner_token=activity_owner_token,
            activity_phase=1 if stream_while_discovering else 2,
            activity_attempt=activity_attempt,
        )
        recovered_job_ids = _reconcile_execution_enrichment_stages(activity_lease)
        if recovered_job_ids:
            log.warning(
                "Reconciled %d enrichment stage(s) for activity lease epoch %d",
                len(recovered_job_ids),
                activity_lease.epoch,
            )
            if on_job_enriched is not None:
                _handoff_reconciled_enriched_jobs(
                    recovered_job_ids,
                    on_job_enriched=on_job_enriched,
                    tenant_id=activity_lease.tenant_id,
                )
    if emit_progress:
        progress_event_kwargs = (
            {"activity_lease": activity_lease} if activity_lease is not None else {}
        )
        _record_pipeline_event(
            "discover",
            "StageStarted",
            "info",
            "Discovery detail enrichment finishing",
            _discovery_progress_payload(
                completed=progress_completed,
                total=progress_total,
                current_step="Detail enrichment",
                message="Detail enrichment finishing",
            ),
            **progress_event_kwargs,
        )
    if not stream_while_discovering:
        discovery_done.set()
    drain_kwargs: dict[str, Any] = {
        "workers": max(1, workers),
        "limit": limit,
        "cancel_event": cancel_event,
        "on_job_enriched": on_job_enriched,
    }
    if stream_while_discovering:
        drain_kwargs["discovery_execution"] = discovery_execution
    if recovery_key:
        drain_kwargs["recovery_key"] = recovery_key
    if activity_lease is not None:
        drain_kwargs["activity_lease"] = activity_lease
    _run_discovery_enrichment_until_idle(
        discovery_done,
        result,
        **drain_kwargs,
    )
    final = result or {"status": "ok", "passes": 0, "pending": 0}

    # Hygiene mutates canonical soft-delete state. Keep it inside the terminal
    # owner's lease before final progress is committed; a superseded attempt
    # must fail its fence without evaluating or hiding any job.
    if not stream_while_discovering:
        run_discovery_hygiene("after", activity_lease=activity_lease)

    if emit_progress:
        status = str(final.get("status") or "ok")
        if status in ("ok", "partial") or status.startswith("skipped"):
            site_errors = dict(final.get("site_errors") or {})
            progress_status = "partial" if status == "partial" else "running"
            message = (
                "Detail enrichment partially complete"
                if status == "partial"
                else "Detail enrichment complete"
            )
            payload = _discovery_progress_payload(
                completed=progress_completed + 1,
                total=progress_total,
                current_step="Detail enrichment",
                status=progress_status,
                message=message,
            )
            if site_errors:
                payload["siteErrors"] = site_errors
                payload["errorMessage"] = (
                    final.get("error_message") or "One or more enrichment sites failed."
                )
            _record_pipeline_event(
                "discover",
                "StageCompleted",
                "warn" if status == "partial" else "info",
                message,
                payload,
                **(
                    {"activity_lease": activity_lease}
                    if activity_lease is not None
                    else {}
                ),
            )
        else:
            error_class = final.get("error_class")
            error_message = final.get("error_message")
            if error_class and error_message:
                detail = f"{error_class}: {error_message}"
            elif error_message:
                detail = str(error_message)
            else:
                detail = status
            _record_pipeline_event(
                "discover",
                "StageFailed",
                "error",
                f"Discovery detail enrichment failed: {detail}",
                {
                    "errorCode": final.get("error_code") or "enrichment_failed",
                    "errorMessage": detail,
                    **_discovery_progress_payload(
                        completed=progress_completed + 1,
                        total=progress_total,
                        current_step="Detail enrichment",
                        status="failed",
                        message="Detail enrichment failed",
                    ),
                },
                **(
                    {"activity_lease": activity_lease}
                    if activity_lease is not None
                    else {}
                ),
            )

    return final


def _sources_for_discovery_family(
    family: str,
    *,
    jobspy_sources: tuple[ScheduledSource, ...],
    ats_sources: tuple[ScheduledSource, ...],
    workday_sources: tuple[ScheduledSource, ...],
    smart_extract_sources: tuple[ScheduledSource, ...],
) -> tuple[ScheduledSource, ...]:
    if family == "jobspy":
        return jobspy_sources
    if family == "ats_api":
        return ats_sources
    if family == "workday":
        return workday_sources
    if family == "smartextract":
        return smart_extract_sources
    return ()


def _discovery_family_label(family: str) -> str:
    return {
        "jobspy": "Broad boards",
        "ats_api": "Canonical ATS APIs",
        "workday": "Workday scraper",
        "smartextract": "Smart extract",
    }.get(family, family)


def _add_supported_discovery_kwargs(
    fn: Callable[..., Any],
    kwargs: dict[str, Any],
    *,
    run_id: str | None,
    cancel_event: threading.Event | None,
    progress_callback: Callable[[dict[str, Any]], None] | None,
) -> None:
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return
    params = signature.parameters
    accepts_kwargs = any(param.kind is inspect.Parameter.VAR_KEYWORD for param in params.values())
    if run_id and ("run_id" in params or accepts_kwargs):
        kwargs["run_id"] = run_id
    if cancel_event is not None and ("cancel_event" in params or accepts_kwargs):
        kwargs["cancel_event"] = cancel_event
    if progress_callback is not None and ("progress_callback" in params or accepts_kwargs):
        kwargs["progress_callback"] = progress_callback


def _jobspy_progress_callback(
    *,
    run_id: str | None,
    source_ids: tuple[str, ...],
    progress_completed: int,
    progress_total: int,
) -> Callable[[dict[str, Any]], None] | None:
    if not run_id:
        return None

    def record_jobspy_progress(snapshot: dict[str, Any]) -> None:
        error_count = _first_present(
            snapshot.get("errors"),
            snapshot.get("error_count"),
            snapshot.get("errorCount"),
        )
        _record_discovery_source_progress(
            source="jobspy",
            label="Broad boards",
            run_id=run_id,
            source_ids=source_ids,
            progress_completed=progress_completed,
            progress_total=progress_total,
            source_progress=DiscoveryRunProgress(
                completed=int(snapshot.get("completed") or 0),
                total=int(snapshot.get("total") or 0),
                unit=str(snapshot.get("unit") or "searches"),
                current_query=_optional_text(
                    _first_present(snapshot.get("current_query"), snapshot.get("currentQuery"))
                ),
                current_location=_optional_text(
                    _first_present(snapshot.get("current_location"), snapshot.get("currentLocation"))
                ),
                new_jobs=_optional_int(_first_present(snapshot.get("new_jobs"), snapshot.get("newJobs"))),
                existing_jobs=_optional_int(
                    _first_present(snapshot.get("existing_jobs"), snapshot.get("existingJobs"))
                ),
                filtered_jobs=_optional_int(
                    _first_present(snapshot.get("filtered_jobs"), snapshot.get("filteredJobs"))
                ),
                error_count=_optional_int(error_count),
                raw_total=_optional_int(_first_present(snapshot.get("raw_total"), snapshot.get("rawTotal"))),
                recovered_units=_optional_int(
                    _first_present(
                        snapshot.get("recovered_units"),
                        snapshot.get("recoveredUnits"),
                    )
                ),
            ),
            message=str(snapshot.get("message") or "JobStreaming progress updated"),
        )

    return record_jobspy_progress


# ---------------------------------------------------------------------------
# Individual stage runners
# ---------------------------------------------------------------------------

def run_discovery_legacy_once(
    workers: int = 1,
    limit: int = 0,
    min_score: int = 7,
    validation_mode: str = "normal",
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    source_ids: tuple[str, ...] = (),
    cancel_event: threading.Event | None = None,
) -> dict:
    """Stage: broad-board, Workday, and smart-extract discovery."""
    stats: dict = {"jobspy": None, "workday": None, "smartextract": None}
    source_results: dict[str, Any] = {}
    source_failures: dict[str, str] = {}
    source_succeeded = False
    selected_source_ids = tuple(dict.fromkeys(source_id.strip() for source_id in source_ids if source_id.strip()))
    source_filter_active = bool(selected_source_ids)
    provided_cancel_event = cancel_event
    cancel_event = cancel_event or threading.Event()
    conn = init_db()
    try:
        seed_discovery_control_queues(conn, config.load_source_registry())
    except Exception:
        log.debug("Failed to seed discovery control queues", exc_info=True)
    schedule = _plan_discovery_schedule(limit, source_ids=selected_source_ids)
    bounded_workers = max(1, workers)
    start_count = _pipeline_job_count() if limit > 0 else 0
    jobspy_sources = schedule.for_prefix("jobspy")
    ats_sources = tuple(
        source
        for source in schedule.for_kinds(SourceKind.ATS_API)
        if not source.source_id.startswith("workday:")
    )
    workday_sources = schedule.for_prefix("workday")
    smart_extract_sources = _smart_extract_sources(schedule)
    source_step_count = (
        (1 if (not source_filter_active or jobspy_sources) else 0)
        + (1 if ats_sources else 0)
        + (1 if (not source_filter_active or workday_sources) else 0)
        + (1 if (not source_filter_active or smart_extract_sources) else 0)
    )
    progress_total = source_step_count + 2
    progress_completed = 0

    # Broad-board JobStreaming — skip if disabled or unavailable.
    search_cfg = config.load_search_config() or {}
    def run_hygiene(label: str) -> int:
        hygiene = retire_invalid_source_jobs(
            conn,
            search_cfg=search_cfg,
            run_id=f"discovery:hygiene:{label}",
        )
        retired = int(hygiene.get("retired_jobs") or 0)
        if retired:
            console.print(f"  [yellow]Discovery hygiene retired {retired} invalid source jobs[/yellow]")
        return retired

    try:
        run_hygiene("before")
    except Exception:
        log.warning("Discovery hygiene failed", exc_info=True)
    enrichment_kwargs: dict[str, Any] = {"workers": bounded_workers, "limit": limit}
    if provided_cancel_event is not None:
        enrichment_kwargs["cancel_event"] = cancel_event
    enrichment_done, enrichment_result, enrichment_thread = _start_discovery_enrichment_worker(**enrichment_kwargs)

    def finish_discovery() -> dict:
        nonlocal progress_completed
        _record_pipeline_event(
            "discover",
            "StageStarted",
            "info",
            "Discovery detail enrichment finishing",
            _discovery_progress_payload(
                completed=progress_completed,
                total=progress_total,
                current_step="Detail enrichment",
                message="Detail enrichment finishing",
            ),
        )
        enrichment_stats = _finish_discovery_enrichment_worker(
            enrichment_done,
            enrichment_thread,
            enrichment_result,
        )
        stats["enrichment"] = str(enrichment_stats.get("status", "ok"))
        progress_completed += 1
        _record_pipeline_event(
            "discover",
            "StageCompleted",
            "info",
            "Discovery detail enrichment complete",
            _discovery_progress_payload(
                completed=progress_completed,
                total=progress_total,
                current_step="Detail enrichment",
                message="Detail enrichment complete",
            ),
        )
        try:
            run_hygiene("after")
        except Exception:
            log.warning("Post-discovery hygiene failed", exc_info=True)
        _record_pipeline_event(
            "discover",
            "StageStarted",
            "info",
            "Discovery preparation started",
            _discovery_progress_payload(
                completed=progress_completed,
                total=progress_total,
                current_step="Preparation",
                message="Preparation started",
            ),
        )
        try:
            from jobctrl.pipeline.preparation import start_discovery_preparation_workflows

            preparation_stats = start_discovery_preparation_workflows(
                min_score=min_score,
                limit=limit,
                workers=bounded_workers,
                validation_mode=validation_mode,
                llm_model=llm_model,
                tailor_models=tailor_models,
                tailor_judge_model=tailor_judge_model,
                tailor_judge_min_score=tailor_judge_min_score,
            )
            if preparation_stats.get("has_work"):
                stats["preparation"] = str(preparation_stats.get("status", "ok"))
                stats["preparation_counts"] = preparation_stats
                if preparation_stats.get("status") != "ok":
                    stats["status"] = "partial"
            preparation_status = "partial" if preparation_stats.get("status") not in (None, "ok") else "succeeded"
            progress_completed += 1
            _record_pipeline_event(
                "discover",
                "StageCompleted",
                "warn" if preparation_status == "partial" else "info",
                "Discovery preparation complete",
                _discovery_progress_payload(
                    completed=progress_completed,
                    total=progress_total,
                    current_step="Preparation",
                    status=preparation_status,
                    message="Preparation complete",
                ),
            )
        except Exception as exc:
            log.exception("Discovery preparation orchestration failed")
            stats["preparation"] = "failed"
            stats["preparation_error"] = str(exc)
            stats["status"] = "partial"
            progress_completed += 1
            _record_pipeline_event(
                "discover",
                "StageFailed",
                "error",
                f"Discovery preparation failed: {exc}",
                _discovery_progress_payload(
                    completed=progress_completed,
                    total=progress_total,
                    current_step="Preparation",
                    status="failed",
                    message="Preparation failed",
                ),
            )
        return stats

    def _run_source_isolated(
        key: str,
        label: str,
        sources: tuple[ScheduledSource, ...],
        run_fn: Callable[..., Any],
    ) -> None:
        """Run one discovery source group, tolerating a per-source failure.

        A raised ``SourceUnavailableError`` has already been durably recorded
        inside ``_run_discovery_source`` (DiscoveryRunFailed event, StageFailed
        pipeline event, failed operational attempt). Catch it here so the
        remaining source groups still run and the stage yields the healthy
        sources' jobs as a partial result. When every source fails the caller
        raises an aggregated ``SourceUnavailableError`` from the stage.
        """
        nonlocal progress_completed, source_succeeded
        try:
            status = _run_discovery_source(
                key,
                label,
                sources,
                run_fn,
                progress_completed=progress_completed,
                progress_total=progress_total,
            )
            stats[key] = status
            if status == "ok":
                source_succeeded = True
        except SourceUnavailableError as exc:
            cause = str(exc)
            source_failures[label] = cause
            stats[key] = "failed"
            stats[f"{key}_error"] = cause
            stats["status"] = "partial"
            console.print(f"  [red]{label} error:[/red] {cause}")
        progress_completed += 1

    def run_jobspy(run_id: str | None = None) -> dict:
        if search_cfg.get("disable_jobspy", False):
            console.print("  [dim]Broad-board discovery disabled in settings[/dim]")
            result = {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}
            source_results["jobspy"] = result
            return result
        console.print("  [cyan]Broad-board JobStreaming crawl...[/cyan]")
        try:
            from jobctrl.discovery.jobspy import run_discovery
        except ImportError:
            console.print("  [dim]JobStreaming not installed — skipping[/dim]")
            result = {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}
            source_results["jobspy"] = result
            return result
        jobspy_cfg = _jobspy_config_for_sources(search_cfg, jobspy_sources)
        if not jobspy_cfg.get("boards"):
            console.print("  [dim]No runnable broad boards scheduled[/dim]")
            result = {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}
            source_results["jobspy"] = result
            return result
        jobspy_limit = _scheduled_limit(schedule, "jobspy", limit)
        try:
            signature = inspect.signature(run_discovery)
        except (TypeError, ValueError):
            accepts_run_id = False
            accepts_progress_callback = False
            accepts_cancel_event = False
        else:
            accepts_run_id = (
                "run_id" in signature.parameters
                or any(
                    param.kind is inspect.Parameter.VAR_KEYWORD
                    for param in signature.parameters.values()
                )
            )
            accepts_progress_callback = (
                "progress_callback" in signature.parameters
                or any(
                    param.kind is inspect.Parameter.VAR_KEYWORD
                    for param in signature.parameters.values()
                )
            )
            accepts_cancel_event = (
                "cancel_event" in signature.parameters
                or any(
                    param.kind is inspect.Parameter.VAR_KEYWORD
                    for param in signature.parameters.values()
                )
            )

        run_kwargs: dict[str, Any] = {"cfg": jobspy_cfg, "limit": jobspy_limit}
        if accepts_run_id:
            run_kwargs["run_id"] = run_id
        if accepts_progress_callback and run_id:
            def record_jobspy_progress(snapshot: dict[str, Any]) -> None:
                error_count = _first_present(
                    snapshot.get("errors"),
                    snapshot.get("error_count"),
                    snapshot.get("errorCount"),
                )
                _record_discovery_source_progress(
                    source="jobspy",
                    label="Broad boards",
                    run_id=run_id,
                    source_ids=tuple(item.source_id for item in jobspy_sources if item.should_run),
                    progress_completed=progress_completed,
                    progress_total=progress_total,
                    source_progress=DiscoveryRunProgress(
                        completed=int(snapshot.get("completed") or 0),
                        total=int(snapshot.get("total") or 0),
                        unit=str(snapshot.get("unit") or "searches"),
                        current_query=_optional_text(
                            _first_present(snapshot.get("current_query"), snapshot.get("currentQuery"))
                        ),
                        current_location=_optional_text(
                            _first_present(snapshot.get("current_location"), snapshot.get("currentLocation"))
                        ),
                        new_jobs=_optional_int(_first_present(snapshot.get("new_jobs"), snapshot.get("newJobs"))),
                        existing_jobs=_optional_int(
                            _first_present(snapshot.get("existing_jobs"), snapshot.get("existingJobs"))
                        ),
                        filtered_jobs=_optional_int(
                            _first_present(snapshot.get("filtered_jobs"), snapshot.get("filteredJobs"))
                        ),
                        error_count=_optional_int(error_count),
                        raw_total=_optional_int(_first_present(snapshot.get("raw_total"), snapshot.get("rawTotal"))),
                        recovered_units=_optional_int(
                            _first_present(
                                snapshot.get("recovered_units"),
                                snapshot.get("recoveredUnits"),
                            )
                        ),
                    ),
                    message=str(snapshot.get("message") or "JobStreaming progress updated"),
                )

            run_kwargs["progress_callback"] = record_jobspy_progress
        if accepts_cancel_event and provided_cancel_event is not None:
            run_kwargs["cancel_event"] = cancel_event
        source_results["jobspy"] = run_discovery(**run_kwargs)
        return source_results["jobspy"]

    if not source_filter_active or jobspy_sources:
        _run_source_isolated("jobspy", "Broad boards", jobspy_sources, run_jobspy)
    if _discover_limit_consumed(start_count, limit, source_results.get("jobspy")):
        if ats_sources:
            stats["ats_api"] = _skip_discovery_source(
                "ats_api",
                "Canonical ATS APIs",
                "limit reached",
                progress_completed=progress_completed,
                progress_total=progress_total,
            )
            progress_completed += 1
        if not source_filter_active or workday_sources:
            stats["workday"] = _skip_discovery_source(
                "workday",
                "Workday scraper",
                "limit reached",
                progress_completed=progress_completed,
                progress_total=progress_total,
            )
            progress_completed += 1
        if not source_filter_active or smart_extract_sources:
            stats["smartextract"] = _skip_discovery_source(
                "smartextract",
                "Smart extract",
                "limit reached",
                progress_completed=progress_completed,
                progress_total=progress_total,
            )
            progress_completed += 1
        return finish_discovery()

    if ats_sources:
        def run_ats(run_id: str | None = None) -> dict:
            console.print("  [cyan]Canonical ATS APIs...[/cyan]")
            ats_kwargs: dict[str, Any] = {
                "search_cfg": search_cfg,
                "run_id": run_id or f"discovery:ats_api:{uuid.uuid4().hex}",
                "limit": _scheduled_limit_for_sources(ats_sources, _discover_remaining_limit(start_count, limit)),
            }
            if provided_cancel_event is not None:
                ats_kwargs["cancel_event"] = cancel_event
            source_results["ats_api"] = run_scheduled_ats_sources(conn, ats_sources, **ats_kwargs)
            return source_results["ats_api"]

        _run_source_isolated("ats_api", "Canonical ATS APIs", ats_sources, run_ats)
        if _discover_limit_consumed(start_count, limit, source_results.get("ats_api")):
            if not source_filter_active or workday_sources:
                stats["workday"] = _skip_discovery_source(
                    "workday",
                    "Workday scraper",
                    "limit reached",
                    progress_completed=progress_completed,
                    progress_total=progress_total,
                )
                progress_completed += 1
            if not source_filter_active or smart_extract_sources:
                stats["smartextract"] = _skip_discovery_source(
                    "smartextract",
                    "Smart extract",
                    "limit reached",
                    progress_completed=progress_completed,
                    progress_total=progress_total,
                )
                progress_completed += 1
            return finish_discovery()

    # Workday corporate scraper
    def run_workday(run_id: str | None = None) -> dict:
        console.print("  [cyan]Workday corporate scraper...[/cyan]")
        from jobctrl.discovery.workday import run_workday_discovery
        workday_kwargs: dict[str, Any] = {
            "employers": _workday_employers_for_sources(workday_sources),
            "workers": bounded_workers,
            "limit": _scheduled_limit(schedule, "workday", _discover_remaining_limit(start_count, limit)),
            "run_id": run_id,
        }
        if provided_cancel_event is not None:
            workday_kwargs["cancel_event"] = cancel_event
        source_results["workday"] = run_workday_discovery(**workday_kwargs)
        return source_results["workday"]

    if not source_filter_active or workday_sources:
        _run_source_isolated("workday", "Workday scraper", workday_sources, run_workday)
        if _discover_limit_consumed(start_count, limit, source_results.get("workday")):
            if not source_filter_active or smart_extract_sources:
                stats["smartextract"] = _skip_discovery_source(
                    "smartextract",
                    "Smart extract",
                    "limit reached",
                    progress_completed=progress_completed,
                    progress_total=progress_total,
                )
                progress_completed += 1
            return finish_discovery()

    # Smart extract
    def run_smart_extract_source() -> dict:
        console.print("  [cyan]Smart extract (AI-powered scraping)...[/cyan]")
        enqueue_manual_action_for_sources(conn, smart_extract_sources)
        from jobctrl.discovery.smartextract import run_smart_extract
        smart_kwargs: dict[str, Any] = {
            "sites": _smart_extract_sites(smart_extract_sources),
            "workers": bounded_workers,
            "limit": _scheduled_limit_for_sources(
                smart_extract_sources,
                _discover_remaining_limit(start_count, limit),
            ),
        }
        if provided_cancel_event is not None:
            smart_kwargs["cancel_event"] = cancel_event
        source_results["smartextract"] = run_smart_extract(**smart_kwargs)
        return source_results["smartextract"]

    if not source_filter_active or smart_extract_sources:
        _run_source_isolated(
            "smartextract", "Smart extract", smart_extract_sources, run_smart_extract_source
        )

    result = finish_discovery()
    if source_failures and not source_succeeded:
        raise SourceUnavailableError(
            "All discovery sources failed: " + "; ".join(source_failures.values())
        )
    return result


def _run_enrich(
    workers: int = 1,
    limit: int = 0,
    job_ids: tuple[JobId, ...] = (),
    cancel_event: threading.Event | None = None,
    reset_linkedin_candidates: bool = True,
    on_job_enriched: Callable[[JobId], None] | None = None,
    recovery_key: str | None = None,
    activity_lease: EnrichmentExecutionLease | None = None,
    workflow_id: str | None = None,
    workflow_run_id: str | None = None,
) -> dict:
    """Stage: Detail enrichment — scrape full descriptions and apply URLs."""
    if cancel_event is not None and cancel_event.is_set():
        raise TransientNetworkError("enrichment canceled before start")
    from jobctrl.enrichment.detail import run_enrichment
    enrich_kwargs: dict[str, Any] = {
        "limit": limit,
        "workers": workers,
        "reset_linkedin_candidates": reset_linkedin_candidates,
        "on_job_enriched": on_job_enriched,
    }
    if job_ids:
        enrich_kwargs["job_ids"] = job_ids
    if recovery_key:
        enrich_kwargs["recovery_key"] = recovery_key
    if activity_lease is not None:
        enrich_kwargs["activity_lease"] = activity_lease
    if workflow_id:
        enrich_kwargs["workflow_id"] = workflow_id
    if workflow_run_id:
        enrich_kwargs["workflow_run_id"] = workflow_run_id
    if cancel_event is None:
        stats = run_enrichment(**enrich_kwargs)
    else:
        stats = run_enrichment(cancel_event=cancel_event, **enrich_kwargs)
    if cancel_event is not None and cancel_event.is_set():
        raise TransientNetworkError("enrichment canceled")
    site_errors = stats.get("site_errors") or {}
    return {
        "status": "partial" if site_errors else "ok",
        "counts": {k: stats.get(k) for k in ("processed", "ok", "partial", "error")},
        "site_errors": site_errors,
    }


def _run_score(
    limit: int = 0,
    rescore: bool = False,
    workers: int = 1,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    cancel_event: threading.Event | None = None,
    workflow_id: str | None = None,
) -> dict:
    """Stage: LLM scoring — assign fit scores 1-10."""
    if cancel_event is not None and cancel_event.is_set():
        raise LlmTransientError("scoring canceled before start")
    from jobctrl.scoring.scorer import run_scoring
    result = run_scoring(
        limit=limit,
        rescore=rescore,
        workers=workers,
        llm_model=llm_model,
        workflow_id=workflow_id,
    )
    if cancel_event is not None and cancel_event.is_set():
        raise LlmTransientError("scoring canceled")
    # ``scoredJobIds`` reaches the pipeline workflow through the score stage
    # result so a resolved global material run can union this run's newly
    # scored jobs into its frozen Tailor cohort.
    return {"status": "ok", "scoredJobIds": list(result.get("scoredJobIds") or [])}


def _run_tailor(
    min_score: int = 7,
    limit: int = 0,
    validation_mode: str = "normal",
    workers: int = 1,
    retailor: bool = False,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    cancel_event: threading.Event | None = None,
    workflow_id: str | None = None,
) -> dict:
    """Stage: Resume tailoring — generate tailored resumes for high-fit jobs."""
    if cancel_event is not None and cancel_event.is_set():
        raise LlmTransientError("tailoring canceled before start")
    from jobctrl.scoring.tailor import run_tailoring
    result = run_tailoring(
        min_score=min_score,
        limit=limit,
        validation_mode=validation_mode,
        workers=workers,
        retailor=retailor,
        tailor_models=tailor_models,
        tailor_judge_model=tailor_judge_model,
        tailor_judge_min_score=tailor_judge_min_score,
        llm_model=llm_model,
        workflow_id=workflow_id,
    )
    if cancel_event is not None and cancel_event.is_set():
        raise LlmTransientError("tailoring canceled")
    failed = int(result.get("failed") or 0)
    errors = int(result.get("errors") or 0)
    exhausted = int(result.get("exhausted") or 0)
    if exhausted:
        raise AttemptBudgetExhaustedError(
            f"{exhausted} tailored resume(s) exhausted the durable attempt budget"
        )
    if errors:
        raise LlmTransientError(
            f"{errors} tailoring error(s), {failed} failed quality gate(s)"
        )
    if failed:
        raise LlmTransientError(
            f"{failed} tailored resume(s) failed validation or judge approval"
        )
    return {**result, "status": "ok"}


def _run_cover(
    min_score: int = 7,
    limit: int = 0,
    validation_mode: str = "normal",
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    cancel_event: threading.Event | None = None,
    workflow_id: str | None = None,
) -> dict:
    """Stage: Cover letter generation."""
    if cancel_event is not None and cancel_event.is_set():
        raise LlmTransientError("cover letter generation canceled before start")
    from jobctrl.database import get_jobs_by_stage
    from jobctrl.scoring.cover_letter import cover_letter_by_url

    jobs = get_jobs_by_stage(
        conn=get_connection(),
        stage="pending_cover",
        min_score=min_score,
        limit=limit,
    )
    generated = 0
    skipped = 0
    errors = 0
    for job in jobs:
        if cancel_event is not None and cancel_event.is_set():
            raise LlmTransientError("cover letter generation canceled")
        result = cover_letter_by_url(
            str(job["url"]),
            min_score=min_score,
            validation_mode=validation_mode,
            llm_model=llm_model,
            workflow_id=workflow_id,
        )
        status = str(result.get("status") or "error")
        if status in {"ok", "already_done"}:
            generated += int(result.get("generated") or 0)
        elif status in {"skipped", "not_eligible"}:
            skipped += 1
        else:
            errors += 1
    if errors:
        raise LlmTransientError(f"{errors} cover letter error(s)")
    return {
        "status": "ok",
        "generated": generated,
        "skipped": skipped,
        "selected": len(jobs),
    }


# Map stage names to their runner functions. ``Callable`` (lowercase
# ``callable`` is the runtime predicate, not a generic type alias).
_StageRunner = Callable[..., dict[str, Any]]
_STAGE_RUNNERS: dict[str, _StageRunner] = {
    "discover": run_discovery_legacy_once,
    "enrich":   _run_enrich,
    "score":    _run_score,
    "tailor":   _run_tailor,
    "cover":    _run_cover,
}


def _build_stage_kwargs(
    stage: str,
    *,
    min_score: int = 7,
    workers: int = 1,
    validation_mode: str = "normal",
    limit: int = 0,
    rescore: bool = False,
    retailor: bool = False,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    source_ids: tuple[str, ...] = (),
    cancel_event: threading.Event | None = None,
) -> dict:
    """Build the keyword arguments for a stage runner."""
    kwargs: dict = {}

    if stage in ("discover", "enrich", "score"):
        kwargs["workers"] = workers
    if stage in ("discover", "enrich", "score"):
        kwargs["limit"] = limit
    if cancel_event is not None and stage in ("discover", "enrich", "score", "tailor", "cover"):
        kwargs["cancel_event"] = cancel_event
    if stage == "discover":
        kwargs["min_score"] = min_score
        kwargs["validation_mode"] = validation_mode
        kwargs["llm_model"] = llm_model
        kwargs["tailor_models"] = tailor_models
        kwargs["tailor_judge_model"] = tailor_judge_model
        kwargs["tailor_judge_min_score"] = tailor_judge_min_score
        if source_ids:
            kwargs["source_ids"] = source_ids
    elif stage == "score":
        kwargs["rescore"] = rescore
        kwargs["llm_model"] = llm_model
    elif stage in ("tailor", "cover"):
        kwargs["min_score"] = min_score
        kwargs["limit"] = limit
        kwargs["validation_mode"] = validation_mode
        kwargs["llm_model"] = llm_model
        if stage == "tailor":
            kwargs["workers"] = workers
            kwargs["retailor"] = retailor
            kwargs["tailor_models"] = tailor_models
            kwargs["tailor_judge_model"] = tailor_judge_model
            kwargs["tailor_judge_min_score"] = tailor_judge_min_score

    return kwargs


# ---------------------------------------------------------------------------
# Stage resolution
# ---------------------------------------------------------------------------

def _resolve_stages(stage_names: list[str]) -> list[str]:
    """Resolve 'all' and validate/order stage names."""
    if "all" in stage_names:
        return list(PRIMARY_STAGE_ORDER)

    resolved = []
    for name in stage_names:
        if name not in STAGE_META:
            console.print(
                f"[red]Unknown stage:[/red] '{name}'. "
                f"Available: {', '.join((*SUPPORTED_STAGE_ORDER, 'enrich'))}, all"
            )
            raise SystemExit(1)
        if name not in resolved:
            resolved.append(name)

    # Maintain canonical order
    return [s for s in INTERNAL_STAGE_ORDER if s in resolved]


# SQL to count pending work for each stage. Round-1 review B1: every
# selector that previously read bare ``fit_score`` now goes through the
# shared ``database._LATEST_SCORE_JOIN`` + ``_EFFECTIVE_FIT_SCORE``
# expression so new scores written via ``ScoreRepository.save`` are
# visible immediately (jobs.fit_score is NULL on the new write path).
_PENDING_SQL: dict[str, str] = {
    # Phase 7 (S-26 round-1 review B3 + B4): every selector that
    # previously read bare ``detail_scraped_at`` / ``full_description``
    # now goes through the shared ``_ENRICHMENT_JOIN`` /
    # ``_ENRICHMENT_PENDING`` / ``_EFFECTIVE_FULL_DESCRIPTION``
    # expressions so jobs enriched through the new repository path are
    # observable. Without these the pipeline thinks "enrich" always has
    # work and "score" / "tailor" / "cover" never have work.
    "enrich": (
        f"SELECT COUNT(*) FROM jobs {db_module._ENRICHMENT_JOIN} {db_module._ACTIVE_STATE_JOIN} "
        f"WHERE {db_module._ENRICHMENT_PENDING} "
        f"AND {db_module._NOT_CLOSED_ACTIVE_STATE}"
    ),
    "score": (
        f"SELECT COUNT(*) FROM jobs {db_module._LATEST_SCORE_JOIN} "
        f"{db_module._ENRICHMENT_JOIN} {db_module._SCORE_DOWNSTREAM_STATE_JOIN} "
        f"{db_module._ACTIVE_STATE_JOIN} "
        f"WHERE {db_module._EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {db_module._EFFECTIVE_FIT_SCORE} IS NULL "
        f"AND {db_module._EFFECTIVE_SCORE_ATTEMPTS} < 5 "
        f"AND {db_module._NOT_CLOSED_ACTIVE_STATE}"
    ),
    # Phase 6 (S-20 + round-2 H1): tailor + cover predicates read through
    # ``_LATEST_MATERIALS_JOIN`` (path) and ``_LATEST_STAGE_ATTEMPTS_JOIN``
    # (attempts + exhaustion). New code never bumps
    # ``jobs.tailor_attempts`` / ``cover_attempts`` so the legacy column
    # would forever read 0 — the canonical counter lives on
    # ``job_stage_states.attempt_count`` and the canonical exhaustion
    # signal is ``job_stage_states.state = 'exhausted'``.
    "tailor": (
        f"SELECT COUNT(*) FROM jobs {db_module._LATEST_SCORE_JOIN} "
        f"{db_module._LATEST_MATERIALS_JOIN} {db_module._LATEST_STAGE_ATTEMPTS_JOIN} "
        f"{db_module._SCORE_DOWNSTREAM_STATE_JOIN} "
        f"{db_module._ENRICHMENT_JOIN} {db_module._ACTIVE_STATE_JOIN} "
        f"WHERE {db_module._EFFECTIVE_FIT_SCORE} >= ? "
        f"AND {db_module._EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {db_module._SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
        f"AND {db_module._SCORE_CURRENT_FOR_DOWNSTREAM} "
        f"AND {db_module._EFFECTIVE_TAILOR_PATH} IS NULL "
        f"AND {db_module._TAILOR_NOT_EXHAUSTED} "
        f"AND {db_module._EFFECTIVE_TAILOR_ATTEMPTS} < 5 "
        f"AND {db_module._NOT_CLOSED_ACTIVE_STATE} "
        f"AND {db_module._ENRICHMENT_NOT_QUARANTINED}"
    ),
    "cover": (
        f"SELECT COUNT(*) FROM jobs {db_module._LATEST_SCORE_JOIN} "
        f"{db_module._LATEST_MATERIALS_JOIN} {db_module._LATEST_STAGE_ATTEMPTS_JOIN} "
        f"{db_module._SCORE_DOWNSTREAM_STATE_JOIN} "
        f"{db_module._ENRICHMENT_JOIN} {db_module._ACTIVE_STATE_JOIN} "
        f"WHERE {db_module._EFFECTIVE_FIT_SCORE} >= ? "
        f"AND {db_module._EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {db_module._SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
        f"AND {db_module._SCORE_CURRENT_FOR_DOWNSTREAM} "
        f"AND {db_module._READY_TAILORED_RESUME_WITH_PDF} "
        f"AND ({db_module._EFFECTIVE_COVER_PATH} IS NULL OR {db_module._EFFECTIVE_COVER_PATH} = '') "
        f"AND {db_module._COVER_NOT_EXHAUSTED} "
        f"AND {db_module._EFFECTIVE_COVER_ATTEMPTS} < 5 "
        f"AND {db_module._NOT_CLOSED_ACTIVE_STATE} "
        f"AND {db_module._ENRICHMENT_NOT_QUARANTINED}"
    ),
}

_DISCOVERY_ENRICH_POLL_INTERVAL = 2
_DISCOVERY_ENRICH_NO_PROGRESS_LIMIT = 3


def _count_pending(stage: str, min_score: int = 7, retailor: bool = False) -> int:
    """Count pending work items for a stage."""
    if stage == "tailor":
        conn = get_connection()
        # Phase 7 (S-26 round-1 review B4): bare ``full_description``
        # is NULL on the new write path; route through the COALESCE
        # expression backed by ``job_enrichments``.
        where = (
            f"{db_module._EFFECTIVE_FIT_SCORE} >= ? "
            f"AND {db_module._EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
            f"AND {db_module._SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
            f"AND {db_module._SCORE_CURRENT_FOR_DOWNSTREAM} "
            f"AND {db_module._TAILOR_NOT_EXHAUSTED} "
            f"AND ({db_module._EFFECTIVE_TAILOR_PATH} IS NOT NULL OR {db_module._EFFECTIVE_TAILOR_ATTEMPTS} < 5) "
            f"AND {db_module._NOT_CLOSED_ACTIVE_STATE} "
            f"AND {db_module._ENRICHMENT_NOT_QUARANTINED}"
            if retailor else
            f"{db_module._EFFECTIVE_FIT_SCORE} >= ? "
            f"AND {db_module._EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
            f"AND {db_module._SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
            f"AND {db_module._SCORE_CURRENT_FOR_DOWNSTREAM} "
            f"AND {db_module._EFFECTIVE_TAILOR_PATH} IS NULL "
            f"AND {db_module._TAILOR_NOT_EXHAUSTED} "
            f"AND {db_module._EFFECTIVE_TAILOR_ATTEMPTS} < 5 "
            f"AND {db_module._NOT_CLOSED_ACTIVE_STATE} "
            f"AND {db_module._ENRICHMENT_NOT_QUARANTINED}"
        )
        return conn.execute(
            f"SELECT COUNT(*) FROM jobs {db_module._LATEST_SCORE_JOIN} "
            f"{db_module._LATEST_MATERIALS_JOIN} {db_module._LATEST_STAGE_ATTEMPTS_JOIN} "
            f"{db_module._SCORE_DOWNSTREAM_STATE_JOIN} {db_module._ENRICHMENT_JOIN} "
            f"{db_module._ACTIVE_STATE_JOIN} "
            f"WHERE {where}",
            (min_score,),
        ).fetchone()[0]

    sql = _PENDING_SQL.get(stage)
    if sql is None:
        return 0
    conn = get_connection()
    if "?" in sql:
        return conn.execute(sql, (min_score,)).fetchone()[0]
    return conn.execute(sql).fetchone()[0]


def _count_retryable_enrichment_blocked() -> int:
    """Count robots-blocked jobs eligible for one first-pass recheck."""

    conn = get_connection()
    return conn.execute(
        f"SELECT COUNT(*) FROM jobs {db_module._ENRICHMENT_JOIN} "
        f"{db_module._ACTIVE_STATE_JOIN} "
        f"WHERE {db_module._ENRICHMENT_RETRYABLE_ROBOTS_BLOCKED} "
        f"AND {db_module._NOT_CLOSED_ACTIVE_STATE}"
    ).fetchone()[0]


def _execution_pending_enrichment_job_ids(
    discovery_execution: DiscoveryExecutionRef,
) -> tuple[JobId, ...]:
    """Return pending enrichment work linked to one live Discover execution."""

    conn = get_connection()
    rows = conn.execute(
        f"SELECT execution.job_id "
        "FROM discovery_execution_jobs AS execution "
        "JOIN jobs ON jobs.tenant_id = execution.tenant_id "
        "AND jobs.job_id = execution.job_id "
        f"{db_module._ENRICHMENT_JOIN} {db_module._ACTIVE_STATE_JOIN} "
        "WHERE execution.tenant_id = ? "
        "AND execution.discover_workflow_id = ? "
        "AND execution.discover_run_id = ? "
        "AND execution.cohort_kind = 'observed_this_run' "
        f"AND {db_module._ENRICHMENT_PENDING} "
        f"AND {db_module._NOT_CLOSED_ACTIVE_STATE} "
        "ORDER BY execution.linked_at, execution.job_id",
        (
            discovery_execution.tenant_id,
            discovery_execution.workflow_id,
            discovery_execution.temporal_run_id,
        ),
    ).fetchall()
    return tuple(JobId(str(row[0])) for row in rows)


def _claim_execution_enrichment_lease(
    discovery_execution: DiscoveryExecutionRef,
    *,
    owner_token: str,
    activity_phase: int,
    activity_attempt: int,
) -> EnrichmentExecutionLease:
    """Claim the monotonically fenced enrichment lane for one Discover run."""

    conn = get_connection()
    return claim_enrichment_execution_lease(
        conn,
        discovery_execution,
        owner_token=owner_token,
        activity_phase=activity_phase,
        activity_attempt=activity_attempt,
    )


def _reconcile_execution_enrichment_stages(
    activity_lease: EnrichmentExecutionLease,
) -> tuple[JobId, ...]:
    """Repair interrupted stage projections under the current activity lease.

    The enrichment aggregate is saved only after a job succeeds or fails. If a
    worker disappears between the stage's ``running`` transition and that
    terminal save, the aggregate remains pending while the stage projection is
    left running. The normal selector intentionally excludes running stages, so
    a later Temporal activity attempt must reconcile that split state before it
    can resume the same Discover execution.

    Lease epoch one has no predecessor. Later live attempts and the terminal
    reconciliation activity both receive higher epochs and reconcile the exact
    execution before selecting work.
    """

    conn = get_connection()
    fence_enrichment_execution_lease(conn, activity_lease)
    rows = conn.execute(
        "SELECT stage.job_id, stage.version, enrichment.current_status, "
        "enrichment.attempts_json, enrichment.enriched_at, enrichment.updated_at "
        "FROM discovery_execution_jobs AS execution "
        "JOIN job_stage_states AS stage "
        "ON stage.tenant_id = execution.tenant_id "
        "AND stage.job_id = execution.job_id "
        "AND stage.stage = 'enrich' "
        "LEFT JOIN job_enrichments AS enrichment "
        "ON enrichment.tenant_id = execution.tenant_id "
        "AND enrichment.job_id = execution.job_id "
        "WHERE execution.tenant_id = ? "
        "AND execution.discover_workflow_id = ? "
        "AND execution.discover_run_id = ? "
        "AND execution.cohort_kind = 'observed_this_run' "
        "AND stage.state = 'running' "
        "ORDER BY execution.linked_at, execution.job_id",
        (
            str(activity_lease.tenant_id),
            activity_lease.workflow_id,
            activity_lease.run_id,
        ),
    ).fetchall()

    recovered: list[JobId] = []
    for row in rows:
        job_id = JobId(str(row[0]))
        version = int(row[1] or 0)
        aggregate_status = str(row[2] or "pending")
        recovered_at = utc_now()
        attempts = json.loads(row[3] or "[]")
        attempt_count = len(attempts) if isinstance(attempts, list) else 0
        metadata = json.dumps(
            {
                "recoveryReason": "orphaned_activity_attempt",
                "activityAttempt": activity_lease.activity_attempt,
                "leaseEpoch": activity_lease.epoch,
            },
            sort_keys=True,
        )
        if aggregate_status == "enriched":
            state = "succeeded"
            finished_at = str(row[4] or row[5] or recovered_at)
            error_code = None
            error_message = None
            retryable = 1
            event_type = "StageCompleted"
            message = "Reconciled enrichment completed before worker interruption"
        elif aggregate_status == "failed":
            state = "failed"
            finished_at = str(row[5] or recovered_at)
            last_attempt = attempts[-1] if isinstance(attempts, list) and attempts else {}
            last_error = last_attempt.get("error") if isinstance(last_attempt, dict) else {}
            last_error = last_error if isinstance(last_error, dict) else {}
            error_code = str(last_error.get("code") or "DETAIL_ERROR")
            error_message = str(last_error.get("message") or "enrichment failed")[:500]
            retryable = int(bool(last_error.get("retryable", True)))
            event_type = "StageFailed"
            message = "Reconciled enrichment failure recorded before worker interruption"
        else:
            state = "pending"
            finished_at = None
            error_code = None
            error_message = None
            retryable = 1
            event_type = "StageReset"
            message = "Recovering enrichment interrupted by a previous worker attempt"
        update = conn.execute(
            "UPDATE job_stage_states SET state = ?, started_at = NULL, "
            "updated_at = ?, finished_at = ?, duration_ms = NULL, "
            "attempt_count = ?, error_code = ?, error_message = ?, retryable = ?, "
            "blocked_by_json = NULL, next_action = NULL, metadata_json = ?, "
            "version = version + 1 "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich' "
            "AND state = 'running' AND version = ? "
            "AND COALESCE((SELECT current_status FROM job_enrichments "
            "WHERE tenant_id = job_stage_states.tenant_id "
            "AND job_id = job_stage_states.job_id), 'pending') = ?",
            (
                state,
                recovered_at,
                finished_at,
                attempt_count,
                error_code,
                error_message,
                retryable,
                metadata,
                str(activity_lease.tenant_id),
                str(job_id),
                version,
                aggregate_status,
            ),
        )
        if update.rowcount != 1:
            conn.rollback()
            raise StaleEnrichmentExecutionLease(
                "enrichment reconciliation lost its execution lease"
            )
        record_job_event(
            conn,
            job_id,
            "enrich",
            event_type,
            tenant_id=activity_lease.tenant_id,
            message=message,
            payload={
                "reason": "orphaned_activity_attempt",
                "previousState": "running",
                "activityAttempt": activity_lease.activity_attempt,
                "leaseEpoch": activity_lease.epoch,
                "aggregateStatus": aggregate_status,
            },
        )
        recovered.append(job_id)
    conn.commit()
    return tuple(recovered)


def _handoff_reconciled_enriched_jobs(
    job_ids: tuple[JobId, ...],
    *,
    on_job_enriched: Callable[[JobId], None],
    tenant_id: str,
) -> None:
    """Restore per-job preparation handoffs lost after aggregate commit."""

    if not job_ids:
        return
    conn = get_connection()
    placeholders = ", ".join("?" for _ in job_ids)
    rows = conn.execute(
        "SELECT stage.job_id FROM job_stage_states stage "
        "JOIN job_enrichments enrichment "
        "ON enrichment.tenant_id = stage.tenant_id "
        "AND enrichment.job_id = stage.job_id "
        f"WHERE stage.tenant_id = ? AND stage.job_id IN ({placeholders}) "
        "AND stage.stage = 'enrich' AND stage.state = 'succeeded' "
        "AND enrichment.current_status = 'enriched'",
        (str(tenant_id), *(str(job_id) for job_id in job_ids)),
    ).fetchall()
    for row in rows:
        job_id = JobId(str(row[0]))
        try:
            on_job_enriched(job_id)
        except Exception:  # noqa: BLE001 - recovery handoff is best-effort
            log.warning(
                "Per-job preparation recovery handoff failed for %s",
                job_id,
                exc_info=True,
            )


def _execution_recoverable_enrichment_job_ids(
    discovery_execution: DiscoveryExecutionRef,
) -> tuple[JobId, ...]:
    """Return re-observed failures eligible for one live recovery attempt."""

    conn = get_connection()
    rows = conn.execute(
        f"SELECT execution.job_id "
        "FROM discovery_execution_jobs AS execution "
        "JOIN jobs ON jobs.tenant_id = execution.tenant_id "
        "AND jobs.job_id = execution.job_id "
        f"{db_module._ENRICHMENT_JOIN} {db_module._ACTIVE_STATE_JOIN} "
        "WHERE execution.tenant_id = ? "
        "AND execution.discover_workflow_id = ? "
        "AND execution.discover_run_id = ? "
        "AND execution.cohort_kind = 'observed_this_run' "
        "AND ("
        f"({db_module._ENRICHMENT_RETRYABLE_ROBOTS_BLOCKED}) OR ("
        "lower(COALESCE(jobs.site, '')) = 'linkedin' "
        "AND je.current_status = 'failed' "
        "AND jss_enrich.state = 'failed' "
        "AND (COALESCE(jss_enrich.retryable, 1) = 1 OR ("
        "jss_enrich.error_code = 'DETAIL_UNSAFE_URL' "
        "AND jss_enrich.error_message LIKE 'Unsupported public route method:%'"
        "))"
        ")) "
        f"AND {db_module._NOT_CLOSED_ACTIVE_STATE} "
        "ORDER BY execution.linked_at, execution.job_id",
        (
            discovery_execution.tenant_id,
            discovery_execution.workflow_id,
            discovery_execution.temporal_run_id,
        ),
    ).fetchall()
    return tuple(JobId(str(row[0])) for row in rows)


def _default_retryable(exc: Exception) -> bool:
    """Classify an uncaught enrichment-worker exception when it carries no code.

    Deterministic programming errors are never worth retrying; anything else is
    assumed transient (network/browser hiccups) unless the exception itself
    declares otherwise.
    """
    deterministic = (ValueError, TypeError, KeyError, AttributeError, IndexError)
    return not isinstance(exc, deterministic)


def _run_discovery_enrichment_until_idle(
    discovery_done: threading.Event,
    result: dict[str, Any],
    *,
    workers: int,
    limit: int,
    cancel_event: threading.Event | None = None,
    on_job_enriched: Callable[[JobId], None] | None = None,
    discovery_execution: DiscoveryExecutionRef | None = None,
    recovery_key: str | None = None,
    activity_lease: EnrichmentExecutionLease | None = None,
) -> None:
    """Drain the detail-enrichment queue while discovery is still producing jobs.

    A "partial" pass (some sites failed but the queue still drained) does not
    abort the drain — the healthy sites keep making progress and the accumulated
    ``site_errors`` are surfaced in the final result so the stage is reported as
    partial rather than failed.
    """
    passes = 0
    no_progress_passes = 0
    site_errors: dict[str, Any] = {}
    recovery_attempted_job_ids: set[JobId] = set()

    try:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise TransientNetworkError("discovery enrichment canceled")
            scoped_job_ids = (
                _execution_pending_enrichment_job_ids(discovery_execution)
                if discovery_execution is not None
                else ()
            )
            recoverable_job_ids = (
                tuple(
                    job_id
                    for job_id in _execution_recoverable_enrichment_job_ids(
                        discovery_execution
                    )
                    if job_id not in recovery_attempted_job_ids
                )
                if discovery_execution is not None
                else ()
            )
            if recoverable_job_ids:
                recovery_attempted_job_ids.update(recoverable_job_ids)
                scoped_job_ids = tuple(
                    dict.fromkeys((*scoped_job_ids, *recoverable_job_ids))
                )
            pending = (
                len(scoped_job_ids)
                if discovery_execution is not None
                else _count_pending("enrich")
            )
            if pending <= 0 and passes == 0 and discovery_execution is None:
                # Robots-blocked is deliberately not steady-state pending: if
                # robots still disallows the URL, counting it forever would
                # spin the drain. Admit it once at the start of a later
                # workflow so an authenticated profile (or changed policy)
                # gets a fresh chance.
                pending = _count_retryable_enrichment_blocked()
            if pending <= 0:
                if discovery_done.is_set():
                    drained: dict[str, Any] = {
                        "status": "partial" if site_errors else "ok",
                        "passes": passes,
                        "pending": 0,
                    }
                    if site_errors:
                        drained["site_errors"] = dict(site_errors)
                    result.update(drained)
                    return
                discovery_done.wait(timeout=_DISCOVERY_ENRICH_POLL_INTERVAL)
                continue

            enrich_kwargs: dict[str, Any] = {
                "workers": workers,
                "limit": limit,
                "cancel_event": cancel_event,
                "reset_linkedin_candidates": (
                    bool(recoverable_job_ids)
                    if discovery_execution is not None
                    else passes == 0
                ),
                "on_job_enriched": on_job_enriched,
            }
            if discovery_execution is not None:
                enrich_kwargs["job_ids"] = scoped_job_ids
            if recovery_key:
                enrich_kwargs["recovery_key"] = recovery_key
            if activity_lease is not None:
                enrich_kwargs["activity_lease"] = activity_lease
            enrichment_result = _run_enrich(**enrich_kwargs)
            passes += 1
            pass_site_errors = enrichment_result.get("site_errors") or {}
            if pass_site_errors:
                site_errors.update(pass_site_errors)
            after = (
                len(
                    tuple(
                        dict.fromkeys(
                            (
                                *_execution_pending_enrichment_job_ids(
                                    discovery_execution
                                ),
                                *(
                                    job_id
                                    for job_id in _execution_recoverable_enrichment_job_ids(
                                        discovery_execution
                                    )
                                    if job_id not in recovery_attempted_job_ids
                                ),
                            )
                        )
                    )
                )
                if discovery_execution is not None
                else _count_pending("enrich")
            )
            status = str(enrichment_result.get("status", "ok"))

            # "partial" means healthy sites still progressed; only a hard failure
            # status ends the drain early.
            if status not in ("ok", "partial"):
                update: dict[str, Any] = {"status": status, "passes": passes, "pending": after}
                if site_errors:
                    update["site_errors"] = dict(site_errors)
                result.update(update)
                if discovery_done.is_set():
                    return

            if after >= pending:
                no_progress_passes += 1
                if discovery_done.is_set() and no_progress_passes >= _DISCOVERY_ENRICH_NO_PROGRESS_LIMIT:
                    if site_errors:
                        result.update(
                            {
                                "status": "partial",
                                "passes": passes,
                                "pending": after,
                                "site_errors": dict(site_errors),
                                "error_message": (
                                    f"{after} pending detail jobs after {passes} passes "
                                    "with site errors"
                                ),
                            }
                        )
                    else:
                        result.update(
                            {
                                "status": f"stuck: {after} pending detail jobs after {passes} passes",
                                "passes": passes,
                                "pending": after,
                            }
                        )
                    return
                if not discovery_done.is_set():
                    discovery_done.wait(timeout=_DISCOVERY_ENRICH_POLL_INTERVAL)
            else:
                no_progress_passes = 0
    except Exception as exc:
        log.exception("Discovery detail enrichment worker crashed")
        result.update(
            {
                "status": "failed",
                "error_class": type(exc).__name__,
                "error_message": str(exc),
                "error_code": getattr(exc, "code", None),
                "retryable": getattr(exc, "retryable", _default_retryable(exc)),
                "error_traceback": traceback.format_exc()[-4000:],
                "passes": passes,
            }
        )


def _start_discovery_enrichment_worker(
    *,
    workers: int,
    limit: int,
    cancel_event: threading.Event | None = None,
) -> tuple[threading.Event, dict[str, Any], threading.Thread]:
    """Start Discovery's internal detail-enrichment queue worker."""
    discovery_done = threading.Event()
    result: dict[str, Any] = {}
    thread = threading.Thread(
        target=_run_discovery_enrichment_until_idle,
        kwargs={
            "discovery_done": discovery_done,
            "result": result,
            "workers": workers,
            "limit": limit,
            "cancel_event": cancel_event,
        },
        name="discover-detail-enrichment",
        daemon=True,
    )
    thread.start()
    return discovery_done, result, thread


def _finish_discovery_enrichment_worker(
    discovery_done: threading.Event,
    thread: threading.Thread,
    result: dict[str, Any],
) -> dict[str, Any]:
    """Signal Discovery's internal detail-enrichment queue worker and wait for it."""
    discovery_done.set()
    thread.join()
    return result or {"status": "ok", "passes": 0, "pending": 0}


# ---------------------------------------------------------------------------
# Single-job processing
# ---------------------------------------------------------------------------

def run_single_job(
    url: str,
    *,
    do_tailor: bool = True,
    do_apply: bool = True,
    validation_mode: str = "normal",
    model: str = "default",
    headless: bool = False,
    dry_run: bool = False,
) -> dict:
    """Start the single-job Temporal workflow path and wait for its result."""
    from jobctrl.config import APP_DIR, DB_PATH
    from jobctrl.domain.discovery.value_objects import PostingUrl
    from jobctrl.infrastructure.discovery import SqliteJobIdentityResolver
    from jobctrl.workflow_specs import (
        build_single_job_workflow_spec,
        start_workflow_spec_and_wait_sync,
        workflow_result_to_dict,
    )

    identity = SqliteJobIdentityResolver(get_connection()).resolve_current_by_posting_url(
        LOCAL_TENANT,
        PostingUrl(value=url),
    )
    if identity is None:
        raise ValueError(f"No current job found for URL: {url}")

    spec = build_single_job_workflow_spec(
        str(identity.job_id),
        do_tailor=do_tailor,
        do_apply=do_apply,
        validation_mode=validation_mode,
        model=model,
        headless=headless,
        dry_run=dry_run,
        expected_app_dir=str(APP_DIR),
        expected_db_path=str(DB_PATH),
    )
    started = start_workflow_spec_and_wait_sync(spec)
    result = workflow_result_to_dict(started.result)
    payload: dict[str, object] = {
        "url": url,
        "runId": started.run_id,
        "workflowId": started.workflow_id,
        "firstExecutionRunId": started.first_execution_run_id,
    }
    if isinstance(result, dict):
        payload.update(result)
    else:
        payload["result"] = result
    return payload
