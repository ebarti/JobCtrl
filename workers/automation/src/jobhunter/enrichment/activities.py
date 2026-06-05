"""Temporal activity for the enrichment stage."""

from __future__ import annotations

from dataclasses import dataclass, field
import time
from typing import Any

from temporalio import activity


@dataclass(frozen=True)
class EnrichActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    limit: int = 0
    workers: int = 1
    dry_run: bool = False
    job_urls: tuple[str, ...] = ()
    workflow_id: str | None = None


@dataclass(frozen=True)
class EnrichActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@activity.defn(name="enrich")
async def enrich_activity(payload: EnrichActivityInput) -> EnrichActivityOutput:
    """Run the enrichment stage via ``run_pipeline``."""
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.pipeline import run_pipeline

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    if payload.job_urls:
        result = await run_blocking_with_heartbeat(
            lambda: _run_selected_enrichment(payload),
            starting_message="selected enrich starting",
            progress_message="selected enrich still running",
        )
        return EnrichActivityOutput(
            status=str(result["status"]),
            elapsed=float(result["elapsed"]),
            errors=dict(result["errors"]),
            stages=list(result["stages"]),
        )

    def _do() -> dict[str, Any]:
        return run_pipeline(
            stages=["enrich"],
            workers=payload.workers,
            limit=payload.limit,
            dry_run=payload.dry_run,
            workflow_id=payload.workflow_id,
        )

    result = await run_blocking_with_heartbeat(
        _do,
        starting_message="enrich starting",
        progress_message="enrich still running",
    )
    stages = list(result.get("stages") or [])
    errors = dict(result.get("errors") or {})
    status = stages[0]["status"] if stages else ("failed" if errors else "ok")
    return EnrichActivityOutput(
        status=status,
        elapsed=float(result.get("elapsed") or 0.0),
        errors=errors,
        stages=stages,
    )


def _run_selected_enrichment(payload: EnrichActivityInput) -> dict[str, Any]:
    from jobhunter.database import get_connection
    from jobhunter.enrichment.detail import _run_detail_scraper

    urls = _limited_job_urls(payload.job_urls, payload.limit)
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
                    "selected": len(urls),
                    "dry_run": True,
                }
            ],
        }

    t0 = time.time()
    stats = _run_detail_scraper(
        get_connection(),
        max_per_site=payload.limit or None,
        workers=payload.workers,
        job_urls=urls,
    )
    elapsed = time.time() - t0
    errors = (
        {"enrich": f"{stats.get('error', 0)} enrichment error(s)"}
        if int(stats.get("error") or 0) > 0
        else {}
    )
    status = "failed" if errors else "ok"
    return {
        "status": status,
        "elapsed": elapsed,
        "errors": errors,
        "stages": [
            {
                "stage": "enrich",
                "status": status,
                "elapsed": elapsed,
                "selected": len(urls),
                **stats,
            }
        ],
    }


def _limited_job_urls(job_urls: tuple[str, ...], limit: int) -> tuple[str, ...]:
    unique = tuple(dict.fromkeys(url for url in job_urls if url))
    if limit > 0:
        return unique[:limit]
    return unique
