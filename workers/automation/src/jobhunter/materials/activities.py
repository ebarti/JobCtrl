"""Temporal activities for the materials-generation stages (tailor / cover / pdf)."""

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
    min_score: int = 7
    limit: int = 0
    workers: int = 1
    validation_mode: str = "normal"
    retailor: bool = False


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
    from jobhunter.pipeline import run_pipeline

    def _do() -> dict[str, Any]:
        return run_pipeline(
            stages=["tailor"],
            min_score=payload.min_score,
            workers=payload.workers,
            validation_mode=payload.validation_mode,
            limit=payload.limit,
            retailor=payload.retailor,
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
    min_score: int = 7
    limit: int = 0
    validation_mode: str = "normal"


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
    from jobhunter.pipeline import run_pipeline

    def _do() -> dict[str, Any]:
        return run_pipeline(
            stages=["cover"],
            min_score=payload.min_score,
            validation_mode=payload.validation_mode,
            limit=payload.limit,
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


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PdfActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    limit: int = 0


@dataclass(frozen=True)
class PdfActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@activity.defn(name="pdf")
async def pdf_activity(payload: PdfActivityInput) -> PdfActivityOutput:
    """Run the pdf-conversion stage via ``run_pipeline``."""
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.pipeline import run_pipeline

    def _do() -> dict[str, Any]:
        return run_pipeline(stages=["pdf"], limit=payload.limit)

    result = await run_blocking_with_heartbeat(
        _do,
        starting_message="pdf starting",
        progress_message="pdf still running",
    )
    stages = list(result.get("stages") or [])
    errors = dict(result.get("errors") or {})
    status = stages[0]["status"] if stages else ("failed" if errors else "ok")
    return PdfActivityOutput(
        status=status,
        elapsed=float(result.get("elapsed") or 0.0),
        errors=errors,
        stages=stages,
    )
