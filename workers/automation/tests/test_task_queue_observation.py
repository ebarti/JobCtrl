from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from temporalio.api.enums.v1 import TaskQueueType

from jobctrl.infrastructure.temporal.task_queue_observation import (
    sample_task_queue_observation,
)


class _DescribeResponse:
    def __init__(self, *, has_stats: bool = True, backlog: int = 7, pollers: int = 2):
        self._has_stats = has_stats
        self.pollers = [SimpleNamespace(identity="private-poller-identity") for _ in range(pollers)]
        self.stats = SimpleNamespace(
            approximate_backlog_count=backlog,
            approximate_backlog_age=SimpleNamespace(seconds=12, nanos=500_000_000),
            tasks_add_rate=2.5,
            tasks_dispatch_rate=2.0,
        )

    def HasField(self, field_name: str) -> bool:
        assert field_name == "stats"
        return self._has_stats


class _WorkflowService:
    def __init__(self, responses):
        self.responses = responses
        self.requests = []

    async def describe_task_queue(self, request, **_kwargs):
        self.requests.append(request)
        response = self.responses[request.task_queue_type]
        if isinstance(response, BaseException):
            raise response
        return response


class _Client:
    namespace = "default"

    def __init__(self, responses):
        self.workflow_service = _WorkflowService(responses)


@pytest.mark.asyncio
async def test_task_queue_sampler_returns_allowlisted_pollers_and_safe_approximate_metrics():
    client = _Client(
        {
            TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW: _DescribeResponse(backlog=3, pollers=1),
            TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY: _DescribeResponse(backlog=7, pollers=2),
        }
    )

    observation = await sample_task_queue_observation(
        client,
        "jobctrl-default",
        now=datetime(2026, 7, 14, 10, 0, tzinfo=UTC),
    )

    assert observation.status == "available"
    assert observation.workflow is not None
    assert observation.activity is not None
    assert observation.workflow.poller_count == 1
    assert observation.activity.poller_count == 2
    assert observation.activity.approximate_backlog_count == 7
    assert observation.activity.approximate_backlog_age_seconds == 12.5
    assert observation.activity.tasks_add_rate == 2.5
    assert observation.activity.tasks_dispatch_rate == 2.0
    assert {request.task_queue.name for request in client.workflow_service.requests} == {
        "jobctrl-default"
    }
    assert all(request.report_stats for request in client.workflow_service.requests)
    assert "private-poller-identity" not in json.dumps(observation.to_json_dict())


@pytest.mark.asyncio
async def test_task_queue_sampler_models_missing_stats_as_unsupported():
    client = _Client(
        {
            TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW: _DescribeResponse(has_stats=False),
            TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY: _DescribeResponse(has_stats=False),
        }
    )

    observation = await sample_task_queue_observation(
        client,
        "jobctrl-default",
        now=datetime(2026, 7, 14, 10, 0, tzinfo=UTC),
    )

    assert observation.status == "unsupported"
    assert observation.reason_code == "describe_task_queue_stats_unsupported"
    assert observation.workflow is None
    assert observation.activity is None


@pytest.mark.asyncio
async def test_task_queue_sampler_models_rpc_failure_as_unavailable_without_error_text():
    canary = "https://temporal.example?secret=private-provider-token"
    client = _Client(
        {
            TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW: RuntimeError(canary),
            TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY: _DescribeResponse(),
        }
    )

    observation = await sample_task_queue_observation(
        client,
        "jobctrl-default",
        now=datetime(2026, 7, 14, 10, 0, tzinfo=UTC),
    )

    assert observation.status == "unavailable"
    assert observation.reason_code == "describe_task_queue_unavailable"
    assert canary not in json.dumps(observation.to_json_dict())
