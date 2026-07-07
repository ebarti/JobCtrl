"""Durability probe workflow — a hermetic durable-execution self-test.

This workflow exists so an operator can *prove* the durable-execution recovery
guarantee (``docs/requirements.md`` TR-008; claims ledger CL-050) without
crawling a single job board or spending a single LLM token. Its only work is a
durable Temporal timer:

  1. emit the standard ``WorkflowStarted`` marker (a tiny local SQLite write),
  2. ``await workflow.sleep(hold_seconds)`` — a timer that lives in Temporal
     history, so it survives the worker being killed and requires no worker at
     all while it counts down,
  3. emit the standard terminal ``WorkflowCompleted`` marker.

Because the only in-flight state is a durable timer, the workflow is:

  * hermetic — no network, no LLM, no browser, no job data touched;
  * controllably long — ``hold_seconds`` keeps it ``Running`` long enough to
    kill the worker mid-flight, unlike a no-op that finishes in milliseconds;
  * resumable — a fresh worker picks the timer up from history and drives the
    *same* workflow execution to ``Completed`` exactly once.

It emits the same lifecycle events every other JobCtrl workflow does, so it
shows up in ``jobctrl runs`` and the read-model projection like any real run.
It never touches apply/submission and is inert until explicitly started.
``scripts/reliability-demo.sh`` drives it end to end.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.exceptions import CancelledError

with workflow.unsafe.imports_passed_through():
    from jobctrl.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )

_WORKFLOW_TYPE = "DurabilityProbeWorkflow"
# Clamp the hold so a fat-fingered input can never wedge a worker for hours.
_MAX_HOLD_SECONDS = 3600


@dataclass(frozen=True)
class DurabilityProbeInput:
    tenant_id: str
    hold_seconds: int = 20
    expected_app_dir: str | None = None
    expected_db_path: str | None = None


@dataclass(frozen=True)
class DurabilityProbeResult:
    workflow_id: str
    run_id: str
    hold_seconds: int


def durability_probe_workflow_id(tenant_id: str, suffix: str) -> str:
    return f"durability-probe-{tenant_id}-{suffix}"


@workflow.defn(name="DurabilityProbeWorkflow")
class DurabilityProbeWorkflow:
    """Hold a durable timer so worker-crash recovery can be demonstrated."""

    @workflow.run
    async def run(self, payload: DurabilityProbeInput) -> DurabilityProbeResult:
        started_at = workflow.now()
        hold_seconds = max(0, min(payload.hold_seconds, _MAX_HOLD_SECONDS))
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type=_WORKFLOW_TYPE,
            input_summary={"holdSeconds": hold_seconds},
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        try:
            await workflow.sleep(timedelta(seconds=hold_seconds))
        except CancelledError:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type=_WORKFLOW_TYPE,
                status="canceled",
                started_at=started_at,
                error_code="workflow_canceled",
                error_message="Durability probe canceled by request.",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise
        except Exception as exc:  # noqa: BLE001 - record then re-raise
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type=_WORKFLOW_TYPE,
                status="failed",
                started_at=started_at,
                error_code="workflow_error",
                error_message=str(exc),
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise
        await emit_workflow_outcome(
            tenant_id=payload.tenant_id,
            workflow_type=_WORKFLOW_TYPE,
            status="succeeded",
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        info = workflow.info()
        return DurabilityProbeResult(
            workflow_id=info.workflow_id,
            run_id=info.run_id,
            hold_seconds=hold_seconds,
        )


__all__ = [
    "DurabilityProbeInput",
    "DurabilityProbeResult",
    "DurabilityProbeWorkflow",
    "durability_probe_workflow_id",
]
