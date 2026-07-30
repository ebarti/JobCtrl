from __future__ import annotations

from dataclasses import dataclass

import pytest
from temporalio.service import RPCError, RPCStatusCode

from jobctrl.infrastructure.temporal.schedule_cutover import (
    activate_identity_cutover_fence,
    identity_bearing_schedule_policies,
    pause_identity_bearing_schedules,
)
from jobctrl.infrastructure.temporal.workflow_dispatch_control import (
    workflow_dispatches_blocked,
)


@dataclass
class _ScheduleHandle:
    outcome: Exception | None = None
    pause_notes: list[str | None] | None = None

    async def pause(self, *, note: str | None = None) -> None:
        if self.outcome is not None:
            raise self.outcome
        if self.pause_notes is None:
            self.pause_notes = []
        self.pause_notes.append(note)


class _ScheduleClient:
    def __init__(self, handle: _ScheduleHandle) -> None:
        self.handle = handle
        self.schedule_ids: list[str] = []

    def get_schedule_handle(
        self,
        schedule_id: str,
    ) -> _ScheduleHandle:
        self.schedule_ids.append(schedule_id)
        return self.handle


def test_identity_bearing_schedule_policy_names_exact_discovery_execution() -> None:
    policies = identity_bearing_schedule_policies("tenant-a")
    assert len(policies) == 1
    policy = policies[0]
    assert policy.schedule_id == "jobctrl-discovery-tenant-a"
    assert policy.workflow_type == "DiscoverWorkflow"
    assert policy.workflow_id == "discover-tenant-a"


@pytest.mark.asyncio
async def test_pause_identity_bearing_schedules_returns_only_confirmed_pauses() -> None:
    handle = _ScheduleHandle()
    client = _ScheduleClient(handle)

    paused = await pause_identity_bearing_schedules(
        client,
        tenant_id="tenant-a",
    )

    assert paused == ("jobctrl-discovery-tenant-a",)
    assert client.schedule_ids == ["jobctrl-discovery-tenant-a"]
    assert handle.pause_notes == [
        "Paused for the stable JobId cutover."
    ]


@pytest.mark.asyncio
async def test_pause_identity_bearing_schedules_treats_absence_as_safe() -> None:
    handle = _ScheduleHandle(
        outcome=RPCError(
            "not found",
            RPCStatusCode.NOT_FOUND,
            b"",
        )
    )

    paused = await pause_identity_bearing_schedules(
        _ScheduleClient(handle),
    )

    assert paused == ()


@pytest.mark.asyncio
async def test_pause_identity_bearing_schedules_propagates_unknown_failure() -> None:
    handle = _ScheduleHandle(
        outcome=RPCError(
            "unavailable",
            RPCStatusCode.UNAVAILABLE,
            b"",
        )
    )

    with pytest.raises(RPCError):
        await pause_identity_bearing_schedules(
            _ScheduleClient(handle),
        )


@pytest.mark.asyncio
async def test_activation_leaves_dispatch_blocked_when_schedule_pause_fails(
    tmp_path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    handle = _ScheduleHandle(
        outcome=RPCError(
            "unavailable",
            RPCStatusCode.UNAVAILABLE,
            b"",
        )
    )

    with pytest.raises(RPCError):
        await activate_identity_cutover_fence(
            _ScheduleClient(handle),
            db_path=str(db_path),
        )

    assert workflow_dispatches_blocked(db_path) is True
