"""Default JSON-RPC handler registry.

Per S-11 the initial method set covers:

* Simple state-transition commands — ``reset_stage``, ``mark_applied``,
  ``mark_skipped``, ``cancel_stage``.  These mutate ``job_stage_states``
  through the same write API the TS surface uses (``state.reset_job_stage``
  / ``state.set_stage_state``).
* Existing local-action wrappers — ``run_stage``, ``apply``,
  ``profile_import``.  These delegate to ``actions.run_local_action``.

Every method accepts ``params.tenantId``; if it is missing the handler logs
a warning and substitutes ``LOCAL_TENANT`` (single-user / local-first per
target §6.5).
"""

from __future__ import annotations

import logging
from typing import Any

from jobhunter.actions import LocalActionRequest, run_local_action
from jobhunter.database import get_connection
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.rpc.server import JsonRpcServer, invalid_params
from jobhunter.state import record_job_event, reset_job_stage, set_stage_state, utc_now

logger = logging.getLogger(__name__)


def _tenant_id(params: dict[str, Any]) -> str:
    raw = params.get("tenantId")
    if not raw:
        logger.warning("JSON-RPC call missing 'tenantId' — defaulting to LOCAL_TENANT")
        return LOCAL_TENANT
    return str(raw)


def _require(params: dict[str, Any], name: str) -> Any:
    if name not in params or params[name] in (None, ""):
        raise invalid_params(f"missing required param: {name}")
    return params[name]


# ---------------------------------------------------------------------------
# Simple state-transition handlers
# ---------------------------------------------------------------------------


def reset_stage(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    stage = str(_require(params, "stage"))
    reset_attempts = bool(params.get("resetAttempts", False))

    conn = get_connection()
    canonical = reset_job_stage(conn, job_url, stage, reset_attempts=reset_attempts)
    return {"jobUrl": canonical, "stage": stage, "state": "pending"}


def mark_applied(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    now = utc_now()

    conn = get_connection()
    set_stage_state(
        conn,
        job_url,
        "apply",
        "succeeded",
        finished_at=now,
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_url,
        "apply",
        "ApplicationManuallyMarked",
        message="Marked applied via RPC",
    )
    conn.commit()
    return {"jobUrl": job_url, "state": "succeeded"}


def mark_skipped(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    stage = str(_require(params, "stage"))
    reason = str(params.get("reason", "manual_skip"))

    conn = get_connection()
    set_stage_state(
        conn,
        job_url,
        stage,
        "skipped",
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_url,
        stage,
        "StageSkipped",
        message=reason,
        payload={"reason": reason},
    )
    conn.commit()
    return {"jobUrl": job_url, "stage": stage, "state": "skipped"}


def cancel_stage(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    job_url = str(_require(params, "jobUrl"))
    stage = str(_require(params, "stage"))
    now = utc_now()

    conn = get_connection()
    set_stage_state(
        conn,
        job_url,
        stage,
        "canceled",
        finished_at=now,
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_url,
        stage,
        "StageCanceled",
        message="Stage canceled via RPC",
    )
    conn.commit()
    return {"jobUrl": job_url, "stage": stage, "state": "canceled"}


# ---------------------------------------------------------------------------
# Local-action wrappers (sync — return LocalActionResult dict)
# ---------------------------------------------------------------------------


def run_stage(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    stage = str(_require(params, "stage"))
    request = LocalActionRequest(
        stage=stage,
        job_url=params.get("jobUrl"),
        limit=int(params.get("limit", 0)),
        workers=int(params.get("workers", 1)),
        min_score=int(params.get("minScore", 7)),
        validation_mode=str(params.get("validationMode", "normal")),
        dry_run=bool(params.get("dryRun", False)),
        rescore=bool(params.get("rescore", False)),
        retailor=bool(params.get("retailor", False)),
    )
    return run_local_action(request).to_dict()


def apply_action(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    request = LocalActionRequest(
        stage="apply",
        job_url=params.get("jobUrl"),
        limit=int(params.get("limit", 1)),
        workers=int(params.get("workers", 1)),
        min_score=int(params.get("minScore", 7)),
        dry_run=bool(params.get("dryRun", False)),
        model=str(params.get("model", "haiku")),
        headless=bool(params.get("headless", False)),
        continuous=bool(params.get("continuous", False)),
    )
    return run_local_action(request).to_dict()


def profile_import(params: dict[str, Any]) -> dict[str, Any]:
    _tenant_id(params)
    pdf_path = str(_require(params, "pdfPath"))
    request = LocalActionRequest(
        stage="profile_import",
        pdf_path=pdf_path,
        import_profile=bool(params.get("importProfile", True)),
        import_style=bool(params.get("importStyle", True)),
    )
    return run_local_action(request).to_dict()


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def register_default_handlers(server: JsonRpcServer) -> None:
    """Wire the default JobHunter method set onto *server*."""
    # Simple state-transition commands — synchronous.
    server.register("reset_stage", reset_stage, mode="sync")
    server.register("mark_applied", mark_applied, mode="sync")
    server.register("mark_skipped", mark_skipped, mode="sync")
    server.register("cancel_stage", cancel_stage, mode="sync")
    # Local-action wrappers — sync for now (the TS API can stream via the
    # ``streaming`` mode in Phase 9).
    server.register("run_stage", run_stage, mode="sync")
    server.register("apply", apply_action, mode="fire_and_forget")
    server.register("profile_import", profile_import, mode="sync")
