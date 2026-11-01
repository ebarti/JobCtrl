"""Operational-only authority for all-family Discovery result admission."""

from __future__ import annotations

import hashlib
import json
import sqlite3

from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.errors import ConfigurationError
from jobctrl.domain.tenant import TenantId

_EVENT = "DiscoveryResultPlanFrozen"
_RESTART = (
    "Bounded Discovery requires its frozen all-family execution result plan. "
    "Restart Discovery after upgrading; existing jobs, captures and checkpoints are preserved."
)


def _key(execution: DiscoveryExecutionRef) -> str:
    scope = [execution.tenant_id, execution.workflow_id, execution.temporal_run_id]
    return "discovery-result-plan:" + hashlib.sha256(json.dumps(scope).encode()).hexdigest()


def _payload(execution, limit, source_limits, bounded):
    if type(limit) is not int or limit < 0 or type(bounded) is not bool:
        raise ConfigurationError(_RESTART)
    if not isinstance(source_limits, dict) or any(
        not isinstance(key, str) or not key or type(cap) is not int or cap < 0
        for key, cap in source_limits.items()
    ) or (not bounded and (limit != 0 or source_limits)):
        raise ConfigurationError(_RESTART)
    payload = {
        "decoder_version": 1,
        "evidence_kind": "all_family_result_plan",
        "discovery_workflow_id": execution.workflow_id,
        "discovery_run_id": execution.temporal_run_id,
        "tenant_id": execution.tenant_id,
        "bounded": bounded,
        "limit": limit,
        "source_result_limits": source_limits,
    }
    payload["fingerprint"] = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return payload


def load_result_plan(conn: sqlite3.Connection, execution: DiscoveryExecutionRef) -> dict | None:
    row = conn.execute(
        "SELECT tenant_id,job_id,stage,event_type,payload_json FROM job_events WHERE idempotency_key=?",
        (_key(execution),),
    ).fetchone()
    if row is None:
        return None
    try:
        raw = json.loads(row[4])
        expected = _payload(execution, raw["limit"], raw["source_result_limits"], raw["bounded"])
        valid = (
            tuple(row[:4]) == (execution.tenant_id, None, "discover", _EVENT)
            and type(raw.get("decoder_version")) is int
            and all(raw.get(key) == value for key, value in expected.items())
        )
    except (ValueError, KeyError, TypeError):
        valid = False
    if not valid:
        raise ConfigurationError(_RESTART)
    return expected


def check_result_plan(conn, execution, *, limit, source_limits, bounded, required=True):
    recorded = load_result_plan(conn, execution)
    if recorded is None:
        if required:
            raise ConfigurationError(_RESTART)
        return
    expected = _payload(execution, limit, source_limits, bounded)
    if expected != recorded:
        raise ConfigurationError(_RESTART)


def check_result_plan_start(conn, execution, *, limit, bounded):
    """Read-only refusal before planning/lifecycle effects; freeze rechecks locked."""
    recorded = load_result_plan(conn, execution)
    if recorded is not None:
        if recorded["limit"] != limit or recorded["bounded"] is not bounded:
            raise ConfigurationError(_RESTART)
        return recorded
    scope = (execution.tenant_id, execution.workflow_id, execution.temporal_run_id)
    for table in ("discovery_execution_jobs", "discovery_search_units", "pipeline_step_projections"):
        extra = " AND step_kind <> 'source_planning'" if table == "pipeline_step_projections" else ""
        if conn.execute(
            f"SELECT 1 FROM {table} WHERE tenant_id=? AND discover_workflow_id=? AND discover_run_id=?"
            + extra + " LIMIT 1", scope,
        ).fetchone():
            raise ConfigurationError(_RESTART)
    if conn.execute(
        "SELECT 1 FROM job_events WHERE tenant_id=? AND event_type='DiscoveryNewJobAdmitted' "
        "AND json_extract(payload_json,'$.discovery_workflow_id')=? "
        "AND json_extract(payload_json,'$.discovery_run_id')=? LIMIT 1", scope,
    ).fetchone():
        raise ConfigurationError(_RESTART)
    return None


def freeze_result_plan(conn, execution, *, limit, source_limits, bounded=True):
    """Retain the first plan; never upgrade an execution with prior source effects."""
    proposed = _payload(execution, limit, source_limits, bounded)
    owns = not conn.in_transaction
    conn.execute("BEGIN IMMEDIATE" if owns else "SAVEPOINT discovery_result_plan")
    try:
        recorded = check_result_plan_start(conn, execution, limit=limit, bounded=bounded)
        if recorded is None:
            from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
            from jobctrl.state import record_job_event

            record_job_event(
                conn, None, "discover", _EVENT, tenant_id=TenantId(execution.tenant_id),
                payload=proposed, idempotency_key=_key(execution), publisher=InProcessEventBus(),
            )
            recorded = load_result_plan(conn, execution)
            if recorded != proposed:
                raise RuntimeError("Discovery execution result plan was not persisted exactly once")
        conn.commit() if owns else conn.execute("RELEASE SAVEPOINT discovery_result_plan")
        return recorded
    except BaseException:
        if owns:
            conn.rollback()
        else:
            conn.execute("ROLLBACK TO SAVEPOINT discovery_result_plan")
            conn.execute("RELEASE SAVEPOINT discovery_result_plan")
        raise
