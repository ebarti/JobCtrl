"""Temporal activity for the enrichment stage."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from temporalio import activity


@dataclass(frozen=True)
class EnrichActivityInput:
    tenant_id: str
    limit: int = 0
    workers: int = 1


@dataclass(frozen=True)
class EnrichActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@activity.defn(name="enrich")
async def enrich_activity(payload: EnrichActivityInput) -> EnrichActivityOutput:
    """Run the enrichment stage via ``run_pipeline``."""
    activity.heartbeat("enrich starting")
    from jobhunter.pipeline import run_pipeline

    result = run_pipeline(
        stages=["enrich"],
        workers=payload.workers,
        limit=payload.limit,
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
