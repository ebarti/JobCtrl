"""Temporal activity for the enrichment stage."""

from __future__ import annotations

from dataclasses import dataclass, field
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

    def _do() -> dict[str, Any]:
        return run_pipeline(
            stages=["enrich"],
            workers=payload.workers,
            limit=payload.limit,
            dry_run=payload.dry_run,
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
