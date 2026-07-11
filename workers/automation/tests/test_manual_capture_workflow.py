"""Manual-capture API -> JSON-RPC -> Temporal -> worker seam tests."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import pytest
from temporalio import activity, workflow
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ActivityError, ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl import config
from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.discovery.manual_capture_workflow import (
    ManualCaptureImportActivityOutput,
    ManualCaptureImportWorkflow,
    ManualCaptureImportWorkflowInput,
    execute_manual_capture_import,
    manual_capture_import_activity,
    manual_capture_import_workflow_id,
)
from jobctrl.domain.rpc.messages import INTERNAL_ERROR, JsonRpcRequest, WorkflowStartSpec
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer
from jobctrl.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobctrl.infrastructure.temporal.registry import ACTIVITIES, WORKFLOWS
from jobctrl.workflow_specs import build_manual_capture_import_workflow_spec


_CAPTURE_URL = "https://example.test/jobs/staff-engineer"
_CAPTURE_HTML = """
<html>
  <head>
    <script type="application/ld+json">
      {
        "@type": "JobPosting",
        "title": "Staff Engineer",
        "description": "Build reliable local-first job search infrastructure.",
        "url": "https://example.test/jobs/staff-engineer",
        "validThrough": "2999-01-01T00:00:00+00:00",
        "jobLocation": {"address": {"addressLocality": "Barcelona"}}
      }
    </script>
  </head>
  <body><main>Build reliable local-first job search infrastructure.</main></body>
</html>
""".strip()


@workflow.defn(name="ManualCaptureActivityHarness")
class _ManualCaptureActivityHarness:
    @workflow.run
    async def run(
        self,
        payload: ManualCaptureImportWorkflowInput,
    ) -> ManualCaptureImportActivityOutput:
        return await workflow.execute_activity(
            manual_capture_import_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=1),
        )


@activity.defn(name="manual_capture_import")
async def _successful_manual_capture_import(
    payload: ManualCaptureImportWorkflowInput,
) -> ManualCaptureImportActivityOutput:
    return ManualCaptureImportActivityOutput(
        status="succeeded",
        item_id=payload.item_id,
        job_id=_CAPTURE_URL,
        imported_at="2026-07-10T10:00:00+00:00",
        retry_context={
            "manual_capture_provenance": {
                "source_kind": "user_mediated_capture",
                "originating_url": _CAPTURE_URL,
            }
        },
    )


@activity.defn(name="manual_capture_import")
async def _mismatched_manual_capture_import(
    _payload: ManualCaptureImportWorkflowInput,
) -> ManualCaptureImportActivityOutput:
    raise ApplicationError(
        "capture identity mismatch",
        type="capture_replay_mismatch",
        non_retryable=True,
    )


class _StubHandle:
    def __init__(self, result_payload: object) -> None:
        self.id = "manual-capture-workflow"
        self.first_execution_run_id = "manual-capture-run"
        self._result_payload = result_payload

    async def result(self) -> object:
        return self._result_payload


async def _stub_canceler(_run_id: str) -> None:
    return None


def _pending_payload(item_id: str = "manual-1") -> ManualCaptureImportWorkflowInput:
    return ManualCaptureImportWorkflowInput(
        tenant_id="local",
        item_id=item_id,
        capture_mode="saved_html",
        content_text=_CAPTURE_HTML,
        captured_url=_CAPTURE_URL,
        note="captured by user",
        future_manual_action_required=True,
    )


def _seed_pending(db_path: Path, *, item_id: str = "manual-1"):
    conn = init_db(db_path)
    conn.execute(
        """
        INSERT INTO manual_capture_queue (
          tenant_id, item_id, originating_url, source_id, reason,
          retry_context_json, required_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
        """,
        (
            "local",
            item_id,
            _CAPTURE_URL,
            "manual:test",
            "login_required",
            "{}",
            "2026-07-10T09:00:00+00:00",
        ),
    )
    conn.commit()
    return conn


def _isolate_runtime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> tuple[str, str]:
    import jobctrl.database as database

    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    init_db(db_path)
    return str(tmp_path), str(db_path)


def test_activity_reconstructs_exact_result_after_import_commit(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = _seed_pending(db_path)
    payload = _pending_payload()
    try:
        first = execute_manual_capture_import(payload, conn=conn)
        events_before_replay = conn.execute(
            "SELECT COUNT(*) FROM job_events"
        ).fetchone()[0]
        snapshot_version_before_replay = conn.execute(
            "SELECT latest_snapshot_version FROM posting_snapshot_sets WHERE job_url = ?",
            (_CAPTURE_URL,),
        ).fetchone()[0]
        replay = execute_manual_capture_import(payload, conn=conn)
        events_after_replay = conn.execute(
            "SELECT COUNT(*) FROM job_events"
        ).fetchone()[0]
        snapshot_version_after_replay = conn.execute(
            "SELECT latest_snapshot_version FROM posting_snapshot_sets WHERE job_url = ?",
            (_CAPTURE_URL,),
        ).fetchone()[0]
        row = conn.execute(
            "SELECT status, content_sha256, imported_at FROM manual_capture_queue "
            "WHERE tenant_id = 'local' AND item_id = 'manual-1'"
        ).fetchone()
    finally:
        close_connection(db_path)

    assert replay == first
    assert first.status == "succeeded"
    assert first.item_id == "manual-1"
    assert first.job_id == _CAPTURE_URL
    assert first.imported_at == row["imported_at"]
    assert row["status"] == "imported"
    assert row["content_sha256"] == hashlib.sha256(
        _CAPTURE_HTML.encode("utf-8")
    ).hexdigest()
    assert events_after_replay == events_before_replay
    assert snapshot_version_after_replay == snapshot_version_before_replay


@pytest.mark.parametrize(
    "changed_payload",
    [
        {"content_text": "different captured content"},
        {"capture_mode": "pasted_text"},
        {"captured_url": "https://example.test/jobs/different"},
        {"future_manual_action_required": False},
        {"note": "different note"},
    ],
)
def test_activity_rejects_mismatched_imported_replay(
    tmp_path: Path,
    changed_payload: dict[str, str],
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = _seed_pending(db_path)
    payload = _pending_payload()
    try:
        execute_manual_capture_import(payload, conn=conn)
        with pytest.raises(ApplicationError) as exc_info:
            execute_manual_capture_import(
                replace(payload, **changed_payload),
                conn=conn,
            )
    finally:
        close_connection(db_path)

    assert exc_info.value.type == "capture_replay_mismatch"
    assert exc_info.value.non_retryable is True


@pytest.mark.parametrize(
    "identity_change",
    [
        {"tenant_id": "other-tenant"},
        {"item_id": "other-item"},
    ],
)
def test_activity_never_reuses_a_different_tenant_or_item(
    tmp_path: Path,
    identity_change: dict[str, str],
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = _seed_pending(db_path)
    payload = _pending_payload()
    try:
        execute_manual_capture_import(payload, conn=conn)
        with pytest.raises(ApplicationError) as exc_info:
            execute_manual_capture_import(
                replace(payload, **identity_change),
                conn=conn,
            )
    finally:
        close_connection(db_path)

    assert exc_info.value.type == "not_found"
    assert exc_info.value.non_retryable is True


@pytest.mark.parametrize("column", ["originating_url", "source_id"])
def test_activity_rejects_changed_capture_source_identity(
    tmp_path: Path,
    column: str,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = _seed_pending(db_path)
    payload = _pending_payload()
    try:
        execute_manual_capture_import(payload, conn=conn)
        conn.execute(
            f"UPDATE manual_capture_queue SET {column} = ? "
            "WHERE tenant_id = 'local' AND item_id = 'manual-1'",
            ("changed-source-identity",),
        )
        conn.commit()
        with pytest.raises(ApplicationError) as exc_info:
            execute_manual_capture_import(payload, conn=conn)
    finally:
        close_connection(db_path)

    assert exc_info.value.type == "capture_replay_mismatch"
    assert exc_info.value.non_retryable is True


def test_activity_returns_not_found_for_unknown_capture(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        with pytest.raises(ApplicationError) as exc_info:
            execute_manual_capture_import(_pending_payload("missing"), conn=conn)
    finally:
        close_connection(db_path)

    assert exc_info.value.type == "not_found"
    assert exc_info.value.non_retryable is True


def test_manual_capture_workflow_id_is_hashed_bounded_and_tenant_scoped() -> None:
    special_item = "capture/with spaces?and=unicode-ñ-" + ("x" * 10_000)
    first = manual_capture_import_workflow_id("tenant/a", special_item)
    second = manual_capture_import_workflow_id("tenant/a", special_item)

    assert first == second
    assert first.startswith("manual-capture-import-")
    assert len(first) == len("manual-capture-import-") + 64 + 1 + 64
    assert special_item not in first
    assert manual_capture_import_workflow_id("tenant/b", special_item) != first
    assert manual_capture_import_workflow_id("tenant/a", special_item + "2") != first


def test_workflow_spec_preserves_guard_and_uses_deterministic_id() -> None:
    params = {
        "tenantId": "local",
        "itemId": "manual-1",
        "captureMode": "saved_html",
        "expectedAppDir": "/tmp/jobctrl",
        "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
        "contentText": _CAPTURE_HTML,
        "capturedUrl": _CAPTURE_URL,
        "note": "captured by user",
        "futureManualActionRequired": True,
    }

    first = build_manual_capture_import_workflow_spec(params)
    second = build_manual_capture_import_workflow_spec(params)
    payload = first.args[0]

    assert first.workflow is ManualCaptureImportWorkflow
    assert first.workflow_id == second.workflow_id
    assert first.workflow_id == manual_capture_import_workflow_id("local", "manual-1")
    assert payload == ManualCaptureImportWorkflowInput(
        tenant_id="local",
        item_id="manual-1",
        capture_mode="saved_html",
        expected_app_dir="/tmp/jobctrl",
        expected_db_path="/tmp/jobctrl/jobctrl.db",
        content_text=_CAPTURE_HTML,
        captured_url=_CAPTURE_URL,
        note="captured by user",
        future_manual_action_required=True,
    )


def test_manual_capture_workflow_and_activity_are_registered() -> None:
    assert ManualCaptureImportWorkflow in WORKFLOWS
    assert manual_capture_import_activity in ACTIVITIES


def test_jsonrpc_handler_awaits_manual_capture_workflow_result() -> None:
    seen: list[WorkflowStartSpec] = []
    result_payload = {
        "status": "succeeded",
        "item_id": "manual-1",
        "job_id": _CAPTURE_URL,
        "imported_at": "2026-07-10T10:00:00+00:00",
        "retry_context": {"manual_capture_provenance": {"source_kind": "user_mediated_capture"}},
        "error": None,
        "error_code": None,
    }

    async def starter(spec: WorkflowStartSpec) -> _StubHandle:
        seen.append(spec)
        return _StubHandle(result_payload)

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)
    response = server.dispatch(
        JsonRpcRequest(
            method="manual_capture_import",
            params={
                "tenantId": "local",
                "itemId": "manual-1",
                "captureMode": "saved_html",
                "contentText": _CAPTURE_HTML,
                "capturedUrl": _CAPTURE_URL,
                "awaitResult": True,
            },
            id=1,
        )
    )

    assert response is not None
    assert response.to_dict()["result"] == {
        "runId": "manual-capture-workflow",
        "workflowId": "manual-capture-workflow",
        "firstExecutionRunId": "manual-capture-run",
        "result": result_payload,
    }
    assert len(seen) == 1
    assert seen[0].workflow is ManualCaptureImportWorkflow


def test_jsonrpc_handler_surfaces_temporal_start_failure() -> None:
    async def starter(_spec: WorkflowStartSpec) -> _StubHandle:
        raise RuntimeError("temporal unavailable")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)
    response = server.dispatch(
        JsonRpcRequest(
            method="manual_capture_import",
            params={
                "itemId": "manual-1",
                "captureMode": "copied_url",
                "capturedUrl": _CAPTURE_URL,
                "awaitResult": True,
            },
            id=1,
        )
    )

    assert response is not None
    assert response.to_dict()["error"]["code"] == INTERNAL_ERROR


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("activity_fn", "expected_status", "expected_error_code"),
    [
        (_successful_manual_capture_import, "succeeded", None),
        (_mismatched_manual_capture_import, "failed", "capture_replay_mismatch"),
    ],
)
async def test_manual_capture_workflow_projects_terminal_result(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    activity_fn,
    expected_status: str,
    expected_error_code: str | None,
) -> None:
    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    queue = f"manual-capture-{uuid.uuid4()}"
    workflow_id = f"manual-capture-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[ManualCaptureImportWorkflow],
            activities=[
                activity_fn,
                record_workflow_started,
                record_workflow_outcome,
            ],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            result = await env.client.execute_workflow(
                ManualCaptureImportWorkflow.run,
                replace(
                    _pending_payload(),
                    expected_app_dir=app_dir,
                    expected_db_path=db_path,
                ),
                id=workflow_id,
                task_queue=queue,
            )

    row = get_connection().execute(
        "SELECT status, workflow_type, error_code FROM workflow_run_projections "
        "WHERE workflow_id = ?",
        (workflow_id,),
    ).fetchone()
    assert result.status == expected_status
    assert result.error_code == expected_error_code
    assert row["status"] == expected_status
    assert row["workflow_type"] == "ManualCaptureImportWorkflow"
    assert row["error_code"] == expected_error_code


@pytest.mark.asyncio
async def test_manual_capture_activity_enforces_expected_runtime_guard() -> None:
    queue = f"manual-capture-guard-{uuid.uuid4()}"
    payload = replace(
        _pending_payload(),
        expected_app_dir="/definitely/not/the-worker-app",
        expected_db_path="/definitely/not/the-worker-app/jobctrl.db",
    )

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[_ManualCaptureActivityHarness],
            activities=[manual_capture_import_activity],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            with pytest.raises(WorkflowFailureError) as exc_info:
                await env.client.execute_workflow(
                    _ManualCaptureActivityHarness.run,
                    payload,
                    id=f"manual-capture-guard-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert isinstance(exc_info.value.cause, ActivityError)
    assert isinstance(exc_info.value.cause.cause, ApplicationError)
    assert exc_info.value.cause.cause.type == "RuntimeIdentityMismatch"
    assert exc_info.value.cause.cause.non_retryable is True
