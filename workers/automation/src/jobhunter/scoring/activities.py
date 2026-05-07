"""Temporal activity for the scoring stage."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from temporalio import activity


@dataclass(frozen=True)
class ScoreActivityInput:
    tenant_id: str
    limit: int = 0
    workers: int = 1
    rescore: bool = False


@dataclass(frozen=True)
class ScoreActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@activity.defn(name="score")
async def score_activity(payload: ScoreActivityInput) -> ScoreActivityOutput:
    """Run the scoring stage via ``run_pipeline``."""
    activity.heartbeat("score starting")
    from jobhunter.pipeline import run_pipeline

    result = run_pipeline(
        stages=["score"],
        workers=payload.workers,
        limit=payload.limit,
        rescore=payload.rescore,
    )
    stages = list(result.get("stages") or [])
    errors = dict(result.get("errors") or {})
    status = stages[0]["status"] if stages else ("failed" if errors else "ok")
    return ScoreActivityOutput(
        status=status,
        elapsed=float(result.get("elapsed") or 0.0),
        errors=errors,
        stages=stages,
    )
