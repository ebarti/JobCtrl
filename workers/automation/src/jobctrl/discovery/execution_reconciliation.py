"""Reconcile pre-lineage Discover histories into the durable execution model.

This module is deliberately a write-side repair controller.  It reads one exact
Temporal workflow/run history and append-only discovery evidence; it never uses
global worker telemetry to attribute work to an execution.  Activities that
already carry ``discovery_execution`` are ignored because their normal activity
lifecycle owns those rows and events.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from collections import defaultdict
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import asdict, dataclass, is_dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from jobctrl.database import get_connection
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.events.operations import (
    PipelineStepCompletedPayload,
    PipelineStepDetailCode,
    PipelineStepFailedPayload,
    PipelineStepKind,
    PipelineStepQueuedPayload,
    PipelineStepSafeDetail,
    PipelineStepStartedPayload,
    create_pipeline_step_completed,
    create_pipeline_step_failed,
    create_pipeline_step_queued,
    create_pipeline_step_started,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.discovery.sqlite_execution_repository import (
    SqliteDiscoveryExecutionRepository,
)
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.state import record_job_event

log = logging.getLogger(__name__)

_DISCOVERY_ACTIVITY_TYPES = frozenset(
    {
        "plan_discovery_sources",
        "discovery_source_family",
        "discovery_enrichment",
        "discovery_preparation_fanout",
    }
)
_STEP_ORDER = ("score", "tailor", "cover", "pdf")
_DECODER_VERSION = 2
_LEGACY_WORK_PLAN_REASON_CODE = "legacy_history_recovery"
_HISTORY_READ_ERROR_CODE = "temporal-history-read-failed"


class LegacyDiscoveryRecoveryError(RuntimeError):
    """A retryable refusal to invent ambiguous legacy execution lineage."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class LegacyActivityAttempt:
    scheduled_event_id: int
    activity_type: str
    payload: dict[str, Any]
    result: dict[str, Any]
    queued_at: str | None
    started_at: str | None
    finished_at: str | None
    attempt: int
    state: Literal["queued", "running", "succeeded", "failed"]
    error_code: str = "activity_failed"
    retryable: bool = True


@dataclass(frozen=True)
class LegacyStep:
    scheduled_event_id: int
    step_kind: PipelineStepKind
    item_key: str
    detail_code: PipelineStepDetailCode
    item_count: int | None
    queued_at: str | None
    started_at: str | None
    finished_at: str | None
    attempt: int
    state: Literal["queued", "running", "succeeded", "failed"]
    error_code: str
    retryable: bool


@dataclass(frozen=True)
class ReconciliationResult:
    workflow_id: str
    temporal_run_id: str
    activities_recovered: int = 0
    jobs_linked: int = 0
    work_plans_recovered: int = 0
    skipped_native_activities: int = 0


def decode_legacy_discovery_history_v1(
    records: Sequence[Mapping[str, Any]],
) -> tuple[list[LegacyActivityAttempt], int]:
    """Decode the version-1 normalized Temporal history representation.

    The normalized form is intentionally small and stable so fixtures do not
    depend on Temporal protobuf internals. Queued and running attempts are
    retained so live work is represented before it finishes. Temporal records
    one scheduled timestamp for the logical activity, not for each retry. A
    later attempt therefore retains its exact attempt number/start/finish while
    leaving ``queued_at`` absent rather than inventing a retry queue time.
    """

    scheduled: dict[int, Mapping[str, Any]] = {}
    started: dict[int, list[tuple[int, Mapping[str, Any]]]] = defaultdict(list)
    terminal: dict[int, list[tuple[int, Mapping[str, Any]]]] = defaultdict(list)
    for position, record in enumerate(records):
        kind = str(record.get("kind") or "")
        if kind == "scheduled":
            scheduled[int(record["event_id"])] = record
        elif kind == "started":
            started[int(record["scheduled_event_id"])].append((position, record))
        elif kind in {"completed", "failed"}:
            terminal[int(record["scheduled_event_id"])].append((position, record))

    attempts: list[LegacyActivityAttempt] = []
    skipped_native = 0
    for scheduled_event_id, scheduled_record in sorted(scheduled.items()):
        activity_type = str(scheduled_record.get("activity_type") or "")
        if activity_type not in _DISCOVERY_ACTIVITY_TYPES:
            continue
        payload = _mapping(scheduled_record.get("payload"))
        if _first(payload, "discovery_execution", "discoveryExecution") is not None:
            skipped_native += 1
            continue
        started_entry = started.get(scheduled_event_id, [])[-1:]
        started_position, started_record = (
            started_entry[0] if started_entry else (-1, None)
        )
        terminal_record = _terminal_record_for_started(
            started_position,
            started_record,
            terminal.get(scheduled_event_id, []),
        )
        attempt = _safe_positive_int(
            started_record.get("attempt") if started_record is not None else None,
            1,
        )
        attempts.append(
            LegacyActivityAttempt(
                scheduled_event_id=scheduled_event_id,
                activity_type=activity_type,
                payload=payload,
                result=_mapping(terminal_record.get("result")) if terminal_record else {},
                queued_at=(
                    str(scheduled_record.get("event_time") or "")
                    if attempt == 1
                    else None
                ),
                started_at=(str(started_record.get("event_time") or "") if started_record else None),
                finished_at=(str(terminal_record.get("event_time") or "") if terminal_record else None),
                attempt=attempt,
                state=(
                    "queued"
                    if started_record is None
                    else "running"
                    if terminal_record is None
                    else "succeeded"
                    if terminal_record.get("kind") == "completed"
                    else "failed"
                ),
                error_code=_safe_error_code(terminal_record.get("error_code") if terminal_record else None),
                retryable=bool(terminal_record.get("retryable", True)) if terminal_record else True,
            )
        )
    return attempts, skipped_native


def _terminal_record_for_started(
    started_position: int,
    started_record: Mapping[str, Any] | None,
    terminals: Sequence[tuple[int, Mapping[str, Any]]],
) -> Mapping[str, Any] | None:
    """Return only a terminal proven to belong to the selected start attempt."""

    if started_record is None:
        return None
    started_event_id = _safe_int(started_record.get("history_event_id"))
    candidates: list[Mapping[str, Any]] = []
    for terminal_position, terminal_record in terminals:
        terminal_started_event_id = _safe_int(
            terminal_record.get("started_event_id")
        )
        if terminal_started_event_id:
            if started_event_id and terminal_started_event_id == started_event_id:
                candidates.append(terminal_record)
            continue
        # Older normalized fixtures did not retain started_event_id. Temporal
        # lifecycle order is still sufficient: a terminal for this latest start
        # must appear after it, never before a later retry has started.
        if terminal_position > started_position:
            candidates.append(terminal_record)
    return candidates[-1] if candidates else None


def legacy_steps_v1(attempts: Sequence[LegacyActivityAttempt]) -> list[LegacyStep]:
    """Map decoded legacy activities to the current pipeline-step contract."""

    enrichment_pass = 0
    fanout_pass = 0
    result: list[LegacyStep] = []
    for activity in attempts:
        payload = activity.payload
        output = activity.result
        if activity.activity_type == "plan_discovery_sources":
            step_kind: PipelineStepKind = "source_planning"
            item_key = "plan"
            detail_code: PipelineStepDetailCode = "source_plan"
            item_count = len(_string_list(_first(output, "families")))
        elif activity.activity_type == "discovery_source_family":
            family = str(_first(payload, "family") or "").strip().lower()
            if not family:
                raise LegacyDiscoveryRecoveryError("source_family_missing")
            step_kind = "source_family"
            item_key = f"family:{family}"
            detail_code = "source_family"
            item_count = 1
        elif activity.activity_type == "discovery_enrichment":
            step_kind = "enrichment_pass"
            if _safe_int(_first(payload, "progress_total", "progressTotal")) == 0:
                enrichment_pass += 1
                item_key = f"streaming:pass-{enrichment_pass}"
                detail_code = "streaming_pass"
            else:
                item_key = "terminal"
                detail_code = "terminal_reconciliation"
            item_count = _safe_int(_first(output, "passes"))
        else:
            include_tailor = bool(_first(payload, "include_pending_tailor", "includePendingTailor"))
            progress_total = _safe_int(_first(payload, "progress_total", "progressTotal"))
            if include_tailor and progress_total == 0:
                step_kind = "existing_backlog_sweep"
                item_key = "existing_backlog"
                detail_code = "existing_backlog"
            elif progress_total == 0:
                fanout_pass += 1
                step_kind = "preparation_fanout"
                item_key = f"streaming:pass-{fanout_pass}"
                detail_code = "streaming_pass"
            else:
                step_kind = "preparation_fanout"
                item_key = "terminal"
                detail_code = "terminal_reconciliation"
            item_count = _safe_int(_first(output, "targets"))
        result.append(
            LegacyStep(
                scheduled_event_id=activity.scheduled_event_id,
                step_kind=step_kind,
                item_key=item_key,
                detail_code=detail_code,
                item_count=item_count,
                queued_at=activity.queued_at,
                started_at=activity.started_at,
                finished_at=activity.finished_at,
                attempt=activity.attempt,
                state=activity.state,
                error_code=activity.error_code,
                retryable=activity.retryable,
            )
        )
    return result


def _native_step_keys_v1(
    records: Sequence[Mapping[str, Any]],
    *,
    tenant_id: str,
    workflow_id: str,
    temporal_run_id: str,
) -> set[tuple[str, str]]:
    """Derive the exact step identities claimed by native activity inputs."""

    enrichment_pass = 0
    fanout_pass = 0
    keys: set[tuple[str, str]] = set()
    for record in records:
        if record.get("kind") != "scheduled":
            continue
        activity_type = str(record.get("activity_type") or "")
        if activity_type not in _DISCOVERY_ACTIVITY_TYPES:
            continue
        payload = _mapping(record.get("payload"))
        execution = _mapping(_first(payload, "discovery_execution", "discoveryExecution"))
        if not execution:
            continue
        if (
            str(_first(execution, "tenant_id", "tenantId") or "") != tenant_id
            or str(_first(execution, "workflow_id", "workflowId") or "") != workflow_id
            or str(_first(execution, "temporal_run_id", "temporalRunId") or "") != temporal_run_id
        ):
            raise LegacyDiscoveryRecoveryError("native_execution_reference_mismatch")
        if activity_type == "plan_discovery_sources":
            keys.add(("source_planning", "plan"))
        elif activity_type == "discovery_source_family":
            family = str(_first(payload, "family") or "").strip().lower()
            if not family:
                raise LegacyDiscoveryRecoveryError("source_family_missing")
            keys.add(("source_family", f"family:{family}"))
        elif activity_type == "discovery_enrichment":
            item_key = str(_first(payload, "pipeline_step_item_key", "pipelineStepItemKey") or "")
            if not item_key:
                if _safe_int(_first(payload, "progress_total", "progressTotal")) == 0:
                    enrichment_pass += 1
                    item_key = f"streaming:pass-{enrichment_pass}"
                else:
                    item_key = "terminal"
            keys.add(("enrichment_pass", item_key))
        else:
            step_kind = str(_first(payload, "pipeline_step_kind", "pipelineStepKind") or "")
            item_key = str(_first(payload, "pipeline_step_item_key", "pipelineStepItemKey") or "")
            if not step_kind:
                step_kind = (
                    "existing_backlog_sweep"
                    if str(_first(payload, "cohort_kind", "cohortKind") or "") == "existing_backlog"
                    else "preparation_fanout"
                )
            if not item_key:
                if step_kind == "existing_backlog_sweep":
                    item_key = "existing_backlog"
                elif _safe_int(_first(payload, "progress_total", "progressTotal")) == 0:
                    fanout_pass += 1
                    item_key = f"streaming:pass-{fanout_pass}"
                else:
                    item_key = "terminal"
            keys.add((step_kind, item_key))
    return keys


async def reconcile_legacy_discovery_execution(
    temporal_client: Any,
    *,
    workflow_id: str,
    temporal_run_id: str,
    tenant_id: str = str(LOCAL_TENANT),
    conn: Any | None = None,
) -> ReconciliationResult:
    """Reconcile one exact Discover execution, merging partial legacy state."""

    if not workflow_id or not temporal_run_id:
        raise ValueError("exact Discover workflow and Temporal run ids are required")
    connection = conn or get_connection()
    _ensure_recovery_manifest_table(connection)
    execution = DiscoveryExecutionRef(
        tenant_id=tenant_id,
        workflow_id=workflow_id,
        temporal_run_id=temporal_run_id,
    )
    repository = SqliteDiscoveryExecutionRepository(connection)
    current_manifest = connection.execute(
        """
        SELECT * FROM discovery_execution_recoveries
        WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
        """,
        (tenant_id, workflow_id, temporal_run_id),
    ).fetchone()
    current_manifest_was_verified = (
        current_manifest is not None
        and _recovery_manifest_matches_persisted_keys(
            connection,
            tenant_id=tenant_id,
            workflow_id=workflow_id,
            temporal_run_id=temporal_run_id,
        )
    )
    _transition_existing_recovery_manifest(
        connection,
        execution,
        state="recovering",
    )
    try:
        handle = temporal_client.get_workflow_handle(workflow_id, run_id=temporal_run_id)
        normalized = await _normalize_temporal_history(handle, temporal_client.data_converter)
    except Exception:
        _transition_existing_recovery_manifest(
            connection,
            execution,
            state="retrying",
            error_code=_HISTORY_READ_ERROR_CODE,
        )
        raise
    history_event_id = max((_safe_int(record.get("history_event_id")) for record in normalized), default=0)
    history_snapshot_at = max((str(record.get("event_time") or "") for record in normalized), default="")
    existing_membership_keys = _persisted_membership_keys(connection, tenant_id, workflow_id, temporal_run_id)
    existing_step_keys = _persisted_step_keys(connection, tenant_id, workflow_id, temporal_run_id)
    if (
        current_manifest is not None
        and str(current_manifest["state"]) == "ready"
        and current_manifest_was_verified
        and int(current_manifest["decoder_version"]) == _DECODER_VERSION
        and int(current_manifest["history_event_id"]) >= history_event_id
        and _recovery_manifest_snapshot_matches_keys(
            current_manifest,
            existing_membership_keys,
            existing_step_keys,
        )
    ):
        _transition_existing_recovery_manifest(
            connection,
            execution,
            state="ready",
            updated_at=str(current_manifest["updated_at"]),
        )
        return ReconciliationResult(
            workflow_id=workflow_id,
            temporal_run_id=temporal_run_id,
        )
    has_legacy_input = any(
        record.get("kind") == "scheduled"
        and str(record.get("activity_type") or "") in _DISCOVERY_ACTIVITY_TYPES
        and not _mapping(
            _first(
                _mapping(record.get("payload")),
                "discovery_execution",
                "discoveryExecution",
            )
        )
        for record in normalized
    )
    mode: Literal["native", "reconstructed"] = "reconstructed" if has_legacy_input else "native"
    preliminary_digest = _recovery_key_digest(existing_membership_keys, existing_step_keys)
    _write_recovery_manifest(
        connection,
        execution,
        state="recovering",
        mode=mode,
        history_event_id=history_event_id,
        expected_memberships=len(existing_membership_keys),
        persisted_memberships=len(existing_membership_keys),
        expected_steps=len(existing_step_keys),
        persisted_steps=len(existing_step_keys),
        key_digest=preliminary_digest,
    )
    try:
        attempts, skipped_native = decode_legacy_discovery_history_v1(normalized)
        terminal_failed_fanout = any(
            attempt.activity_type == "discovery_preparation_fanout"
            and attempt.state == "failed"
            and not attempt.retryable
            for attempt in attempts
        )
        legacy_recovery_pending = any(
            attempt.state in {"queued", "running"}
            or (attempt.state == "failed" and attempt.retryable)
            for attempt in attempts
        )
        native_step_keys = _native_step_keys_v1(
            normalized,
            tenant_id=tenant_id,
            workflow_id=workflow_id,
            temporal_run_id=temporal_run_id,
        )
        source_memberships = _exact_source_memberships(
            connection,
            attempts,
            tenant_id=tenant_id,
            until_at=history_snapshot_at,
        )
        observed_urls = set(source_memberships)
        fanout_attempts = [attempt for attempt in attempts if attempt.activity_type == "discovery_preparation_fanout"]
        work_plans = (
            _exact_legacy_work_plans(
                connection,
                fanout_attempts,
                tenant_id=tenant_id,
            )
            if fanout_attempts
            else {}
        )
        steps = legacy_steps_v1(attempts)
    except Exception as exc:
        _write_recovery_manifest(
            connection,
            execution,
            state="retrying",
            mode=mode,
            history_event_id=history_event_id,
            expected_memberships=len(existing_membership_keys),
            persisted_memberships=len(existing_membership_keys),
            expected_steps=len(existing_step_keys),
            persisted_steps=len(existing_step_keys),
            key_digest=preliminary_digest,
            error_code=(exc.code if isinstance(exc, LegacyDiscoveryRecoveryError) else "recovery_internal_error"),
        )
        raise
    expected_membership_keys = existing_membership_keys | observed_urls | set(work_plans)
    expected_step_keys = existing_step_keys | native_step_keys | {(step.step_kind, step.item_key) for step in steps}
    key_digest = _recovery_key_digest(expected_membership_keys, expected_step_keys)
    _write_recovery_manifest(
        connection,
        execution,
        state="recovering",
        mode=mode,
        history_event_id=history_event_id,
        expected_memberships=len(expected_membership_keys),
        persisted_memberships=len(existing_membership_keys),
        expected_steps=len(expected_step_keys),
        persisted_steps=len(existing_step_keys),
        key_digest=key_digest,
    )

    linked = 0
    planned = 0
    recovered_events = 0
    try:
        for job_url in sorted(set(work_plans) - observed_urls):
            if repository.get(execution, job_url) is None:
                repository.link_job(
                    execution,
                    job_url,
                    cohort_kind="existing_backlog",
                    linked_at=history_snapshot_at,
                )
                linked += 1

        for job_url, source in sorted(source_memberships.items()):
            existing = repository.get(execution, job_url)
            if existing is None:
                repository.link_job(
                    execution,
                    job_url,
                    cohort_kind="observed_this_run",
                    source_family=source[0],
                    source_run_id=source[1],
                    linked_at=source[2],
                )
                linked += 1
            elif existing.cohort_kind != "observed_this_run":
                repository.link_job(
                    execution,
                    job_url,
                    cohort_kind="observed_this_run",
                    source_family=source[0],
                    source_run_id=source[1],
                    linked_at=source[2],
                )

        for job_url, (preparation_workflow_id, required_steps) in sorted(work_plans.items()):
            membership = repository.get(execution, job_url)
            if membership is None:
                raise LegacyDiscoveryRecoveryError("work_plan_membership_missing")
            if membership.work_plan_state == "pending":
                repository.set_work_plan(
                    execution,
                    job_url,
                    state="planned",
                    required_steps=required_steps,
                    preparation_workflow_id=preparation_workflow_id,
                    reason=_LEGACY_WORK_PLAN_REASON_CODE,
                )
                planned += 1
            elif (
                membership.work_plan_state != "planned"
                or membership.preparation_workflow_id != preparation_workflow_id
                or tuple(membership.required_steps or ()) != tuple(required_steps)
            ):
                raise LegacyDiscoveryRecoveryError("existing_work_plan_conflict")

        for step in steps:
            recovered_events += _append_missing_step_events(connection, execution, step)
        connection.commit()
        ProjectionBuilder(
            conn_factory=get_connection if conn is None else (lambda: connection),
            tenant_id=TenantId(tenant_id),
        ).refresh()
        persisted_membership_keys = _persisted_membership_keys(connection, tenant_id, workflow_id, temporal_run_id)
        persisted_step_keys = _persisted_step_keys(connection, tenant_id, workflow_id, temporal_run_id)
        if persisted_membership_keys != expected_membership_keys or persisted_step_keys != expected_step_keys:
            raise LegacyDiscoveryRecoveryError("recovery_manifest_set_mismatch")
        final_state: Literal["ready", "recovering", "incomplete"] = (
            "incomplete"
            if terminal_failed_fanout
            else "recovering"
            if legacy_recovery_pending
            else "ready"
        )
        _write_recovery_manifest(
            connection,
            execution,
            state=final_state,
            mode=mode,
            history_event_id=history_event_id,
            expected_memberships=len(expected_membership_keys),
            persisted_memberships=len(persisted_membership_keys),
            expected_steps=len(expected_step_keys),
            persisted_steps=len(persisted_step_keys),
            key_digest=key_digest,
            error_code=(
                "legacy-fanout-terminal-failed"
                if terminal_failed_fanout
                else None
            ),
        )
    except Exception as exc:
        _write_recovery_manifest(
            connection,
            execution,
            state="retrying",
            mode=mode,
            history_event_id=history_event_id,
            expected_memberships=len(expected_membership_keys),
            persisted_memberships=_persisted_membership_count(connection, tenant_id, workflow_id, temporal_run_id),
            expected_steps=len(expected_step_keys),
            persisted_steps=len(_persisted_step_keys(connection, tenant_id, workflow_id, temporal_run_id)),
            key_digest=key_digest,
            error_code=(exc.code if isinstance(exc, LegacyDiscoveryRecoveryError) else "recovery_internal_error"),
        )
        raise
    return ReconciliationResult(
        workflow_id=workflow_id,
        temporal_run_id=temporal_run_id,
        activities_recovered=recovered_events,
        jobs_linked=linked,
        work_plans_recovered=planned,
        skipped_native_activities=skipped_native,
    )


async def _normalize_temporal_history(handle: Any, converter: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    async for event in _history_events(handle):
        kind = event.WhichOneof("attributes")
        event_time = _timestamp(event.event_time)
        if kind == "activity_task_scheduled_event_attributes":
            attrs = event.activity_task_scheduled_event_attributes
            records.append(
                {
                    "kind": "scheduled",
                    "history_event_id": int(event.event_id),
                    "event_id": int(event.event_id),
                    "event_time": event_time,
                    "activity_type": str(attrs.activity_type.name),
                    "payload": await _decode_payloads(converter, attrs.input),
                }
            )
        elif kind == "activity_task_started_event_attributes":
            attrs = event.activity_task_started_event_attributes
            records.append(
                {
                    "kind": "started",
                    "history_event_id": int(event.event_id),
                    "scheduled_event_id": int(attrs.scheduled_event_id),
                    "event_time": event_time,
                    "attempt": int(attrs.attempt or 1),
                }
            )
        elif kind in {
            "activity_task_completed_event_attributes",
            "activity_task_failed_event_attributes",
            "activity_task_timed_out_event_attributes",
            "activity_task_canceled_event_attributes",
        }:
            attrs = getattr(event, kind)
            completed = kind == "activity_task_completed_event_attributes"
            canceled = kind == "activity_task_canceled_event_attributes"
            failure = None if completed else getattr(attrs, "failure", None)
            records.append(
                {
                    "kind": "completed" if completed else "failed",
                    "history_event_id": int(event.event_id),
                    "scheduled_event_id": int(attrs.scheduled_event_id),
                    "started_event_id": _safe_int(
                        getattr(attrs, "started_event_id", 0)
                    ),
                    "event_time": event_time,
                    "result": (await _decode_payloads(converter, attrs.result) if completed else {}),
                    "error_code": (
                        "activity_canceled" if canceled else _failure_code(failure)
                    ),
                    "retryable": _failure_retryable(
                        failure,
                        _safe_int(getattr(attrs, "retry_state", 0)),
                        canceled=canceled,
                    ),
                }
            )
        else:
            # Retain every Temporal event id as the inspected watermark even
            # when that event does not contribute a discovery activity record.
            records.append(
                {
                    "kind": "watermark",
                    "history_event_id": int(event.event_id),
                    "event_time": event_time,
                }
            )
    return records


async def _history_events(handle: Any) -> AsyncIterator[Any]:
    async for event in handle.fetch_history_events(wait_new_event=False):
        yield event


async def _decode_payloads(converter: Any, payloads: Any) -> dict[str, Any]:
    raw = list(getattr(payloads, "payloads", ()) or ())
    if not raw:
        return {}
    decoded = await converter.decode(raw)
    return _mapping(decoded[0] if decoded else None)


def _exact_source_memberships(
    conn: Any,
    attempts: Sequence[LegacyActivityAttempt],
    *,
    tenant_id: str,
    until_at: str,
) -> dict[str, tuple[str, str, str]]:
    by_job: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    source_attempts = [a for a in attempts if a.activity_type == "discovery_source_family"]
    for activity in source_attempts:
        family = str(_first(activity.payload, "family") or "").strip().lower()
        source_ids = set(_string_list(_first(activity.result, "source_ids", "sourceIds")))
        if not source_ids:
            source_ids = set(_string_list(_first(activity.payload, "source_ids", "sourceIds")))
        if not source_ids:
            continue
        activity_started_at = activity.started_at or activity.queued_at
        activity_until_at = activity.finished_at or until_at
        candidates = []
        for row in conn.execute(
            """
            SELECT run_id, source_ids_json, started_at, completed_at, failed_at
            FROM discovery_runs
            WHERE tenant_id = ? AND started_at >= ? AND started_at <= ?
            """,
            (tenant_id, activity_started_at, activity_until_at),
        ).fetchall():
            stored_sources = set(_json_string_list(row["source_ids_json"]))
            terminal_at = str(row["completed_at"] or row["failed_at"] or "")
            if stored_sources == source_ids and (not terminal_at or terminal_at <= activity_until_at):
                candidates.append(str(row["run_id"]))
        if len(candidates) != 1:
            raise LegacyDiscoveryRecoveryError("source_run_mapping_not_unique")
        source_run_id = candidates[0]
        for row in conn.execute(
            """
            SELECT payload_json, occurred_at FROM job_events
            WHERE event_type = 'JobSourceObserved' AND occurred_at >= ? AND occurred_at <= ?
            ORDER BY event_id
            """,
            (activity_started_at, activity_until_at),
        ).fetchall():
            payload = _json_mapping(row["payload_json"])
            payload_tenant = str(_first(payload, "tenant_id", "tenantId") or "local")
            if payload_tenant != tenant_id:
                continue
            if str(_first(payload, "run_id", "runId") or "") != source_run_id:
                continue
            source_id = str(_first(payload, "source_id", "sourceId") or "")
            job_url = str(_first(payload, "job_id", "jobId", "job_url", "jobUrl") or "")
            if source_id not in source_ids or not job_url:
                raise LegacyDiscoveryRecoveryError("source_observation_set_mismatch")
            by_job[job_url].append((family, source_run_id, str(row["occurred_at"])))
    result: dict[str, tuple[str, str, str]] = {}
    for job_url, matches in by_job.items():
        distinct = list(dict.fromkeys(matches))
        # A canonical job can be observed by multiple source families. Preserve
        # its earliest append-only observation as the stable membership
        # provenance; later observations remain in the audit stream.
        result[job_url] = min(distinct, key=lambda item: (item[2], item[0], item[1]))
    return result


def _exact_legacy_work_plans(
    conn: Any,
    fanout_attempts: Sequence[LegacyActivityAttempt],
    *,
    tenant_id: str,
) -> dict[str, tuple[str, tuple[str, ...]]]:
    if not fanout_attempts:
        return {}
    start_events = _exact_preparation_start_events(conn, tenant_id=tenant_id)
    causal_job_urls: dict[tuple[str, str], set[str]] = defaultdict(set)
    for attempt in fanout_attempts:
        if attempt.state not in {"succeeded", "failed"} or attempt.started_at is None or attempt.finished_at is None:
            raise LegacyDiscoveryRecoveryError("preparation_fanout_not_terminal")
        started_at = _strict_datetime(attempt.started_at)
        finished_at = _strict_datetime(attempt.finished_at)
        if finished_at < started_at:
            raise LegacyDiscoveryRecoveryError("preparation_fanout_interval_invalid")
        pass_workflow_ids: set[str] = set()
        pass_executions: set[tuple[str, str]] = set()
        for occurred_at, workflow_id, temporal_run_id, summary in start_events:
            if not _is_preparation_dispatch_summary(summary):
                continue
            occurred = _strict_datetime(occurred_at)
            if occurred < started_at or occurred > finished_at:
                continue
            pass_workflow_ids.add(workflow_id)
            execution_key = (workflow_id, temporal_run_id)
            pass_executions.add(execution_key)
            causal_job_urls[execution_key].add(str(_first(summary, "job_url", "jobUrl") or ""))
        if attempt.state == "succeeded":
            target_count = _strict_nonnegative_int(_first(attempt.result, "targets"))
            if target_count is None or len(pass_workflow_ids) != target_count or len(pass_executions) != target_count:
                raise LegacyDiscoveryRecoveryError("preparation_fanout_target_set_mismatch")

    candidates: dict[str, list[tuple[str, tuple[str, ...]]]] = defaultdict(list)
    for (workflow_id, temporal_run_id), dispatch_job_urls in sorted(causal_job_urls.items()):
        if len(dispatch_job_urls) != 1 or not next(iter(dispatch_job_urls)):
            raise LegacyDiscoveryRecoveryError("preparation_summary_not_deterministic")
        plans = {
            decoded
            for _occurred_at, event_workflow_id, event_run_id, summary in start_events
            if event_workflow_id == workflow_id and event_run_id == temporal_run_id
            if (decoded := _decode_full_legacy_preparation_summary(workflow_id, summary)) is not None
        }
        if len(plans) != 1:
            raise LegacyDiscoveryRecoveryError("preparation_summary_not_deterministic")
        job_url, steps = next(iter(plans))
        if job_url != next(iter(dispatch_job_urls)):
            raise LegacyDiscoveryRecoveryError("preparation_summary_not_deterministic")
        candidates[job_url].append((workflow_id, steps))
    if any(len(set(values)) != 1 for values in candidates.values()):
        raise LegacyDiscoveryRecoveryError("preparation_work_plan_set_mismatch")
    return {job_url: list(dict.fromkeys(values))[0] for job_url, values in candidates.items()}


def _exact_preparation_start_events(
    conn: Any,
    *,
    tenant_id: str,
) -> list[tuple[str, str, str, dict[str, Any]]]:
    """Read append-only preparation start evidence without using projections.

    ``default_workflow_starter`` emits a job-only marker synchronously inside
    the fanout activity. The preparation workflow later emits its full input
    summary. Both remain in the canonical workflow event stream even when the
    folded projection retains only a later job-only marker.
    """

    events: list[tuple[str, str, str, dict[str, Any]]] = []
    for row in conn.execute(
        """
        SELECT occurred_at, payload_json FROM job_events
        WHERE event_type = 'WorkflowStarted'
        ORDER BY event_id
        """
    ).fetchall():
        payload = _json_mapping(row["payload_json"])
        if str(_first(payload, "tenant_id", "tenantId") or "local") != tenant_id:
            continue
        if str(_first(payload, "workflow_type", "workflowType") or "") != "JobPreparationWorkflow":
            continue
        workflow_id = str(_first(payload, "workflow_id", "workflowId") or "")
        temporal_run_id = str(_first(payload, "temporal_run_id", "temporalRunId") or "")
        summary = _mapping(_first(payload, "input_summary", "inputSummary"))
        occurred_at = str(row["occurred_at"] or "")
        if workflow_id and temporal_run_id and summary and occurred_at:
            events.append((occurred_at, workflow_id, temporal_run_id, summary))
    return events


def _decode_full_legacy_preparation_summary(
    workflow_id: str,
    summary: Mapping[str, Any],
) -> tuple[str, tuple[str, ...]] | None:
    """Return one full legacy plan, ignoring known dispatch/native summaries."""

    if _is_preparation_dispatch_summary(summary):
        return None
    if _first(summary, "discovery_execution", "discoveryExecution") is not None:
        return None
    job_url = str(_first(summary, "job_url", "jobUrl") or "")
    raw_steps = _first(summary, "steps")
    idem = str(_first(summary, "idempotency_key", "idempotencyKey") or "")
    if not job_url or not isinstance(raw_steps, (list, tuple)) or not idem:
        raise LegacyDiscoveryRecoveryError("preparation_summary_not_deterministic")
    requested_steps = _string_list(raw_steps)
    if not requested_steps or any(step not in _STEP_ORDER for step in requested_steps) or workflow_id != f"prep-{idem}":
        raise LegacyDiscoveryRecoveryError("preparation_summary_not_deterministic")
    return job_url, tuple(step for step in _STEP_ORDER if step in requested_steps)


def _is_preparation_dispatch_summary(summary: Mapping[str, Any]) -> bool:
    job_url = str(_first(summary, "job_url", "jobUrl") or "")
    return bool(job_url) and set(summary) in ({"jobUrl"}, {"job_url"})


def _append_missing_step_events(
    conn: Any,
    execution: DiscoveryExecutionRef,
    step: LegacyStep,
) -> int:
    tenant = TenantId(execution.tenant_id)
    detail = PipelineStepSafeDetail(code=step.detail_code, item_count=step.item_count)
    events = []
    if step.queued_at is not None:
        events.append(
            create_pipeline_step_queued(
                tenant,
                PipelineStepQueuedPayload(
                    execution=execution,
                    step_kind=step.step_kind,
                    item_key=step.item_key,
                    attempt=step.attempt,
                    queued_at=step.queued_at,
                    detail=detail,
                ),
            )
        )
    elif step.state == "queued":
        raise LegacyDiscoveryRecoveryError("queued_step_timestamp_missing")
    if step.state != "queued":
        if step.started_at is None:
            raise LegacyDiscoveryRecoveryError("started_step_timestamp_missing")
        events.append(
            create_pipeline_step_started(
                tenant,
                PipelineStepStartedPayload(
                    execution=execution,
                    step_kind=step.step_kind,
                    item_key=step.item_key,
                    attempt=step.attempt,
                    started_at=step.started_at,
                    detail=detail,
                ),
            )
        )
    if step.state in {"succeeded", "failed"} and step.finished_at is None:
        raise LegacyDiscoveryRecoveryError("terminal_step_timestamp_missing")
    duration_ms = (
        _duration_ms(step.started_at, step.finished_at)
        if step.started_at is not None and step.finished_at is not None
        else None
    )
    if step.state == "succeeded":
        events.append(
            create_pipeline_step_completed(
                tenant,
                PipelineStepCompletedPayload(
                    execution=execution,
                    step_kind=step.step_kind,
                    item_key=step.item_key,
                    attempt=step.attempt,
                    completed_at=step.finished_at,
                    duration_ms=duration_ms,
                    detail=detail,
                ),
            )
        )
    elif step.state == "failed":
        events.append(
            create_pipeline_step_failed(
                tenant,
                PipelineStepFailedPayload(
                    execution=execution,
                    step_kind=step.step_kind,
                    item_key=step.item_key,
                    attempt=step.attempt,
                    failed_at=step.finished_at,
                    duration_ms=duration_ms,
                    error_code=step.error_code,
                    retryable=step.retryable,
                    detail=detail,
                ),
            )
        )
    written = 0
    for event in events:
        if _step_event_exists(conn, event.event_type, dict(event.payload)):
            continue
        record_job_event(
            conn,
            None,
            "workflow",
            event.event_type,
            payload={**dict(event.payload), "recoveredFromLegacyHistory": True},
            occurred_at=event.occurred_at,
        )
        written += 1
    return written


def _step_event_exists(conn: Any, event_type: str, payload: dict[str, Any]) -> bool:
    execution = _mapping(payload.get("execution"))
    rows = conn.execute(
        "SELECT payload_json FROM job_events WHERE event_type = ? AND stage = 'workflow'",
        (event_type,),
    ).fetchall()
    for row in rows:
        existing = _json_mapping(row["payload_json"])
        existing_execution = _mapping(existing.get("execution"))
        if (
            existing_execution == execution
            and existing.get("stepKind") == payload.get("stepKind")
            and existing.get("itemKey") == payload.get("itemKey")
            and existing.get("attempt") == payload.get("attempt")
        ):
            return True
    return False


def _ensure_recovery_manifest_table(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS discovery_execution_recoveries (
            tenant_id                   TEXT NOT NULL,
            discover_workflow_id        TEXT NOT NULL,
            discover_run_id             TEXT NOT NULL,
            state                       TEXT NOT NULL
                CHECK (state IN ('recovering', 'ready', 'retrying', 'incomplete')),
            mode                        TEXT NOT NULL
                CHECK (mode IN ('native', 'reconstructed')),
            decoder_version             INTEGER NOT NULL,
            history_event_id            INTEGER NOT NULL,
            expected_membership_count   INTEGER NOT NULL,
            persisted_membership_count  INTEGER NOT NULL,
            expected_step_count         INTEGER NOT NULL,
            persisted_step_count        INTEGER NOT NULL,
            key_digest                  TEXT NOT NULL,
            last_error_code             TEXT,
            updated_at                  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, discover_workflow_id, discover_run_id)
        )
        """
    )
    conn.commit()


def _write_recovery_manifest(
    conn: Any,
    execution: DiscoveryExecutionRef,
    *,
    state: Literal["recovering", "ready", "retrying", "incomplete"],
    mode: Literal["native", "reconstructed"],
    history_event_id: int,
    expected_memberships: int,
    persisted_memberships: int,
    expected_steps: int,
    persisted_steps: int,
    key_digest: str,
    error_code: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO discovery_execution_recoveries (
            tenant_id, discover_workflow_id, discover_run_id, state, mode,
            decoder_version, history_event_id, expected_membership_count,
            persisted_membership_count, expected_step_count,
            persisted_step_count, key_digest, last_error_code, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, discover_workflow_id, discover_run_id)
        DO UPDATE SET
            state = excluded.state,
            mode = excluded.mode,
            decoder_version = excluded.decoder_version,
            history_event_id = excluded.history_event_id,
            expected_membership_count = excluded.expected_membership_count,
            persisted_membership_count = excluded.persisted_membership_count,
            expected_step_count = excluded.expected_step_count,
            persisted_step_count = excluded.persisted_step_count,
            key_digest = excluded.key_digest,
            last_error_code = excluded.last_error_code,
            updated_at = excluded.updated_at
        WHERE excluded.history_event_id >= discovery_execution_recoveries.history_event_id
        """,
        (
            execution.tenant_id,
            execution.workflow_id,
            execution.temporal_run_id,
            state,
            mode,
            _DECODER_VERSION,
            history_event_id,
            expected_memberships,
            persisted_memberships,
            expected_steps,
            persisted_steps,
            key_digest,
            _safe_error_code(error_code) if error_code else None,
            datetime.now(UTC).isoformat(),
        ),
    )
    conn.commit()


def _transition_existing_recovery_manifest(
    conn: Any,
    execution: DiscoveryExecutionRef,
    *,
    state: Literal["recovering", "ready", "retrying", "incomplete"],
    error_code: str | None = None,
    updated_at: str | None = None,
) -> bool:
    """Change only checkpoint liveness, preserving its last verified proof."""

    cursor = conn.execute(
        """
        UPDATE discovery_execution_recoveries
        SET state = ?, last_error_code = ?, updated_at = ?
        WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
        """,
        (
            state,
            _safe_error_code(error_code) if error_code else None,
            updated_at or datetime.now(UTC).isoformat(),
            execution.tenant_id,
            execution.workflow_id,
            execution.temporal_run_id,
        ),
    )
    conn.commit()
    return bool(cursor.rowcount)


def _persisted_membership_keys(
    conn: Any,
    tenant_id: str,
    workflow_id: str,
    temporal_run_id: str,
) -> set[str]:
    return {
        str(row["job_url"])
        for row in conn.execute(
            """
            SELECT job_url FROM discovery_execution_jobs
            WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
            """,
            (tenant_id, workflow_id, temporal_run_id),
        ).fetchall()
    }


def _persisted_membership_count(
    conn: Any,
    tenant_id: str,
    workflow_id: str,
    temporal_run_id: str,
) -> int:
    return len(_persisted_membership_keys(conn, tenant_id, workflow_id, temporal_run_id))


def _persisted_step_keys(
    conn: Any,
    tenant_id: str,
    workflow_id: str,
    temporal_run_id: str,
) -> set[tuple[str, str]]:
    try:
        rows = conn.execute(
            """
            SELECT step_kind, item_key FROM pipeline_step_projections
            WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
            """,
            (tenant_id, workflow_id, temporal_run_id),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        if "no such table" not in str(exc).lower():
            raise
        return set()
    return {(str(row["step_kind"]), str(row["item_key"])) for row in rows}


def _recovery_manifest_matches_persisted_keys(
    conn: Any,
    *,
    tenant_id: str,
    workflow_id: str,
    temporal_run_id: str,
) -> bool:
    """Return whether a ready manifest still proves the current exact key sets."""

    try:
        manifest = conn.execute(
            """
            SELECT state, mode, decoder_version, history_event_id,
                   expected_membership_count, persisted_membership_count,
                   expected_step_count, persisted_step_count, key_digest,
                   updated_at
            FROM discovery_execution_recoveries
            WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
            """,
            (tenant_id, workflow_id, temporal_run_id),
        ).fetchone()
        if manifest is None:
            return False
        memberships = _persisted_membership_keys(conn, tenant_id, workflow_id, temporal_run_id)
        steps = _persisted_step_keys(conn, tenant_id, workflow_id, temporal_run_id)
        manifest_integers = {
            field: int(manifest[field])
            for field in (
                "decoder_version",
                "history_event_id",
                "expected_membership_count",
                "persisted_membership_count",
                "expected_step_count",
                "persisted_step_count",
            )
        }
    except (KeyError, TypeError, ValueError, sqlite3.OperationalError):
        return False

    membership_count = len(memberships)
    step_count = len(steps)
    return (
        str(manifest["state"]) == "ready"
        and str(manifest["mode"]) in {"native", "reconstructed"}
        and manifest_integers["decoder_version"] == _DECODER_VERSION
        and manifest_integers["history_event_id"] >= 0
        and manifest_integers["expected_membership_count"] == membership_count
        and manifest_integers["persisted_membership_count"] == membership_count
        and manifest_integers["expected_step_count"] == step_count
        and manifest_integers["persisted_step_count"] == step_count
        and str(manifest["key_digest"]) == _recovery_key_digest(memberships, steps)
        and bool(str(manifest["updated_at"] or "").strip())
    )


def _recovery_manifest_snapshot_matches_keys(
    manifest: Any,
    memberships: set[str],
    steps: set[tuple[str, str]],
) -> bool:
    """Revalidate a pre-read ready snapshot after its state was downgraded."""

    try:
        return (
            int(manifest["expected_membership_count"]) == len(memberships)
            and int(manifest["persisted_membership_count"]) == len(memberships)
            and int(manifest["expected_step_count"]) == len(steps)
            and int(manifest["persisted_step_count"]) == len(steps)
            and str(manifest["key_digest"]) == _recovery_key_digest(memberships, steps)
        )
    except (KeyError, TypeError, ValueError):
        return False


def _recovery_key_digest(
    memberships: set[str],
    steps: set[tuple[str, str]],
) -> str:
    def key_hex(value: str) -> str:
        return value.encode("utf-8").hex()

    canonical = json.dumps(
        {
            "memberships": sorted(key_hex(value) for value in memberships),
            "steps": sorted(
                key_hex(
                    json.dumps(
                        [step_kind, item_key],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                )
                for step_kind, item_key in steps
            ),
        },
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _mapping(value: object) -> dict[str, Any]:
    if is_dataclass(value) and not isinstance(value, type):
        value = asdict(value)
    return dict(value) if isinstance(value, Mapping) else {}


def _first(values: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in values:
            return values[key]
    return None


def _string_list(value: object) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [str(item) for item in value if str(item)]


def _json_mapping(value: object) -> dict[str, Any]:
    if not isinstance(value, str):
        return {}
    try:
        return _mapping(json.loads(value))
    except (TypeError, ValueError):
        return {}


def _json_string_list(value: object) -> list[str]:
    if not isinstance(value, str):
        return []
    try:
        return _string_list(json.loads(value))
    except (TypeError, ValueError):
        return []


def _safe_int(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _strict_nonnegative_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _safe_positive_int(value: object, fallback: int) -> int:
    parsed = _safe_int(value)
    return parsed if parsed > 0 else fallback


def _safe_error_code(value: object) -> str:
    candidate = str(value or "activity_failed").strip().lower().replace("_", "-")
    safe = "".join(char for char in candidate if char.isalnum() or char in ".:-")
    return (safe or "activity-failed")[:80]


def _failure_code(failure: Any) -> str:
    if failure is None:
        return "activity_failed"
    info = getattr(failure, "application_failure_info", None)
    return str(getattr(info, "type", None) or "activity_failed")


def _failure_retryable(
    failure: Any,
    retry_state: int = 0,
    *,
    canceled: bool = False,
) -> bool:
    if canceled:
        return False
    info = getattr(failure, "application_failure_info", None)
    if bool(getattr(info, "non_retryable", False)):
        return False
    # Temporal's RETRY_STATE_IN_PROGRESS (1) and INTERNAL_SERVER_ERROR (6)
    # can still produce another attempt. Other specified states are terminal.
    return retry_state in {1, 6} if retry_state else True


def _timestamp(value: Any) -> str:
    return value.ToDatetime(tzinfo=UTC).isoformat()


def _strict_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise LegacyDiscoveryRecoveryError("preparation_fanout_interval_invalid") from exc
    if parsed.tzinfo is None:
        raise LegacyDiscoveryRecoveryError("preparation_fanout_interval_invalid")
    return parsed.astimezone(UTC)


def _duration_ms(started_at: str, finished_at: str) -> int:
    start = datetime.fromisoformat(started_at)
    finish = datetime.fromisoformat(finished_at)
    return max(0, int((finish - start).total_seconds() * 1_000))


__all__ = [
    "LegacyActivityAttempt",
    "LegacyDiscoveryRecoveryError",
    "ReconciliationResult",
    "decode_legacy_discovery_history_v1",
    "legacy_steps_v1",
    "reconcile_legacy_discovery_execution",
]
