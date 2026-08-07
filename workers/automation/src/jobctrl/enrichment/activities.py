"""Temporal activity for the enrichment stage."""

from __future__ import annotations

from dataclasses import dataclass, field
import threading
import time
from typing import Any

from temporalio import activity

from jobctrl.domain.errors import JobCtrlError, TransientNetworkError, to_application_error
from jobctrl.domain.identifiers import JobId, canonical_job_id


class _ActivityCancellationEvent(threading.Event):
    """Cooperative stop signal that preserves why Temporal stopped an attempt.

    A Temporal activity task can be cancelled because the user cancelled the
    workflow, but it can also be interrupted by an activity timeout, worker
    shutdown, reset, or a stale/not-found task token.  The activity-local signal
    terminalizes only an explicit SDK cancellation request; the workflow's
    separate cancellation-cleanup activity owns the closed-workflow race where
    this task sees only ``not_found``.  The enrichment thread still stops
    cooperatively for every case, while retryable interruptions remain
    selectable for a replacement attempt.
    """

    terminal_cancellation_requested: bool

    def __init__(self) -> None:
        super().__init__()
        self.terminal_cancellation_requested = False

    def request_stop(self) -> None:
        try:
            details = activity.cancellation_details()
        except RuntimeError:
            details = None
        self.terminal_cancellation_requested = bool(details is None or details.cancel_requested)
        self.set()


@dataclass(frozen=True)
class EnrichActivityInput:
    # Tenant scope travels with selected canonical job identifiers.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    limit: int = 0
    workers: int = 1
    dry_run: bool = False
    job_ids: tuple[JobId, ...] = ()
    workflow_id: str | None = None
    workflow_run_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_ids", _canonical_job_ids(self.job_ids))


@dataclass(frozen=True)
class EnrichActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class CancelEnrichmentCohortInput:
    tenant_id: str
    workflow_id: str
    workflow_run_id: str
    job_ids: tuple[JobId, ...] = ()
    expected_app_dir: str | None = None
    expected_db_path: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_ids", _canonical_job_ids(self.job_ids))


@activity.defn(name="cancel_enrichment_cohort")
async def cancel_enrichment_cohort_activity(
    payload: CancelEnrichmentCohortInput,
) -> int:
    """Terminalize the exact Enrich owner after workflow cancellation."""

    from jobctrl.database import get_connection
    from jobctrl.domain.tenant import TenantId
    from jobctrl.enrichment.detail import cancel_enrichment_cohort
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )
    conn = get_connection()
    if payload.job_ids:
        job_ids = payload.job_ids
    else:
        rows = conn.execute(
            "SELECT job_id FROM job_stage_states "
            "WHERE tenant_id = ? AND stage = 'enrich' "
            "AND state IN ('pending', 'queued', 'running') "
            "AND metadata_json IS NOT NULL AND json_valid(metadata_json) "
            "AND json_extract(metadata_json, '$.workflowId') = ? "
            "AND json_extract(metadata_json, '$.temporalRunId') = ? "
            "ORDER BY job_id",
            (payload.tenant_id, payload.workflow_id, payload.workflow_run_id),
        ).fetchall()
        job_ids = tuple(canonical_job_id(str(row[0])) for row in rows)
    return cancel_enrichment_cohort(
        conn,
        job_ids,
        tenant_id=TenantId(payload.tenant_id),
        workflow_id=payload.workflow_id,
        workflow_run_id=payload.workflow_run_id,
    )


@activity.defn(name="enrich")
async def enrich_activity(payload: EnrichActivityInput) -> EnrichActivityOutput:
    """Run the enrichment stage."""
    from jobctrl.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobctrl.pipeline.runner import _run_enrich, _run_stage_observed

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    cancel_event = _ActivityCancellationEvent()
    try:
        info = activity.info()
        activity_attempt = info.attempt
        activity_owner_token = f"{info.activity_id}:{info.activity_run_id}:{info.attempt}"
    except RuntimeError:
        # Direct unit calls have no Temporal activity context.
        activity_attempt = 1
        activity_owner_token = None
    try:
        if payload.job_ids:
            result = await run_blocking_with_heartbeat(
                lambda: _run_selected_enrichment(
                    payload,
                    cancel_event=cancel_event,
                    activity_attempt=activity_attempt,
                    activity_owner_token=activity_owner_token,
                ),
                starting_message="selected enrich starting",
                progress_message="selected enrich still running",
                on_cancel=cancel_event.request_stop,
                activity_name="enrich",
            )
            _raise_on_failure("enrich", result, TransientNetworkError)
            return EnrichActivityOutput(
                status=str(result["status"]),
                elapsed=float(result["elapsed"]),
                errors=dict(result["errors"]),
                stages=list(result["stages"]),
            )

        if payload.dry_run:
            return EnrichActivityOutput(
                status="ok",
                elapsed=0.0,
                errors={},
                stages=[
                    {
                        "stage": "enrich",
                        "status": "ok",
                        "elapsed": 0.0,
                        "dry_run": True,
                    }
                ],
            )

        def _run_observed_enrichment() -> tuple[dict[str, Any], float, str]:
            observed_kwargs: dict[str, Any] = {
                "workers": payload.workers,
                "limit": payload.limit,
                "cancel_event": cancel_event,
                "workflow_id": payload.workflow_id,
                "workflow_run_id": payload.workflow_run_id,
                **(
                    {"recovery_key": (f"{payload.workflow_id}:{payload.workflow_run_id or 'initial'}")}
                    if payload.workflow_id
                    else {}
                ),
            }
            activity_lease = _claim_activity_enrichment_lease(
                payload,
                activity_attempt=activity_attempt,
                activity_owner_token=activity_owner_token,
            )
            if activity_lease is not None:
                observed_kwargs["activity_lease"] = activity_lease
            return _run_stage_observed(
                "enrich",
                _run_enrich,
                observed_kwargs,
                mode="workflow",
                pass_number=1,
            )

        result = await run_blocking_with_heartbeat(
            _run_observed_enrichment,
            starting_message="enrich starting",
            progress_message="enrich still running",
            on_cancel=cancel_event.request_stop,
            activity_name="enrich",
        )
        stage_result, elapsed, status = result
        errors: dict[str, str] = {}
        if status not in _SUCCESS_STATUSES:
            errors["enrich"] = str(stage_result.get("error") or stage_result.get("error_message") or status)
        stages = [{"stage": "enrich", "status": status, "elapsed": elapsed, **stage_result}]
        activity_result = {
            "status": status,
            "elapsed": float(elapsed),
            "errors": errors,
            "stages": stages,
        }
        _raise_on_failure("enrich", activity_result, TransientNetworkError)
        return EnrichActivityOutput(
            status=status,
            elapsed=float(elapsed),
            errors=errors,
            stages=stages,
        )
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


def _run_selected_enrichment(
    payload: EnrichActivityInput,
    *,
    cancel_event: threading.Event | None = None,
    activity_attempt: int = 1,
    activity_owner_token: str | None = None,
) -> dict[str, Any]:
    from jobctrl.database import get_connection
    from jobctrl.enrichment.detail import _run_detail_scraper

    job_ids = _limited_job_ids(payload.job_ids, payload.limit)
    if payload.dry_run:
        return {
            "status": "ok",
            "elapsed": 0.0,
            "errors": {},
            "stages": [
                {
                    "stage": "enrich",
                    "status": "ok",
                    "elapsed": 0.0,
                    "selected": len(job_ids),
                    "enrichedJobIds": [str(job_id) for job_id in job_ids],
                    "dry_run": True,
                }
            ],
        }

    conn = get_connection()
    activity_lease = _claim_activity_enrichment_lease(
        payload,
        activity_attempt=activity_attempt,
        activity_owner_token=activity_owner_token,
        conn=conn,
    )
    t0 = time.time()
    scraper_kwargs: dict[str, Any] = {
        "max_per_site": payload.limit or None,
        "workers": payload.workers,
        "tenant_id": payload.tenant_id,
        "job_ids": job_ids,
    }
    if payload.workflow_id:
        scraper_kwargs["workflow_id"] = payload.workflow_id
    if payload.workflow_run_id:
        scraper_kwargs["workflow_run_id"] = payload.workflow_run_id
    if cancel_event is not None:
        scraper_kwargs["cancel_event"] = cancel_event
    if activity_lease is not None:
        scraper_kwargs["activity_lease"] = activity_lease
    stats = _run_detail_scraper(conn, **scraper_kwargs)
    elapsed = time.time() - t0
    enriched_job_ids = _selected_enriched_job_ids(
        conn,
        tenant_id=payload.tenant_id,
        job_ids=job_ids,
    )
    # Per-job blocked/failed outcomes are durable lifecycle results, not a
    # systemic activity failure.  Keep them in the stage diagnostics while
    # returning the exact successful subset so the workflow never dispatches
    # downstream stages for jobs that are not canonically enriched.
    status = "ok" if len(enriched_job_ids) == len(job_ids) else "partial"
    return {
        "status": status,
        "elapsed": elapsed,
        "errors": {},
        "stages": [
            {
                "stage": "enrich",
                "status": status,
                "elapsed": elapsed,
                "selected": len(job_ids),
                "enrichedJobIds": [str(job_id) for job_id in enriched_job_ids],
                **stats,
            }
        ],
    }


def _selected_enriched_job_ids(
    conn: Any,
    *,
    tenant_id: str,
    job_ids: tuple[JobId, ...],
) -> tuple[JobId, ...]:
    """Return the requested IDs that have a canonical usable enrichment."""

    if not job_ids:
        return ()
    placeholders = ", ".join("?" for _ in job_ids)
    rows = conn.execute(
        "SELECT job_id FROM job_enrichments "
        f"WHERE tenant_id = ? AND job_id IN ({placeholders}) "
        "AND current_status = 'enriched' "
        "AND full_description IS NOT NULL "
        "AND trim(full_description) != ''",
        (tenant_id, *(str(job_id) for job_id in job_ids)),
    ).fetchall()
    enriched = {str(row[0]) for row in rows}
    return tuple(job_id for job_id in job_ids if str(job_id) in enriched)


def _claim_activity_enrichment_lease(
    payload: EnrichActivityInput,
    *,
    activity_attempt: int,
    activity_owner_token: str | None,
    conn: Any | None = None,
):
    """Claim the exact pipeline Enrich execution before any durable write."""

    if not payload.workflow_id or not payload.workflow_run_id or not activity_owner_token:
        return None
    from jobctrl.database import get_connection
    from jobctrl.domain.tenant import TenantId
    from jobctrl.infrastructure.enrichment.execution_lease import (
        claim_enrichment_execution_lease_for_run,
    )

    return claim_enrichment_execution_lease_for_run(
        conn or get_connection(),
        tenant_id=TenantId(payload.tenant_id),
        workflow_id=payload.workflow_id,
        run_id=payload.workflow_run_id,
        owner_token=activity_owner_token,
        activity_phase=1,
        activity_attempt=activity_attempt,
    )


def _limited_job_ids(job_ids: tuple[JobId, ...], limit: int) -> tuple[JobId, ...]:
    unique = tuple(dict.fromkeys(job_ids))
    if limit > 0:
        return unique[:limit]
    return unique


def _canonical_job_ids(job_ids: tuple[JobId, ...]) -> tuple[JobId, ...]:
    return tuple(dict.fromkeys(canonical_job_id(str(job_id)) for job_id in job_ids))


_SUCCESS_STATUSES = {"ok", "partial", "skipped", "already_done"}


def _raise_on_failure(stage: str, result: dict[str, Any], error_type: type[JobCtrlError]) -> None:
    status = str(result.get("status") or "ok").lower()
    if status not in _SUCCESS_STATUSES:
        detail = result.get("errors") or result.get("error") or result.get("status") or "stage failed"
        raise error_type(f"{stage} failed: {detail}")
