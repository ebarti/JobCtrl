"""Exact-run preparation results observed from immutable Temporal history.

This is an audit-only backfill, not a lifecycle writer. Completed preparation
runs may intentionally stop before PDF; their actual result is the authority
for that branch. Missing history and invalid results remain unknown.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from temporalio.converter import DataConverter

from jobctrl.domain.discovery.execution import (
    DISCOVERY_PREPARATION_STEPS,
    DiscoveryExecutionRef,
    validate_required_steps,
)
from jobctrl.domain.events.workflow import (
    PreparationWorkflowOutcomeObservedPayload,
    create_preparation_workflow_outcome_observed,
    validate_preparation_outcome_steps,
)
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.runtime_identity import RuntimeIdentity, current_runtime_identity

log = logging.getLogger(__name__)

EVENT_TYPE = "PreparationWorkflowOutcomeObserved"
MAX_RUNS_PER_PASS = 10
MAX_HISTORY_EVENTS = 2048
MAX_PAYLOAD_BYTES = 64 * 1024
PASS_TIMEOUT_SECONDS = 5.0

# Selection fairness only: these cursors are never outcome authority. Rotate
# past unreadable histories so old missing rows cannot starve a ready sibling.
_cursors: OrderedDict[tuple[str, str], str] = OrderedDict()
_cursor_lock = threading.Lock()


@dataclass(frozen=True)
class PreparationOutcomeAssociation:
    execution: DiscoveryExecutionRef
    job_id: str
    required_steps: tuple[str, ...]
    cohort_kind: str
    runtime: RuntimeIdentity | None


@dataclass(frozen=True)
class PreparationOutcomeTarget:
    tenant_id: str
    workflow_id: str
    temporal_run_id: str
    association: PreparationOutcomeAssociation | None = None


def _identifier(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 1024:
        raise ValueError("invalid preparation outcome identifier")
    if value != value.strip():
        raise ValueError("noncanonical preparation outcome identifier")
    return value


def _steps(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > len(DISCOVERY_PREPARATION_STEPS):
        raise ValueError("invalid preparation outcome steps")
    if any(not isinstance(step, str) or step not in DISCOVERY_PREPARATION_STEPS for step in value):
        raise ValueError("unknown preparation outcome step")
    if len(set(value)) != len(value):
        raise ValueError("duplicate preparation outcome step")
    return tuple(value)


async def _decode_one(converter: Any, payloads: Any) -> Mapping[str, Any]:
    raw = list(getattr(payloads, "payloads", ()) or ())
    if len(raw) != 1 or sum(len(payload.data) for payload in raw) > MAX_PAYLOAD_BYTES:
        raise ValueError("invalid preparation history payload size")
    decoded = await converter.decode(raw)
    if len(decoded) != 1 or not isinstance(decoded[0], Mapping):
        raise ValueError("invalid preparation history payload")
    return decoded[0]


async def _preparation_outcome_from_history(
    handle: Any,
    target: PreparationOutcomeTarget,
    *,
    data_converter: Any = None,
) -> PreparationWorkflowOutcomeObservedPayload | None:
    """Decode one explicit run's start and successful, literal completed result."""
    if getattr(handle, "run_id", None) != target.temporal_run_id:
        return None
    converter = data_converter or DataConverter.default
    started: Mapping[str, Any] | None = None
    completed: Mapping[str, Any] | None = None
    terminal_event_id: int | None = None
    previous_event_id = 0
    seen = 0
    async for event in handle.fetch_history_events(wait_new_event=False):
        seen += 1
        event_id = getattr(event, "event_id", None)
        if seen > MAX_HISTORY_EVENTS or type(event_id) is not int or event_id <= previous_event_id:
            return None
        previous_event_id = event_id
        kind = event.WhichOneof("attributes")
        if kind == "workflow_execution_started_event_attributes":
            attrs = event.workflow_execution_started_event_attributes
            if (
                started is not None
                or getattr(getattr(attrs, "workflow_type", None), "name", None) != "JobPreparationWorkflow"
            ):
                return None
            started = await _decode_one(converter, attrs.input)
        elif kind == "workflow_execution_completed_event_attributes":
            attrs = event.workflow_execution_completed_event_attributes
            if started is None or completed is not None or getattr(attrs, "new_execution_run_id", ""):
                return None
            completed = await _decode_one(converter, attrs.result)
            terminal_event_id = event_id
        elif kind in {
            "workflow_execution_failed_event_attributes",
            "workflow_execution_canceled_event_attributes",
            "workflow_execution_timed_out_event_attributes",
            "workflow_execution_terminated_event_attributes",
            "workflow_execution_continued_as_new_event_attributes",
        }:
            return None
    if started is None or completed is None or terminal_event_id is None:
        return None
    try:
        if _identifier(started.get("tenant_id")) != target.tenant_id:
            return None
        key = _identifier(started.get("idempotency_key"))
        if target.workflow_id != "prep-" + key:
            return None
        job_id = canonical_job_id(_identifier(started.get("job_id")))
        required = _steps(started.get("steps"))
        if not required or required != validate_required_steps(required) or "pdf" not in required:
            return None
        raw_execution = started.get("discovery_execution")
        origin = None
        origin_cohort = started.get("discovery_cohort_kind")
        if raw_execution is None:
            if origin_cohort is not None:
                return None
        else:
            if not isinstance(raw_execution, Mapping) or set(raw_execution) != {
                "tenant_id",
                "workflow_id",
                "temporal_run_id",
            }:
                return None
            origin = DiscoveryExecutionRef(
                tenant_id=_identifier(raw_execution.get("tenant_id")),
                workflow_id=_identifier(raw_execution.get("workflow_id")),
                temporal_run_id=_identifier(raw_execution.get("temporal_run_id")),
            )
            if origin.tenant_id != target.tenant_id or origin_cohort not in {"observed_this_run", "existing_backlog"}:
                return None
        association = target.association
        linked_cohort = None
        execution = origin
        if association is not None:
            if (
                association.execution.tenant_id != target.tenant_id
                or association.job_id != str(job_id)
                or association.required_steps != required
                or association.cohort_kind not in {"observed_this_run", "existing_backlog"}
            ):
                return None
            execution = association.execution
            if execution != origin:
                # Foreign or manual owners are usable only through an explicit
                # membership and an immutable input bound to this workspace.
                if not _input_matches_runtime(started, association.runtime):
                    return None
                linked_cohort = association.cohort_kind
        if execution is None:
            return None
        if set(completed) != {"steps_completed", "steps_skipped", "steps_failed", "failure", "error_code"}:
            return None
        done = _steps(completed["steps_completed"])
        skipped = _steps(completed["steps_skipped"])
        if (
            _steps(completed["steps_failed"])
            or completed["failure"] is not None
            or completed["error_code"] is not None
            or len(skipped) > 1
        ):
            return None
        validate_preparation_outcome_steps(required, done, skipped)
        return PreparationWorkflowOutcomeObservedPayload(
            workflow_id=target.workflow_id,
            temporal_run_id=target.temporal_run_id,
            job_id=job_id,
            idempotency_key=key,
            required_steps=required,
            discovery_execution=execution,
            terminal_history_event_id=terminal_event_id,
            steps_completed=done,
            steps_skipped=skipped,
            association_cohort_kind=linked_cohort,
            origin_discovery_execution=origin if linked_cohort else None,
            origin_discovery_cohort_kind=origin_cohort if linked_cohort else None,
        )
    except (KeyError, TypeError, ValueError):
        return None


async def preparation_outcome_from_history(
    handle: Any,
    target: PreparationOutcomeTarget,
    *,
    data_converter: Any = None,
) -> PreparationWorkflowOutcomeObservedPayload | None:
    """Return no receipt for malformed history; transport failures stay retryable."""
    try:
        return await _preparation_outcome_from_history(handle, target, data_converter=data_converter)
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


def _database_path(conn: sqlite3.Connection) -> str:
    return next((str(row[2]) for row in conn.execute("PRAGMA database_list") if row[1] == "main"), "")


def _runtime_for_connection(conn: sqlite3.Connection) -> RuntimeIdentity | None:
    current = current_runtime_identity()
    path = _database_path(conn)
    return current if path and Path(path).resolve() == Path(current.db_path).resolve() else None


def _input_matches_runtime(started: Mapping[str, Any], runtime: RuntimeIdentity | None) -> bool:
    if runtime is None:
        return False
    return all(
        isinstance(started.get(field), str)
        and bool(started[field])
        and Path(started[field]).is_absolute()
        and Path(started[field]).resolve() == Path(expected).resolve()
        for field, expected in (("expected_app_dir", runtime.app_dir), ("expected_db_path", runtime.db_path))
    )


def _association_key(target: PreparationOutcomeTarget) -> str:
    association = target.association
    if association is None:
        raise ValueError("missing preparation outcome association")
    return "preparation-outcome:2:" + json.dumps(
        [
            target.tenant_id,
            target.workflow_id,
            target.temporal_run_id,
            association.execution.workflow_id,
            association.execution.temporal_run_id,
            association.job_id,
            association.cohort_kind,
            list(association.required_steps),
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def missing_preparation_outcomes(
    conn: sqlite3.Connection,
    *,
    tenant_id: str = str(LOCAL_TENANT),
    limit: int = MAX_RUNS_PER_PASS,
    after_target_key: str = "",
) -> list[PreparationOutcomeTarget]:
    """Select bounded successful owners separately for each recorded association."""
    if conn.in_transaction:
        return []
    key_sql = (
        "'preparation-outcome:2:' || json_array(wrp.tenant_id, wrp.workflow_id, wrp.temporal_run_id, "
        "member.discover_workflow_id, member.discover_run_id, member.job_id, member.cohort_kind, "
        "json(CASE WHEN json_valid(member.required_steps_json) THEN member.required_steps_json ELSE '[]' END))"
    )
    rows = conn.execute(
        "SELECT wrp.workflow_id, wrp.temporal_run_id, member.discover_workflow_id, member.discover_run_id, "
        "member.job_id, member.cohort_kind, member.required_steps_json, " + key_sql + " AS target_key "
        "FROM workflow_run_projections wrp JOIN discovery_execution_jobs member "
        "ON member.tenant_id = wrp.tenant_id AND member.preparation_workflow_id = wrp.workflow_id "
        "WHERE wrp.tenant_id = ? AND wrp.workflow_type = 'JobPreparationWorkflow' "
        "AND wrp.status = 'succeeded' AND wrp.temporal_run_id IS NOT NULL "
        "AND TRIM(wrp.temporal_run_id) != '' AND member.work_plan_state = 'planned' "
        "AND CASE WHEN json_valid(member.required_steps_json) "
        "THEN EXISTS (SELECT 1 FROM json_each(member.required_steps_json) WHERE value = 'pdf') ELSE 0 END "
        "AND " + key_sql + " > ? "
        "AND NOT EXISTS (SELECT 1 FROM job_events receipt "
        "WHERE receipt.tenant_id = wrp.tenant_id AND receipt.event_type = ? "
        "AND receipt.entity_kind = 'workflow_run' AND receipt.entity_ref = wrp.workflow_id "
        "AND (receipt.idempotency_key = " + key_sql + " OR ("
        "receipt.idempotency_key = ? || wrp.workflow_id || ':' || wrp.temporal_run_id "
        "AND CASE WHEN json_valid(receipt.payload_json) THEN "
        "json_extract(receipt.payload_json, '$.discoveryExecution.tenantId') = member.tenant_id "
        "AND json_extract(receipt.payload_json, '$.discoveryExecution.workflowId') = member.discover_workflow_id "
        "AND json_extract(receipt.payload_json, '$.discoveryExecution.temporalRunId') = member.discover_run_id "
        "ELSE 0 END))) "
        "ORDER BY target_key LIMIT ?",
        (
            tenant_id,
            after_target_key,
            EVENT_TYPE,
            f"preparation-outcome:1:{tenant_id}:",
            min(MAX_RUNS_PER_PASS, max(1, limit)),
        ),
    ).fetchall()
    runtime = _runtime_for_connection(conn)
    targets = []
    for row in rows:
        try:
            required = _steps(json.loads(row[6]))
            if required != validate_required_steps(required):
                continue
            targets.append(
                PreparationOutcomeTarget(
                    _identifier(tenant_id),
                    _identifier(row[0]),
                    _identifier(row[1]),
                    PreparationOutcomeAssociation(
                        DiscoveryExecutionRef(_identifier(tenant_id), _identifier(row[2]), _identifier(row[3])),
                        str(canonical_job_id(_identifier(row[4]))),
                        required,
                        _identifier(row[5]),
                        runtime,
                    ),
                )
            )
        except (TypeError, ValueError):
            continue
    return targets


def record_preparation_outcome(
    conn: sqlite3.Connection,
    observation: PreparationWorkflowOutcomeObservedPayload,
    *,
    target: PreparationOutcomeTarget | None = None,
) -> bool:
    """Append only if the exact successful owner and frozen plan still match."""
    from jobctrl.state import record_job_event

    if conn.in_transaction:
        raise RuntimeError("Preparation outcome observation requires its own transaction")
    event = create_preparation_workflow_outcome_observed(
        TenantId(observation.discovery_execution.tenant_id),
        observation,
    )
    execution = observation.discovery_execution
    linked = observation.association_cohort_kind is not None
    if linked:
        association = target.association if target is not None else None
        if (
            association is None
            or association.runtime is None
            or _runtime_for_connection(conn) != association.runtime
            or target.tenant_id != execution.tenant_id
            or target.workflow_id != observation.workflow_id
            or target.temporal_run_id != observation.temporal_run_id
            or association.execution != execution
            or association.job_id != str(observation.job_id)
            or association.required_steps != observation.required_steps
            or association.cohort_kind != observation.association_cohort_kind
        ):
            return False
    # This runs on the heartbeat's SQLite-owning thread. A busy writer must
    # defer the observation, rather than block that event loop for the normal
    # connection's ten-second busy timeout. Restore the caller's setting.
    busy_timeout = int(conn.execute("PRAGMA busy_timeout").fetchone()[0])
    conn.execute("PRAGMA busy_timeout = 0")
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT member.required_steps_json, member.cohort_kind FROM discovery_execution_jobs member "
            "JOIN workflow_run_projections owner ON owner.tenant_id = member.tenant_id "
            "AND owner.workflow_id = member.preparation_workflow_id "
            "WHERE member.tenant_id = ? AND member.discover_workflow_id = ? "
            "AND member.discover_run_id = ? AND member.job_id = ? "
            "AND member.work_plan_state = 'planned' AND member.preparation_workflow_id = ? "
            "AND owner.workflow_type = 'JobPreparationWorkflow' AND owner.status = 'succeeded' "
            "AND owner.temporal_run_id = ?",
            (
                execution.tenant_id,
                execution.workflow_id,
                execution.temporal_run_id,
                str(observation.job_id),
                observation.workflow_id,
                observation.temporal_run_id,
            ),
        ).fetchone()
        if (
            row is None
            or _steps(json.loads(row[0])) != observation.required_steps
            or (linked and row[1] != observation.association_cohort_kind)
        ):
            conn.rollback()
            return False
        before = conn.total_changes
        record_job_event(
            conn,
            observation.job_id,
            "workflow",
            EVENT_TYPE,
            tenant_id=TenantId(execution.tenant_id),
            payload=dict(event.payload),
            entity_kind="workflow_run",
            entity_ref=observation.workflow_id,
            idempotency_key=(
                _association_key(target)
                if linked
                else f"preparation-outcome:1:{execution.tenant_id}:{observation.workflow_id}:{observation.temporal_run_id}"
            ),
        )
        changed = conn.total_changes > before
        conn.commit()
        return changed
    except BaseException:
        if conn.in_transaction:
            conn.rollback()
        raise
    finally:
        conn.execute(f"PRAGMA busy_timeout = {busy_timeout}")


def _cursor_scope(conn: sqlite3.Connection, tenant_id: str) -> tuple[str, str]:
    path = next((str(row[2]) for row in conn.execute("PRAGMA database_list") if row[1] == "main"), "")
    return path or f"memory:{id(conn)}", tenant_id


def _remember_cursor(scope: tuple[str, str], workflow_id: str) -> None:
    with _cursor_lock:
        _cursors[scope] = workflow_id
        _cursors.move_to_end(scope)
        while len(_cursors) > 64:
            _cursors.popitem(last=False)


async def reconcile_preparation_outcomes(
    temporal_client: Any,
    *,
    conn: sqlite3.Connection | None = None,
    tenant_id: str = str(LOCAL_TENANT),
) -> int:
    """Backfill a fair, bounded batch without replacing any lifecycle outcome."""
    from jobctrl.database import get_connection

    connection = conn if conn is not None else get_connection()
    if connection.in_transaction:
        return 0
    scope = _cursor_scope(connection, tenant_id)
    with _cursor_lock:
        cursor = _cursors.get(scope, "")
    targets = missing_preparation_outcomes(connection, tenant_id=tenant_id, after_target_key=cursor)
    if not targets and cursor:
        targets = missing_preparation_outcomes(connection, tenant_id=tenant_id)
    changed = 0
    deadline = asyncio.get_running_loop().time() + PASS_TIMEOUT_SECONDS
    for target in targets:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            break
        _remember_cursor(scope, _association_key(target))
        try:
            handle = temporal_client.get_workflow_handle(target.workflow_id, run_id=target.temporal_run_id)
            observation = await asyncio.wait_for(
                preparation_outcome_from_history(
                    handle,
                    target,
                    data_converter=getattr(temporal_client, "data_converter", None),
                ),
                timeout=remaining,
            )
            if observation is not None:
                changed += int(record_preparation_outcome(connection, observation, target=target))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # one unavailable history must not stop peer recovery
            # Exception messages may contain raw Temporal payloads; retain no
            # response prose, credentials or unbounded error details here.
            log.debug("Preparation outcome remains unknown (%s)", type(exc).__name__)
    return changed
