from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

import pytest
from temporalio.client import WorkflowExecutionStatus
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.service import RPCError, RPCStatusCode

from jobctrl import config
from jobctrl.apply import auto_apply
from jobctrl.apply.auto_apply import auto_apply_workflow_id, reconcile_auto_apply_loop
from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobctrl.browser_capabilities import BrowserCapabilityStatus


@pytest.fixture(autouse=True)
def ready_auto_apply_browser_for_existing_reconciler_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """The legacy loop tests exercise scheduling after capability validation."""

    monkeypatch.setattr(
        auto_apply,
        "browser_capability_status",
        lambda _capability: BrowserCapabilityStatus(
            id="auto-apply-browser",
            status="ready",
            detail="test capability",
        ),
    )


class _FakeHandle:
    def __init__(self, status: WorkflowExecutionStatus | Exception) -> None:
        self.status = status
        self.cancel_count = 0

    async def describe(self) -> SimpleNamespace:
        if isinstance(self.status, Exception):
            raise self.status
        return SimpleNamespace(status=self.status, run_id="temporal-run")

    async def cancel(self) -> None:
        self.cancel_count += 1
        self.status = WorkflowExecutionStatus.CANCELED


class _FakeClient:
    def __init__(self) -> None:
        self.handles: dict[str, _FakeHandle] = {}
        self.starts: list[dict[str, Any]] = []

    def get_workflow_handle(self, workflow_id: str) -> _FakeHandle:
        return self.handles.get(
            workflow_id,
            _FakeHandle(RPCError("not found", RPCStatusCode.NOT_FOUND, b"")),
        )

    async def start_workflow(self, workflow, payload, **kwargs) -> _FakeHandle:
        self.starts.append({"workflow": workflow, "payload": payload, "kwargs": kwargs})
        handle = _FakeHandle(WorkflowExecutionStatus.RUNNING)
        self.handles[str(kwargs["id"])] = handle
        return handle


def _write_config_settings(path, **values: object) -> None:
    path.write_text(json.dumps(values), encoding="utf-8")


def _write_discovery_automation_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    **automation: object,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    sqlite3.connect(db_path).close()
    monkeypatch.setattr(config, "DB_PATH", db_path)
    discovery = config._default_discovery_search_config()
    discovery["automation"] = automation
    config._save_discovery_search_config_to_db(discovery)


@pytest.mark.asyncio
async def test_auto_apply_reconciler_does_not_start_a_disabled_browser_capability(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_path = tmp_path / "config.json"
    _write_config_settings(settings_path)
    _write_discovery_automation_settings(monkeypatch, tmp_path, auto_apply=True)
    client = _FakeClient()
    monkeypatch.setattr(
        auto_apply,
        "browser_capability_status",
        lambda _capability: BrowserCapabilityStatus(
            id="auto-apply-browser",
            status="disabled",
            detail="disabled for test",
        ),
    )

    result = await reconcile_auto_apply_loop(
        client, task_queue="jobctrl-test", settings_path=settings_path
    )

    assert result.action == "blocked_capability_disabled"
    assert result.enabled is False
    assert client.starts == []


@pytest.mark.asyncio
async def test_auto_apply_on_starts_exactly_one_standing_loop(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings_path = tmp_path / "config.json"
    _write_config_settings(
        settings_path,
        apply_concurrency=3,
    )
    _write_discovery_automation_settings(
        monkeypatch,
        tmp_path,
        auto_apply=True,
        min_fit_score=9,
        apply_approval_required=True,
    )
    client = _FakeClient()

    first = await reconcile_auto_apply_loop(
        client,
        task_queue="jobctrl-test",
        settings_path=settings_path,
        expected_app_dir="/tmp/jobctrl",
        expected_db_path="/tmp/jobctrl/jobctrl.db",
    )
    second = await reconcile_auto_apply_loop(
        client,
        task_queue="jobctrl-test",
        settings_path=settings_path,
        expected_app_dir="/tmp/jobctrl",
        expected_db_path="/tmp/jobctrl/jobctrl.db",
    )

    assert first.action == "started"
    assert second.action == "already_running"
    assert len(client.starts) == 1
    start = client.starts[0]
    assert start["workflow"] is ApplyWorkflow.run
    payload = start["payload"]
    assert isinstance(payload, ApplyWorkflowInput)
    assert payload.continuous is True
    assert payload.auto_apply_loop is True
    assert payload.dry_run is False
    assert payload.min_score == 9
    assert payload.workers == 3
    assert payload.approval_required is True
    assert payload.expected_app_dir == "/tmp/jobctrl"
    assert payload.expected_db_path == "/tmp/jobctrl/jobctrl.db"
    assert start["kwargs"]["id"] == auto_apply_workflow_id("local")
    assert start["kwargs"]["id_conflict_policy"] is WorkflowIDConflictPolicy.USE_EXISTING
    assert start["kwargs"]["id_reuse_policy"] is WorkflowIDReusePolicy.ALLOW_DUPLICATE


@pytest.mark.asyncio
async def test_auto_apply_off_cancels_the_standing_loop(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings_path = tmp_path / "config.json"
    _write_config_settings(settings_path)
    _write_discovery_automation_settings(monkeypatch, tmp_path, auto_apply=False)
    workflow_id = auto_apply_workflow_id("local")
    handle = _FakeHandle(WorkflowExecutionStatus.RUNNING)
    client = _FakeClient()
    client.handles[workflow_id] = handle

    first = await reconcile_auto_apply_loop(
        client,
        task_queue="jobctrl-test",
        settings_path=settings_path,
    )
    second = await reconcile_auto_apply_loop(
        client,
        task_queue="jobctrl-test",
        settings_path=settings_path,
    )

    assert first.action == "canceled"
    assert second.action == "already_stopped"
    assert handle.cancel_count == 1
    assert client.starts == []


@pytest.mark.asyncio
async def test_auto_apply_budget_exceeded_halt_does_not_restart_loop(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_path = tmp_path / "config.json"
    _write_config_settings(settings_path, daily_budget_usd=1.0)
    _write_discovery_automation_settings(monkeypatch, tmp_path, auto_apply=True)
    db_path = tmp_path / "jobctrl.db"
    today = datetime.now(timezone.utc).date().isoformat()
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE workflow_run_projections (
              workflow_id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              error_code TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE llm_spend (
              day TEXT PRIMARY KEY,
              input_tokens INTEGER NOT NULL DEFAULT 0,
              output_tokens INTEGER NOT NULL DEFAULT 0,
              estimated_usd REAL NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute(
            """
            INSERT INTO workflow_run_projections (workflow_id, status, error_code)
            VALUES (?, 'failed', 'budget_exceeded')
            """,
            (auto_apply_workflow_id("local"),),
        )
        conn.execute(
            """
            INSERT INTO llm_spend (day, estimated_usd)
            VALUES (?, 1.25)
            """,
            (today,),
        )
    client = _FakeClient()

    result = await reconcile_auto_apply_loop(
        client,
        task_queue="jobctrl-test",
        settings_path=settings_path,
        expected_db_path=str(db_path),
    )

    assert result.action == "halted_budget_exceeded"
    assert result.changed is False
    assert client.starts == []
