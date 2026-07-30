from __future__ import annotations

import asyncio
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from temporalio.client import WorkflowExecutionStatus
from temporalio.service import RPCError, RPCStatusCode

from jobctrl.database import close_connection, init_db
from jobctrl.discovery.manual_capture_workflow import (
    manual_capture_import_workflow_id,
)
from jobctrl.infrastructure.temporal.identity_cutover_preflight import (
    IdentityCutoverPreflightResult,
    run_identity_cutover_preflight,
)
from jobctrl.infrastructure.temporal.identity_cutover_proof import (
    CONTROL_KEY,
    INVENTORY_PROOF_VERSION,
    registry_inventory_fingerprint,
    worker_inventory_fingerprint,
)
from jobctrl.infrastructure.temporal.workflow_dispatch_control import (
    IdentityCutoverLease,
    IdentityCutoverLeaseError,
    identity_cutover_exclusive_lease,
    set_workflow_dispatches_blocked,
    workflow_dispatch_read_lock,
)
from jobctrl.workflow_specs import (
    apply_workflow_id,
    interview_prep_workflow_id,
)


@dataclass(frozen=True)
class _WorkflowDescription:
    status: WorkflowExecutionStatus


class _WorkflowHandle:
    def __init__(self, outcome: object) -> None:
        self.outcome = outcome

    async def describe(self) -> object:
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        if callable(self.outcome):
            return self.outcome()
        return self.outcome


class _ScheduleHandle:
    def __init__(self, outcome: object) -> None:
        self.outcome = outcome

    async def describe(self) -> object:
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


class _WorkflowService:
    def __init__(
        self,
        *,
        namespace_id: str,
        outcome: object | None = None,
    ) -> None:
        self.namespace_id = namespace_id
        self.outcome = outcome
        self.requests: list[object] = []

    async def describe_namespace(
        self,
        request: object,
        *,
        retry: bool,
        timeout: object,
    ) -> object:
        self.requests.append(request)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        if self.outcome is not None:
            return self.outcome
        return SimpleNamespace(
            namespace_info=SimpleNamespace(id=self.namespace_id),
        )


_PROOF_ID = "proof-one"
_TEMPORAL_NAMESPACE = "default"
_TEMPORAL_NAMESPACE_ID = "namespace-id-one"
_AUTHORITY_WORKFLOW_ID = "cutover-authority-marker"
_AUTHORITY_RUN_ID = "marker-run-one"


class _TemporalClient:
    def __init__(
        self,
        *,
        workflows: dict[tuple[str, str | None], object] | None = None,
        schedule: object | None = None,
        namespace: str = _TEMPORAL_NAMESPACE,
        namespace_id: str = _TEMPORAL_NAMESPACE_ID,
        namespace_outcome: object | None = None,
        authority_outcome: object = _WorkflowDescription(WorkflowExecutionStatus.COMPLETED),
    ) -> None:
        self.workflows = workflows or {}
        self.namespace = namespace
        self.workflow_service = _WorkflowService(
            namespace_id=namespace_id,
            outcome=namespace_outcome,
        )
        self.authority_outcome = authority_outcome
        self.schedule = (
            schedule
            if schedule is not None
            else SimpleNamespace(schedule=SimpleNamespace(state=SimpleNamespace(paused=True)))
        )
        self.workflow_describes: list[tuple[str, str | None]] = []
        self.schedule_describes: list[str] = []

    def get_workflow_handle(
        self,
        workflow_id: str,
        *,
        run_id: str | None = None,
    ) -> _WorkflowHandle:
        self.workflow_describes.append((workflow_id, run_id))
        if workflow_id == _AUTHORITY_WORKFLOW_ID and run_id == _AUTHORITY_RUN_ID:
            outcome = self.authority_outcome
        else:
            outcome = self.workflows.get(
                (workflow_id, run_id),
                RPCError(
                    "not found",
                    RPCStatusCode.NOT_FOUND,
                    b"",
                ),
            )
        return _WorkflowHandle(outcome)

    def get_schedule_handle(self, schedule_id: str) -> _ScheduleHandle:
        self.schedule_describes.append(schedule_id)
        return _ScheduleHandle(self.schedule)


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "jobctrl.db"
    conn = init_db(path)
    conn.commit()
    close_connection(path)
    return path


def _block_dispatches(db_path: Path) -> None:
    set_workflow_dispatches_blocked(
        blocked=True,
        reason="identity-cutover",
        db_path=db_path,
    )
    _seal_inventory(db_path)


def _seal_inventory(
    db_path: Path,
    *,
    proof_id: str = _PROOF_ID,
) -> None:
    with sqlite3.connect(db_path) as conn:
        fence_blocked_at = conn.execute(
            """
            SELECT blocked_at
            FROM workflow_dispatch_control
            WHERE control_key = ?
            """,
            (CONTROL_KEY,),
        ).fetchone()[0]
        registry = registry_inventory_fingerprint(conn)
        workers = worker_inventory_fingerprint(conn)
        conn.execute(
            """
            INSERT INTO workflow_identity_cutover_inventory_proof (
                control_key, proof_version, proof_id, fence_blocked_at,
                registry_inventory_digest, registry_entry_count,
                worker_inventory_digest, worker_entry_count,
                worker_quiescent_at, temporal_namespace,
                temporal_namespace_id, authority_workflow_id,
                authority_run_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(control_key) DO UPDATE SET
                proof_version = excluded.proof_version,
                proof_id = excluded.proof_id,
                fence_blocked_at = excluded.fence_blocked_at,
                registry_inventory_digest =
                    excluded.registry_inventory_digest,
                registry_entry_count = excluded.registry_entry_count,
                worker_inventory_digest = excluded.worker_inventory_digest,
                worker_entry_count = excluded.worker_entry_count,
                worker_quiescent_at = excluded.worker_quiescent_at,
                temporal_namespace = excluded.temporal_namespace,
                temporal_namespace_id = excluded.temporal_namespace_id,
                authority_workflow_id = excluded.authority_workflow_id,
                authority_run_id = excluded.authority_run_id,
                created_at = excluded.created_at
            """,
            (
                CONTROL_KEY,
                INVENTORY_PROOF_VERSION,
                proof_id,
                str(fence_blocked_at),
                registry.digest,
                registry.entry_count,
                workers.digest,
                workers.entry_count,
                "2026-07-30T00:00:01+00:00",
                _TEMPORAL_NAMESPACE,
                _TEMPORAL_NAMESPACE_ID,
                _AUTHORITY_WORKFLOW_ID,
                _AUTHORITY_RUN_ID,
                "2026-07-30T00:00:01+00:00",
            ),
        )


async def _run_preflight(
    temporal_client: _TemporalClient,
    *,
    db_path: Path,
) -> IdentityCutoverPreflightResult:
    async with identity_cutover_exclusive_lease(
        db_path=db_path,
    ) as lease:
        return await run_identity_cutover_preflight(
            temporal_client,
            db_path=db_path,
            cutover_lease=lease,
        )


def _insert_dispatch(
    db_path: Path,
    *,
    workflow_type: str,
    workflow_id: str,
    run_id: str | None,
) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO workflow_dispatch_registry (
                launch_id, workflow_id, temporal_run_id,
                workflow_type, state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'dispatched', ?, ?)
            """,
            (
                f"launch-{workflow_id}",
                workflow_id,
                run_id,
                workflow_type,
                "2026-07-30T00:00:00+00:00",
                "2026-07-30T00:00:00+00:00",
            ),
        )
    _seal_inventory(db_path)


def _ensure_job(db_path: Path) -> str:
    job_id = "00000000-0000-4000-8000-000000000001"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO jobs (
                tenant_id, job_id, url, discovered_at
            ) VALUES ('local', ?, ?, ?)
            """,
            (
                job_id,
                "https://example.test/jobs/one",
                "2026-07-30T00:00:00+00:00",
            ),
        )
    return job_id


@pytest.mark.asyncio
async def test_preflight_requires_active_exclusive_cutover_lease(
    db_path: Path,
) -> None:
    client = _TemporalClient()
    released_lease = IdentityCutoverLease(
        db_path=db_path,
        lease_id="released",
        _active=False,
    )

    with pytest.raises(
        IdentityCutoverLeaseError,
        match="no longer active",
    ):
        await run_identity_cutover_preflight(
            client,
            db_path=db_path,
            cutover_lease=released_lease,
        )
    assert client.schedule_describes == []
    assert client.workflow_describes == []


@pytest.mark.asyncio
async def test_preflight_refuses_unproven_pre_fence_upgrade_inventory(
    db_path: Path,
) -> None:
    # This is the supported-upgrade crash window: predecessor Temporal may
    # contain an accepted random-ID execution while neither the dispatch
    # registry nor the best-effort projection/event contains it. Activating the
    # gate alone must never turn local absence into readiness.
    set_workflow_dispatches_blocked(
        blocked=True,
        reason="identity-cutover",
        db_path=db_path,
    )
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert any(
        blocker.code == "pre_fence_inventory_unproven" and blocker.detail == "proof_missing"
        for blocker in result.blockers
    )
    assert client.schedule_describes == []
    assert client.workflow_describes == []


@pytest.mark.asyncio
async def test_preflight_is_ready_after_paused_schedule_and_exact_absence(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is True
    assert result.blockers == ()
    assert result.schedules[0].state == "paused"
    assert client.schedule_describes == [
        "jobctrl-discovery-local",
        "jobctrl-discovery-local",
    ]
    assert client.workflow_describes == [
        (_AUTHORITY_WORKFLOW_ID, _AUTHORITY_RUN_ID),
        ("apply-auto-local", None),
        ("discover-local", None),
        ("apply-auto-local", None),
        ("discover-local", None),
    ]
    assert all(observation.state == "not_found" for observation in result.executions)


@pytest.mark.asyncio
async def test_ready_result_is_returned_while_exclusive_lease_remains_held(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    client = _TemporalClient()
    worker_entered = asyncio.Event()

    async def _enter_worker_runtime() -> None:
        async with workflow_dispatch_read_lock(
            db_path=db_path,
        ):
            worker_entered.set()

    async with identity_cutover_exclusive_lease(
        db_path=db_path,
    ) as lease:
        result = await run_identity_cutover_preflight(
            client,
            db_path=db_path,
            cutover_lease=lease,
        )
        worker_task = asyncio.create_task(_enter_worker_runtime())
        await asyncio.sleep(0.1)
        assert result.ready is True
        assert worker_entered.is_set() is False

    await worker_task
    assert worker_entered.is_set() is True


@pytest.mark.asyncio
async def test_preflight_rejects_wrong_temporal_namespace_before_absence_checks(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    client = _TemporalClient(namespace="wrong-namespace")

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert [blocker.code for blocker in result.blockers] == ["temporal_namespace_mismatch"]
    assert client.workflow_service.requests == []
    assert client.schedule_describes == []
    assert client.workflow_describes == []


@pytest.mark.asyncio
async def test_preflight_rejects_wrong_temporal_history_store(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    client = _TemporalClient(namespace_id="wrong-namespace-id")

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert [blocker.code for blocker in result.blockers] == ["temporal_namespace_id_mismatch"]
    assert len(client.workflow_service.requests) == 1
    assert client.schedule_describes == []
    assert client.workflow_describes == []


@pytest.mark.asyncio
async def test_preflight_fails_closed_when_namespace_authority_is_unavailable(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    client = _TemporalClient(
        namespace_outcome=RuntimeError(
            "sensitive-temporal-endpoint",
        )
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert [blocker.code for blocker in result.blockers] == ["temporal_namespace_describe_unavailable"]
    assert client.schedule_describes == []
    assert client.workflow_describes == []
    assert "sensitive-temporal-endpoint" not in repr(result)


@pytest.mark.asyncio
async def test_preflight_requires_exact_authority_marker_execution(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    client = _TemporalClient(
        authority_outcome=RPCError(
            "not found in wrong history store",
            RPCStatusCode.NOT_FOUND,
            b"sensitive-history-target",
        )
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert [blocker.code for blocker in result.blockers] == ["temporal_authority_marker_unavailable"]
    assert client.schedule_describes == []
    assert client.workflow_describes == [(_AUTHORITY_WORKFLOW_ID, _AUTHORITY_RUN_ID)]
    assert "sensitive-history-target" not in repr(result)


@pytest.mark.asyncio
async def test_preflight_requires_closed_authority_marker(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    client = _TemporalClient(authority_outcome=_WorkflowDescription(WorkflowExecutionStatus.RUNNING))

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert [blocker.code for blocker in result.blockers] == ["temporal_authority_marker_open"]
    assert client.schedule_describes == []
    assert client.workflow_describes == [(_AUTHORITY_WORKFLOW_ID, _AUTHORITY_RUN_ID)]


@pytest.mark.asyncio
async def test_preflight_describes_recorded_run_and_latest_execution(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    _insert_dispatch(
        db_path,
        workflow_type="ApplyWorkflow",
        workflow_id="apply-local-job-one",
        run_id="run-one",
    )
    client = _TemporalClient(
        workflows={
            (
                "apply-local-job-one",
                "run-one",
            ): _WorkflowDescription(WorkflowExecutionStatus.COMPLETED),
            (
                "apply-local-job-one",
                None,
            ): _WorkflowDescription(WorkflowExecutionStatus.RUNNING),
        }
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert {
        (observation.candidate.workflow_id, observation.candidate.temporal_run_id)
        for observation in result.executions
        if observation.candidate.workflow_id == "apply-local-job-one"
    } == {
        ("apply-local-job-one", "run-one"),
        ("apply-local-job-one", None),
    }
    assert any(
        blocker.code == "workflow_execution_open" and blocker.temporal_run_id is None for blocker in result.blockers
    )


@pytest.mark.asyncio
async def test_preflight_follows_continued_run_through_latest_execution(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    _insert_dispatch(
        db_path,
        workflow_type="ApplyWorkflow",
        workflow_id="apply-local-continued",
        run_id="run-before-continue",
    )
    client = _TemporalClient(
        workflows={
            (
                "apply-local-continued",
                "run-before-continue",
            ): _WorkflowDescription(WorkflowExecutionStatus.CONTINUED_AS_NEW),
            (
                "apply-local-continued",
                None,
            ): _WorkflowDescription(WorkflowExecutionStatus.COMPLETED),
        }
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is True
    assert {
        (
            observation.candidate.temporal_run_id,
            observation.state,
            observation.temporal_status,
        )
        for observation in result.executions
        if observation.candidate.workflow_id == "apply-local-continued"
    } == {
        (None, "closed", "COMPLETED"),
        (
            "run-before-continue",
            "closed",
            "CONTINUED_AS_NEW",
        ),
    }


@pytest.mark.asyncio
async def test_preflight_fails_closed_when_exact_describe_is_unavailable(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    _insert_dispatch(
        db_path,
        workflow_type="ContactResearchWorkflow",
        workflow_id="contact-research-task-one",
        run_id="run-contact",
    )
    client = _TemporalClient(
        workflows={
            (
                "contact-research-task-one",
                "run-contact",
            ): RPCError(
                "unavailable",
                RPCStatusCode.UNAVAILABLE,
                b"",
            ),
        }
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert any(
        blocker.code == "workflow_describe_unavailable" and blocker.temporal_run_id == "run-contact"
        for blocker in result.blockers
    )


@pytest.mark.asyncio
async def test_preflight_refuses_unknown_open_projection_workflow_type(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO workflow_run_projections (
                workflow_id, tenant_id, workflow_type, status,
                input_summary_json, retryable, events_json
            ) VALUES (?, 'local', ?, 'in_progress', '{}', 0, '[]')
            """,
            ("legacy-unknown", "RemovedLegacyWorkflow"),
        )
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert any(
        blocker.code == "workflow_type_unregistered" and blocker.workflow_type == "RemovedLegacyWorkflow"
        for blocker in result.blockers
    )
    assert client.workflow_describes == []


@pytest.mark.asyncio
async def test_preflight_reads_canonical_workflow_started_event_when_projection_is_missing(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO job_events (
                event_type, occurred_at, payload_json
            ) VALUES ('WorkflowStarted', ?, ?)
            """,
            (
                "2026-07-30T00:00:00+00:00",
                json.dumps(
                    {
                        "tenantId": "local",
                        "workflowId": "run-from-canonical-event",
                        "workflowType": "JobPipelineWorkflow",
                        "temporalRunId": "event-run-id",
                    }
                ),
            ),
        )
    client = _TemporalClient(
        workflows={
            (
                "run-from-canonical-event",
                "event-run-id",
            ): _WorkflowDescription(WorkflowExecutionStatus.RUNNING),
        }
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    event_candidate = next(
        candidate
        for candidate in result.candidates
        if candidate.workflow_id == "run-from-canonical-event" and candidate.temporal_run_id == "event-run-id"
    )
    assert "workflow_start_event" in event_candidate.sources
    assert any(
        blocker.code == "workflow_execution_open" and blocker.workflow_id == "run-from-canonical-event"
        for blocker in result.blockers
    )


@pytest.mark.asyncio
async def test_preflight_refuses_workflow_started_event_without_tenant(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO job_events (
                event_type, occurred_at, payload_json
            ) VALUES ('WorkflowStarted', ?, ?)
            """,
            (
                "2026-07-30T00:00:00+00:00",
                json.dumps(
                    {
                        "workflowId": "run-without-tenant",
                        "workflowType": "ApplyWorkflow",
                        "temporalRunId": "run-id-without-tenant",
                    }
                ),
            ),
        )
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert any(
        blocker.code == "workflow_start_event_invalid" and blocker.detail == "event:1" for blocker in result.blockers
    )
    assert client.schedule_describes == []
    assert client.workflow_describes == []


@pytest.mark.asyncio
async def test_preflight_derives_deterministic_domain_execution_ids(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    job_id = _ensure_job(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO manual_capture_queue (
                tenant_id, item_id, originating_url, reason,
                required_at, status
            ) VALUES (
                'local', 'capture-one', 'https://example.test/jobs/one',
                'manual', ?, 'pending'
            )
            """,
            ("2026-07-30T00:00:00+00:00",),
        )
        conn.execute(
            """
            INSERT INTO contact_research_tasks (
                tenant_id, task_id, employer, job_id,
                status, updated_at
            ) VALUES (
                'local', 'research-one', 'Example', ?,
                'queued', ?
            )
            """,
            (
                job_id,
                "2026-07-30T00:00:00+00:00",
            ),
        )
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is True
    by_id = {candidate.workflow_id: candidate for candidate in result.candidates}
    posting_url = "https://example.test/jobs/one"
    expected_sources = {
        apply_workflow_id("local", job_id): "job_identity_derived",
        apply_workflow_id("local", posting_url): "job_identity_derived",
        interview_prep_workflow_id(
            "local",
            job_id,
        ): "job_identity_derived",
        interview_prep_workflow_id(
            "local",
            posting_url,
        ): "job_identity_derived",
        manual_capture_import_workflow_id(
            "local",
            "capture-one",
        ): "manual_capture_queue",
        "contact-research-research-one": "contact_research_task",
        "apply-auto-local": "auto_apply_loop",
    }
    for workflow_id, source in expected_sources.items():
        assert source in by_id[workflow_id].sources


@pytest.mark.asyncio
async def test_preflight_derives_temporal_owned_pipeline_child_ids(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    _insert_dispatch(
        db_path,
        workflow_type="JobPipelineWorkflow",
        workflow_id="pipeline-parent",
        run_id="pipeline-parent-run",
    )
    client = _TemporalClient(
        workflows={
            (
                "pipeline-parent",
                "pipeline-parent-run",
            ): _WorkflowDescription(WorkflowExecutionStatus.COMPLETED),
            (
                "pipeline-parent",
                None,
            ): _WorkflowDescription(WorkflowExecutionStatus.COMPLETED),
            (
                "pipeline-parent-apply",
                None,
            ): _WorkflowDescription(WorkflowExecutionStatus.RUNNING),
        }
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    apply_child = next(candidate for candidate in result.candidates if candidate.workflow_id == "pipeline-parent-apply")
    discover_child = next(
        candidate for candidate in result.candidates if candidate.workflow_id == "pipeline-parent-discover"
    )
    assert apply_child.sources == ("pipeline_child",)
    assert discover_child.sources == ("pipeline_child",)
    assert any(
        blocker.code == "workflow_execution_open" and blocker.workflow_id == "pipeline-parent-apply"
        for blocker in result.blockers
    )


@pytest.mark.asyncio
async def test_preflight_ignores_registered_non_identity_workflow(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    _insert_dispatch(
        db_path,
        workflow_type="ProfileImportWorkflow",
        workflow_id="profile-import-one",
        run_id="profile-run-one",
    )
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is True
    assert all(candidate.workflow_id != "profile-import-one" for candidate in result.candidates)
    assert all(workflow_id != "profile-import-one" for workflow_id, _run_id in client.workflow_describes)


@pytest.mark.asyncio
async def test_preflight_refuses_one_execution_claimed_by_two_workflow_types(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    _insert_dispatch(
        db_path,
        workflow_type="ApplyWorkflow",
        workflow_id="shared-identity",
        run_id=None,
    )
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO workflow_run_projections (
                workflow_id, tenant_id, workflow_type, status,
                input_summary_json, retryable, events_json
            ) VALUES (?, 'local', ?, 'in_progress', '{}', 0, '[]')
            """,
            ("shared-identity", "ContactResearchWorkflow"),
        )
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert any(
        blocker.code == "workflow_identity_type_conflict" and blocker.workflow_id == "shared-identity"
        for blocker in result.blockers
    )
    assert client.workflow_describes == []


@pytest.mark.asyncio
async def test_preflight_requires_complete_local_inventory_schema(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute("DROP TABLE pipeline_step_projections")
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert any(
        blocker.code == "inventory_table_missing" and blocker.source == "pipeline_step_projections"
        for blocker in result.blockers
    )
    assert client.workflow_describes == []


@pytest.mark.asyncio
async def test_preflight_blocks_nonterminal_search_unit_after_temporal_close(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO discovery_search_units (
                tenant_id, discover_workflow_id, discover_run_id,
                unit_id, ordinal, request_json, request_fingerprint,
                state, created_at, updated_at
            ) VALUES (
                'local', 'discover-local', 'discover-run-one',
                'unit-one', 0, '{}', 'fingerprint',
                'running', ?, ?
            )
            """,
            (
                "2026-07-30T00:00:00+00:00",
                "2026-07-30T00:00:00+00:00",
            ),
        )
    client = _TemporalClient(
        workflows={
            (
                "discover-local",
                "discover-run-one",
            ): _WorkflowDescription(WorkflowExecutionStatus.COMPLETED),
            (
                "discover-local",
                None,
            ): _WorkflowDescription(WorkflowExecutionStatus.COMPLETED),
        }
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert any(
        owner.source == "discovery_search_units" and owner.state == "running" and owner.count == 1
        for owner in result.durable_owners
    )
    assert any(
        blocker.code == "durable_owner_nonterminal" and blocker.source == "discovery_search_units"
        for blocker in result.blockers
    )


@pytest.mark.asyncio
async def test_preflight_rechecks_exact_execution_after_stable_inventory(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    observations = iter(
        (
            _WorkflowDescription(WorkflowExecutionStatus.COMPLETED),
            _WorkflowDescription(WorkflowExecutionStatus.RUNNING),
        )
    )
    client = _TemporalClient(
        workflows={
            ("discover-local", None): lambda: next(observations),
        }
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    discover = next(
        observation for observation in result.executions if observation.candidate.workflow_id == "discover-local"
    )
    assert discover.state == "open"
    assert any(blocker.code == "workflow_execution_open" for blocker in result.blockers)
    assert client.workflow_describes == [
        (_AUTHORITY_WORKFLOW_ID, _AUTHORITY_RUN_ID),
        ("apply-auto-local", None),
        ("discover-local", None),
        ("apply-auto-local", None),
        ("discover-local", None),
    ]


@pytest.mark.asyncio
async def test_preflight_blocks_queued_preparation_owner_even_when_run_absent(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    resolved_job_id = _ensure_job(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO preparation_work_items (
                item_id, tenant_id, job_id, kind, target_version,
                source_event_id, state, idempotency_key, attempts,
                last_error, created_at, updated_at, available_at
            ) VALUES (
                'item-one', 'local', ?, 'score_job', 1,
                '', 'queued', 'preparation:legacy-key', 0,
                '', ?, ?, ?
            )
            """,
            (
                resolved_job_id,
                "2026-07-30T00:00:00+00:00",
                "2026-07-30T00:00:00+00:00",
                "2026-07-30T00:00:00+00:00",
            ),
        )
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert (
        "prep-preparation:legacy-key",
        None,
    ) in client.workflow_describes
    assert any(
        blocker.code == "durable_owner_nonterminal" and blocker.source == "preparation_work_items"
        for blocker in result.blockers
    )


@pytest.mark.asyncio
async def test_preflight_blocks_pending_discovery_work_plan(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    job_id = _ensure_job(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO discovery_execution_jobs (
                tenant_id, discover_workflow_id, discover_run_id,
                job_id, cohort_kind, work_plan_state, linked_at
            ) VALUES (
                'local', 'discover-local', 'discover-pending-run',
                ?, 'existing_backlog', 'pending', ?
            )
            """,
            (
                job_id,
                "2026-07-30T00:00:00+00:00",
            ),
        )
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert any(
        owner.source == "discovery_execution_jobs" and owner.state == "pending" and owner.count == 1
        for owner in result.durable_owners
    )
    assert any(
        blocker.code == "durable_owner_nonterminal" and blocker.source == "discovery_execution_jobs"
        for blocker in result.blockers
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["queued", "running"])
async def test_preflight_blocks_nonterminal_pipeline_step(
    db_path: Path,
    state: str,
) -> None:
    _block_dispatches(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO pipeline_step_projections (
                tenant_id, discover_workflow_id, discover_run_id,
                step_kind, item_key, state, attempt,
                last_event_id, last_updated_at
            ) VALUES (
                'local', 'discover-local', 'discover-step-run',
                'source_family', ?, ?, 1, 1, ?
            )
            """,
            (
                f"step-{state}",
                state,
                "2026-07-30T00:00:00+00:00",
            ),
        )
    client = _TemporalClient()

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert any(
        owner.source == "pipeline_step_projections" and owner.state == state and owner.count == 1
        for owner in result.durable_owners
    )
    assert any(
        blocker.code == "durable_owner_nonterminal" and blocker.source == "pipeline_step_projections"
        for blocker in result.blockers
    )


@pytest.mark.asyncio
async def test_preflight_refuses_unpaused_identity_schedule(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    client = _TemporalClient(schedule=SimpleNamespace(schedule=SimpleNamespace(state=SimpleNamespace(paused=False))))

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert result.schedules[0].state == "unpaused"
    assert any(blocker.code == "identity_schedule_unpaused" for blocker in result.blockers)


@pytest.mark.asyncio
async def test_preflight_refuses_local_work_added_during_exact_describe(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)

    def _close_after_persisting_work() -> _WorkflowDescription:
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                """
                INSERT INTO discovery_search_units (
                    tenant_id, discover_workflow_id, discover_run_id,
                    unit_id, ordinal, request_json, request_fingerprint,
                    state, created_at, updated_at
                ) VALUES (
                    'local', 'discover-local', 'late-run',
                    'late-unit', 0, '{}', 'fingerprint',
                    'pending', ?, ?
                )
                """,
                (
                    "2026-07-30T00:00:00+00:00",
                    "2026-07-30T00:00:00+00:00",
                ),
            )
        return _WorkflowDescription(WorkflowExecutionStatus.COMPLETED)

    client = _TemporalClient(
        workflows={
            ("discover-local", None): _close_after_persisting_work,
        }
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert any(blocker.code == "local_inventory_changed" for blocker in result.blockers)
    assert any(
        blocker.code == "durable_owner_nonterminal" and blocker.source == "discovery_search_units"
        for blocker in result.blockers
    )


@pytest.mark.asyncio
async def test_preflight_refuses_local_work_added_during_second_describe(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    describe_count = 0

    def _persist_work_during_second_describe() -> _WorkflowDescription:
        nonlocal describe_count
        describe_count += 1
        if describe_count == 2:
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    """
                    INSERT INTO discovery_search_units (
                        tenant_id, discover_workflow_id, discover_run_id,
                        unit_id, ordinal, request_json, request_fingerprint,
                        state, created_at, updated_at
                    ) VALUES (
                        'local', 'discover-local', 'late-second-run',
                        'late-second-unit', 0, '{}', 'fingerprint-second',
                        'pending', ?, ?
                    )
                    """,
                    (
                        "2026-07-30T00:00:00+00:00",
                        "2026-07-30T00:00:00+00:00",
                    ),
                )
        return _WorkflowDescription(WorkflowExecutionStatus.COMPLETED)

    client = _TemporalClient(
        workflows={
            ("discover-local", None): _persist_work_during_second_describe,
        }
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert describe_count == 2
    assert any(blocker.code == "local_inventory_changed" for blocker in result.blockers)
    assert any(
        blocker.code == "durable_owner_nonterminal" and blocker.source == "discovery_search_units"
        for blocker in result.blockers
    )


@pytest.mark.asyncio
async def test_preflight_refuses_replaced_fence_and_proof_generation(
    db_path: Path,
) -> None:
    _block_dispatches(db_path)
    describe_count = 0

    def _replace_proof_during_second_describe() -> _WorkflowDescription:
        nonlocal describe_count
        describe_count += 1
        if describe_count == 2:
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    """
                    UPDATE workflow_dispatch_control
                    SET blocked_at = ?
                    WHERE control_key = ?
                    """,
                    (
                        "2026-07-30T00:00:02+00:00",
                        CONTROL_KEY,
                    ),
                )
            _seal_inventory(
                db_path,
                proof_id="proof-two",
            )
        return _WorkflowDescription(WorkflowExecutionStatus.COMPLETED)

    client = _TemporalClient(
        workflows={
            ("discover-local", None): _replace_proof_during_second_describe,
        }
    )

    result = await _run_preflight(
        client,
        db_path=db_path,
    )

    assert result.ready is False
    assert describe_count == 2
    assert any(blocker.code == "cutover_proof_changed" for blocker in result.blockers)
