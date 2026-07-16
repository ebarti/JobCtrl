"""Safe sampling of Temporal task-queue pollers and approximate backlog stats."""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from temporalio.api.enums.v1 import TaskQueueType
from temporalio.api.taskqueue.v1 import TaskQueue
from temporalio.api.workflowservice.v1 import DescribeTaskQueueRequest
from temporalio.client import Client
from temporalio.service import RPCError, RPCStatusCode

TaskQueueObservationStatus = Literal[
    "available",
    "unsupported",
    "unavailable",
    "stale",
]


@dataclass(frozen=True)
class TaskQueueStatsSnapshot:
    poller_count: int
    approximate_backlog_count: int
    approximate_backlog_age_seconds: float
    tasks_add_rate: float
    tasks_dispatch_rate: float

    def to_json_dict(self) -> dict[str, int | float]:
        return {
            "pollerCount": self.poller_count,
            "approximateBacklogCount": self.approximate_backlog_count,
            "approximateBacklogAgeSeconds": self.approximate_backlog_age_seconds,
            "tasksAddRate": self.tasks_add_rate,
            "tasksDispatchRate": self.tasks_dispatch_rate,
        }


@dataclass(frozen=True)
class TaskQueueObservation:
    status: TaskQueueObservationStatus
    observed_at: datetime
    workflow: TaskQueueStatsSnapshot | None = None
    activity: TaskQueueStatsSnapshot | None = None
    reason_code: str | None = None
    last_known_status: Literal["available", "unsupported", "unavailable"] | None = None

    @classmethod
    def available(
        cls,
        *,
        observed_at: datetime,
        workflow: TaskQueueStatsSnapshot,
        activity: TaskQueueStatsSnapshot,
    ) -> TaskQueueObservation:
        return cls(
            status="available",
            observed_at=_as_utc(observed_at),
            workflow=workflow,
            activity=activity,
        )

    @classmethod
    def unsupported(
        cls,
        *,
        observed_at: datetime,
        reason_code: str = "describe_task_queue_stats_unsupported",
    ) -> TaskQueueObservation:
        return cls(
            status="unsupported",
            observed_at=_as_utc(observed_at),
            reason_code=reason_code,
        )

    @classmethod
    def unavailable(
        cls,
        *,
        observed_at: datetime,
        reason_code: str = "describe_task_queue_unavailable",
    ) -> TaskQueueObservation:
        return cls(
            status="unavailable",
            observed_at=_as_utc(observed_at),
            reason_code=reason_code,
        )

    def to_json_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "status": self.status,
            "observedAt": _as_utc(self.observed_at).isoformat(),
        }
        if self.workflow is not None:
            result["workflow"] = self.workflow.to_json_dict()
        if self.activity is not None:
            result["activity"] = self.activity.to_json_dict()
        if self.reason_code is not None:
            result["reasonCode"] = self.reason_code
        if self.last_known_status is not None:
            result["lastKnownStatus"] = self.last_known_status
        return result


@dataclass(frozen=True)
class _KindSample:
    status: Literal["available", "unsupported", "unavailable"]
    stats: TaskQueueStatsSnapshot | None = None


async def sample_task_queue_observation(
    client: Client,
    task_queue: str,
    *,
    now: datetime | None = None,
    timeout_seconds: float = 3.0,
) -> TaskQueueObservation:
    """Sample workflow and activity task-queue views without leaking RPC text.

    The two DescribeTaskQueue calls are independent and concurrent. Partial
    data is intentionally not presented as a complete queue observation.
    """

    workflow_sample, activity_sample = await asyncio.gather(
        _sample_kind(
            client,
            task_queue,
            TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW,
            timeout_seconds=timeout_seconds,
        ),
        _sample_kind(
            client,
            task_queue,
            TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
            timeout_seconds=timeout_seconds,
        ),
    )
    observed_at = _as_utc(now or datetime.now(UTC))
    if workflow_sample.status == "available" and activity_sample.status == "available":
        assert workflow_sample.stats is not None
        assert activity_sample.stats is not None
        return TaskQueueObservation.available(
            observed_at=observed_at,
            workflow=workflow_sample.stats,
            activity=activity_sample.stats,
        )
    if "unavailable" in {workflow_sample.status, activity_sample.status}:
        return TaskQueueObservation.unavailable(observed_at=observed_at)
    return TaskQueueObservation.unsupported(observed_at=observed_at)


async def _sample_kind(
    client: Client,
    task_queue: str,
    queue_type: Any,
    *,
    timeout_seconds: float,
) -> _KindSample:
    try:
        request = DescribeTaskQueueRequest(
            namespace=client.namespace,
            task_queue=TaskQueue(name=task_queue),
            task_queue_type=queue_type,
            report_stats=True,
        )
        response = await client.workflow_service.describe_task_queue(
            request,
            retry=False,
            timeout=timedelta(seconds=max(0.1, timeout_seconds)),
        )
    except RPCError as exc:
        if exc.status in {RPCStatusCode.UNIMPLEMENTED, RPCStatusCode.INVALID_ARGUMENT}:
            return _KindSample(status="unsupported")
        return _KindSample(status="unavailable")
    except Exception:
        # Never persist the exception text: endpoints and transport messages
        # can contain deployment details or credentials.
        return _KindSample(status="unavailable")

    try:
        has_stats = bool(response.HasField("stats"))
    except (AttributeError, ValueError):
        has_stats = getattr(response, "stats", None) is not None
    if not has_stats:
        return _KindSample(status="unsupported")

    stats = response.stats
    age = stats.approximate_backlog_age
    age_seconds = _nonnegative_float(age.seconds) + (_nonnegative_float(age.nanos) / 1_000_000_000)
    return _KindSample(
        status="available",
        stats=TaskQueueStatsSnapshot(
            poller_count=max(0, len(response.pollers)),
            approximate_backlog_count=max(0, int(stats.approximate_backlog_count)),
            approximate_backlog_age_seconds=age_seconds,
            tasks_add_rate=_nonnegative_float(stats.tasks_add_rate),
            tasks_dispatch_rate=_nonnegative_float(stats.tasks_dispatch_rate),
        ),
    )


def _nonnegative_float(value: object) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return max(0.0, number)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


__all__ = [
    "TaskQueueObservation",
    "TaskQueueObservationStatus",
    "TaskQueueStatsSnapshot",
    "sample_task_queue_observation",
]
