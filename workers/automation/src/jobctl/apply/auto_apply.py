"""Worker reconciler for the settings-controlled standing apply loop."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from temporalio.client import WorkflowExecutionStatus
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.service import RPCError, RPCStatusCode

from jobctl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobctl.domain.tenant import LOCAL_TENANT
from jobctl.infrastructure.scoring.criteria_provider import (
    read_apply_approval_required,
    read_apply_concurrency,
    read_auto_apply_enabled,
    read_daily_budget_usd,
    read_min_fit_score,
)

AUTO_APPLY_WORKFLOW_PREFIX = "apply-auto"


@dataclass(frozen=True)
class AutoApplyLoopSettings:
    enabled: bool
    min_score: int
    workers: int
    approval_required: bool


@dataclass(frozen=True)
class AutoApplyReconcileResult:
    workflow_id: str
    action: str
    enabled: bool

    @property
    def changed(self) -> bool:
        return self.action in {"started", "canceled"}


def auto_apply_workflow_id(tenant_id: str = str(LOCAL_TENANT)) -> str:
    return f"{AUTO_APPLY_WORKFLOW_PREFIX}-{tenant_id}"


def read_auto_apply_loop_settings(
    path: Path | str | None = None,
) -> AutoApplyLoopSettings:
    return AutoApplyLoopSettings(
        enabled=read_auto_apply_enabled(path, default=False),
        min_score=read_min_fit_score(path, default=7),
        workers=read_apply_concurrency(path, default=1),
        approval_required=read_apply_approval_required(path, default=True),
    )


async def reconcile_auto_apply_loop(
    client: Any,
    *,
    task_queue: str,
    tenant_id: str = str(LOCAL_TENANT),
    settings_path: Path | str | None = None,
    expected_app_dir: str | None = None,
    expected_db_path: str | None = None,
) -> AutoApplyReconcileResult:
    """Ensure the deterministic continuous apply workflow matches settings."""
    settings = read_auto_apply_loop_settings(settings_path)
    workflow_id = auto_apply_workflow_id(tenant_id)
    running = await _is_workflow_running(client, workflow_id)
    if settings.enabled:
        if running:
            return AutoApplyReconcileResult(workflow_id, "already_running", True)
        if _budget_halt_active(
            db_path=expected_db_path,
            workflow_id=workflow_id,
            settings_path=settings_path,
        ):
            return AutoApplyReconcileResult(workflow_id, "halted_budget_exceeded", True)
        payload = ApplyWorkflowInput(
            tenant_id=tenant_id,
            expected_app_dir=expected_app_dir,
            expected_db_path=expected_db_path,
            dry_run=False,
            min_score=settings.min_score,
            workers=settings.workers,
            limit=0,
            approval_required=settings.approval_required,
            continuous=True,
            auto_apply_loop=True,
        )
        await client.start_workflow(
            ApplyWorkflow.run,
            payload,
            id=workflow_id,
            task_queue=task_queue,
            id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
            id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE,
        )
        return AutoApplyReconcileResult(workflow_id, "started", True)

    if running:
        await client.get_workflow_handle(workflow_id).cancel()
        return AutoApplyReconcileResult(workflow_id, "canceled", False)
    return AutoApplyReconcileResult(workflow_id, "already_stopped", False)


async def _is_workflow_running(client: Any, workflow_id: str) -> bool:
    try:
        description = await client.get_workflow_handle(workflow_id).describe()
    except RPCError as exc:
        if exc.status == RPCStatusCode.NOT_FOUND:
            return False
        raise
    status = getattr(description, "status", None)
    return status == WorkflowExecutionStatus.RUNNING or getattr(status, "name", "") == "CONTINUED_AS_NEW"


def _budget_halt_active(
    *,
    db_path: str | None,
    workflow_id: str,
    settings_path: Path | str | None,
) -> bool:
    if not db_path:
        return False
    path = Path(db_path)
    if not path.exists():
        return False
    try:
        with sqlite3.connect(path) as conn:
            row = conn.execute(
                """
                SELECT status, error_code
                FROM workflow_run_projections
                WHERE workflow_id = ?
                LIMIT 1
                """,
                (workflow_id,),
            ).fetchone()
            if not row or str(row[0]) != "failed" or str(row[1]) != "budget_exceeded":
                return False
            daily_budget = read_daily_budget_usd(settings_path, default=25.0)
            if daily_budget <= 0:
                return False
            spend_day = datetime.now(timezone.utc).date().isoformat()
            spend = conn.execute(
                "SELECT estimated_usd FROM llm_spend WHERE day = ?",
                (spend_day,),
            ).fetchone()
    except sqlite3.Error:
        return False
    estimated = float(spend[0] or 0.0) if spend else 0.0
    return estimated >= daily_budget


__all__ = [
    "AUTO_APPLY_WORKFLOW_PREFIX",
    "AutoApplyLoopSettings",
    "AutoApplyReconcileResult",
    "auto_apply_workflow_id",
    "read_auto_apply_loop_settings",
    "reconcile_auto_apply_loop",
]
