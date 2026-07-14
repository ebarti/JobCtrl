from __future__ import annotations

import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from jobctrl.infrastructure.temporal import activity_runtime_telemetry
from jobctrl.infrastructure.temporal.activity_runtime_telemetry import (
    ActiveActivityInventory,
    ActivityRuntimeTelemetryInterceptor,
)


def test_inventory_is_concurrency_safe_for_parallel_starts_and_terminals():
    inventory = ActiveActivityInventory()
    participants = 8
    started = threading.Barrier(participants + 1)
    release = threading.Event()
    base_time = datetime(2026, 7, 14, 9, 0, tzinfo=UTC)

    def run_activity(index: int) -> None:
        token = inventory.start(
            activity_type="score_job",
            activity_id=f"activity-{index}",
            workflow_id=f"workflow-{index}",
            workflow_run_id=f"run-{index}",
            attempt=1,
            started_at=base_time + timedelta(seconds=index),
        )
        started.wait()
        release.wait(timeout=5)
        inventory.finish(token)

    with ThreadPoolExecutor(max_workers=participants) as executor:
        futures = [executor.submit(run_activity, index) for index in range(participants)]
        started.wait(timeout=5)
        active = inventory.snapshot()
        assert active.active_activity_count == participants
        assert active.counts_by_type == {"score_job": participants}
        release.set()
        for future in futures:
            future.result(timeout=5)

    terminal = inventory.snapshot()
    assert terminal.active_activity_count == 0
    assert terminal.active_details == ()
    assert terminal.durations_by_type["score_job"].completed_count == participants


@pytest.mark.asyncio
async def test_interceptor_cleans_up_success_failure_retry_and_cancellation(monkeypatch):
    monotonic_now = [0.0]
    inventory = ActiveActivityInventory(monotonic=lambda: monotonic_now[0])
    current_info = SimpleNamespace(
        activity_type="tailor_job",
        activity_id="activity-one",
        workflow_id="workflow-one",
        workflow_run_id="run-one",
        attempt=1,
        started_time=datetime(2026, 7, 14, 9, 0, tzinfo=UTC),
    )

    class Next:
        outcome: object = "ok"

        async def execute_activity(self, _input):
            monotonic_now[0] += 1.0
            if isinstance(self.outcome, BaseException):
                raise self.outcome
            return self.outcome

    next_interceptor = Next()
    inbound = ActivityRuntimeTelemetryInterceptor(inventory).intercept_activity(next_interceptor)
    monkeypatch.setattr(activity_runtime_telemetry.activity, "info", lambda: current_info)

    assert await inbound.execute_activity(object()) == "ok"
    assert inventory.snapshot().active_activity_count == 0

    next_interceptor.outcome = RuntimeError("retryable failure")
    with pytest.raises(RuntimeError, match="retryable failure"):
        await inbound.execute_activity(object())
    assert inventory.snapshot().active_activity_count == 0

    current_info.attempt = 2
    next_interceptor.outcome = "retry succeeded"
    assert await inbound.execute_activity(object()) == "retry succeeded"
    assert inventory.snapshot().active_activity_count == 0

    current_info.activity_id = "activity-cancelled"
    current_info.attempt = 1
    next_interceptor.outcome = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await inbound.execute_activity(object())

    snapshot = inventory.snapshot()
    assert snapshot.active_activity_count == 0
    assert snapshot.durations_by_type["tailor_job"].completed_count == 4
    assert snapshot.durations_by_type["tailor_job"].total_duration_ms == 4_000
    assert snapshot.durations_by_type["tailor_job"].max_duration_ms == 1_000


def test_inventory_returns_exact_total_with_bounded_longest_running_safe_details():
    canaries = (
        "https://jobs.example/private/role?token=raw-url",
        "description-private-canary",
        "resume-profile-private-canary",
        "prompt-private-canary",
        "provider-output-private-canary",
        "/Users/private/artifact.pdf",
        "secret-api-key-private-canary",
    )
    sensitive_identity = "|".join(canaries)
    inventory = ActiveActivityInventory(max_details=20)
    started_at = datetime(2026, 7, 14, 8, 0, tzinfo=UTC)

    for index in range(25):
        inventory.start(
            activity_type="score_job",
            activity_id=f"{sensitive_identity}:{index}",
            workflow_id=f"{sensitive_identity}:workflow",
            workflow_run_id=f"{sensitive_identity}:run",
            attempt=1,
            started_at=started_at + timedelta(seconds=index),
        )

    snapshot = inventory.snapshot()
    serialized = json.dumps(
        {
            "counts": snapshot.counts_json_dict(),
            "details": snapshot.details_json_list(),
            "durations": snapshot.durations_json_dict(),
        },
        sort_keys=True,
    )

    assert snapshot.active_activity_count == 25
    assert snapshot.active_details_total == 25
    assert len(snapshot.active_details) == 20
    assert snapshot.active_details_truncated is True
    assert snapshot.active_details[0].started_at == started_at
    assert snapshot.active_details[-1].started_at == started_at + timedelta(seconds=19)
    for canary in canaries:
        assert canary not in serialized
    assert all(
        detail.operational_ref.opaque_id.startswith("op_")
        and len(detail.operational_ref.opaque_id) == 27
        for detail in snapshot.active_details
    )


def test_inventory_counts_non_allowlisted_slot_without_exposing_metadata():
    inventory = ActiveActivityInventory()
    canary = "private-provider-activity-type-secret"

    token = inventory.start(
        activity_type=canary,
        activity_id="https://jobs.example/private",
        workflow_id="secret-workflow",
        workflow_run_id="secret-run",
        attempt=1,
        started_at=datetime(2026, 7, 14, 9, 0, tzinfo=UTC),
    )

    snapshot = inventory.snapshot()
    serialized = json.dumps(
        {
            "counts": snapshot.counts_json_dict(),
            "details": snapshot.details_json_list(),
            "durations": snapshot.durations_json_dict(),
        },
        sort_keys=True,
    )
    assert token is not None
    assert snapshot.active_activity_count == 1
    assert snapshot.active_details_total == 0
    assert snapshot.counts_by_type == {}
    assert snapshot.active_details == ()
    assert snapshot.active_details_truncated is False
    assert canary not in serialized

    inventory.finish(token)

    terminal = inventory.snapshot()
    assert terminal.active_activity_count == 0
    assert terminal.durations_by_type == {}


@pytest.mark.asyncio
async def test_interceptor_tracks_non_allowlisted_activity_until_terminal(monkeypatch):
    inventory = ActiveActivityInventory()
    entered = asyncio.Event()
    release = asyncio.Event()
    canary = "private-unallowlisted-activity-type"
    info = SimpleNamespace(
        activity_type=canary,
        activity_id="private-activity-id",
        workflow_id="private-workflow-id",
        workflow_run_id="private-run-id",
        attempt=1,
        started_time=datetime(2026, 7, 14, 9, 0, tzinfo=UTC),
    )

    class Next:
        async def execute_activity(self, _input):
            entered.set()
            await release.wait()
            return "done"

    inbound = ActivityRuntimeTelemetryInterceptor(inventory).intercept_activity(Next())
    monkeypatch.setattr(activity_runtime_telemetry.activity, "info", lambda: info)

    task = asyncio.create_task(inbound.execute_activity(object()))
    await entered.wait()
    active = inventory.snapshot()
    assert active.active_activity_count == 1
    assert active.active_details_total == 0
    assert active.counts_by_type == {}
    assert active.active_details == ()

    release.set()
    assert await task == "done"
    assert inventory.snapshot().active_activity_count == 0


def test_inventory_keeps_only_projection_resolvable_workflow_and_execution_refs():
    inventory = ActiveActivityInventory()
    workflow_id = f"prep-preparation:{'a' * 64}"
    temporal_run_id = "12345678-1234-4abc-8def-1234567890ab"

    inventory.start(
        activity_type="render_pdf",
        activity_id="render-one",
        workflow_id=workflow_id,
        workflow_run_id=temporal_run_id,
        attempt=1,
        started_at=datetime(2026, 7, 14, 9, 0, tzinfo=UTC),
    )

    detail = inventory.snapshot().active_details[0]
    assert detail.workflow_ref == workflow_id
    assert detail.execution_ref == temporal_run_id
