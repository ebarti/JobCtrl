"""Source-quality projection helpers built from durable ``job_events`` rows."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterable

from jobhunter.domain.operations.projections import (
    DiscoveryRunProjection,
    SourceQualityStats,
)
from jobhunter.domain.tenant import TenantId
from jobhunter.infrastructure.observability.source_spans import (
    source_quality_aggregation_span,
)


SOURCE_QUALITY_EVENT_TYPES = {
    "DiscoveryRunStarted",
    "DiscoveryRunCompleted",
    "DiscoveryRunFailed",
    "JobSourceObserved",
    "DuplicateJobLinked",
    "PostingContentSnapshotCaptured",
    "PostingContentSnapshotFailed",
    "JobEnriched",
    "EnrichmentFailed",
    "JobActiveStateChanged",
    "ContentDuplicateCandidateDetected",
}


@dataclass(frozen=True)
class EventRow:
    event_type: str
    occurred_at: str
    payload: dict[str, Any]
    job_url: str | None = None


@dataclass
class _MutableStats:
    source_id: str
    run_count: int = 0
    failed_run_count: int = 0
    consecutive_failures: int = 0
    observed_jobs: int = 0
    new_jobs: int = 0
    existing_jobs: int = 0
    duplicate_jobs: int = 0
    active_jobs: int = 0
    stale_jobs: int = 0
    detail_success_count: int = 0
    detail_failure_count: int = 0
    last_run_id: str | None = None
    last_error_class: str | None = None
    event_count: int = 0


@dataclass
class SourceQualityProjectionResult:
    runs: tuple[DiscoveryRunProjection, ...]
    stats: tuple[SourceQualityStats, ...]


def event_row_from_sql(row: Any) -> EventRow:
    event_type = _row_value(row, "event_type", 2)
    occurred_at = _row_value(row, "occurred_at", 3)
    payload_json = _row_value(row, "payload_json", 4)
    return EventRow(
        event_type=str(event_type or ""),
        occurred_at=str(occurred_at or ""),
        payload=_json_payload(payload_json),
        job_url=_nullable_str(_row_value(row, "job_url", 1)),
    )


def project_source_quality(
    *,
    tenant_id: TenantId,
    events: Iterable[EventRow],
    updated_at: str,
) -> SourceQualityProjectionResult:
    ordered = tuple(events)
    runs: dict[str, DiscoveryRunProjection] = {}
    stats: dict[str, _MutableStats] = {}
    source_by_observation: dict[str, str] = {}
    sources_by_job: dict[str, set[str]] = {}
    window_start = ordered[0].occurred_at if ordered else updated_at
    window_end = ordered[-1].occurred_at if ordered else updated_at

    for event in ordered:
        if event.event_type not in SOURCE_QUALITY_EVENT_TYPES:
            continue
        payload = event.payload
        if event.event_type == "DiscoveryRunStarted":
            run_id = _text(payload, "run_id", "runId")
            source_ids = tuple(_str_list(_value(payload, "source_ids", "sourceIds")))
            if not run_id:
                continue
            runs[run_id] = DiscoveryRunProjection(
                run_id=run_id,
                tenant_id=tenant_id,
                source_ids=source_ids,
                profile_snapshot_id=_nullable_str(
                    _value(payload, "profile_snapshot_id", "profileSnapshotId")
                ),
                status="running",
                started_at=_text(payload, "started_at", "startedAt") or event.occurred_at,
            )
            for source_id in source_ids:
                _stats(stats, source_id).event_count += 1
        elif event.event_type == "DiscoveryRunCompleted":
            run_id = _text(payload, "run_id", "runId")
            counts = _dict(_value(payload, "counts"))
            source_ids = runs.get(run_id).source_ids if run_id in runs else ()
            if run_id in runs:
                runs[run_id] = _merge_run(
                    runs[run_id],
                    status="completed",
                    counts=_normalize_counts(counts),
                    error_classes=tuple(_str_list(_value(payload, "error_classes", "errorClasses"))),
                    completed_at=_text(payload, "completed_at", "completedAt") or event.occurred_at,
                )
            for source_id in source_ids:
                current = _stats(stats, source_id)
                current.run_count += 1
                current.consecutive_failures = 0
                current.new_jobs += _int(counts, "new_jobs", "newJobs")
                current.existing_jobs += _int(counts, "existing_jobs", "existingJobs")
                current.observed_jobs += _int(counts, "observed_jobs", "observedJobs")
                current.duplicate_jobs += _int(counts, "duplicate_jobs", "duplicateJobs")
                current.last_run_id = run_id
                current.event_count += 1
        elif event.event_type == "DiscoveryRunFailed":
            run_id = _text(payload, "run_id", "runId")
            source_id = _text(payload, "source_id", "sourceId")
            error_class = _text(payload, "error_class", "errorClass")
            if run_id in runs:
                runs[run_id] = _merge_run(
                    runs[run_id],
                    status="failed",
                    error_classes=(error_class,) if error_class else (),
                    failed_at=_text(payload, "failed_at", "failedAt") or event.occurred_at,
                    failed_source_id=source_id or None,
                    retryable=bool(_value(payload, "retryable") is not False),
                )
            if source_id:
                current = _stats(stats, source_id)
                current.failed_run_count += 1
                current.consecutive_failures += 1
                current.last_run_id = run_id or current.last_run_id
                current.last_error_class = error_class or current.last_error_class
                current.event_count += 1
        elif event.event_type == "JobSourceObserved":
            source_id = _text(payload, "source_id", "sourceId")
            observation_id = _text(payload, "source_observation_id", "sourceObservationId")
            job_id = _text(payload, "job_id", "jobId") or event.job_url
            if source_id:
                current = _stats(stats, source_id)
                current.observed_jobs += 1
                current.event_count += 1
                if observation_id:
                    source_by_observation[observation_id] = source_id
                if job_id:
                    sources_by_job.setdefault(job_id, set()).add(source_id)
        elif event.event_type == "DuplicateJobLinked":
            observation_id = _text(
                payload,
                "superseded_job_or_observation_id",
                "supersededJobOrObservationId",
            )
            source_id = source_by_observation.get(observation_id)
            if source_id:
                current = _stats(stats, source_id)
                current.duplicate_jobs += 1
                current.event_count += 1
        elif event.event_type == "PostingContentSnapshotCaptured":
            source_id = _text(payload, "source_id", "sourceId")
            if source_id:
                current = _stats(stats, source_id)
                current.detail_success_count += 1
                current.event_count += 1
        elif event.event_type == "PostingContentSnapshotFailed":
            source_id = _text(payload, "source_id", "sourceId")
            if source_id:
                current = _stats(stats, source_id)
                current.detail_failure_count += 1
                current.last_error_class = _text(payload, "error_class", "errorClass") or None
                current.event_count += 1
        elif event.event_type == "JobActiveStateChanged":
            job_id = _text(payload, "job_id", "jobId") or event.job_url
            active_state = _text(payload, "active_state", "activeState")
            for source_id in sources_by_job.get(job_id, set()):
                current = _stats(stats, source_id)
                if active_state == "active":
                    current.active_jobs += 1
                elif active_state in {"closed", "expired", "removed", "location_incompatible"}:
                    current.stale_jobs += 1
                current.event_count += 1

    projected_stats = []
    for source_id, current in sorted(stats.items()):
        with source_quality_aggregation_span(
            tenant_id=str(tenant_id),
            source_id=source_id,
            window=f"{window_start}/{window_end}",
            event_count=current.event_count,
        ):
            projected_stats.append(
                SourceQualityStats(
                    tenant_id=tenant_id,
                    source_id=source_id,
                    window_start=window_start,
                    window_end=window_end,
                    run_count=current.run_count,
                    failed_run_count=current.failed_run_count,
                    consecutive_failures=current.consecutive_failures,
                    observed_jobs=current.observed_jobs,
                    new_jobs=current.new_jobs,
                    existing_jobs=current.existing_jobs,
                    duplicate_jobs=current.duplicate_jobs,
                    active_jobs=current.active_jobs,
                    stale_jobs=current.stale_jobs,
                    detail_success_count=current.detail_success_count,
                    detail_failure_count=current.detail_failure_count,
                    active_verification_rate=_rate(
                        current.active_jobs,
                        current.active_jobs + current.stale_jobs,
                    ),
                    duplicate_rate=_rate(current.duplicate_jobs, current.observed_jobs),
                    full_description_success_rate=_rate(
                        current.detail_success_count,
                        current.detail_success_count + current.detail_failure_count,
                    ),
                    apply_url_success_rate=None,
                    last_run_id=current.last_run_id,
                    last_error_class=current.last_error_class,
                    recommended_state=_recommended_state(current),
                    updated_at=updated_at,
                )
            )
    return SourceQualityProjectionResult(
        runs=tuple(runs.values()),
        stats=tuple(projected_stats),
    )


def _stats(stats: dict[str, _MutableStats], source_id: str) -> _MutableStats:
    if source_id not in stats:
        stats[source_id] = _MutableStats(source_id=source_id)
    return stats[source_id]


def _merge_run(
    run: DiscoveryRunProjection,
    *,
    status: str,
    counts: dict[str, int] | None = None,
    error_classes: tuple[str, ...] | None = None,
    completed_at: str | None = None,
    failed_at: str | None = None,
    failed_source_id: str | None = None,
    retryable: bool | None = None,
) -> DiscoveryRunProjection:
    return DiscoveryRunProjection(
        run_id=run.run_id,
        tenant_id=run.tenant_id,
        source_ids=run.source_ids,
        profile_snapshot_id=run.profile_snapshot_id,
        status=status,
        counts=counts if counts is not None else run.counts,
        error_classes=error_classes if error_classes is not None else run.error_classes,
        started_at=run.started_at,
        completed_at=completed_at if completed_at is not None else run.completed_at,
        failed_at=failed_at if failed_at is not None else run.failed_at,
        failed_source_id=failed_source_id if failed_source_id is not None else run.failed_source_id,
        retryable=retryable if retryable is not None else run.retryable,
    )


def _recommended_state(stats: _MutableStats) -> str:
    active_rate = _rate(stats.active_jobs, stats.active_jobs + stats.stale_jobs)
    duplicate_rate = _rate(stats.duplicate_jobs, stats.observed_jobs)
    detail_rate = _rate(
        stats.detail_success_count,
        stats.detail_success_count + stats.detail_failure_count,
    )
    sample = max(stats.observed_jobs, stats.new_jobs + stats.existing_jobs)
    if stats.consecutive_failures >= 5:
        return "disabled"
    if stats.consecutive_failures >= 3:
        return "quarantined"
    if sample >= 10 and duplicate_rate is not None and duplicate_rate >= 0.85:
        return "quarantined"
    if sample >= 10 and active_rate is not None and active_rate < 0.25:
        return "quarantined"
    if sample >= 10 and detail_rate is not None and detail_rate < 0.25:
        return "quarantined"
    return "normal"


def _normalize_counts(counts: dict[str, Any]) -> dict[str, int]:
    return {
        "total": _int(counts, "total"),
        "new_jobs": _int(counts, "new_jobs", "newJobs"),
        "existing_jobs": _int(counts, "existing_jobs", "existingJobs"),
        "observed_jobs": _int(counts, "observed_jobs", "observedJobs"),
        "duplicate_jobs": _int(counts, "duplicate_jobs", "duplicateJobs"),
        "rejected_duplicates": _int(counts, "rejected_duplicates", "rejectedDuplicates"),
    }


def _rate(numerator: int, denominator: int) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator, 4)


def _json_payload(raw: object) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _row_value(row: Any, key: str, index: int) -> Any:
    if hasattr(row, "keys") and key in row.keys():
        return row[key]
    return row[index]


def _value(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload:
            return payload[key]
    return None


def _text(payload: dict[str, Any], *keys: str) -> str:
    value = _value(payload, *keys)
    if value is None:
        return ""
    return str(value)


def _nullable_str(value: object) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


def _str_list(value: object) -> list[str]:
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value if str(item)]
    return []


def _dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _int(payload: dict[str, Any], *keys: str) -> int:
    value = _value(payload, *keys)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
