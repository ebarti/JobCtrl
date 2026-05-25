"""Temporal activities for the materials-generation stages (tailor / cover)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from temporalio import activity


# ---------------------------------------------------------------------------
# Tailor
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TailorActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    min_score: int = 7
    limit: int = 0
    workers: int = 1
    validation_mode: str = "normal"
    dry_run: bool = False
    retailor: bool = False
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float = 0.82


@dataclass(frozen=True)
class TailorActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@activity.defn(name="tailor")
async def tailor_activity(payload: TailorActivityInput) -> TailorActivityOutput:
    """Run the tailor stage via ``run_pipeline``."""
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
            stages=["tailor"],
            min_score=payload.min_score,
            workers=payload.workers,
            validation_mode=payload.validation_mode,
            limit=payload.limit,
            dry_run=payload.dry_run,
            retailor=payload.retailor,
            tailor_models=payload.tailor_models,
            tailor_judge_model=payload.tailor_judge_model,
            tailor_judge_min_score=payload.tailor_judge_min_score,
        )

    result = await run_blocking_with_heartbeat(
        _do,
        starting_message="tailor starting",
        progress_message="tailor still running",
    )
    stages = list(result.get("stages") or [])
    errors = dict(result.get("errors") or {})
    status = stages[0]["status"] if stages else ("failed" if errors else "ok")
    return TailorActivityOutput(
        status=status,
        elapsed=float(result.get("elapsed") or 0.0),
        errors=errors,
        stages=stages,
    )


# ---------------------------------------------------------------------------
# Cover letter
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CoverActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    min_score: int = 7
    limit: int = 0
    validation_mode: str = "normal"
    dry_run: bool = False


@dataclass(frozen=True)
class CoverActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@activity.defn(name="cover")
async def cover_activity(payload: CoverActivityInput) -> CoverActivityOutput:
    """Run the cover-letter stage via ``run_pipeline``."""
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
            stages=["cover"],
            min_score=payload.min_score,
            validation_mode=payload.validation_mode,
            limit=payload.limit,
            dry_run=payload.dry_run,
        )

    result = await run_blocking_with_heartbeat(
        _do,
        starting_message="cover starting",
        progress_message="cover still running",
    )
    stages = list(result.get("stages") or [])
    errors = dict(result.get("errors") or {})
    status = stages[0]["status"] if stages else ("failed" if errors else "ok")
    return CoverActivityOutput(
        status=status,
        elapsed=float(result.get("elapsed") or 0.0),
        errors=errors,
        stages=stages,
    )
