"""Durable orchestration-step lifecycle emission from Temporal activities.

The workflow layer supplies only deterministic scope. Attempt number and the
honest queued/started timestamps come from Temporal's activity metadata, while
terminal timestamps come from the activity worker clock. A worker crash or
heartbeat timeout therefore leaves the last attempt running; this helper never
invents a terminal fact that the activity did not observe.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from temporalio import activity
from temporalio.exceptions import ApplicationError

from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.errors import JobCtrlError
from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.events.operations import (
    PipelineStepCompletedPayload,
    PipelineStepDetailCode,
    PipelineStepFailedPayload,
    PipelineStepKind,
    PipelineStepQueuedPayload,
    PipelineStepSafeDetail,
    PipelineStepStartedPayload,
    create_pipeline_step_completed,
    create_pipeline_step_failed,
    create_pipeline_step_queued,
    create_pipeline_step_started,
)
from jobctrl.domain.tenant import TenantId

_SAFE_ERROR_CODE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,79}$")


class ActivityAttemptInfo(Protocol):
    attempt: int
    current_attempt_scheduled_time: datetime
    started_time: datetime


EventWriter = Callable[[DomainEvent], None]
Clock = Callable[[], datetime]


@dataclass(frozen=True)
class PipelineStepScope:
    execution: DiscoveryExecutionRef
    step_kind: PipelineStepKind
    item_key: str
    detail_code: PipelineStepDetailCode
    expected_app_dir: str | None = None
    expected_db_path: str | None = None


@dataclass
class PipelineStepAttempt:
    """One observed Temporal activity attempt and its durable event writer."""

    scope: PipelineStepScope
    attempt: int
    started_at: datetime
    writer: EventWriter
    clock: Clock
    terminal_emitted: bool = False

    def completed(self, *, item_count: int | None = None) -> None:
        if self.terminal_emitted:
            return
        finished_at = _as_utc(self.clock())
        self.writer(
            create_pipeline_step_completed(
                TenantId(self.scope.execution.tenant_id),
                PipelineStepCompletedPayload(
                    execution=self.scope.execution,
                    step_kind=self.scope.step_kind,
                    item_key=self.scope.item_key,
                    attempt=self.attempt,
                    completed_at=finished_at.isoformat(),
                    duration_ms=_duration_ms(self.started_at, finished_at),
                    detail=self._detail(item_count),
                ),
            )
        )
        self.terminal_emitted = True

    def failed(
        self,
        *,
        error_code: str,
        retryable: bool,
        item_count: int | None = None,
    ) -> None:
        if self.terminal_emitted:
            return
        finished_at = _as_utc(self.clock())
        self.writer(
            create_pipeline_step_failed(
                TenantId(self.scope.execution.tenant_id),
                PipelineStepFailedPayload(
                    execution=self.scope.execution,
                    step_kind=self.scope.step_kind,
                    item_key=self.scope.item_key,
                    attempt=self.attempt,
                    failed_at=finished_at.isoformat(),
                    duration_ms=_duration_ms(self.started_at, finished_at),
                    error_code=_safe_error_code(error_code, "activity_failed"),
                    retryable=retryable,
                    detail=self._detail(item_count),
                ),
            )
        )
        self.terminal_emitted = True

    def failed_from_exception(
        self,
        exc: Exception,
        *,
        fallback_error_code: str,
        item_count: int | None = None,
    ) -> None:
        error_code, retryable = classify_pipeline_step_failure(
            exc,
            fallback_error_code=fallback_error_code,
        )
        self.failed(
            error_code=error_code,
            retryable=retryable,
            item_count=item_count,
        )

    def _detail(self, item_count: int | None) -> PipelineStepSafeDetail:
        return PipelineStepSafeDetail(
            code=self.scope.detail_code,
            item_count=item_count,
        )


def begin_pipeline_step_attempt(
    scope: PipelineStepScope | None,
    *,
    item_count: int | None = None,
    info: ActivityAttemptInfo | None = None,
    writer: EventWriter | None = None,
    clock: Clock | None = None,
) -> PipelineStepAttempt | None:
    """Persist queued + started facts for the current activity attempt.

    ``None`` scope is the compatibility path for activities that were not
    launched from a Discover execution. Temporal always supplies both timing
    fields for a real activity attempt; missing metadata is rejected rather
    than replaced with the worker clock.
    """

    if scope is None:
        return None
    attempt_info = info or activity.info()
    queued_at = getattr(attempt_info, "current_attempt_scheduled_time", None)
    started_at = getattr(attempt_info, "started_time", None)
    attempt = getattr(attempt_info, "attempt", None)
    if not isinstance(queued_at, datetime) or not isinstance(started_at, datetime):
        raise RuntimeError("Temporal activity attempt timing metadata is unavailable")
    if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
        raise RuntimeError("Temporal activity attempt number is invalid")

    event_writer = writer or _durable_writer(scope)
    tenant_id = TenantId(scope.execution.tenant_id)
    detail = PipelineStepSafeDetail(code=scope.detail_code, item_count=item_count)
    event_writer(
        create_pipeline_step_queued(
            tenant_id,
            PipelineStepQueuedPayload(
                execution=scope.execution,
                step_kind=scope.step_kind,
                item_key=scope.item_key,
                attempt=attempt,
                queued_at=_as_utc(queued_at).isoformat(),
                detail=detail,
            ),
        )
    )
    normalized_started_at = _as_utc(started_at)
    event_writer(
        create_pipeline_step_started(
            tenant_id,
            PipelineStepStartedPayload(
                execution=scope.execution,
                step_kind=scope.step_kind,
                item_key=scope.item_key,
                attempt=attempt,
                started_at=normalized_started_at.isoformat(),
                detail=detail,
            ),
        )
    )
    return PipelineStepAttempt(
        scope=scope,
        attempt=attempt,
        started_at=normalized_started_at,
        writer=event_writer,
        clock=clock or _utc_now,
    )


def classify_pipeline_step_failure(
    exc: Exception,
    *,
    fallback_error_code: str,
) -> tuple[str, bool]:
    """Return a safe code and retryability without persisting exception text."""

    fallback = _safe_error_code(fallback_error_code, "activity_failed")
    if isinstance(exc, JobCtrlError):
        return _safe_error_code(exc.code, fallback), bool(exc.retryable)
    if isinstance(exc, ApplicationError):
        error_type = getattr(exc, "type", None)
        retryable = not bool(getattr(exc, "non_retryable", False))
        return _safe_error_code(error_type, fallback), retryable
    return fallback, True


def pdf_pipeline_step_item_key(idempotency_key: str) -> str:
    """Derive a stable, non-reversible PDF scope without persisting a job URL."""

    digest = hashlib.sha256(idempotency_key.encode("utf-8", errors="replace")).hexdigest()
    return f"pdf:{digest}"


def _durable_writer(scope: PipelineStepScope) -> EventWriter:
    def write(event: DomainEvent) -> None:
        from jobctrl.database import get_connection
        from jobctrl.infrastructure.projections.projection_builder import (
            ProjectionBuilder,
        )
        from jobctrl.infrastructure.temporal.runtime_guard import (
            assert_activity_runtime,
        )
        from jobctrl.state import record_job_event

        assert_activity_runtime(
            expected_app_dir=scope.expected_app_dir,
            expected_db_path=scope.expected_db_path,
        )
        conn = get_connection()
        record_job_event(
            conn,
            None,
            "workflow",
            event.event_type,
            payload=dict(event.payload),
            occurred_at=event.occurred_at,
        )
        conn.commit()
        ProjectionBuilder(
            conn_factory=get_connection,
            tenant_id=TenantId(scope.execution.tenant_id),
        ).refresh()

    return write


def _safe_error_code(value: object, fallback: str) -> str:
    candidate = value if isinstance(value, str) else ""
    return candidate if _SAFE_ERROR_CODE.fullmatch(candidate) else fallback


def _duration_ms(started_at: datetime, finished_at: datetime) -> int:
    return max(0, int((_as_utc(finished_at) - _as_utc(started_at)).total_seconds() * 1_000))


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _utc_now() -> datetime:
    return datetime.now(UTC)


__all__ = [
    "PipelineStepAttempt",
    "PipelineStepScope",
    "begin_pipeline_step_attempt",
    "classify_pipeline_step_failure",
    "pdf_pipeline_step_item_key",
]
