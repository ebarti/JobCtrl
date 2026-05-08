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
from temporalio.exceptions import ApplicationError


@dataclass(frozen=True)
class ApplyActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    job_url: str | None = None
    limit: int = 1
    min_score: int = 7
    model: str = "haiku"
    headless: bool = False
    dry_run: bool = False
    workers: int = 1
    # Run-forever poll mode — when True, the activity calls ``apply_main``
    # with ``limit=0`` (the launcher's run-forever sentinel) and ignores
    # ``limit``.  Otherwise ``max(1, limit)`` jobs are processed.
    continuous: bool = False


@dataclass(frozen=True)
class ApplyActivityOutput:
    status: str
    applied: int
    failed: int
    error: str | None = None


@activity.defn(name="apply")
async def apply_activity(payload: ApplyActivityInput) -> ApplyActivityOutput:
    """Run the apply launcher in a worker thread, heart-beating so cancellation lands.

    Exception policy:

    - ``CancelledError`` — re-raised so Temporal marks the activity cancelled.
    - ``LookupError`` (missing job URL or other lookup misses) — wrapped in a
      non-retryable ``ApplicationError`` so the workflow fails fast.
    - Any other exception — re-raised verbatim so Temporal's configured retry
      policy can fire on transient browser / network / executor failures.
    """

    def _run_apply() -> tuple[int, int]:
        from jobhunter.apply.launcher import main as apply_main

        # ``continuous=True`` selects the launcher's run-forever poll mode,
        # which it activates via ``limit == 0``.  Otherwise enforce a floor
        # of one to keep ``limit < 1`` calls from no-oping.
        effective_limit = 0 if payload.continuous else max(1, payload.limit)
        return apply_main(
            limit=effective_limit,
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
        try:
            while True:
                try:
                    applied, failed = await asyncio.wait_for(
                        asyncio.shield(apply_task), timeout=15.0
                    )
                    break
                except asyncio.TimeoutError:
                    activity.heartbeat("apply still running")
        except asyncio.CancelledError:
            # Signal the launcher's run-forever loop to stop so the
            # executor thread releases Chrome / DB connections instead of
            # leaking past activity cancellation. ``asyncio.shield`` keeps
            # the task running otherwise — Temporal would think the
            # activity died but the worker_loop polls on, draining tokens.
            activity.logger.info("apply_activity cancelled — signalling launcher stop")
            try:
                from jobhunter.apply.launcher import _stop_event

                _stop_event.set()
            except Exception:  # noqa: BLE001 — never let cleanup mask the cancel
                activity.logger.exception(
                    "apply_activity: failed to set launcher _stop_event during cancel"
                )
            raise
        except LookupError as exc:
            # Missing job URL or other lookup misses are operator errors;
            # do not retry — surface them immediately to the workflow.
            raise ApplicationError(
                str(exc), type=type(exc).__name__, non_retryable=True
            ) from exc

        status = "ok" if failed == 0 else "failed"
        return ApplyActivityOutput(
            status=status,
            applied=int(applied),
            failed=int(failed),
            error=None,
        )
    finally:
        # Final heartbeat so a future heartbeat-timeout regression
        # (post-iteration delay > heartbeat_timeout) doesn't surface as
        # a phantom dead activity.
        try:
            activity.heartbeat("apply done")
        except Exception:  # noqa: BLE001 — heartbeat outside activity ctx is fine
            pass


# Re-exported for the registry; activity decorator metadata is preserved.
__all__: list[Any] = ["apply_activity", "ApplyActivityInput", "ApplyActivityOutput"]
