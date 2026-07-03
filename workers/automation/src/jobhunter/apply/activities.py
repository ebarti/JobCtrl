"""Temporal activity for the apply stage."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError


@dataclass(frozen=True)
class ApplyActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    job_url: str | None = None
    limit: int = 1
    min_score: int = 7
    model: str = "default"
    headless: bool = False
    dry_run: bool = False
    workers: int = 1
    approval_required: bool = True
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

    # ``apply.launcher`` installs process signal handlers at import time; import
    # it on the activity event-loop thread before handing work to the executor.
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat
    from jobhunter.infrastructure.scoring.criteria_provider import read_apply_approval_required
    from jobhunter.apply.launcher import main as apply_main

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )
    workflow_id = activity.info().workflow_id

    def _run_apply() -> tuple[int, int]:
        # ``continuous=True`` selects the launcher's run-forever poll mode,
        # which it activates via ``limit == 0``.  Otherwise enforce a floor
        # of one to keep ``limit < 1`` calls from no-oping.
        effective_limit = 0 if payload.continuous else max(1, payload.limit)
        approval_required = read_apply_approval_required(default=payload.approval_required)
        return apply_main(
            limit=effective_limit,
            target_url=payload.job_url,
            min_score=payload.min_score,
            headless=payload.headless,
            model=payload.model,
            dry_run=payload.dry_run,
            workers=payload.workers,
            approval_required=approval_required,
            workflow_id=workflow_id,
            install_signal_handlers=False,
        )

    try:
        applied, failed = await run_blocking_with_heartbeat(
            _run_apply,
            starting_message="apply starting",
            progress_message="apply still running",
            poll_interval=15.0,
            activity_name="apply",
            job_context={"job_url": payload.job_url or "", "dry_run": payload.dry_run},
            on_cancel=_signal_launcher_stop,
        )

        status = "ok" if failed == 0 else "failed"
        return ApplyActivityOutput(
            status=status,
            applied=int(applied),
            failed=int(failed),
            error=None,
        )
    except LookupError as exc:
        # Missing job URL or other lookup misses are operator errors;
        # do not retry — surface them immediately to the workflow.
        raise ApplicationError(
            str(exc), type=type(exc).__name__, non_retryable=True
        ) from exc


def _signal_launcher_stop() -> None:
    activity.logger.info("apply_activity cancelled — signalling launcher stop")
    try:
        from jobhunter.apply.launcher import _stop_event

        _stop_event.set()
    except Exception:  # noqa: BLE001 — never let cleanup mask the cancel
        activity.logger.exception(
            "apply_activity: failed to set launcher _stop_event during cancel"
        )


# Re-exported for the registry; activity decorator metadata is preserved.
__all__: list[Any] = ["apply_activity", "ApplyActivityInput", "ApplyActivityOutput"]
