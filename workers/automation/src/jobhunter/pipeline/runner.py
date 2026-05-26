"""JobHunter Pipeline Orchestrator.

Runs pipeline stages in sequence or concurrently (streaming mode).

Usage (via CLI):
    jobhunter run                        # all stages, sequential
    jobhunter run --stream               # all stages, concurrent
    jobhunter run discover score         # specific stages
    jobhunter run score tailor cover     # LLM-only stages
    jobhunter run --dry-run              # preview without executing
"""

from __future__ import annotations

import json
import logging
import inspect
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Callable

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from jobhunter import config
from jobhunter.config import load_env, ensure_dirs
from jobhunter import database as db_module
from jobhunter.database import init_db, get_connection, get_stats
from jobhunter.domain.discovery.scheduler import (
    DiscoveryRun,
    DiscoveryRunCounts,
    DiscoverySchedule,
    DiscoveryScheduler,
    ScheduledSource,
    SourceQualitySnapshot,
)
from jobhunter.domain.discovery.source_registry import SourceKind, SourcePriority, SourceState
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.discovery.sqlite_run_repository import (
    SqliteDiscoveryRunRepository,
)
from jobhunter.infrastructure.discovery.production_wiring import (
    enqueue_manual_action_for_sources,
    retire_invalid_source_jobs,
    run_scheduled_ats_sources,
    seed_discovery_control_queues,
)
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobhunter.operational_metrics import record_operational_attempt_metric
from jobhunter.infrastructure.observability.source_spans import discovery_run_span
from jobhunter.state import record_job_event, utc_now

log = logging.getLogger(__name__)
console = Console()

_PIPELINE_JOB_ID = "pipeline"


# ---------------------------------------------------------------------------
# Stage definitions
# ---------------------------------------------------------------------------

STAGE_ORDER = ("discover", "score", "tailor", "cover")
INTERNAL_STAGE_ORDER = ("discover", "enrich", "score", "tailor", "cover")

STAGE_META: dict[str, dict] = {
    "discover": {"desc": "Job discovery + detail enrichment"},
    "enrich":   {"desc": "Detail enrichment (full descriptions + apply URLs)"},
    "score":    {"desc": "LLM scoring (fit 1-10)"},
    "tailor":   {"desc": "Resume tailoring (LLM + validation + resume PDF)"},
    "cover":    {"desc": "Cover letter generation + cover PDF"},
}

# Upstream dependencies: a stage only finishes when all of its producers are
# done and it has no remaining pending work.
_UPSTREAMS: dict[str, tuple[str, ...]] = {
    "discover": (),
    "enrich":   ("discover",),
    "score":    ("discover",),
    "tailor":   ("score",),
    "cover":    ("tailor",),
}


# ---------------------------------------------------------------------------
# Observability helpers
# ---------------------------------------------------------------------------

def _pipeline_tracer():
    return trace.get_tracer("jobhunter.pipeline")


def _record_pipeline_event(
    stage: str,
    event_type: str,
    level: str,
    message: str,
    payload: dict[str, Any] | None = None,
) -> None:
    """Emit a durable pipeline-level event plus a short Langfuse event observation."""
    now = utc_now()
    enriched = _pipeline_event_payload(stage, event_type, now, payload)
    _record_pipeline_observation_event(stage, event_type, level, message, enriched)

    try:
        conn = get_connection()
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
    except Exception:
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
            span.set_attribute("jobhunter.pipeline.event_type", event_type)
            span.set_attribute("jobhunter.pipeline.message", message)
            span.set_attribute("langfuse.observation.level", _langfuse_level(level))
            span.set_attribute("langfuse.observation.status_message", message)
            for key, value in payload.items():
                if isinstance(value, str | int | float | bool):
                    span.set_attribute(f"langfuse.observation.metadata.{key}", value)
    except Exception:
        log.debug("Failed to emit pipeline OTel event for %s/%s", stage, event_type, exc_info=True)


def _set_pipeline_span_attributes(span, stage: str, *, observation_type: str = "span") -> None:  # type: ignore[no-untyped-def]
    span.set_attribute("jobhunter.pipeline.stage", stage)
    span.set_attribute("jobhunter.pipeline.job_id", _PIPELINE_JOB_ID)
    span.set_attribute("langfuse.trace.name", "jobhunter.pipeline")
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
        span.set_attribute("jobhunter.pipeline.mode", mode)
        span.set_attribute("jobhunter.pipeline.pass_number", pass_number)
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
        span.set_attribute("jobhunter.pipeline.status", status)
        span.set_attribute("jobhunter.pipeline.duration_ms", duration_ms)
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
) -> str:
    runnable = tuple(item for item in scheduled_sources if item.should_run)
    if not runnable:
        reason = scheduled_sources[0].reason if scheduled_sources else "not scheduled"
        return _record_skipped_discovery_run(source, label, scheduled_sources, reason)

    source_ids = tuple(item.source_id for item in runnable)
    run_id = f"discovery:{source}:{uuid.uuid4().hex}"
    started_at = utc_now()
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
        {"source": source, "sourceLabel": label, "runId": run_id, "sourceIds": list(source_ids)},
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
        span.set_attribute("jobhunter.pipeline.source", source)
        span.set_attribute("jobhunter.discovery.run_id", run_id)
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
            failed_source_id = source_ids[0] if len(source_ids) == 1 else ""
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
                },
            )
            return f"error: {exc}"

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
        span.set_attribute("jobhunter.pipeline.source_status", status)
        span.set_attribute("jobhunter.discovery.result.total", counts.total)
        span.set_attribute("jobhunter.discovery.result.new_jobs", counts.new_jobs)
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


def _record_skipped_discovery_run(
    source: str,
    label: str,
    scheduled_sources: tuple[ScheduledSource, ...],
    reason: str,
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
    )


def _skip_discovery_source(
    source: str,
    label: str,
    reason: str,
    *,
    run_id: str | None = None,
    source_ids: tuple[str, ...] = (),
    record_metric: bool = True,
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


def _plan_discovery_schedule(limit: int) -> DiscoverySchedule:
    scheduler = DiscoveryScheduler()
    return scheduler.plan(
        registry=config.load_source_registry(),
        quality=_load_source_quality_snapshots(),
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


def _row_get(row: Any, key: str, index: int) -> Any:
    if hasattr(row, "keys") and key in row.keys():
        return row[key]
    return row[index]


# ---------------------------------------------------------------------------
# Individual stage runners
# ---------------------------------------------------------------------------

def _run_discover(workers: int = 1, limit: int = 0) -> dict:
    """Stage: Job discovery — JobSpy, Workday, and smart-extract scrapers."""
    stats: dict = {"jobspy": None, "workday": None, "smartextract": None}
    source_results: dict[str, Any] = {}
    conn = init_db()
    try:
        seed_discovery_control_queues(conn, config.load_source_registry())
    except Exception:
        log.debug("Failed to seed discovery control queues", exc_info=True)
    schedule = _plan_discovery_schedule(limit)
    bounded_workers = max(1, workers)
    start_count = _pipeline_job_count() if limit > 0 else 0

    # JobSpy — skip if disabled in config or module not installed
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
    enrichment_done, enrichment_result, enrichment_thread = _start_discovery_enrichment_worker(
        workers=bounded_workers,
        limit=limit,
    )

    def finish_discovery() -> dict:
        enrichment_stats = _finish_discovery_enrichment_worker(
            enrichment_done,
            enrichment_thread,
            enrichment_result,
        )
        stats["enrichment"] = str(enrichment_stats.get("status", "ok"))
        try:
            run_hygiene("after")
        except Exception:
            log.warning("Post-discovery hygiene failed", exc_info=True)
        return stats

    jobspy_sources = schedule.for_prefix("jobspy")

    def run_jobspy(run_id: str | None = None) -> dict:
        if search_cfg.get("disable_jobspy", False):
            console.print("  [dim]JobSpy disabled in searches.yaml[/dim]")
            result = {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}
            source_results["jobspy"] = result
            return result
        console.print("  [cyan]JobSpy full crawl...[/cyan]")
        try:
            from jobhunter.discovery.jobspy import run_discovery
        except ImportError:
            console.print("  [dim]JobSpy not installed — skipping[/dim]")
            result = {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}
            source_results["jobspy"] = result
            return result
        jobspy_cfg = _jobspy_config_for_sources(search_cfg, jobspy_sources)
        if not jobspy_cfg.get("boards"):
            console.print("  [dim]No runnable JobSpy boards scheduled[/dim]")
            result = {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}
            source_results["jobspy"] = result
            return result
        jobspy_limit = _scheduled_limit(schedule, "jobspy", limit)
        try:
            signature = inspect.signature(run_discovery)
        except (TypeError, ValueError):
            accepts_run_id = False
        else:
            accepts_run_id = (
                "run_id" in signature.parameters
                or any(
                    param.kind is inspect.Parameter.VAR_KEYWORD
                    for param in signature.parameters.values()
                )
            )
        if accepts_run_id:
            source_results["jobspy"] = run_discovery(
                cfg=jobspy_cfg,
                limit=jobspy_limit,
                run_id=run_id,
            )
        else:
            source_results["jobspy"] = run_discovery(cfg=jobspy_cfg, limit=jobspy_limit)
        return source_results["jobspy"]

    stats["jobspy"] = _run_discovery_source(
        "jobspy",
        "JobSpy",
        jobspy_sources,
        run_jobspy,
    )
    if isinstance(stats["jobspy"], str) and stats["jobspy"].startswith("error"):
        console.print(f"  [red]JobSpy error:[/red] {stats['jobspy'][7:]}")
    if _discover_limit_consumed(start_count, limit, source_results.get("jobspy")):
        stats["workday"] = _skip_discovery_source("workday", "Workday scraper", "limit reached")
        stats["smartextract"] = _skip_discovery_source("smartextract", "Smart extract", "limit reached")
        return finish_discovery()

    ats_sources = tuple(
        source
        for source in schedule.for_kinds(SourceKind.ATS_API)
        if not source.source_id.startswith("workday:")
    )
    if ats_sources:
        def run_ats(run_id: str | None = None) -> dict:
            console.print("  [cyan]Canonical ATS APIs...[/cyan]")
            source_results["ats_api"] = run_scheduled_ats_sources(
                conn,
                ats_sources,
                search_cfg=search_cfg,
                run_id=run_id or f"discovery:ats_api:{uuid.uuid4().hex}",
                limit=_scheduled_limit_for_sources(ats_sources, _discover_remaining_limit(start_count, limit)),
            )
            return source_results["ats_api"]

        stats["ats_api"] = _run_discovery_source(
            "ats_api",
            "Canonical ATS APIs",
            ats_sources,
            run_ats,
        )
        if isinstance(stats["ats_api"], str) and stats["ats_api"].startswith("error"):
            console.print(f"  [red]Canonical ATS API error:[/red] {stats['ats_api'][7:]}")
        if _discover_limit_consumed(start_count, limit, source_results.get("ats_api")):
            stats["workday"] = _skip_discovery_source("workday", "Workday scraper", "limit reached")
            stats["smartextract"] = _skip_discovery_source("smartextract", "Smart extract", "limit reached")
            return finish_discovery()

    # Workday corporate scraper
    workday_sources = schedule.for_prefix("workday")

    def run_workday(run_id: str | None = None) -> dict:
        console.print("  [cyan]Workday corporate scraper...[/cyan]")
        from jobhunter.discovery.workday import run_workday_discovery
        source_results["workday"] = run_workday_discovery(
            employers=_workday_employers_for_sources(workday_sources),
            workers=bounded_workers,
            limit=_scheduled_limit(schedule, "workday", _discover_remaining_limit(start_count, limit)),
            run_id=run_id,
        )
        return source_results["workday"]

    stats["workday"] = _run_discovery_source(
        "workday",
        "Workday scraper",
        workday_sources,
        run_workday,
    )
    if isinstance(stats["workday"], str) and stats["workday"].startswith("error"):
        console.print(f"  [red]Workday error:[/red] {stats['workday'][7:]}")
    if _discover_limit_consumed(start_count, limit, source_results.get("workday")):
        stats["smartextract"] = _skip_discovery_source("smartextract", "Smart extract", "limit reached")
        return finish_discovery()

    # Smart extract
    smart_extract_sources = _smart_extract_sources(schedule)

    def run_smart_extract_source() -> dict:
        console.print("  [cyan]Smart extract (AI-powered scraping)...[/cyan]")
        enqueue_manual_action_for_sources(conn, smart_extract_sources)
        from jobhunter.discovery.smartextract import run_smart_extract
        source_results["smartextract"] = run_smart_extract(
            sites=_smart_extract_sites(smart_extract_sources),
            workers=bounded_workers,
            limit=_scheduled_limit_for_sources(
                smart_extract_sources,
                _discover_remaining_limit(start_count, limit),
            ),
        )
        return source_results["smartextract"]

    stats["smartextract"] = _run_discovery_source(
        "smartextract",
        "Smart extract",
        smart_extract_sources,
        run_smart_extract_source,
    )
    if isinstance(stats["smartextract"], str) and stats["smartextract"].startswith("error"):
        console.print(f"  [red]Smart extract error:[/red] {stats['smartextract'][7:]}")

    return finish_discovery()


def _run_enrich(workers: int = 1, limit: int = 0) -> dict:
    """Stage: Detail enrichment — scrape full descriptions and apply URLs."""
    try:
        from jobhunter.enrichment.detail import run_enrichment
        run_enrichment(limit=limit, workers=workers)
        return {"status": "ok"}
    except Exception as e:
        log.error("Enrichment failed: %s", e)
        return {"status": f"error: {e}", "error_class": type(e).__name__, "error_message": str(e)}


def _run_score(
    limit: int = 0,
    rescore: bool = False,
    workers: int = 1,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
) -> dict:
    """Stage: LLM scoring — assign fit scores 1-10."""
    try:
        from jobhunter.scoring.scorer import run_scoring
        run_scoring(limit=limit, rescore=rescore, workers=workers, llm_model=llm_model)
        return {"status": "ok"}
    except Exception as e:
        log.error("Scoring failed: %s", e)
        return {"status": f"error: {e}", "error_class": type(e).__name__, "error_message": str(e)}


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
) -> dict:
    """Stage: Resume tailoring — generate tailored resumes for high-fit jobs."""
    try:
        from jobhunter.scoring.tailor import run_tailoring
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
        )
        failed = int(result.get("failed") or 0)
        errors = int(result.get("errors") or 0)
        if errors:
            return {
                **result,
                "status": "error: tailor errors",
                "error_class": "TailorStageErrors",
                "error_message": f"{errors} tailoring error(s), {failed} failed quality gate(s)",
            }
        if failed:
            return {
                **result,
                "status": "failed",
                "error_class": "TailorQualityGateFailed",
                "error_message": f"{failed} tailored resume(s) failed validation or judge approval",
            }
        return {**result, "status": "ok"}
    except Exception as e:
        log.error("Tailoring failed: %s", e)
        return {"status": f"error: {e}", "error_class": type(e).__name__, "error_message": str(e)}


def _run_cover(
    min_score: int = 7,
    limit: int = 0,
    validation_mode: str = "normal",
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
) -> dict:
    """Stage: Cover letter generation."""
    try:
        from jobhunter.scoring.cover_letter import run_cover_letters
        run_cover_letters(
            min_score=min_score,
            limit=limit,
            validation_mode=validation_mode,
            llm_model=llm_model,
        )
        return {"status": "ok"}
    except Exception as e:
        log.error("Cover letter generation failed: %s", e)
        return {"status": f"error: {e}", "error_class": type(e).__name__, "error_message": str(e)}


# Map stage names to their runner functions. ``Callable`` (lowercase
# ``callable`` is the runtime predicate, not a generic type alias).
_StageRunner = Callable[..., dict[str, Any]]
_STAGE_RUNNERS: dict[str, _StageRunner] = {
    "discover": _run_discover,
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
) -> dict:
    """Build the keyword arguments for a stage runner."""
    kwargs: dict = {}

    if stage in ("discover", "enrich", "score"):
        kwargs["workers"] = workers
    if stage in ("discover", "enrich", "score"):
        kwargs["limit"] = limit
    if stage == "score":
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
        return list(STAGE_ORDER)

    resolved = []
    for name in stage_names:
        if name not in STAGE_META:
            console.print(
                f"[red]Unknown stage:[/red] '{name}'. "
                f"Available: {', '.join((*STAGE_ORDER, 'enrich'))}, all"
            )
            raise SystemExit(1)
        if name not in resolved:
            resolved.append(name)

    # Maintain canonical order
    return [s for s in INTERNAL_STAGE_ORDER if s in resolved]


# ---------------------------------------------------------------------------
# Streaming pipeline helpers
# ---------------------------------------------------------------------------

class _StageTracker:
    """Thread-safe tracker for which stages have finished producing work."""

    def __init__(self):
        self._events: dict[str, threading.Event] = {
            stage: threading.Event() for stage in INTERNAL_STAGE_ORDER
        }
        self._results: dict[str, dict] = {}
        self._lock = threading.Lock()

    def mark_done(self, stage: str, result: dict | None = None) -> None:
        with self._lock:
            self._results[stage] = result or {"status": "ok"}
        self._events[stage].set()

    def status(self, stage: str) -> str:
        with self._lock:
            result = self._results.get(stage)
        if not isinstance(result, dict):
            return "pending"
        return str(result.get("status", "ok"))

    def failed_upstream(self, stages: tuple[str, ...]) -> tuple[str, str] | None:
        for stage in stages:
            status = self.status(stage)
            if status not in ("ok", "partial", "skipped"):
                return stage, status
        return None

    def is_done(self, stage: str) -> bool:
        return self._events[stage].is_set()

    def wait(self, stage: str, timeout: float | None = None) -> bool:
        return self._events[stage].wait(timeout=timeout)

    def get_results(self) -> dict[str, dict]:
        with self._lock:
            return dict(self._results)


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
        f"SELECT COUNT(*) FROM jobs {db_module._ENRICHMENT_JOIN} "
        f"WHERE {db_module._ENRICHMENT_PENDING}"
    ),
    "score": (
        f"SELECT COUNT(*) FROM jobs {db_module._LATEST_SCORE_JOIN} "
        f"{db_module._ENRICHMENT_JOIN} "
        f"WHERE {db_module._EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {db_module._EFFECTIVE_FIT_SCORE} IS NULL"
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
        f"{db_module._ENRICHMENT_JOIN} "
        f"WHERE {db_module._EFFECTIVE_FIT_SCORE} >= ? "
        f"AND {db_module._EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {db_module._SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
        f"AND {db_module._SCORE_CURRENT_FOR_DOWNSTREAM} "
        f"AND {db_module._EFFECTIVE_TAILOR_PATH} IS NULL "
        f"AND {db_module._TAILOR_NOT_EXHAUSTED} "
        f"AND {db_module._EFFECTIVE_TAILOR_ATTEMPTS} < 5"
    ),
    "cover": (
        f"SELECT COUNT(*) FROM jobs {db_module._LATEST_SCORE_JOIN} "
        f"{db_module._LATEST_MATERIALS_JOIN} {db_module._LATEST_STAGE_ATTEMPTS_JOIN} "
        f"{db_module._SCORE_DOWNSTREAM_STATE_JOIN} "
        f"{db_module._ENRICHMENT_JOIN} "
        f"WHERE {db_module._EFFECTIVE_FIT_SCORE} >= ? "
        f"AND {db_module._EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {db_module._SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
        f"AND {db_module._SCORE_CURRENT_FOR_DOWNSTREAM} "
        f"AND {db_module._READY_TAILORED_RESUME_WITH_PDF} "
        f"AND ({db_module._EFFECTIVE_COVER_PATH} IS NULL OR {db_module._EFFECTIVE_COVER_PATH} = '') "
        f"AND {db_module._COVER_NOT_EXHAUSTED} "
        f"AND {db_module._EFFECTIVE_COVER_ATTEMPTS} < 5"
    ),
}

# How long to sleep between polling loops in streaming mode (seconds)
_STREAM_POLL_INTERVAL = 10
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
            f"AND ({db_module._EFFECTIVE_TAILOR_PATH} IS NOT NULL OR {db_module._EFFECTIVE_TAILOR_ATTEMPTS} < 5)"
            if retailor else
            f"{db_module._EFFECTIVE_FIT_SCORE} >= ? "
            f"AND {db_module._EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
            f"AND {db_module._SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
            f"AND {db_module._SCORE_CURRENT_FOR_DOWNSTREAM} "
            f"AND {db_module._EFFECTIVE_TAILOR_PATH} IS NULL "
            f"AND {db_module._TAILOR_NOT_EXHAUSTED} "
            f"AND {db_module._EFFECTIVE_TAILOR_ATTEMPTS} < 5"
        )
        return conn.execute(
            f"SELECT COUNT(*) FROM jobs {db_module._LATEST_SCORE_JOIN} "
            f"{db_module._LATEST_MATERIALS_JOIN} {db_module._LATEST_STAGE_ATTEMPTS_JOIN} "
            f"{db_module._SCORE_DOWNSTREAM_STATE_JOIN} {db_module._ENRICHMENT_JOIN} "
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


def _run_discovery_enrichment_until_idle(
    discovery_done: threading.Event,
    result: dict[str, Any],
    *,
    workers: int,
    limit: int,
) -> None:
    """Drain the detail-enrichment queue while discovery is still producing jobs."""
    passes = 0
    no_progress_passes = 0

    try:
        while True:
            pending = _count_pending("enrich")
            if pending <= 0:
                if discovery_done.is_set():
                    result.update({"status": "ok", "passes": passes, "pending": 0})
                    return
                discovery_done.wait(timeout=_DISCOVERY_ENRICH_POLL_INTERVAL)
                continue

            enrichment_result = _run_enrich(workers=workers, limit=limit)
            passes += 1
            after = _count_pending("enrich")
            status = str(enrichment_result.get("status", "ok"))

            if status != "ok":
                result.update({"status": status, "passes": passes, "pending": after})
                if discovery_done.is_set():
                    return

            if after >= pending:
                no_progress_passes += 1
                if discovery_done.is_set() and no_progress_passes >= _DISCOVERY_ENRICH_NO_PROGRESS_LIMIT:
                    result.update(
                        {
                            "status": f"stuck: {after} pending detail jobs after {passes} passes",
                            "passes": passes,
                            "pending": after,
                        }
                    )
                    return
            else:
                no_progress_passes = 0
    except Exception as exc:
        log.exception("Discovery detail enrichment worker crashed")
        result.update(
            {
                "status": f"error: {exc}",
                "error_class": type(exc).__name__,
                "error_message": str(exc),
                "passes": passes,
            }
        )


def _start_discovery_enrichment_worker(
    *,
    workers: int,
    limit: int,
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


def _run_stage_streaming(
    stage: str,
    tracker: _StageTracker,
    stop_event: threading.Event,
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
) -> None:
    """Run a single stage in streaming mode: loop until upstream done + no work.

    For discover: runs once, then marks done.
    For all others: polls DB for pending work, runs the batch processor,
    and repeats until upstream is done and no pending work remains.
    """
    runner = _STAGE_RUNNERS[stage]
    kwargs = _build_stage_kwargs(
        stage,
        min_score=min_score,
        workers=workers,
        validation_mode=validation_mode,
        limit=limit,
        rescore=rescore,
        retailor=retailor,
        llm_model=llm_model,
        tailor_models=tailor_models,
        tailor_judge_model=tailor_judge_model,
        tailor_judge_min_score=tailor_judge_min_score,
    )
    upstreams = _UPSTREAMS[stage]

    if stage == "discover":
        # Discover runs once (its sub-scrapers already do their full crawl)
        try:
            result, _elapsed, _status = _run_stage_observed(
                stage,
                runner,
                kwargs,
                mode="streaming",
                pass_number=1,
            )
            tracker.mark_done(stage, result)
        except Exception as e:
            log.exception("Stage '%s' crashed", stage)
            tracker.mark_done(stage, {"status": f"error: {e}"})
        return

    # For downstream stages: loop until upstream done + no pending work
    passes = 0
    no_progress_passes = 0
    while not stop_event.is_set():
        pending = _count_pending(stage, min_score, retailor=retailor)
        upstream_done = all(tracker.is_done(s) for s in upstreams)
        failed_upstream = tracker.failed_upstream(upstreams) if upstream_done else None

        if failed_upstream is not None:
            upstream_stage, upstream_status = failed_upstream
            tracker.mark_done(
                stage,
                {
                    "status": f"blocked: upstream {upstream_stage} failed",
                    "blocked_by": upstream_stage,
                    "upstream_status": upstream_status,
                    "passes": passes,
                },
            )
            return

        if pending > 0:
            try:
                _result, _elapsed, _status = _run_stage_observed(
                    stage,
                    runner,
                    kwargs,
                    mode="streaming",
                    pass_number=passes + 1,
                )
                passes += 1
                if upstream_done and _status not in ("ok", "partial", "skipped"):
                    tracker.mark_done(stage, _result)
                    return
                after = _count_pending(stage, min_score, retailor=retailor)
                if upstream_done and after >= pending:
                    no_progress_passes += 1
                    if no_progress_passes >= 3:
                        tracker.mark_done(
                            stage,
                            {"status": f"stuck: {after} pending after {passes} passes", "passes": passes},
                        )
                        return
                else:
                    no_progress_passes = 0
            except Exception as e:
                log.error("Stage '%s' error (pass %d): %s", stage, passes, e)
                passes += 1
                if upstream_done:
                    no_progress_passes += 1
                    if no_progress_passes >= 3:
                        tracker.mark_done(
                            stage,
                            {"status": f"error: no progress after {passes} passes: {e}", "passes": passes},
                        )
                        return
        else:
            # No work right now
            if upstream_done:
                # No work and upstream is done — this stage is finished
                break
            # Upstream still running, wait and retry
            if stop_event.wait(timeout=_STREAM_POLL_INTERVAL):
                break  # Stop requested

    tracker.mark_done(stage, {"status": "ok", "passes": passes})


# ---------------------------------------------------------------------------
# Pipeline orchestrators
# ---------------------------------------------------------------------------

def _run_sequential(ordered: list[str], min_score: int, workers: int = 1,
                    validation_mode: str = "normal", limit: int = 0,
                    rescore: bool = False, retailor: bool = False,
                    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
                    tailor_models: tuple[str, ...] = (),
                    tailor_judge_model: str | None = None,
                    tailor_judge_min_score: float | None = None) -> dict:
    """Execute stages one at a time (original behavior)."""
    results: list[dict] = []
    errors: dict[str, str] = {}
    pipeline_start = time.time()

    for name in ordered:
        blocked_by = next((upstream for upstream in _UPSTREAMS[name] if upstream in errors), None)
        if blocked_by is not None:
            status = f"blocked: upstream {blocked_by} failed"
            results.append({"stage": name, "status": status, "elapsed": 0.0})
            errors[name] = status
            console.print(f"\n  [yellow]Stage '{name}' skipped:[/yellow] {status}")
            continue

        meta = STAGE_META[name]
        console.print(f"\n{'=' * 70}")
        console.print(f"  [bold]STAGE: {name}[/bold] — {meta['desc']}")
        console.print(f"  Started: {datetime.now().strftime('%H:%M:%S')}")
        console.print(f"{'=' * 70}")

        t0 = time.time()
        runner = _STAGE_RUNNERS[name]

        try:
            kwargs = _build_stage_kwargs(
                name,
                min_score=min_score,
                workers=workers,
                validation_mode=validation_mode,
                limit=limit,
                rescore=rescore,
                retailor=retailor,
                llm_model=llm_model,
                tailor_models=tailor_models,
                tailor_judge_model=tailor_judge_model,
                tailor_judge_min_score=tailor_judge_min_score,
            )
            result, elapsed, status = _run_stage_observed(
                name,
                runner,
                kwargs,
                mode="sequential",
                pass_number=1,
            )

        except Exception as e:
            elapsed = time.time() - t0
            status = f"error: {e}"
            log.exception("Stage '%s' crashed", name)
            console.print(f"\n  [red]STAGE FAILED:[/red] {e}")

        results.append({"stage": name, "status": status, "elapsed": elapsed})
        if status not in ("ok", "partial"):
            errors[name] = status

        console.print(f"\n  Stage '{name}' completed in {elapsed:.1f}s — {status}")

    total_elapsed = time.time() - pipeline_start
    return {"stages": results, "errors": errors, "elapsed": total_elapsed}


def _run_streaming(ordered: list[str], min_score: int, workers: int = 1,
                   validation_mode: str = "normal", limit: int = 0,
                   rescore: bool = False, retailor: bool = False,
                   llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
                   tailor_models: tuple[str, ...] = (),
                   tailor_judge_model: str | None = None,
                   tailor_judge_min_score: float | None = None) -> dict:
    """Execute stages concurrently with DB as conveyor belt."""
    tracker = _StageTracker()
    stop_event = threading.Event()
    pipeline_start = time.time()

    console.print("\n  [bold cyan]STREAMING MODE[/bold cyan] — stages run concurrently")
    console.print(f"  Poll interval: {_STREAM_POLL_INTERVAL}s\n")

    # Mark stages NOT in `ordered` as done so downstream doesn't wait for them
    for stage in INTERNAL_STAGE_ORDER:
        if stage not in ordered:
            tracker.mark_done(stage, {"status": "skipped"})

    # Launch each stage in its own thread
    threads: dict[str, threading.Thread] = {}
    start_times: dict[str, float] = {}

    for name in ordered:
        start_times[name] = time.time()
        t = threading.Thread(
            target=_run_stage_streaming,
            args=(name, tracker, stop_event, min_score, workers,
                  validation_mode, limit, rescore, retailor,
                  llm_model, tailor_models, tailor_judge_model,
                  tailor_judge_min_score),
            name=f"stage-{name}",
            daemon=True,
        )
        threads[name] = t
        t.start()
        console.print(f"  [dim]Started thread:[/dim] {name}")

    # Wait for all threads to finish
    try:
        for name in ordered:
            threads[name].join()
            elapsed = time.time() - start_times[name]
            console.print(
                f"  [green]Completed:[/green] {name} ({elapsed:.1f}s)"
            )
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted — stopping stages...[/yellow]")
        stop_event.set()
        for t in threads.values():
            t.join(timeout=10)

    total_elapsed = time.time() - pipeline_start

    # Build results from tracker
    all_results = tracker.get_results()
    results: list[dict] = []
    errors: dict[str, str] = {}

    for name in ordered:
        r = all_results.get(name, {"status": "unknown"})
        elapsed = time.time() - start_times.get(name, pipeline_start)
        status = r.get("status", "ok")

        results.append({"stage": name, "status": status, "elapsed": elapsed})
        if status not in ("ok", "partial", "skipped"):
            errors[name] = status

    return {"stages": results, "errors": errors, "elapsed": total_elapsed}


def run_pipeline(
    stages: list[str] | None = None,
    min_score: int = 7,
    dry_run: bool = False,
    stream: bool = False,
    workers: int = 1,
    validation_mode: str = "normal",
    limit: int = 0,
    rescore: bool = False,
    retailor: bool = False,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
) -> dict:
    """Run pipeline stages.

    Args:
        stages: List of stage names, or None / ["all"] for full pipeline.
        min_score: Minimum fit score for tailor/cover stages.
        dry_run: If True, preview stages without executing.
        stream: If True, run stages concurrently (streaming mode).
        workers: Number of parallel threads for discovery, enrichment,
            scoring, and tailoring stages.
        validation_mode: Validation strictness for tailor/cover stages.
        limit: Optional per-stage batch limit. 0 means no limit.
        rescore: Re-score already scored jobs when running the score stage.
        retailor: Re-tailor already tailored jobs when running the tailor stage.
        llm_model: Default LLM model spec for score, tailor, and cover stages.
        tailor_models: Optional model specs for candidate generation.
        tailor_judge_model: Optional model spec for the structured judge.
        tailor_judge_min_score: Optional minimum judge score required for approval.

    Returns:
        Dict with keys: stages (list of result dicts), errors (dict), elapsed (float).
    """
    # Bootstrap
    load_env()
    ensure_dirs()
    init_db()

    # Resolve stages
    if stages is None:
        stages = ["all"]
    ordered = _resolve_stages(stages)

    if stream and retailor and "tailor" in ordered:
        raise ValueError("--retailor is not supported with --stream because already-tailored jobs never drain.")

    # Banner
    mode = "streaming" if stream else "sequential"
    console.print()
    console.print(Panel.fit(
        f"[bold]JobHunter Pipeline[/bold] ({mode})",
        border_style="blue",
    ))
    console.print(f"  Min score:  {min_score}")
    console.print(f"  Workers:    {workers}")
    console.print(f"  Validation: {validation_mode}")
    if limit > 0:
        console.print(f"  Limit:      {limit}")
    if rescore:
        console.print("  Rescore:    enabled")
    if retailor:
        console.print("  Retailor:   enabled")
    if tailor_models:
        console.print(f"  Tailor LLM: {', '.join(tailor_models)}")
    if tailor_judge_model:
        score_label = (
            f"{tailor_judge_min_score:.2f}"
            if tailor_judge_min_score is not None
            else "env/default"
        )
        console.print(f"  Tailor judge: {tailor_judge_model} (min {score_label})")
    console.print(f"  Stages:     {' -> '.join(ordered)}")

    # Pre-run stats
    pre_stats = get_stats()
    console.print(f"  DB:        {pre_stats['total']} jobs, {pre_stats['pending_detail']} pending enrichment")

    if dry_run:
        console.print(f"\n  [yellow]DRY RUN[/yellow] — would execute ({mode}):")
        for name in ordered:
            meta = STAGE_META[name]
            console.print(f"    {name:<12s}  {meta['desc']}")
            _record_operational_attempt(
                stage=name,
                attempt_kind="pipeline_stage",
                outcome="dry_run",
                metadata={"mode": mode, "planned": True},
            )
        console.print("\n  No changes made.")
        return {"stages": [], "errors": {}, "elapsed": 0.0}

    # Execute
    if stream:
        result = _run_streaming(
            ordered,
            min_score,
            workers=workers,
            validation_mode=validation_mode,
            limit=limit,
            rescore=rescore,
            retailor=retailor,
            llm_model=llm_model,
            tailor_models=tailor_models,
            tailor_judge_model=tailor_judge_model,
            tailor_judge_min_score=tailor_judge_min_score,
        )
    else:
        result = _run_sequential(
            ordered,
            min_score,
            workers=workers,
            validation_mode=validation_mode,
            limit=limit,
            rescore=rescore,
            retailor=retailor,
            llm_model=llm_model,
            tailor_models=tailor_models,
            tailor_judge_model=tailor_judge_model,
            tailor_judge_min_score=tailor_judge_min_score,
        )

    # Summary table
    console.print(f"\n{'=' * 70}")
    summary = Table(title="Pipeline Summary", show_header=True, header_style="bold")
    summary.add_column("Stage", style="bold")
    summary.add_column("Status")
    summary.add_column("Time", justify="right")

    for r in result["stages"]:
        elapsed_str = f"{r['elapsed']:.1f}s"
        status_display = r["status"][:30]
        if r["status"] == "ok":
            style = "green"
        elif r["status"] in ("partial", "skipped"):
            style = "yellow"
        else:
            style = "red"
        summary.add_row(r["stage"], f"[{style}]{status_display}[/{style}]", elapsed_str)

    summary.add_row("", "", "")
    summary.add_row("[bold]Total[/bold]", "", f"[bold]{result['elapsed']:.1f}s[/bold]")
    console.print(summary)

    # Final DB stats
    final = get_stats()
    console.print("\n  [bold]DB Final State:[/bold]")
    console.print(f"    Total jobs:     {final['total']}")
    console.print(f"    With desc:      {final['with_description']}")
    console.print(f"    Scored:         {final['scored']}")
    console.print(f"    Tailored:       {final['tailored']}")
    console.print(f"    Cover letters:  {final['with_cover_letter']}")
    console.print(f"    Ready to apply: {final['ready_to_apply']}")
    console.print(f"    Applied:        {final['applied']}")
    console.print(f"{'=' * 70}\n")

    return result


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
    """Process a single job by URL: optionally tailor + cover letter, then apply.

    If the job is not yet in the database it will be inserted and enriched
    (full description + application URL scraped) automatically.

    Args:
        url: Job URL.
        do_tailor: Score (if needed), tailor resume, generate cover letter, convert to PDF.
        do_apply: Launch auto-apply for this job.
        validation_mode: Validation strictness for tailor/cover.
        model: Claude model for auto-apply.
        headless: Run Chrome in headless mode for apply.
        dry_run: Preview without executing.

    Returns:
        Dict with keys: url, tailor_status, cover_status, apply_status, errors.
    """
    from datetime import datetime, timezone
    from urllib.parse import urlparse

    from jobhunter.config import (
        RESUME_PATH, TAILORED_DIR, COVER_LETTER_DIR,
    )
    from jobhunter.domain.tenant import LOCAL_TENANT
    from jobhunter.infrastructure.profile import get_profile_repository

    load_env()
    ensure_dirs()
    init_db()

    conn = get_connection()
    # Phase 7 (S-26 round-1 review B6): use the helper that LEFT JOINs
    # ``job_enrichments`` and promotes ``full_description`` /
    # ``application_url`` / ``detail_scraped_at`` into the legacy
    # column slots — bare ``SELECT * FROM jobs`` reads NULL on the new
    # write path.
    from jobhunter.database import load_job_with_enrichment

    job_record = load_job_with_enrichment(conn, url)

    if job_record is None:
        # ---- Auto-insert + enrich unknown job URL ----
        console.print("  [cyan]Job not in database — inserting and enriching...[/cyan]")

        # Derive a site label from the hostname
        hostname = urlparse(url).hostname or ""
        _ATS_DOMAINS = {
            "greenhouse.io": "Greenhouse",
            "lever.co": "Lever",
            "ashbyhq.com": "Ashby",
            "myworkdayjobs.com": "Workday",
            "icims.com": "iCIMS",
            "smartrecruiters.com": "SmartRecruiters",
            "jobvite.com": "Jobvite",
            "recruitee.com": "Recruitee",
            "bamboohr.com": "BambooHR",
            "jazz.co": "JazzHR",
        }
        site = "Unknown"
        for domain, label in _ATS_DOMAINS.items():
            if hostname.endswith(domain):
                site = label
                break
        else:
            # Use the first subdomain segment as fallback
            site = hostname.split(".")[0].capitalize() if hostname else "Unknown"

        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO jobs (url, title, site, strategy, discovered_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (url, None, site, "manual", now),
        )
        conn.commit()

        if not dry_run:
            from jobhunter.enrichment.detail import scrape_site_batch

            enrich_stats = scrape_site_batch(
                conn=conn,
                site=site,
                jobs=[(url, "(manual)")],
                delay=0,
            )
            if enrich_stats["ok"] == 0 and enrich_stats["partial"] == 0:
                return {
                    "url": url,
                    "error": "Enrichment failed — could not scrape job description",
                }
        else:
            console.print("  [dim]DRY RUN — would enrich job[/dim]")

        # Re-read after enrichment via the same helper
        job_record = load_job_with_enrichment(conn, url)
        if job_record is None:
            return {"url": url, "error": "Job disappeared after insert"}

        # Infer title from description if still missing
        if not job_record.get("title") and job_record.get("full_description"):
            # Use first non-empty line as a rough title
            for line in job_record["full_description"].splitlines():
                line = line.strip()
                if 10 < len(line) < 120:
                    conn.execute("UPDATE jobs SET title = ? WHERE url = ?", (line, url))
                    conn.commit()
                    break
            # Re-read with updated title
            job_record = load_job_with_enrichment(conn, url)

    job = job_record or {}
    result: dict = {"url": url, "title": job.get("title") or "", "errors": []}

    # ------------------------------------------------------------------
    # Tailor flow: enrich (if needed) → score → tailor → cover letter → PDF
    # ------------------------------------------------------------------
    if do_tailor:
        # Enrich if missing full description (job was in DB but never enriched)
        if not job.get("full_description"):
            console.print("  [cyan]Job has no description — enriching...[/cyan]")
            if not dry_run:
                from jobhunter.enrichment.detail import scrape_site_batch

                enrich_stats = scrape_site_batch(
                    conn=conn,
                    site=job.get("site", "Unknown"),
                    jobs=[(url, job.get("title") or "(manual)")],
                    delay=0,
                )
                if enrich_stats["ok"] == 0 and enrich_stats["partial"] == 0:
                    result["error"] = "Enrichment failed — could not scrape job description"
                    return result
                # Re-read through the helper so enrichment fields land
                # in the row dict.
                job = load_job_with_enrichment(conn, url) or {}
            else:
                console.print("  [dim]DRY RUN — would enrich job[/dim]")

        if not dry_run and not job.get("full_description"):
            result["error"] = "Job still has no full description after enrichment"
            return result

        snapshot = get_profile_repository().load_snapshot(LOCAL_TENANT)
        resume_text = RESUME_PATH.read_text(encoding="utf-8")

        # Score if not yet scored. Phase 5 (S-18): scoring goes through the
        # ScoreRepository — no more inline UPDATE jobs SET fit_score writes.
        from jobhunter.domain.identifiers import JobId
        from jobhunter.infrastructure.scoring import SqliteScoreRepository

        score_repo = SqliteScoreRepository(conn)
        existing_score = score_repo.load(LOCAL_TENANT, JobId(str(url)))
        score_for_downstream = existing_score
        if existing_score is None:
            console.print("  [cyan]Scoring job...[/cyan]")
            if not dry_run:
                from jobhunter.scoring.scorer import score_job
                outcome = score_job(
                    snapshot,
                    job,
                    repository=score_repo,
                    resume_text=resume_text,
                )
                if outcome.ok and outcome.score is not None:
                    score_for_downstream = outcome.score
                    job["fit_score"] = outcome.score.fit_score.value
                    console.print(f"  Score: [bold]{outcome.score.fit_score.value}[/bold]/10")
                else:
                    result["error"] = outcome.error or "Scoring failed"
                    return result
            else:
                console.print("  [dim]DRY RUN — would score job[/dim]")
        else:
            job["fit_score"] = existing_score.fit_score.value

        if score_for_downstream is not None:
            eligibility = score_for_downstream.breakdown.eligibility
            if eligibility.status == "blocked" or eligibility.hard_blockers:
                blockers = ", ".join(eligibility.hard_blockers) or eligibility.status
                result["tailor_status"] = "blocked_score_eligibility"
                result["cover_status"] = "blocked_score_eligibility"
                if do_apply:
                    result["apply_status"] = "skipped"
                result["errors"].append(
                    f"Score eligibility blocks tailoring: {blockers}"
                )
                console.print(
                    "  [yellow]Skipping tailoring and cover letter: "
                    f"score eligibility blocked ({blockers})[/yellow]"
                )
                return result

        # Tailor resume — Phase 6 (S-23) routes through TailorResumeUseCase
        # via the existing ``_tailor_one_job`` thin wrapper. No more
        # ``UPDATE jobs SET tailored_resume_path``: persistence happens
        # inside the use case via ``MaterialsRepository``.
        console.print("  [cyan]Tailoring resume...[/cyan]")
        if not dry_run:
            from jobhunter.scoring.tailor import _tailor_one_job

            TAILORED_DIR.mkdir(parents=True, exist_ok=True)
            tailor_result = _tailor_one_job(job, resume_text, snapshot, validation_mode)

            _success = {"approved"}
            if tailor_result["status"] in _success and tailor_result.get("path"):
                # Surface the materials path into the legacy job dict slot
                # so the cover-letter step (still file-driven) can read it.
                job["tailored_resume_path"] = tailor_result["path"]

            result["tailor_status"] = tailor_result["status"]
            result["tailored_path"] = tailor_result.get("path")
            console.print(f"  Tailor: [bold]{tailor_result['status']}[/bold]")

            if tailor_result["status"] not in _success:
                result["errors"].append(f"Tailor failed: {tailor_result['status']}")
                result["cover_status"] = "blocked_tailor_failed"
                result["apply_status"] = "skipped"
                return result
        else:
            console.print("  [dim]DRY RUN — would tailor resume[/dim]")
            result["tailor_status"] = "dry_run"

        # Cover letter — Phase 6 (S-24) routes through
        # GenerateCoverLetterUseCase. Persistence + PDF render happen in
        # the use case path; this branch only surfaces status to the UI.
        console.print("  [cyan]Generating cover letter...[/cyan]")
        if not dry_run:
            from pathlib import Path

            from jobhunter.scoring.cover_letter import _build_use_case as _build_cover_use_case
            from jobhunter.infrastructure.materials import (
                PlaywrightHtmlPdfAdapter,
                SqliteMaterialsRepository,
            )

            COVER_LETTER_DIR.mkdir(parents=True, exist_ok=True)
            cover_use_case = _build_cover_use_case(
                repository=SqliteMaterialsRepository(conn),
            )
            try:
                outcome = cover_use_case.execute(
                    job=job,
                    profile_snapshot=snapshot,
                    cover_letter_dir=COVER_LETTER_DIR,
                    validation_mode=validation_mode,
                )
                if outcome.status == "ok" and outcome.text_path and outcome.materials is not None:
                    # Best-effort cover-letter PDF render so the apply
                    # launcher can pick it up alongside the txt artifact.
                    try:
                        cl_text = Path(outcome.text_path).read_text(encoding="utf-8")
                        pdf_artifact = PlaywrightHtmlPdfAdapter().render_cover_letter_to_pdf(
                            cover_letter_text=cl_text,
                            output_path=str(Path(outcome.text_path).with_suffix(".pdf")),
                            created_at=datetime.now(timezone.utc).isoformat(),
                        )
                        materials = outcome.materials.with_cover_letter_pdf(
                            pdf_artifact,
                            updated_at=datetime.now(timezone.utc).isoformat(),
                        )
                        SqliteMaterialsRepository(conn).save(materials)
                    except Exception:
                        log.debug("Cover letter PDF failed", exc_info=True)
                    result["cover_status"] = "ok"
                    result["cover_letter_path"] = outcome.text_path
                    console.print("  Cover letter: [bold green]ok[/bold green]")
                else:
                    result["cover_status"] = f"error: {outcome.error or outcome.status}"
                    result["errors"].append(
                        f"Cover letter failed: {outcome.error or outcome.status}"
                    )
                    console.print(f"  Cover letter: [red]error[/red] — {outcome.error or outcome.status}")
            except Exception as e:
                result["cover_status"] = f"error: {e}"
                result["errors"].append(f"Cover letter failed: {e}")
                console.print(f"  Cover letter: [red]error[/red] — {e}")
        else:
            console.print("  [dim]DRY RUN — would generate cover letter[/dim]")
            result["cover_status"] = "dry_run"

    # ------------------------------------------------------------------
    # Apply flow
    # ------------------------------------------------------------------
    if do_apply:
        # Re-read job to pick up any changes from tailoring above
        row = conn.execute("SELECT * FROM jobs WHERE url = ?", (url,)).fetchone()
        job = dict(row) if row else job

        if not job.get("tailored_resume_path"):
            msg = "Job has no tailored resume — run with --tailor first"
            result["apply_status"] = "skipped"
            result["errors"].append(msg)
            console.print(f"  [red]{msg}[/red]")
        elif not job.get("application_url"):
            msg = "Job has no application URL — run enrichment first"
            result["apply_status"] = "skipped"
            result["errors"].append(msg)
            console.print(f"  [red]{msg}[/red]")
        else:
            console.print("  [cyan]Launching auto-apply...[/cyan]")
            if not dry_run:
                from jobhunter.apply.launcher import main as apply_main
                apply_main(
                    limit=1,
                    target_url=url,
                    min_score=0,  # bypass score filter for targeted apply
                    headless=headless,
                    model=model,
                    dry_run=False,
                    workers=1,
                )
                result["apply_status"] = "launched"
            else:
                console.print("  [dim]DRY RUN — would launch auto-apply[/dim]")
                result["apply_status"] = "dry_run"

    return result
