"""Authoritative exact-run quiescence checks for the stable JobId cutover.

A fence-epoch recovery proof plus independent SQLite authorities provide a
closed inventory of exact workflow identifiers. They never decide whether an
execution is open. Every candidate is checked through
``DescribeWorkflowExecution``; Temporal visibility/list APIs are intentionally
outside this module because their absence result is eventually consistent and
cannot certify quiescence.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any, Literal

from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest
from temporalio.client import WorkflowExecutionStatus
from temporalio.service import RPCError, RPCStatusCode

from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.temporal.identity_cutover_proof import (
    INVENTORY_PROOF_TABLE,
    InventoryProofIdentity,
    validate_identity_cutover_inventory_proof,
)
from jobctrl.infrastructure.temporal.registry import (
    WORKFLOW_IDENTITY_CUTOVER_POLICIES,
    WorkflowIdentityCutoverPolicy,
)
from jobctrl.infrastructure.temporal.schedule_cutover import (
    identity_bearing_schedule_policies,
)
from jobctrl.infrastructure.temporal.workflow_dispatch_control import (
    IdentityCutoverLease,
)

ExecutionState = Literal[
    "open",
    "closed",
    "not_found",
    "unavailable",
    "unknown",
]
ScheduleState = Literal[
    "paused",
    "not_found",
    "unpaused",
    "unavailable",
    "unknown",
]

_CONTROL_KEY = "stable-job-id-cutover"
_OPEN_TEMPORAL_STATES = {
    WorkflowExecutionStatus.RUNNING,
}
_CLOSED_TEMPORAL_STATES = {
    WorkflowExecutionStatus.COMPLETED,
    WorkflowExecutionStatus.FAILED,
    WorkflowExecutionStatus.CANCELED,
    WorkflowExecutionStatus.TERMINATED,
    WorkflowExecutionStatus.TIMED_OUT,
    # Every exact-run candidate also contributes a current/latest handle for
    # the same Workflow ID. The continued execution is therefore checked
    # separately; the predecessor run itself is terminal.
    WorkflowExecutionStatus.CONTINUED_AS_NEW,
}
_INVENTORY_TABLES = {
    "workflow_dispatch_control",
    "workflow_dispatch_registry",
    INVENTORY_PROOF_TABLE,
    "workflow_run_projections",
    "job_events",
    "jobs",
    "manual_capture_queue",
    "contact_research_tasks",
    "discovery_execution_jobs",
    "discovery_search_units",
    "pipeline_step_projections",
    "preparation_work_items",
}


@dataclass(frozen=True)
class WorkflowExecutionCandidate:
    workflow_type: str
    workflow_id: str
    temporal_run_id: str | None
    sources: tuple[str, ...]


@dataclass(frozen=True)
class WorkflowExecutionObservation:
    candidate: WorkflowExecutionCandidate
    state: ExecutionState
    temporal_status: str | None = None


@dataclass(frozen=True)
class ScheduleFenceObservation:
    schedule_id: str
    workflow_type: str
    state: ScheduleState


@dataclass(frozen=True)
class DurableOwnerObservation:
    source: str
    state: str
    count: int


@dataclass(frozen=True)
class IdentityCutoverBlocker:
    code: str
    source: str
    workflow_type: str | None = None
    workflow_id: str | None = None
    temporal_run_id: str | None = None
    detail: str | None = None


@dataclass(frozen=True)
class IdentityCutoverPreflightResult:
    ready: bool
    dispatch_gate_blocked: bool
    candidates: tuple[WorkflowExecutionCandidate, ...]
    executions: tuple[WorkflowExecutionObservation, ...]
    schedules: tuple[ScheduleFenceObservation, ...]
    durable_owners: tuple[DurableOwnerObservation, ...]
    blockers: tuple[IdentityCutoverBlocker, ...]


@dataclass
class _CandidateAccumulator:
    workflow_type: str
    workflow_id: str
    temporal_run_id: str | None
    sources: set[str]


@dataclass(frozen=True)
class _LocalIdentityInventory:
    dispatch_gate_blocked: bool
    fence_blocked_at: str | None
    proof_identity: InventoryProofIdentity | None
    candidates: tuple[WorkflowExecutionCandidate, ...]
    durable_owners: tuple[DurableOwnerObservation, ...]
    blockers: tuple[IdentityCutoverBlocker, ...]


async def run_identity_cutover_preflight(
    temporal_client: Any,
    *,
    db_path: Path | str,
    cutover_lease: IdentityCutoverLease,
    tenant_id: str = str(LOCAL_TENANT),
) -> IdentityCutoverPreflightResult:
    """Return readiness while the caller retains the exclusive cutover lease."""

    path = Path(db_path)
    cutover_lease.assert_active(db_path=path)
    try:
        initial = _read_local_inventory(path, tenant_id=tenant_id)
    except sqlite3.Error:
        return _result(
            gate_blocked=False,
            candidates=(),
            durable_owners=(),
            blockers=[
                IdentityCutoverBlocker(
                    code="inventory_unreadable",
                    source="sqlite",
                )
            ],
        )

    blockers = list(initial.blockers)
    if not initial.dispatch_gate_blocked:
        blockers.append(
            IdentityCutoverBlocker(
                code="dispatch_gate_open",
                source="workflow_dispatch_control",
            )
        )

    # Do not spend remote calls or imply a meaningful Temporal snapshot while
    # local membership can still grow or its inventory contract is incomplete.
    if not initial.dispatch_gate_blocked or _has_inventory_blocker(blockers):
        return _result(
            gate_blocked=initial.dispatch_gate_blocked,
            candidates=initial.candidates,
            durable_owners=initial.durable_owners,
            blockers=blockers,
        )

    if initial.proof_identity is None:
        blockers.append(
            IdentityCutoverBlocker(
                code="pre_fence_inventory_unproven",
                source=INVENTORY_PROOF_TABLE,
                detail="proof_identity_missing",
            )
        )
        return _result(
            gate_blocked=initial.dispatch_gate_blocked,
            candidates=initial.candidates,
            durable_owners=initial.durable_owners,
            blockers=blockers,
        )

    blockers.extend(
        await _validate_temporal_authority(
            temporal_client,
            proof_identity=initial.proof_identity,
        )
    )
    if blockers:
        return _result(
            gate_blocked=initial.dispatch_gate_blocked,
            candidates=initial.candidates,
            durable_owners=initial.durable_owners,
            blockers=blockers,
        )

    schedule_observations, schedule_blockers = await _observe_schedule_fences(
        temporal_client,
        tenant_id=tenant_id,
    )
    blockers.extend(schedule_blockers)

    execution_observations: list[WorkflowExecutionObservation] = []
    for candidate in initial.candidates:
        observation, blocker = await _observe_exact_execution(
            temporal_client,
            candidate,
        )
        execution_observations.append(observation)
        if blocker is not None:
            blockers.append(blocker)

    for owner in initial.durable_owners:
        blockers.append(
            IdentityCutoverBlocker(
                code="durable_owner_nonterminal",
                source=owner.source,
                detail=f"{owner.state}:{owner.count}",
            )
        )

    # An execution that was open when the local snapshot was read can finish
    # and commit new durable work before its describe call returns CLOSED.
    # Require a second identical local inventory, then repeat exact describes.
    # This turns that TOCTOU window into a retryable blocker instead of a false
    # quiescence result.
    if blockers:
        return _result(
            gate_blocked=initial.dispatch_gate_blocked,
            candidates=initial.candidates,
            executions=execution_observations,
            schedules=schedule_observations,
            durable_owners=initial.durable_owners,
            blockers=blockers,
        )

    try:
        final = _read_local_inventory(path, tenant_id=tenant_id)
    except sqlite3.Error:
        final = _unreadable_local_inventory()

    blockers.extend(final.blockers)
    if not final.dispatch_gate_blocked:
        blockers.append(
            IdentityCutoverBlocker(
                code="dispatch_gate_open",
                source="workflow_dispatch_control",
            )
        )
    if final.fence_blocked_at != initial.fence_blocked_at or final.proof_identity != initial.proof_identity:
        blockers.append(
            IdentityCutoverBlocker(
                code="cutover_proof_changed",
                source=INVENTORY_PROOF_TABLE,
            )
        )
    if final.candidates != initial.candidates or final.durable_owners != initial.durable_owners:
        blockers.append(
            IdentityCutoverBlocker(
                code="local_inventory_changed",
                source="sqlite",
            )
        )
    for owner in final.durable_owners:
        blockers.append(
            IdentityCutoverBlocker(
                code="durable_owner_nonterminal",
                source=owner.source,
                detail=f"{owner.state}:{owner.count}",
            )
        )
    if blockers:
        return _result(
            gate_blocked=final.dispatch_gate_blocked,
            candidates=final.candidates,
            schedules=schedule_observations,
            durable_owners=final.durable_owners,
            blockers=blockers,
        )

    final_schedule_observations, final_schedule_blockers = await _observe_schedule_fences(
        temporal_client,
        tenant_id=tenant_id,
    )
    blockers.extend(final_schedule_blockers)
    final_execution_observations: list[WorkflowExecutionObservation] = []
    for candidate in final.candidates:
        observation, blocker = await _observe_exact_execution(
            temporal_client,
            candidate,
        )
        final_execution_observations.append(observation)
        if blocker is not None:
            blockers.append(blocker)

    # The process handoff proof prevents supported workers from writing after
    # this boundary. Still take one final SQLite snapshot after the last remote
    # describe pass so a restarted worker, changed proof, or late activity
    # commit is observed rather than converted into a false-ready result.
    try:
        sealed = _read_local_inventory(path, tenant_id=tenant_id)
    except sqlite3.Error:
        sealed = _unreadable_local_inventory()
    blockers.extend(sealed.blockers)
    if not sealed.dispatch_gate_blocked:
        blockers.append(
            IdentityCutoverBlocker(
                code="dispatch_gate_open",
                source="workflow_dispatch_control",
            )
        )
    if sealed.fence_blocked_at != final.fence_blocked_at or sealed.proof_identity != final.proof_identity:
        blockers.append(
            IdentityCutoverBlocker(
                code="cutover_proof_changed",
                source=INVENTORY_PROOF_TABLE,
            )
        )
    if sealed.candidates != final.candidates or sealed.durable_owners != final.durable_owners:
        blockers.append(
            IdentityCutoverBlocker(
                code="local_inventory_changed",
                source="sqlite",
            )
        )
    for owner in sealed.durable_owners:
        blockers.append(
            IdentityCutoverBlocker(
                code="durable_owner_nonterminal",
                source=owner.source,
                detail=f"{owner.state}:{owner.count}",
            )
        )

    cutover_lease.assert_active(db_path=path)
    return _result(
        gate_blocked=sealed.dispatch_gate_blocked,
        candidates=sealed.candidates,
        executions=final_execution_observations,
        schedules=final_schedule_observations,
        durable_owners=sealed.durable_owners,
        blockers=blockers,
    )


def _read_local_inventory(
    path: Path,
    *,
    tenant_id: str,
) -> _LocalIdentityInventory:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return _load_local_inventory(
            conn,
            tenant_id=tenant_id,
        )
    finally:
        conn.close()


def _load_local_inventory(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
) -> _LocalIdentityInventory:
    policies = _policies_by_type()
    blockers: list[IdentityCutoverBlocker] = []
    tables = _table_names(conn)
    for table in sorted(_INVENTORY_TABLES - tables):
        blockers.append(
            IdentityCutoverBlocker(
                code="inventory_table_missing",
                source=table,
            )
        )

    gate_blocked = False
    fence_blocked_at: str | None = None
    if "workflow_dispatch_control" in tables:
        row = conn.execute(
            """
            SELECT blocked_at
            FROM workflow_dispatch_control
            WHERE control_key = ?
            """,
            (_CONTROL_KEY,),
        ).fetchone()
        gate_blocked = row is not None
        if row is not None:
            fence_blocked_at = _optional_text(row[0])

    proof_identity: InventoryProofIdentity | None = None
    if gate_blocked:
        proof = validate_identity_cutover_inventory_proof(
            conn,
            fence_blocked_at=fence_blocked_at,
        )
        if not proof.valid:
            blockers.append(
                IdentityCutoverBlocker(
                    code="pre_fence_inventory_unproven",
                    source=INVENTORY_PROOF_TABLE,
                    detail=(proof.state if proof.detail is None else f"{proof.state}:{proof.detail}"),
                )
            )
        else:
            proof_identity = proof.identity

    candidates: dict[
        tuple[str, str, str | None],
        _CandidateAccumulator,
    ] = {}

    if "workflow_dispatch_registry" in tables:
        rows = conn.execute(
            """
            SELECT workflow_type, workflow_id, temporal_run_id
            FROM workflow_dispatch_registry
            ORDER BY created_at, launch_id
            """
        ).fetchall()
        for row in rows:
            _add_registered_candidate(
                candidates,
                blockers,
                policies,
                workflow_type=str(row["workflow_type"] or ""),
                workflow_id=str(row["workflow_id"] or ""),
                temporal_run_id=_optional_text(row["temporal_run_id"]),
                source="dispatch_registry",
            )

    if "job_events" in tables:
        rows = conn.execute(
            """
            SELECT event_id, payload_json
            FROM job_events
            WHERE event_type = 'WorkflowStarted'
            ORDER BY event_id
            """
        ).fetchall()
        for row in rows:
            try:
                payload = json.loads(str(row["payload_json"] or ""))
            except (TypeError, ValueError):
                payload = None
            if not isinstance(payload, dict):
                blockers.append(_invalid_workflow_start_event(row["event_id"]))
                continue
            raw_tenant = payload.get(
                "tenantId",
                payload.get("tenant_id"),
            )
            raw_workflow_type = payload.get(
                "workflowType",
                payload.get("workflow_type"),
            )
            raw_workflow_id = payload.get(
                "workflowId",
                payload.get("workflow_id"),
            )
            raw_temporal_run_id = payload.get(
                "temporalRunId",
                payload.get("temporal_run_id"),
            )
            if (
                not isinstance(raw_tenant, str)
                or not raw_tenant.strip()
                or not isinstance(raw_workflow_type, str)
                or not raw_workflow_type.strip()
                or not isinstance(raw_workflow_id, str)
                or not raw_workflow_id.strip()
                or (raw_temporal_run_id is not None and not isinstance(raw_temporal_run_id, str))
            ):
                blockers.append(_invalid_workflow_start_event(row["event_id"]))
                continue
            event_tenant = raw_tenant.strip()
            if event_tenant != tenant_id:
                continue
            _add_registered_candidate(
                candidates,
                blockers,
                policies,
                workflow_type=raw_workflow_type.strip(),
                workflow_id=raw_workflow_id.strip(),
                temporal_run_id=_optional_text(raw_temporal_run_id),
                source="workflow_start_event",
            )

    if "workflow_run_projections" in tables:
        rows = conn.execute(
            """
            SELECT workflow_type, workflow_id, temporal_run_id
            FROM workflow_run_projections
            WHERE tenant_id = ?
            ORDER BY COALESCE(started_at, finished_at), workflow_id
            """,
            (tenant_id,),
        ).fetchall()
        for row in rows:
            _add_registered_candidate(
                candidates,
                blockers,
                policies,
                workflow_type=str(row["workflow_type"] or ""),
                workflow_id=str(row["workflow_id"] or ""),
                temporal_run_id=_optional_text(row["temporal_run_id"]),
                source="workflow_run_projection",
            )

    for schedule in identity_bearing_schedule_policies(tenant_id):
        _add_registered_candidate(
            candidates,
            blockers,
            policies,
            workflow_type=schedule.workflow_type,
            workflow_id=schedule.workflow_id,
            temporal_run_id=None,
            source="identity_schedule",
        )

    if "jobs" in tables:
        from jobctrl.workflow_specs import (
            apply_workflow_id,
            interview_prep_workflow_id,
        )

        rows = conn.execute(
            """
            SELECT job_id, url
            FROM jobs
            WHERE tenant_id = ?
            ORDER BY job_id, url
            """,
            (tenant_id,),
        ).fetchall()
        for row in rows:
            job_id = _optional_text(row["job_id"])
            posting_url = _optional_text(row["url"])
            if job_id is None or posting_url is None:
                blockers.append(
                    IdentityCutoverBlocker(
                        code="job_identity_incomplete",
                        source="job_identity_derived",
                        detail=("missing_job_id" if job_id is None else "missing_posting_url"),
                    )
                )
            for job_key in {value for value in (job_id, posting_url) if value is not None}:
                _add_registered_candidate(
                    candidates,
                    blockers,
                    policies,
                    workflow_type="ApplyWorkflow",
                    workflow_id=apply_workflow_id(tenant_id, job_key),
                    temporal_run_id=None,
                    source="job_identity_derived",
                )
                _add_registered_candidate(
                    candidates,
                    blockers,
                    policies,
                    workflow_type="InterviewPrepWorkflow",
                    workflow_id=interview_prep_workflow_id(
                        tenant_id,
                        job_key,
                    ),
                    temporal_run_id=None,
                    source="job_identity_derived",
                )

    from jobctrl.apply.auto_apply import auto_apply_workflow_id

    _add_registered_candidate(
        candidates,
        blockers,
        policies,
        workflow_type="ApplyWorkflow",
        workflow_id=auto_apply_workflow_id(tenant_id),
        temporal_run_id=None,
        source="auto_apply_loop",
    )

    if "manual_capture_queue" in tables:
        from jobctrl.discovery.manual_capture_workflow import (
            manual_capture_import_workflow_id,
        )

        rows = conn.execute(
            """
            SELECT item_id
            FROM manual_capture_queue
            WHERE tenant_id = ?
            ORDER BY item_id
            """,
            (tenant_id,),
        ).fetchall()
        for row in rows:
            item_id = _optional_text(row["item_id"])
            _add_registered_candidate(
                candidates,
                blockers,
                policies,
                workflow_type="ManualCaptureImportWorkflow",
                workflow_id=(
                    manual_capture_import_workflow_id(
                        tenant_id,
                        item_id,
                    )
                    if item_id is not None
                    else ""
                ),
                temporal_run_id=None,
                source="manual_capture_queue",
            )

    if "contact_research_tasks" in tables:
        from jobctrl.contact.workflow import (
            contact_research_workflow_id,
        )

        rows = conn.execute(
            """
            SELECT task_id
            FROM contact_research_tasks
            WHERE tenant_id = ?
            ORDER BY task_id
            """,
            (tenant_id,),
        ).fetchall()
        for row in rows:
            task_id = _optional_text(row["task_id"])
            _add_registered_candidate(
                candidates,
                blockers,
                policies,
                workflow_type="ContactResearchWorkflow",
                workflow_id=(contact_research_workflow_id(task_id) if task_id is not None else ""),
                temporal_run_id=None,
                source="contact_research_task",
            )

    if "discovery_execution_jobs" in tables:
        pending_count = int(
            conn.execute(
                """
                SELECT COUNT(*)
                FROM discovery_execution_jobs
                WHERE tenant_id = ?
                  AND work_plan_state = 'pending'
                """,
                (tenant_id,),
            ).fetchone()[0]
        )
        rows = conn.execute(
            """
            SELECT DISTINCT discover_workflow_id, discover_run_id,
                            preparation_workflow_id, work_plan_state
            FROM discovery_execution_jobs
            WHERE tenant_id = ?
              AND work_plan_state IN ('pending', 'planned')
            ORDER BY discover_workflow_id, discover_run_id,
                     preparation_workflow_id
            """,
            (tenant_id,),
        ).fetchall()
        for row in rows:
            _add_registered_candidate(
                candidates,
                blockers,
                policies,
                workflow_type="DiscoverWorkflow",
                workflow_id=str(row["discover_workflow_id"] or ""),
                temporal_run_id=_optional_text(row["discover_run_id"]),
                source="discovery_execution",
            )
            preparation_workflow_id = _optional_text(row["preparation_workflow_id"])
            if preparation_workflow_id is not None:
                _add_registered_candidate(
                    candidates,
                    blockers,
                    policies,
                    workflow_type="JobPreparationWorkflow",
                    workflow_id=preparation_workflow_id,
                    temporal_run_id=None,
                    source="discovery_preparation_plan",
                )
        if pending_count:
            durable_owners = [
                DurableOwnerObservation(
                    source="discovery_execution_jobs",
                    state="pending",
                    count=pending_count,
                )
            ]
        else:
            durable_owners = []
    else:
        durable_owners = []

    if "discovery_search_units" in tables:
        rows = conn.execute(
            """
            SELECT discover_workflow_id, discover_run_id, state, COUNT(*) AS n
            FROM discovery_search_units
            WHERE tenant_id = ?
              AND state IN ('pending', 'running')
            GROUP BY discover_workflow_id, discover_run_id, state
            ORDER BY discover_workflow_id, discover_run_id, state
            """,
            (tenant_id,),
        ).fetchall()
        for row in rows:
            _add_registered_candidate(
                candidates,
                blockers,
                policies,
                workflow_type="DiscoverWorkflow",
                workflow_id=str(row["discover_workflow_id"] or ""),
                temporal_run_id=_optional_text(row["discover_run_id"]),
                source="discovery_search_unit",
            )
            durable_owners.append(
                DurableOwnerObservation(
                    source="discovery_search_units",
                    state=str(row["state"]),
                    count=int(row["n"]),
                )
            )

    if "pipeline_step_projections" in tables:
        rows = conn.execute(
            """
            SELECT discover_workflow_id, discover_run_id, state, COUNT(*) AS n
            FROM pipeline_step_projections
            WHERE tenant_id = ?
              AND state IN ('queued', 'running')
            GROUP BY discover_workflow_id, discover_run_id, state
            ORDER BY discover_workflow_id, discover_run_id, state
            """,
            (tenant_id,),
        ).fetchall()
        for row in rows:
            _add_registered_candidate(
                candidates,
                blockers,
                policies,
                workflow_type="DiscoverWorkflow",
                workflow_id=str(row["discover_workflow_id"] or ""),
                temporal_run_id=_optional_text(row["discover_run_id"]),
                source="pipeline_step_projection",
            )
            durable_owners.append(
                DurableOwnerObservation(
                    source="pipeline_step_projections",
                    state=str(row["state"]),
                    count=int(row["n"]),
                )
            )

    if "preparation_work_items" in tables:
        rows = conn.execute(
            """
            SELECT idempotency_key, state
            FROM preparation_work_items
            WHERE tenant_id = ?
              AND state IN ('queued', 'running')
            ORDER BY idempotency_key
            """,
            (tenant_id,),
        ).fetchall()
        counts: dict[str, int] = {}
        for row in rows:
            state = str(row["state"])
            counts[state] = counts.get(state, 0) + 1
            idempotency_key = str(row["idempotency_key"] or "").strip()
            _add_registered_candidate(
                candidates,
                blockers,
                policies,
                workflow_type="JobPreparationWorkflow",
                workflow_id=(f"prep-{idempotency_key}" if idempotency_key else ""),
                temporal_run_id=None,
                source="preparation_work_item",
            )
        durable_owners.extend(
            DurableOwnerObservation(
                source="preparation_work_items",
                state=state,
                count=count,
            )
            for state, count in sorted(counts.items())
        )

    # Child workflows are started by Temporal from inside JobPipelineWorkflow,
    # so they never cross the application dispatch boundary. Their deterministic
    # IDs remain derivable from every canonical parent candidate.
    pipeline_workflow_ids = {
        candidate.workflow_id for candidate in candidates.values() if candidate.workflow_type == "JobPipelineWorkflow"
    }
    for pipeline_workflow_id in sorted(pipeline_workflow_ids):
        _add_registered_candidate(
            candidates,
            blockers,
            policies,
            workflow_type="DiscoverWorkflow",
            workflow_id=f"{pipeline_workflow_id}-discover",
            temporal_run_id=None,
            source="pipeline_child",
        )
        _add_registered_candidate(
            candidates,
            blockers,
            policies,
            workflow_type="ApplyWorkflow",
            workflow_id=f"{pipeline_workflow_id}-apply",
            temporal_run_id=None,
            source="pipeline_child",
        )

    frozen_candidates = tuple(
        WorkflowExecutionCandidate(
            workflow_type=item.workflow_type,
            workflow_id=item.workflow_id,
            temporal_run_id=item.temporal_run_id,
            sources=tuple(sorted(item.sources)),
        )
        for item in sorted(
            candidates.values(),
            key=lambda candidate: (
                candidate.workflow_type,
                candidate.workflow_id,
                candidate.temporal_run_id or "",
            ),
        )
    )
    identity_types: dict[tuple[str, str | None], set[str]] = {}
    for candidate in frozen_candidates:
        identity = (
            candidate.workflow_id,
            candidate.temporal_run_id,
        )
        identity_types.setdefault(identity, set()).add(candidate.workflow_type)
    for (workflow_id, temporal_run_id), workflow_types in sorted(
        identity_types.items(),
        key=lambda item: (item[0][0], item[0][1] or ""),
    ):
        if len(workflow_types) <= 1:
            continue
        blockers.append(
            IdentityCutoverBlocker(
                code="workflow_identity_type_conflict",
                source="sqlite",
                workflow_id=workflow_id,
                temporal_run_id=temporal_run_id,
                detail=",".join(sorted(workflow_types)),
            )
        )
    return _LocalIdentityInventory(
        dispatch_gate_blocked=gate_blocked,
        fence_blocked_at=fence_blocked_at,
        proof_identity=proof_identity,
        candidates=frozen_candidates,
        durable_owners=tuple(durable_owners),
        blockers=tuple(blockers),
    )


def _unreadable_local_inventory() -> _LocalIdentityInventory:
    return _LocalIdentityInventory(
        dispatch_gate_blocked=False,
        fence_blocked_at=None,
        proof_identity=None,
        candidates=(),
        durable_owners=(),
        blockers=(
            IdentityCutoverBlocker(
                code="inventory_unreadable",
                source="sqlite",
            ),
        ),
    )


def _add_registered_candidate(
    candidates: dict[
        tuple[str, str, str | None],
        _CandidateAccumulator,
    ],
    blockers: list[IdentityCutoverBlocker],
    policies: dict[str, WorkflowIdentityCutoverPolicy],
    *,
    workflow_type: str,
    workflow_id: str,
    temporal_run_id: str | None,
    source: str,
) -> None:
    policy = policies.get(workflow_type)
    if policy is None:
        blockers.append(
            IdentityCutoverBlocker(
                code="workflow_type_unregistered",
                source=source,
                workflow_type=workflow_type or None,
                workflow_id=workflow_id or None,
                temporal_run_id=temporal_run_id,
            )
        )
        return
    if not policy.blocks_cutover_when_open:
        return
    if source not in policy.inventory_sources:
        blockers.append(
            IdentityCutoverBlocker(
                code="inventory_source_undeclared",
                source=source,
                workflow_type=workflow_type,
                workflow_id=workflow_id or None,
                temporal_run_id=temporal_run_id,
            )
        )
        return
    if not workflow_id.strip():
        blockers.append(
            IdentityCutoverBlocker(
                code="workflow_id_missing",
                source=source,
                workflow_type=workflow_type,
                temporal_run_id=temporal_run_id,
            )
        )
        return
    _merge_candidate(
        candidates,
        workflow_type=workflow_type,
        workflow_id=workflow_id,
        temporal_run_id=temporal_run_id,
        source=source,
    )
    # A pinned predecessor can be terminal because it continued as new while
    # the current chain is still live. Always inspect the latest execution too.
    if temporal_run_id is not None:
        _merge_candidate(
            candidates,
            workflow_type=workflow_type,
            workflow_id=workflow_id,
            temporal_run_id=None,
            source=source,
        )


def _merge_candidate(
    candidates: dict[
        tuple[str, str, str | None],
        _CandidateAccumulator,
    ],
    *,
    workflow_type: str,
    workflow_id: str,
    temporal_run_id: str | None,
    source: str,
) -> None:
    key = (workflow_type, workflow_id, temporal_run_id)
    existing = candidates.get(key)
    if existing is None:
        candidates[key] = _CandidateAccumulator(
            workflow_type=workflow_type,
            workflow_id=workflow_id,
            temporal_run_id=temporal_run_id,
            sources={source},
        )
        return
    existing.sources.add(source)


async def _validate_temporal_authority(
    temporal_client: Any,
    *,
    proof_identity: InventoryProofIdentity,
) -> list[IdentityCutoverBlocker]:
    """Bind exact absence checks to the recovery proof's history authority."""

    namespace = _optional_text(getattr(temporal_client, "namespace", None))
    if namespace != proof_identity.temporal_namespace:
        return [
            IdentityCutoverBlocker(
                code="temporal_namespace_mismatch",
                source="temporal_authority",
            )
        ]

    try:
        response = await temporal_client.workflow_service.describe_namespace(
            DescribeNamespaceRequest(namespace=namespace),
            retry=False,
            timeout=timedelta(seconds=3),
        )
    except Exception:
        return [
            IdentityCutoverBlocker(
                code="temporal_namespace_describe_unavailable",
                source="temporal_authority",
            )
        ]

    namespace_info = getattr(response, "namespace_info", None)
    namespace_id = _optional_text(getattr(namespace_info, "id", None))
    if namespace_id != proof_identity.temporal_namespace_id:
        return [
            IdentityCutoverBlocker(
                code="temporal_namespace_id_mismatch",
                source="temporal_authority",
            )
        ]

    marker = WorkflowExecutionCandidate(
        workflow_type="DurabilityProbeWorkflow",
        workflow_id=proof_identity.authority_workflow_id,
        temporal_run_id=proof_identity.authority_run_id,
        sources=("temporal_authority",),
    )
    observation, _blocker = await _observe_exact_execution(
        temporal_client,
        marker,
        not_found_is_safe=False,
    )
    if observation.state == "closed":
        return []
    if observation.state == "open":
        code = "temporal_authority_marker_open"
    elif observation.state == "unknown":
        code = "temporal_authority_marker_status_unknown"
    else:
        code = "temporal_authority_marker_unavailable"
    return [
        IdentityCutoverBlocker(
            code=code,
            source="temporal_authority",
            workflow_type=marker.workflow_type,
            workflow_id=marker.workflow_id,
            temporal_run_id=marker.temporal_run_id,
        )
    ]


async def _observe_schedule_fences(
    temporal_client: Any,
    *,
    tenant_id: str,
) -> tuple[
    list[ScheduleFenceObservation],
    list[IdentityCutoverBlocker],
]:
    observations: list[ScheduleFenceObservation] = []
    blockers: list[IdentityCutoverBlocker] = []
    for policy in identity_bearing_schedule_policies(tenant_id):
        try:
            description = await temporal_client.get_schedule_handle(policy.schedule_id).describe()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                observations.append(
                    ScheduleFenceObservation(
                        schedule_id=policy.schedule_id,
                        workflow_type=policy.workflow_type,
                        state="not_found",
                    )
                )
                continue
            observations.append(
                ScheduleFenceObservation(
                    schedule_id=policy.schedule_id,
                    workflow_type=policy.workflow_type,
                    state="unavailable",
                )
            )
            blockers.append(
                IdentityCutoverBlocker(
                    code="schedule_describe_unavailable",
                    source="identity_schedule",
                    workflow_type=policy.workflow_type,
                    workflow_id=policy.workflow_id,
                )
            )
            continue
        except Exception:
            observations.append(
                ScheduleFenceObservation(
                    schedule_id=policy.schedule_id,
                    workflow_type=policy.workflow_type,
                    state="unavailable",
                )
            )
            blockers.append(
                IdentityCutoverBlocker(
                    code="schedule_describe_unavailable",
                    source="identity_schedule",
                    workflow_type=policy.workflow_type,
                    workflow_id=policy.workflow_id,
                )
            )
            continue

        schedule = getattr(description, "schedule", None)
        state = getattr(schedule, "state", None)
        paused = getattr(state, "paused", None)
        if paused is True:
            observation_state: ScheduleState = "paused"
        elif paused is False:
            observation_state = "unpaused"
            blockers.append(
                IdentityCutoverBlocker(
                    code="identity_schedule_unpaused",
                    source="identity_schedule",
                    workflow_type=policy.workflow_type,
                    workflow_id=policy.workflow_id,
                )
            )
        else:
            observation_state = "unknown"
            blockers.append(
                IdentityCutoverBlocker(
                    code="schedule_state_unknown",
                    source="identity_schedule",
                    workflow_type=policy.workflow_type,
                    workflow_id=policy.workflow_id,
                )
            )
        observations.append(
            ScheduleFenceObservation(
                schedule_id=policy.schedule_id,
                workflow_type=policy.workflow_type,
                state=observation_state,
            )
        )
    return observations, blockers


async def _observe_exact_execution(
    temporal_client: Any,
    candidate: WorkflowExecutionCandidate,
    *,
    not_found_is_safe: bool = True,
) -> tuple[
    WorkflowExecutionObservation,
    IdentityCutoverBlocker | None,
]:
    try:
        handle = temporal_client.get_workflow_handle(
            candidate.workflow_id,
            **({"run_id": candidate.temporal_run_id} if candidate.temporal_run_id is not None else {}),
        )
        description = await handle.describe()
    except RPCError as exc:
        if exc.status == RPCStatusCode.NOT_FOUND and not_found_is_safe:
            return (
                WorkflowExecutionObservation(
                    candidate=candidate,
                    state="not_found",
                ),
                None,
            )
        return _unavailable_execution(candidate)
    except Exception:
        return _unavailable_execution(candidate)

    status = getattr(description, "status", None)
    status_name = getattr(status, "name", str(status) if status is not None else None)
    if status in _OPEN_TEMPORAL_STATES:
        return (
            WorkflowExecutionObservation(
                candidate=candidate,
                state="open",
                temporal_status=status_name,
            ),
            IdentityCutoverBlocker(
                code="workflow_execution_open",
                source="temporal_describe",
                workflow_type=candidate.workflow_type,
                workflow_id=candidate.workflow_id,
                temporal_run_id=candidate.temporal_run_id,
                detail=status_name,
            ),
        )
    if status in _CLOSED_TEMPORAL_STATES:
        return (
            WorkflowExecutionObservation(
                candidate=candidate,
                state="closed",
                temporal_status=status_name,
            ),
            None,
        )
    return (
        WorkflowExecutionObservation(
            candidate=candidate,
            state="unknown",
            temporal_status=status_name,
        ),
        IdentityCutoverBlocker(
            code="workflow_execution_status_unknown",
            source="temporal_describe",
            workflow_type=candidate.workflow_type,
            workflow_id=candidate.workflow_id,
            temporal_run_id=candidate.temporal_run_id,
            detail=status_name,
        ),
    )


def _unavailable_execution(
    candidate: WorkflowExecutionCandidate,
) -> tuple[
    WorkflowExecutionObservation,
    IdentityCutoverBlocker,
]:
    return (
        WorkflowExecutionObservation(
            candidate=candidate,
            state="unavailable",
        ),
        IdentityCutoverBlocker(
            code="workflow_describe_unavailable",
            source="temporal_describe",
            workflow_type=candidate.workflow_type,
            workflow_id=candidate.workflow_id,
            temporal_run_id=candidate.temporal_run_id,
        ),
    )


def _policies_by_type() -> dict[str, WorkflowIdentityCutoverPolicy]:
    return {policy.workflow_type: policy for policy in WORKFLOW_IDENTITY_CUTOVER_POLICIES.values()}


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in conn.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
            """
        ).fetchall()
    }


def _optional_text(value: Any) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None


def _invalid_workflow_start_event(
    event_id: Any,
) -> IdentityCutoverBlocker:
    return IdentityCutoverBlocker(
        code="workflow_start_event_invalid",
        source="workflow_start_event",
        detail=f"event:{event_id}",
    )


def _has_inventory_blocker(
    blockers: list[IdentityCutoverBlocker],
) -> bool:
    return any(
        blocker.code
        in {
            "inventory_table_missing",
            "inventory_source_undeclared",
            "job_identity_incomplete",
            "pre_fence_inventory_unproven",
            "workflow_start_event_invalid",
            "workflow_id_missing",
            "workflow_identity_type_conflict",
            "workflow_type_unregistered",
        }
        for blocker in blockers
    )


def _result(
    *,
    gate_blocked: bool,
    candidates: tuple[WorkflowExecutionCandidate, ...],
    durable_owners: tuple[DurableOwnerObservation, ...],
    blockers: list[IdentityCutoverBlocker],
    executions: list[WorkflowExecutionObservation] | None = None,
    schedules: list[ScheduleFenceObservation] | None = None,
) -> IdentityCutoverPreflightResult:
    return IdentityCutoverPreflightResult(
        ready=not blockers,
        dispatch_gate_blocked=gate_blocked,
        candidates=candidates,
        executions=tuple(executions or ()),
        schedules=tuple(schedules or ()),
        durable_owners=durable_owners,
        blockers=tuple(blockers),
    )


__all__ = [
    "DurableOwnerObservation",
    "IdentityCutoverBlocker",
    "IdentityCutoverPreflightResult",
    "ScheduleFenceObservation",
    "WorkflowExecutionCandidate",
    "WorkflowExecutionObservation",
    "run_identity_cutover_preflight",
]
