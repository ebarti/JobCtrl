"""Temporal activity for the apply stage."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from jobctrl.domain.identifiers import JobId, canonical_job_id


@dataclass(frozen=True)
class ApplyActivityInput:
    # Every targeted claim is scoped by this tenant and canonical JobId.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    job_id: JobId | None = None
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
    auto_apply_loop: bool = False

    def __post_init__(self) -> None:
        if self.job_id is not None:
            object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))


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
    - ``LookupError`` (missing JobId or other lookup misses) — wrapped in a
      non-retryable ``ApplicationError`` so the workflow fails fast.
    - Any other exception — re-raised verbatim so Temporal's configured retry
      policy can fire on transient browser / network / executor failures.
    """

    # Every invocation creates its own cancellation/resource owner before
    # handing blocking launcher work to the activity executor.
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat
    from jobctrl.infrastructure.scoring.criteria_provider import (
        read_apply_approval_required,
        read_apply_concurrency,
        read_min_fit_score,
    )
    from jobctrl.browser_capabilities import require_system_browser_capability
    from jobctrl.apply.launcher import main as apply_main
    from jobctrl.apply.ownership import ApplyLauncherBusy, ApplyLauncherCleanupIncomplete, ApplyLauncherRun

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )
    # A caller may have bypassed the CLI/API workflow builder. Re-check at the
    # worker execution boundary before importing the apply launcher or touching
    # a browser profile.
    from jobctrl.runtime import is_bundled_runtime
    bundled = is_bundled_runtime()
    dedicated_scope = bundled
    if not dedicated_scope:
        require_system_browser_capability("auto-apply-browser")
    workflow_id = activity.info().workflow_id
    launcher_run = None if dedicated_scope else ApplyLauncherRun()
    from jobctrl.apply.execution import ScopedApplyExecution
    scoped_execution = ScopedApplyExecution() if dedicated_scope else None

    def _run_apply() -> tuple[int, int]:
        # ``continuous=True`` selects the launcher's run-forever poll mode,
        # which it activates via ``limit == 0``.  Otherwise enforce a floor
        # of one to keep ``limit < 1`` calls from no-oping.
        effective_limit = 0 if payload.continuous else max(1, payload.limit)
        approval_required = read_apply_approval_required(default=payload.approval_required)
        min_score = read_min_fit_score(default=payload.min_score) if payload.auto_apply_loop else payload.min_score
        workers = read_apply_concurrency(default=payload.workers) if payload.auto_apply_loop else payload.workers
        options = dict(
            limit=effective_limit, target_job_id=str(payload.job_id) if payload.job_id is not None else None,
            tenant_id=payload.tenant_id, min_score=min_score, headless=payload.headless, model=payload.model,
            dry_run=payload.dry_run, continuous=payload.continuous, workers=workers, poll_interval=60,
            approval_required=approval_required, workflow_id=workflow_id,
        )
        if scoped_execution is not None:
            return scoped_execution.run(options)
        options.pop("poll_interval")
        return apply_main(**options, install_signal_handlers=False, launcher_run=launcher_run)


    try:
        applied, failed = await run_blocking_with_heartbeat(
            _run_apply,
            starting_message="apply starting",
            progress_message="apply still running",
            poll_interval=15.0,
            activity_name="apply",
            job_context={
                "job_id": str(payload.job_id) if payload.job_id is not None else "",
                "dry_run": payload.dry_run,
            },
            on_cancel=scoped_execution.cancel if scoped_execution is not None else launcher_run.cancel,
        )

        status = "ok" if failed == 0 else "failed"
        return ApplyActivityOutput(
            status=status,
            applied=int(applied),
            failed=int(failed),
            error=None,
        )
    except (ApplyLauncherBusy, ApplyLauncherCleanupIncomplete) as exc:
        code = "apply_launcher_busy" if isinstance(exc, ApplyLauncherBusy) else "apply_launcher_cleanup_incomplete"
        raise ApplicationError(str(exc), type=code, non_retryable=True) from exc
    except LookupError as exc:
        # Missing JobId or other lookup misses are operator errors;
        # do not retry — surface them immediately to the workflow.
        raise ApplicationError(str(exc), type=type(exc).__name__, non_retryable=True) from exc


# Re-exported for the registry; activity decorator metadata is preserved.
__all__: list[Any] = ["apply_activity", "ApplyActivityInput", "ApplyActivityOutput"]
