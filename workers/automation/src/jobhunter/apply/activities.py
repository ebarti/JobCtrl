"""Temporal activity for the apply stage.

Wraps ``apply.launcher.main`` directly (rather than ``run_pipeline``) because
apply is its own stage with its own parameter shape — model, headless,
min_score, workers — that the generic pipeline orchestrator does not pass
through.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import activity


@dataclass(frozen=True)
class ApplyActivityInput:
    tenant_id: str
    job_url: str | None = None
    limit: int = 1
    min_score: int = 7
    model: str = "haiku"
    headless: bool = False
    dry_run: bool = False
    workers: int = 1


@dataclass(frozen=True)
class ApplyActivityOutput:
    status: str
    applied: int
    failed: int
    error: str | None = None


@activity.defn(name="apply")
async def apply_activity(payload: ApplyActivityInput) -> ApplyActivityOutput:
    """Run the apply launcher in a worker thread, heart-beating so cancellation lands."""

    def _run_apply() -> tuple[int, int]:
        from jobhunter.apply.launcher import main as apply_main

        return apply_main(
            limit=max(1, payload.limit),
            target_url=payload.job_url,
            min_score=payload.min_score,
            headless=payload.headless,
            model=payload.model,
            dry_run=payload.dry_run,
            workers=payload.workers,
        )

    activity.heartbeat("apply starting")
    loop = asyncio.get_running_loop()
    apply_task = loop.run_in_executor(None, _run_apply)

    try:
        while True:
            try:
                applied, failed = await asyncio.wait_for(asyncio.shield(apply_task), timeout=15.0)
                break
            except asyncio.TimeoutError:
                activity.heartbeat("apply still running")
    except asyncio.CancelledError:
        activity.logger.info("apply_activity cancelled")
        raise
    except Exception as exc:  # noqa: BLE001 — apply path must surface as structured failure
        return ApplyActivityOutput(
            status="failed",
            applied=0,
            failed=0,
            error=str(exc),
        )

    status = "ok" if failed == 0 else "failed"
    return ApplyActivityOutput(
        status=status,
        applied=int(applied),
        failed=int(failed),
        error=None,
    )


# Re-exported for the registry; activity decorator metadata is preserved.
__all__: list[Any] = ["apply_activity", "ApplyActivityInput", "ApplyActivityOutput"]
