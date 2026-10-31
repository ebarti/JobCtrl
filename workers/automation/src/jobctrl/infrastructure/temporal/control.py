"""Bounded local capacity for an explicit allowlist of short workflow controls."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from temporalio import workflow

from jobctrl.infrastructure.preparation_recovery import cancel_preparation_state_activity
from jobctrl.llm import check_spend_budget

_CONTROL_PATCHES = {
    check_spend_budget: "workflow-local-spend-preflight-v1",
    cancel_preparation_state_activity: "workflow-local-preparation-cancel-v1",
}
_CONTROL_ATTEMPT_TIMEOUT = timedelta(seconds=30)
_CONTROL_SCHEDULE_TIMEOUT = timedelta(minutes=3)


async def execute_control_activity(activity_fn, payload, **remote_options: Any):
    """Keep short controls independent of occupied remote model-work slots.

    Only these two activities may enter the reserved local pool. Original
    options and remote commands remain intact when replaying old histories.
    """
    try:
        marker = _CONTROL_PATCHES[activity_fn]
    except KeyError:
        raise ValueError("activity is not an allowlisted workflow control") from None
    if workflow.patched(marker):
        local_options = dict(remote_options)
        # Local activities have no heartbeat API. Database work runs off-loop;
        # queueing plus all retries stays bounded independently of model work.
        local_options.pop("heartbeat_timeout", None)
        local_options["start_to_close_timeout"] = _CONTROL_ATTEMPT_TIMEOUT
        return await workflow.execute_local_activity(
            activity_fn, payload,
            schedule_to_close_timeout=_CONTROL_SCHEDULE_TIMEOUT,
            **local_options,
        )
    return await workflow.execute_activity(activity_fn, payload, **remote_options)
