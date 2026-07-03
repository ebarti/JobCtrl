"""Finalize activities + workflow-side helpers for Temporal loop closure (P0).

Every workflow emits a ``WorkflowStarted`` marker at the top and, on its
normal-completion and failure exit paths, exactly one terminal event
(``WorkflowCompleted`` / ``WorkflowFailed``) through a finalize activity. The
activity reuses ``record_job_event`` and refreshes the projection, so the run
terminalizes in the read-model without a trigger-coupled reaper.

Cancellation is deliberately NOT recorded here: Temporal cancels
newly-scheduled activities while a workflow is cancelling, so a finalize
activity cannot reliably run on the cancel path (there is no ``asyncio.shield``
that would let it). Cancellation — with timeouts, terminations, and worker
crashes where no finalize can run — is backstopped by the describe-based
reconciler in the worker heartbeat loop, which maps the closed/absent Temporal
execution to the matching terminal ``Workflow*`` event.

Workflow bodies stay deterministic: all SQLite/clock/uuid IO happens inside the
activities; the helpers only read ``workflow.info()`` / ``workflow.now()``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

# The finalize activities are tiny local SQLite writes; a run's terminal state
# is only durable once recorded, so they retry a handful of times but stay
# fast.
_FINALIZE_TIMEOUT = timedelta(seconds=30)
_FINALIZE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=10),
    maximum_attempts=5,
)


@dataclass(frozen=True)
class WorkflowStartedInput:
    tenant_id: str
    workflow_id: str
    workflow_type: str
    input_summary: dict[str, Any] = field(default_factory=dict)
    started_at: str | None = None
    temporal_run_id: str | None = None
    expected_app_dir: str | None = None
    expected_db_path: str | None = None


@dataclass(frozen=True)
class WorkflowOutcomeInput:
    tenant_id: str
    workflow_id: str
    workflow_type: str
    # One of the terminal statuses: succeeded | failed | canceled |
    # timed_out | terminated.
    status: str
    error_code: str | None = None
    error_message: str | None = None
    retryable: bool = False
    finished_at: str | None = None
    duration_ms: int | None = None
    temporal_run_id: str | None = None
    expected_app_dir: str | None = None
    expected_db_path: str | None = None


# ------------------------------------------------------------------ activities


@activity.defn(name="record_workflow_started")
async def record_workflow_started(payload: WorkflowStartedInput) -> None:
    from jobhunter.domain.events.workflow import (
        WorkflowStartedPayload,
        create_workflow_started,
    )

    event = create_workflow_started(
        payload.tenant_id,
        WorkflowStartedPayload(
            workflow_id=payload.workflow_id,
            workflow_type=payload.workflow_type,
            input_summary=dict(payload.input_summary),
            started_at=payload.started_at,
            temporal_run_id=payload.temporal_run_id,
        ),
    )
    _emit(payload.expected_app_dir, payload.expected_db_path, event)


@activity.defn(name="record_workflow_outcome")
async def record_workflow_outcome(payload: WorkflowOutcomeInput) -> None:
    event = build_workflow_outcome_event(payload)
    _emit(payload.expected_app_dir, payload.expected_db_path, event)


def build_workflow_outcome_event(payload: WorkflowOutcomeInput):
    """Map a terminal status to the matching ``Workflow*`` domain event."""
    from jobhunter.domain.events.workflow import (
        WorkflowCanceledPayload,
        WorkflowCompletedPayload,
        WorkflowFailedPayload,
        WorkflowTerminatedPayload,
        WorkflowTimedOutPayload,
        create_workflow_canceled,
        create_workflow_completed,
        create_workflow_failed,
        create_workflow_terminated,
        create_workflow_timed_out,
    )

    if payload.status == "succeeded":
        return create_workflow_completed(
            payload.tenant_id,
            WorkflowCompletedPayload(
                workflow_id=payload.workflow_id,
                workflow_type=payload.workflow_type,
                finished_at=payload.finished_at,
                duration_ms=payload.duration_ms,
                temporal_run_id=payload.temporal_run_id,
            ),
        )
    if payload.status == "canceled":
        return create_workflow_canceled(
            payload.tenant_id,
            WorkflowCanceledPayload(
                workflow_id=payload.workflow_id,
                workflow_type=payload.workflow_type,
                finished_at=payload.finished_at,
                duration_ms=payload.duration_ms,
                temporal_run_id=payload.temporal_run_id,
            ),
        )
    if payload.status == "timed_out":
        return create_workflow_timed_out(
            payload.tenant_id,
            WorkflowTimedOutPayload(
                workflow_id=payload.workflow_id,
                workflow_type=payload.workflow_type,
                error_message=payload.error_message or "",
                finished_at=payload.finished_at,
                duration_ms=payload.duration_ms,
                temporal_run_id=payload.temporal_run_id,
            ),
        )
    if payload.status == "terminated":
        return create_workflow_terminated(
            payload.tenant_id,
            WorkflowTerminatedPayload(
                workflow_id=payload.workflow_id,
                workflow_type=payload.workflow_type,
                error_message=payload.error_message or "",
                finished_at=payload.finished_at,
                duration_ms=payload.duration_ms,
                temporal_run_id=payload.temporal_run_id,
            ),
        )
    # Default: failed.
    return create_workflow_failed(
        payload.tenant_id,
        WorkflowFailedPayload(
            workflow_id=payload.workflow_id,
            workflow_type=payload.workflow_type,
            error_code=payload.error_code or "",
            error_message=payload.error_message or "",
            retryable=payload.retryable,
            finished_at=payload.finished_at,
            duration_ms=payload.duration_ms,
            temporal_run_id=payload.temporal_run_id,
        ),
    )


def _emit(expected_app_dir: str | None, expected_db_path: str | None, event) -> None:
    from jobhunter.database import get_connection
    from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.state import record_job_event

    assert_activity_runtime(
        expected_app_dir=expected_app_dir,
        expected_db_path=expected_db_path,
    )
    conn = get_connection()
    # Workflow lifecycle events are not tied to a single job (a pipeline run is
    # a batch), so ``job_url`` is NULL; the run identity lives in the payload.
    record_job_event(
        conn,
        None,
        "workflow",
        event.event_type,
        payload=dict(event.payload),
    )
    conn.commit()
    # Refresh explicitly so ``workflow_run_projections`` updates even when the
    # process has no bus-subscribed ProjectionBuilder (idempotent otherwise).
    ProjectionBuilder(conn_factory=get_connection).refresh()


# ------------------------------------------------------- workflow-side helpers


async def emit_workflow_started(
    *,
    tenant_id: str,
    workflow_type: str,
    input_summary: dict[str, Any],
    started_at: datetime,
    expected_app_dir: str | None,
    expected_db_path: str | None,
) -> None:
    """Record the start marker. Called at the top of a workflow's ``run``."""
    info = workflow.info()
    await workflow.execute_activity(
        record_workflow_started,
        WorkflowStartedInput(
            tenant_id=tenant_id,
            workflow_id=info.workflow_id,
            workflow_type=workflow_type,
            input_summary=input_summary,
            started_at=started_at.isoformat(),
            temporal_run_id=info.run_id,
            expected_app_dir=expected_app_dir,
            expected_db_path=expected_db_path,
        ),
        start_to_close_timeout=_FINALIZE_TIMEOUT,
        retry_policy=_FINALIZE_RETRY,
    )


async def emit_workflow_outcome(
    *,
    tenant_id: str,
    workflow_type: str,
    status: str,
    started_at: datetime,
    error_code: str | None = None,
    error_message: str | None = None,
    retryable: bool = False,
    expected_app_dir: str | None,
    expected_db_path: str | None,
) -> None:
    """Record the terminal outcome. Called on every exit path (incl. cancel)."""
    info = workflow.info()
    now = workflow.now()
    duration_ms = int((now - started_at).total_seconds() * 1000)
    await workflow.execute_activity(
        record_workflow_outcome,
        WorkflowOutcomeInput(
            tenant_id=tenant_id,
            workflow_id=info.workflow_id,
            workflow_type=workflow_type,
            status=status,
            error_code=error_code,
            error_message=error_message,
            retryable=retryable,
            finished_at=now.isoformat(),
            duration_ms=duration_ms,
            temporal_run_id=info.run_id,
            expected_app_dir=expected_app_dir,
            expected_db_path=expected_db_path,
        ),
        start_to_close_timeout=_FINALIZE_TIMEOUT,
        retry_policy=_FINALIZE_RETRY,
    )


__all__ = [
    "WorkflowStartedInput",
    "WorkflowOutcomeInput",
    "record_workflow_started",
    "record_workflow_outcome",
    "build_workflow_outcome_event",
    "emit_workflow_started",
    "emit_workflow_outcome",
]
