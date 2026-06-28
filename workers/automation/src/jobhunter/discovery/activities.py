"""Temporal activity for the discovery stage.

Wraps the existing ``run_pipeline(stages=["discover"])`` orchestrator so the
Temporal workflow consults the same stage runner the CLI uses.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

from temporalio import activity

from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class DiscoverActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    limit: int = 0
    workers: int = 1
    dry_run: bool = False
    min_score: int = 7
    validation_mode: str = "normal"
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float | None = None
    source_ids: tuple[str, ...] = ()
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    workflow_id: str | None = None


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
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.pipeline import run_pipeline

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    cancel_event = threading.Event()

    def _do() -> dict[str, Any]:
        return run_pipeline(
            stages=["discover"],
            workers=payload.workers,
            limit=payload.limit,
            dry_run=payload.dry_run,
            min_score=payload.min_score,
            validation_mode=payload.validation_mode,
            tailor_models=payload.tailor_models,
            tailor_judge_model=payload.tailor_judge_model,
            tailor_judge_min_score=payload.tailor_judge_min_score,
            source_ids=payload.source_ids,
            llm_model=payload.llm_model,
            workflow_id=payload.workflow_id,
            cancel_event=cancel_event,
        )

    result = await run_blocking_with_heartbeat(
        _do,
        starting_message="discover starting",
        progress_message="discover still running",
        on_cancel=cancel_event.set,
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
