"""Typed, content-free pipeline step lifecycle event contracts."""

from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

from jobctrl.domain.events import (
    PipelineStepCompletedPayload,
    PipelineStepFailedPayload,
    PipelineStepQueuedPayload,
    PipelineStepSafeDetail,
    PipelineStepStartedPayload,
    create_pipeline_step_completed,
    create_pipeline_step_failed,
    create_pipeline_step_queued,
    create_pipeline_step_started,
)
from jobctrl.domain.tenant import LOCAL_TENANT


@dataclass(frozen=True)
class _ExecutionRef:
    """Structural stand-in for the independently delivered lineage value object."""

    tenant_id: str = "local"
    workflow_id: str = "discover-local"
    temporal_run_id: str = "temporal-run-1"


def test_pipeline_step_factories_emit_deterministic_camel_case_payloads() -> None:
    execution = _ExecutionRef()
    detail = PipelineStepSafeDetail(code="source_family", item_count=1)
    queued = create_pipeline_step_queued(
        LOCAL_TENANT,
        PipelineStepQueuedPayload(
            execution=execution,
            step_kind="source_family",
            item_key="family:workday",
            attempt=1,
            queued_at="2026-07-14T08:00:00.000Z",
            detail=detail,
        ),
    )
    started = create_pipeline_step_started(
        LOCAL_TENANT,
        PipelineStepStartedPayload(
            execution=execution,
            step_kind="source_family",
            item_key="family:workday",
            attempt=1,
            started_at="2026-07-14T08:00:01.000Z",
            detail=detail,
        ),
    )
    completed = create_pipeline_step_completed(
        LOCAL_TENANT,
        PipelineStepCompletedPayload(
            execution=execution,
            step_kind="source_family",
            item_key="family:workday",
            attempt=1,
            completed_at="2026-07-14T08:00:02.000Z",
            duration_ms=1_000,
            detail=detail,
        ),
    )
    failed = create_pipeline_step_failed(
        LOCAL_TENANT,
        PipelineStepFailedPayload(
            execution=execution,
            step_kind="source_family",
            item_key="family:workday",
            attempt=2,
            failed_at="2026-07-14T08:00:03.000Z",
            duration_ms=500,
            error_code="source_timeout",
            retryable=True,
            detail=detail,
        ),
    )

    assert [event.event_type for event in (queued, started, completed, failed)] == [
        "PipelineStepQueued",
        "PipelineStepStarted",
        "PipelineStepCompleted",
        "PipelineStepFailed",
    ]
    assert queued.payload == {
        "execution": {
            "tenantId": "local",
            "workflowId": "discover-local",
            "temporalRunId": "temporal-run-1",
        },
        "stepKind": "source_family",
        "itemKey": "family:workday",
        "attempt": 1,
        "detail": {"code": "source_family", "itemCount": 1},
        "queuedAt": "2026-07-14T08:00:00.000Z",
    }
    assert json.dumps(queued.payload, sort_keys=True) == json.dumps(
        dict(queued.payload), sort_keys=True
    )
    assert failed.payload["errorCode"] == "source_timeout"
    assert failed.payload["retryable"] is True


@pytest.mark.parametrize(
    ("item_key", "error_code"),
    [
        ("https://example.com/private-job", "source_timeout"),
        ("terminal", "provider said: secret output"),
    ],
)
def test_pipeline_step_factories_reject_unsafe_free_form_content(
    item_key: str, error_code: str
) -> None:
    with pytest.raises(ValueError, match="bounded safe"):
        create_pipeline_step_failed(
            LOCAL_TENANT,
            PipelineStepFailedPayload(
                execution=_ExecutionRef(),
                step_kind="enrichment_pass",
                item_key=item_key,
                attempt=1,
                failed_at="2026-07-14T08:00:00.000Z",
                duration_ms=None,
                error_code=error_code,
                retryable=False,
            ),
        )
