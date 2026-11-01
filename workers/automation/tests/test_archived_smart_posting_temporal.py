"""Real Temporal source recovery and replay with owned public/model transports."""

import asyncio
from uuid import uuid4

import pytest
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl import config, database
from jobctrl.database import close_connection, init_db
from jobctrl.discovery.activities import discovery_source_family_activity, plan_discovery_sources
from jobctrl.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
from jobctrl.domain.discovery.source_registry import (
    SMART_EXTRACT_EXPERIMENTAL_POLICY, SourceKind, SourcePriority, SourceRegistryEntry, SourceState,
)
from jobctrl.domain.enrichment.snapshot_use_case import CapturePostingSnapshotUseCase
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery.production_wiring import seed_source_registry_controls
from jobctrl.infrastructure.temporal import run_in_activity
from tests.smart_posting_fakes import PostingModel
from tests.temporal_env import time_skipping_env
from tests.test_captured_posting_recovery import capture, smart_models
from tests.test_workflow_discovery import (
    _automatic_compensation_refresh, _cancel_enrichment_cohort, _check_spend_budget,
    _discovery_enrichment, _discovery_preparation_fanout, _record_workflow_outcome, _record_workflow_started,
)


SOURCE = "smart_extract:synthetic"


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [0, 1], ids=["unbounded", "last-admission-slot"])
async def test_actual_temporal_recovery_resumes_canonical_insert_snapshot_gap_and_replays(tmp_path, monkeypatch, limit):
    from jobctrl.discovery import smartextract

    path = tmp_path / "owned-archived-smart.db"
    app_dir = tmp_path / "owned-app"
    app_dir.mkdir()
    monkeypatch.setattr(database, "DB_PATH", path)
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.setattr(config, "APP_DIR", app_dir)
    conn = init_db(path)
    seed_source_registry_controls(conn, [SourceRegistryEntry(
        LOCAL_TENANT, SOURCE, SourceKind.SMART_EXTRACT, "Synthetic", "user", SourcePriority.STANDARD,
        SourceState.ACTIVE, SMART_EXTRACT_EXPERIMENTAL_POLICY,
        {"name": "Synthetic", "url": "https://example.test/owned-careers"},
    )])
    capture(conn, "1", source=SOURCE)
    if limit:
        capture(conn, "2", source=SOURCE)
    model = PostingModel()
    smart_models(monkeypatch, model)
    monkeypatch.setattr(smartextract, "prefer_live_browser", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("jobctrl.infrastructure.discovery.live_browser.prefer_live_browser", lambda *_args, **_kwargs: None)
    attempts, fresh_fetches = [], []
    original = CapturePostingSnapshotUseCase.execute

    def interrupted(self, **kwargs):
        attempts.append(kwargs["job_id"])
        if limit:
            assert self._snapshot_repository._conn.execute(
                "SELECT count(*) FROM job_events WHERE event_type='DiscoveryNewJobAdmitted' AND job_id IS NULL",
            ).fetchone()[0] == 1
        if len(attempts) == 1:
            assert self._snapshot_repository._conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
            assert self._snapshot_repository._conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
            raise RuntimeError("synthetic snapshot store unavailable after canonical insert")
        return original(self, **kwargs)

    monkeypatch.setattr(CapturePostingSnapshotUseCase, "execute", interrupted)

    def fresh_transport(*_args, **_kwargs):
        with database.get_connection() as check:
            assert check.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is not None
            assert check.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 1
        fresh_fetches.append(True)
        return {"name": "Synthetic", "status": "OK", "strategy": "json_ld", "total": 0, "jobs": []}

    monkeypatch.setattr(smartextract, "_run_one_site", fresh_transport)
    previous = run_in_activity._activity_executor()
    pool = run_in_activity.ActivityThreadPoolExecutor(max_workers=2)
    run_in_activity.set_activity_executor(pool)
    queue = f"owned-archived-smart-{uuid4()}"
    try:
        async with time_skipping_env() as env:
            async with Worker(
                env.client, task_queue=queue, workflows=[DiscoverWorkflow],
                activities=[_check_spend_budget, _record_workflow_started, _record_workflow_outcome,
                            _cancel_enrichment_cohort, plan_discovery_sources, discovery_source_family_activity,
                            _discovery_enrichment, _discovery_preparation_fanout, _automatic_compensation_refresh],
                activity_executor=pool,
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    DiscoverWorkflow.run, DiscoverWorkflowInput(tenant_id="local", source_ids=(SOURCE,),
                        expected_app_dir=str(app_dir), expected_db_path=str(path), limit=limit), id=queue, task_queue=queue,
                )
                result = await asyncio.wait_for(handle.result(), 60)
                history = await handle.fetch_history()
        assert result.families_failed == [] and result.families_completed == ["smartextract"]
        assert len(attempts) == 2 and str(attempts[0]) == str(attempts[1])
        assert len(fresh_fetches) == (0 if limit else 1) and len(model.calls) == 3
        assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM job_source_observations").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM posting_triage WHERE consumed_at IS NULL").fetchone()[0] == (1 if limit else 0)
        assert conn.execute("SELECT full_description FROM job_enrichments").fetchone()[0] == "Lead the platform team and delivery."
        assert conn.execute("SELECT count(*) FROM job_events WHERE event_type='PostingContentSnapshotCaptured'").fetchone()[0] == 1
        for event_type in ("JobDiscovered", "CanonicalJobIdentityResolved", "JobSourceObserved"):
            assert conn.execute("SELECT count(*) FROM job_events WHERE event_type=?", (event_type,)).fetchone()[0] == 1
        if limit:
            assert conn.execute(
                "SELECT count(*) FROM job_events WHERE event_type='DiscoveryResultPlanFrozen' AND job_id IS NULL",
            ).fetchone()[0] == 1
            assert conn.execute(
                "SELECT count(*) FROM job_events WHERE event_type='DiscoveryNewJobAdmitted' AND job_id IS NULL",
            ).fetchone()[0] == 1
        assert [row[0] for row in conn.execute(
            "SELECT json_extract(payload_json,'$.attempt') FROM job_events WHERE event_type='ArchivedCaptureOwnerClaimed' ORDER BY event_id",
        )] == [1, 2]
        await Replayer(workflows=[DiscoverWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
        assert len(attempts) == 2 and len(model.calls) == 3
    finally:
        run_in_activity.shutdown_activity_executors()
        pool.shutdown(wait=True)
        run_in_activity.set_activity_executor(previous)
        close_connection(path)
