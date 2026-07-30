"""Temporal-owned schedule controls for the stable JobId cutover."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from temporalio.service import RPCError, RPCStatusCode

from jobctrl.discovery.workflow import discover_workflow_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.temporal.workflow_dispatch_control import (
    activate_workflow_dispatch_fence,
)

_CUTOVER_PAUSE_NOTE = "Paused for the stable JobId cutover."


@dataclass(frozen=True)
class ScheduledWorkflowIdentityPolicy:
    schedule_id: str
    workflow_type: str
    workflow_id: str


@dataclass(frozen=True)
class IdentityCutoverFenceReceipt:
    dispatches_blocked: bool
    paused_schedule_ids: tuple[str, ...]


def identity_bearing_schedule_policies(
    tenant_id: str = str(LOCAL_TENANT),
) -> tuple[ScheduledWorkflowIdentityPolicy, ...]:
    """Return every Temporal-owned schedule that can start job identity work."""

    return (
        ScheduledWorkflowIdentityPolicy(
            schedule_id=f"jobctrl-discovery-{tenant_id}",
            workflow_type="DiscoverWorkflow",
            workflow_id=discover_workflow_id(tenant_id),
        ),
    )


async def pause_identity_bearing_schedules(
    client: Any,
    *,
    tenant_id: str = str(LOCAL_TENANT),
) -> tuple[str, ...]:
    """Pause every configured identity-bearing schedule, failing closed."""

    paused: list[str] = []
    for policy in identity_bearing_schedule_policies(tenant_id):
        handle = client.get_schedule_handle(policy.schedule_id)
        try:
            await handle.pause(note=_CUTOVER_PAUSE_NOTE)
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                continue
            raise
        paused.append(policy.schedule_id)
    return tuple(paused)


async def activate_identity_cutover_fence(
    client: Any,
    *,
    db_path: str,
    tenant_id: str = str(LOCAL_TENANT),
) -> IdentityCutoverFenceReceipt:
    """Atomically block direct dispatch and pause Temporal-owned schedules."""

    async def _pause() -> tuple[str, ...]:
        return await pause_identity_bearing_schedules(
            client,
            tenant_id=tenant_id,
        )

    paused = await activate_workflow_dispatch_fence(
        reason="stable-job-id-cutover",
        after_blocked=_pause,
        db_path=db_path,
    )
    return IdentityCutoverFenceReceipt(
        dispatches_blocked=True,
        paused_schedule_ids=paused,
    )


__all__ = [
    "IdentityCutoverFenceReceipt",
    "ScheduledWorkflowIdentityPolicy",
    "activate_identity_cutover_fence",
    "identity_bearing_schedule_policies",
    "pause_identity_bearing_schedules",
]
