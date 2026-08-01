"""Temporal activity for the enrichment stage."""

from __future__ import annotations

from dataclasses import dataclass, field
import threading
import time
from typing import Any

from temporalio import activity

from jobctrl.domain.errors import JobCtrlError, TransientNetworkError, to_application_error
from jobctrl.domain.identifiers import JobId, canonical_job_id


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

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_ids", _canonical_job_ids(self.job_ids))


@dataclass(frozen=True)
class EnrichActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


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

    cancel_event = threading.Event()
    try:
        if payload.job_ids:
            result = await run_blocking_with_heartbeat(
                lambda: _run_selected_enrichment(payload, cancel_event=cancel_event),
                starting_message="selected enrich starting",
                progress_message="selected enrich still running",
                on_cancel=cancel_event.set,
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

        result = await run_blocking_with_heartbeat(
            lambda: _run_stage_observed(
                "enrich",
                _run_enrich,
                {
                    "workers": payload.workers,
                    "limit": payload.limit,
                    "cancel_event": cancel_event,
                },
                mode="workflow",
                pass_number=1,
            ),
            starting_message="enrich starting",
            progress_message="enrich still running",
            on_cancel=cancel_event.set,
            activity_name="enrich",
        )
        stage_result, elapsed, status = result
        errors: dict[str, str] = {}
        if status not in _SUCCESS_STATUSES:
            errors["enrich"] = str(
                stage_result.get("error")
                or stage_result.get("error_message")
                or status
            )
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
                    "dry_run": True,
                }
            ],
        }

    conn = get_connection()
    t0 = time.time()
    scraper_kwargs: dict[str, Any] = {
        "max_per_site": payload.limit or None,
        "workers": payload.workers,
        "tenant_id": payload.tenant_id,
        "job_ids": job_ids,
    }
    if cancel_event is not None:
        scraper_kwargs["cancel_event"] = cancel_event
    stats = _run_detail_scraper(conn, **scraper_kwargs)
    elapsed = time.time() - t0
    errors = (
        {"enrich": f"{stats.get('error', 0)} enrichment error(s)"}
        if int(stats.get("error") or 0) > 0
        else {}
    )
    status = "partial" if errors else "ok"
    return {
        "status": status,
        "elapsed": elapsed,
        "errors": errors,
        "stages": [
            {
                "stage": "enrich",
                "status": status,
                "elapsed": elapsed,
                "selected": len(job_ids),
                **stats,
            }
        ],
    }


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
