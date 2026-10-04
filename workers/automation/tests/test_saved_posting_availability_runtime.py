"""Production workflow/dispatch and preflight entry points with synthetic transport."""
from datetime import datetime, timedelta, timezone
import io
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from temporalio.worker import UnsandboxedWorkflowRunner, Worker
from typer.testing import CliRunner

from jobctrl import config, database
from jobctrl.domain.errors import MissingInputError
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment import availability
from jobctrl.enrichment.availability_workflow import (
    AvailabilityWorkflowInput, SavedPostingAvailabilityWorkflow, availability_workflow_spec,
    check_saved_posting_availability_activity, reconcile_saved_posting_availability,
)
from jobctrl.infrastructure.runtime_identity import RuntimeIdentityMismatch, current_runtime_identity
from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
from jobctrl.infrastructure.temporal.registry import ACTIVITIES, WORKFLOWS

from .availability_transports import POSTING_URL, SyntheticAvailabilityTransport
from .temporal_env import time_skipping_env
from .rpc_contract_probe import build_server

JOB = "10000000-0000-4000-8000-000000000123"


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    db_path = tmp_path / "runtime.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    conn = database.init_db(db_path)
    conn.execute("INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) VALUES ('local', ?, ?, 'Synthetic role', 'synthetic', ?)",
                 (JOB, POSTING_URL, datetime.now(timezone.utc).isoformat()))
    conn.execute("INSERT INTO job_enrichments (tenant_id, job_id, current_status, full_description, updated_at) VALUES ('local', ?, 'enriched', 'Accepted synthetic description', ?)",
                 (JOB, datetime.now(timezone.utc).isoformat()))
    conn.commit()
    control = tmp_path / "employer-control.json"
    control.write_text(json.dumps({"state": "active"}))
    monkeypatch.setattr(availability, "public_get", SyntheticAvailabilityTransport(control).get)
    yield SimpleNamespace(conn=conn, path=db_path, app=tmp_path, control=control, identity=current_runtime_identity())
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_real_temporal_activity_and_registered_workflow_record_current_evidence(runtime):
    assert SavedPostingAvailabilityWorkflow in WORKFLOWS
    assert check_saved_posting_availability_activity in ACTIVITIES
    async with time_skipping_env() as env:
        queue = "availability-production-fixture"
        async with Worker(env.client, task_queue=queue, workflows=[SavedPostingAvailabilityWorkflow],
                          activities=[check_saved_posting_availability_activity, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            result = await env.client.execute_workflow(SavedPostingAvailabilityWorkflow.run,
                AvailabilityWorkflowInput("local", JOB, str(runtime.app), str(runtime.path)),
                id=f"availability-local-{JOB}", task_queue=queue)
    assert result["verdict"] == "active" and result["lastSuccessfullyVerifiedAt"]
    assert result["lineage"][0]["rawHash"]
    events = [row[0] for row in runtime.conn.execute("SELECT event_type FROM job_events")]
    assert "WorkflowStarted" in events and "WorkflowCompleted" in events and "JobAvailabilityObserved" in events
    assert not runtime.conn.in_transaction


@pytest.mark.asyncio
async def test_startup_heartbeat_admission_is_durable_bounded_and_runtime_bound(runtime, monkeypatch):
    client = SimpleNamespace(start_workflow=AsyncMock())
    assert await reconcile_saved_posting_availability(client, "owned-queue", runtime.identity)
    assert not await reconcile_saved_posting_availability(client, "owned-queue", runtime.identity)
    assert client.start_workflow.await_count == 1
    payload = client.start_workflow.call_args.args[1]
    assert payload.expected_db_path == str(runtime.path) and payload.job_id is None
    now = availability._now() + timedelta(minutes=2)
    monkeypatch.setattr(availability, "_now", lambda: now)
    assert await reconcile_saved_posting_availability(client, "owned-queue", runtime.identity)
    assert client.start_workflow.await_count == 2


def test_rpc_command_is_strict_and_uses_canonical_job_and_current_runtime(runtime):
    params = {"tenantId": "local", "jobId": JOB, "expectedAppDir": str(runtime.app), "expectedDbPath": str(runtime.path)}
    spec = availability_workflow_spec(params)
    assert spec.workflow is SavedPostingAvailabilityWorkflow and spec.args[0].job_id == JOB
    for bad in [{**params, "bypass": True}, {**params, "jobId": POSTING_URL}, {"jobId": JOB}, {**params, "expectedDbPath": "/tmp/other.db"}]:
        with pytest.raises((ValueError, RuntimeIdentityMismatch)):
            availability_workflow_spec(bad)


def test_registered_rpc_server_and_cli_dispatch_the_strict_saved_job_command(runtime, monkeypatch):
    from jobctrl import cli
    specs = []
    server = build_server(started_specs=specs)
    params = {"tenantId": "local", "jobId": JOB, "expectedAppDir": str(runtime.app), "expectedDbPath": str(runtime.path)}
    output = io.StringIO()
    server.serve(stdin=io.StringIO(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "check_posting_availability", "params": params}) + "\n"), stdout=output)
    assert json.loads(output.getvalue())["result"]["workflowId"] == "synthetic-workflow"
    assert specs[0].args[0].job_id == JOB
    captured = []
    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr(cli, "_run_workflow_spec_from_cli", lambda spec, **kw: captured.append(spec) or {"verdict": "active"})
    result = CliRunner().invoke(cli.app, ["check-availability", JOB])
    assert result.exit_code == 0, result.exception
    assert captured[0].args[0].expected_db_path == str(runtime.path)
    assert '"verdict": "active"' in result.stdout


def test_unknown_preflight_stops_real_scoring_before_provider_and_keeps_stage_attempts(runtime, monkeypatch):
    from jobctrl.scoring import scorer
    runtime.control.write_text(json.dumps({"state": "unknown"}))
    monkeypatch.setattr(scorer, "get_connection", lambda: runtime.conn)
    monkeypatch.setattr(scorer, "_ensure_employer_analysis_for_job", lambda **kw: pytest.fail("unknown posting spent provider work"))
    before = runtime.conn.execute("SELECT * FROM job_stage_states").fetchall()
    with pytest.raises(MissingInputError, match="Check availability"):
        scorer.score_job_by_id(JOB, tenant_id=LOCAL_TENANT, profile_snapshot=SimpleNamespace(), resume_text="Synthetic", require_employer_analysis=False)
    assert runtime.conn.execute("SELECT * FROM job_stage_states").fetchall() == before
    assert availability.read_availability(runtime.conn, JOB)["verdict"] == "unknown"


def test_unknown_preflight_stops_apply_before_attempt_or_provider(runtime, monkeypatch):
    from jobctrl.apply import launcher
    runtime.control.write_text(json.dumps({"state": "unknown"}))
    monkeypatch.setattr(launcher, "get_connection", lambda: runtime.conn)
    monkeypatch.setattr(launcher, "_build_use_case", lambda: pytest.fail("unknown posting launched application"))
    before = runtime.conn.execute("SELECT * FROM job_stage_states").fetchall()
    assert launcher.run_job({"job_id": JOB, "url": POSTING_URL}, 1, tenant_id=LOCAL_TENANT, dry_run=True) == ("blocked", 0)
    assert runtime.conn.execute("SELECT * FROM job_stage_states").fetchall() == before
    assert not runtime.conn.execute("SELECT 1 FROM job_events WHERE event_type IN ('ApplyRunStarted','ApplySubmissionIntentRecorded')").fetchone()
