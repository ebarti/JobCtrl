"""Temporal activity for the discovery stage.

Wraps the existing ``run_pipeline(stages=["discover"])`` orchestrator so the
Temporal workflow consults the same stage runner the CLI uses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from temporalio import activity


@dataclass(frozen=True)
class DiscoverActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    workers: int = 1


@dataclass(frozen=True)
class DiscoverActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@activity.defn(name="discover")
async def discover_activity(payload: DiscoverActivityInput) -> DiscoverActivityOutput:
    """Run the discovery stage via ``run_pipeline``."""
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.pipeline import run_pipeline

    def _do() -> dict[str, Any]:
        return run_pipeline(stages=["discover"], workers=payload.workers)

    result = await run_blocking_with_heartbeat(
        _do,
        starting_message="discover starting",
        progress_message="discover still running",
    )
    stages = list(result.get("stages") or [])
    errors = dict(result.get("errors") or {})
    status = stages[0]["status"] if stages else ("failed" if errors else "ok")
    return DiscoverActivityOutput(
        status=status,
        elapsed=float(result.get("elapsed") or 0.0),
        errors=errors,
        stages=stages,
    )
