"""Temporal activity for the scoring stage."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from temporalio import activity


@dataclass(frozen=True)
class ScoreActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    limit: int = 0
    workers: int = 1
    dry_run: bool = False
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
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.pipeline import run_pipeline

    def _do() -> dict[str, Any]:
        return run_pipeline(
            stages=["score"],
            workers=payload.workers,
            limit=payload.limit,
            dry_run=payload.dry_run,
            rescore=payload.rescore,
        )

    result = await run_blocking_with_heartbeat(
        _do,
        starting_message="score starting",
        progress_message="score still running",
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
