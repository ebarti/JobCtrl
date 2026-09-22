"""Cached Discovery connections must release writers on every retry outcome."""

from __future__ import annotations

import json
import sqlite3

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.discovery.activities import (
    DiscoverySourceActivityInput,
    DiscoverySourceActivityOutput,
    PlanDiscoverySourcesOutput,
)
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.enrichment import StaleEnrichmentExecutionLease
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment import detail
from jobctrl.infrastructure.enrichment.execution_lease import claim_enrichment_execution_lease
from jobctrl.state import record_job_event, set_stage_state

from .test_enrichment_queue_selectors import _mark_robots_blocked, _save_enriched, _seed_discovered


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "transaction-lifecycle.db"
    conn = init_db(path)
    peer = sqlite3.connect(path, timeout=0.1)
    try:
        yield conn, peer
    finally:
        peer.close()
        close_connection(path)


def _lease(conn, attempt=1):
    return claim_enrichment_execution_lease(
        conn,
        DiscoveryExecutionRef(tenant_id="local", workflow_id="discover-fixture", temporal_run_id="run-fixture"),
        owner_token=f"owner-{attempt}",
        activity_phase=1,
        activity_attempt=attempt,
    )


def _stage(conn, job_id):
    return tuple(
        conn.execute("SELECT * FROM job_stage_states WHERE job_id = ? AND stage = 'enrich'", (str(job_id),)).fetchone()
    )


def _assert_writer_released(conn, peer):
    assert not conn.in_transaction
    peer.execute("BEGIN IMMEDIATE")
    record_job_event(peer, None, "discover", "PeerPersisted", message="Synthetic independent writer")
    peer.commit()
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type = 'PeerPersisted'").fetchone()[0] > 0
    assert _lease(conn, attempt=2).activity_attempt == 2
    assert not conn.in_transaction


@pytest.mark.parametrize("with_lease", [True, False])
def test_repeated_retry_denial_preserves_metadata_and_releases_cached_writer(database, with_lease):
    conn, peer = database
    job_id = _seed_discovered(conn, "https://fixture.example/jobs/blocked")
    _mark_robots_blocked(conn, job_id)
    lease = _lease(conn) if with_lease else None
    kwargs = {"tenant_id": LOCAL_TENANT, "activity_lease": lease}
    assert detail._claim_robots_retry_for_workflow(conn, job_id, "discover-fixture:run-fixture", **kwargs)
    accepted = _stage(conn, job_id)
    for _ in range(3):
        assert not detail._claim_robots_retry_for_workflow(conn, job_id, "discover-fixture:run-fixture", **kwargs)
        assert _stage(conn, job_id) == accepted
        assert not conn.in_transaction
    _assert_writer_released(conn, peer)


@pytest.mark.parametrize("outcome", ["cas_lost", "write_error"])
@pytest.mark.parametrize("with_lease", [True, False])
def test_retry_update_failure_releases_only_its_owned_transaction(database, outcome, with_lease):
    conn, peer = database
    job_id = _seed_discovered(conn, "https://fixture.example/jobs/blocked")
    _mark_robots_blocked(conn, job_id)
    lease = _lease(conn) if with_lease else None
    before = _stage(conn, job_id)
    fault = "RAISE(IGNORE)" if outcome == "cas_lost" else "RAISE(ABORT, 'fixture write rejected')"
    conn.execute(f"CREATE TEMP TRIGGER reject_retry BEFORE UPDATE ON job_stage_states BEGIN SELECT {fault}; END")
    kwargs = {"tenant_id": LOCAL_TENANT, "activity_lease": lease}
    if outcome == "cas_lost":
        assert not detail._claim_robots_retry_for_workflow(conn, job_id, "next-run", **kwargs)
    else:
        with pytest.raises(sqlite3.IntegrityError, match="fixture write rejected"):
            detail._claim_robots_retry_for_workflow(conn, job_id, "next-run", **kwargs)
    assert _stage(conn, job_id) == before
    _assert_writer_released(conn, peer)


def test_retry_claim_rejects_inherited_transaction_without_committing_or_rolling_it_back(database):
    conn, peer = database
    job_id = _seed_discovered(conn, "https://fixture.example/jobs/blocked")
    _mark_robots_blocked(conn, job_id)
    lease = _lease(conn)
    before = _stage(conn, job_id)
    conn.execute("UPDATE jobs SET title = 'uncommitted caller edit' WHERE job_id = ?", (str(job_id),))
    with pytest.raises(sqlite3.OperationalError, match="within a transaction"):
        detail._claim_robots_retry_for_workflow(conn, job_id, "next-run", tenant_id=LOCAL_TENANT, activity_lease=lease)
    assert conn.in_transaction
    assert (
        conn.execute("SELECT title FROM jobs WHERE job_id = ?", (str(job_id),)).fetchone()[0]
        == "uncommitted caller edit"
    )
    assert peer.execute("SELECT title FROM jobs WHERE job_id = ?", (str(job_id),)).fetchone()[0] == "Engineer"
    assert _stage(conn, job_id) == before
    conn.rollback()
    _assert_writer_released(conn, peer)


def test_stale_retry_owner_cannot_change_current_stage_or_retain_writer(database):
    conn, peer = database
    job_id = _seed_discovered(conn, "https://fixture.example/jobs/blocked")
    _mark_robots_blocked(conn, job_id)
    old = _lease(conn)
    current = _lease(peer, attempt=2)
    assert detail._claim_robots_retry_for_workflow(
        peer, job_id, "current-run", tenant_id=LOCAL_TENANT, activity_lease=current
    )
    before = _stage(conn, job_id)
    with pytest.raises(StaleEnrichmentExecutionLease):
        detail._claim_robots_retry_for_workflow(conn, job_id, "current-run", tenant_id=LOCAL_TENANT, activity_lease=old)
    assert _stage(conn, job_id) == before
    _assert_writer_released(conn, peer)


def test_failed_failure_recording_releases_writer_and_preserves_accepted_artifact(database):
    conn, peer = database
    job_id = _seed_discovered(conn, "https://fixture.example/jobs/accepted")
    _mark_robots_blocked(conn, job_id)
    _save_enriched(conn, job_id)
    set_stage_state(conn, job_id, "enrich", "succeeded", validate_transition=False)
    conn.commit()
    lease = _lease(conn)
    before = _stage(conn, job_id)
    artifact = tuple(conn.execute("SELECT * FROM job_enrichments WHERE job_id = ?", (str(job_id),)).fetchone())
    conn.execute(
        "CREATE TEMP TRIGGER reject_failure BEFORE UPDATE ON job_stage_states "
        "BEGIN SELECT RAISE(ABORT, 'fixture failure persistence rejected'); END"
    )
    detail._record_enrich_job_failure(
        conn,
        job_id,
        "https://fixture.example/jobs/accepted",
        RuntimeError("fixture audit failure"),
        tenant_id=LOCAL_TENANT,
        activity_lease=lease,
    )
    assert _stage(conn, job_id) == before
    assert tuple(conn.execute("SELECT * FROM job_enrichments WHERE job_id = ?", (str(job_id),)).fetchone()) == artifact
    _assert_writer_released(conn, peer)


def _seed_terminal_tailor(conn, terminal="exhausted"):
    from jobctrl.pipeline.preparation import current_scoring_policy_version
    from jobctrl.state import ensure_job_stage_rows, reconcile_tailor_terminal_dependents

    job_id = _seed_discovered(conn, "https://fixture.example/jobs/terminal-tailor")
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(conn, job_id, "tailor", terminal, validate_transition=False)
    reconcile_tailor_terminal_dependents(conn)
    conn.commit()
    current_scoring_policy_version(conn, LOCAL_TENANT)
    assert not conn.in_transaction
    return job_id


@pytest.mark.parametrize("terminal", ["failed", "exhausted"])
def test_repeated_empty_preparation_releases_writer_with_existing_policy(database, monkeypatch, terminal):
    from jobctrl.pipeline import preparation

    conn, peer = database
    _seed_terminal_tailor(conn, terminal)
    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    before = [tuple(row) for row in conn.execute("SELECT * FROM job_stage_states ORDER BY job_id, stage")]
    for _ in range(3):
        assert preparation.derive_preparation_targets(preparation.DerivePreparationTargetsInput()) == []
        assert [tuple(row) for row in conn.execute("SELECT * FROM job_stage_states ORDER BY job_id, stage")] == before
        _assert_writer_released(conn, peer)


def test_preparation_reconciliation_error_rolls_back_all_dependent_changes(database, monkeypatch):
    from jobctrl.pipeline import preparation

    conn, peer = database
    job_id = _seed_terminal_tailor(conn)
    conn.execute(
        "UPDATE job_stage_states SET state = 'pending' WHERE job_id = ? AND stage IN ('cover', 'apply')", (str(job_id),)
    )
    conn.commit()
    before = [tuple(row) for row in conn.execute("SELECT * FROM job_stage_states ORDER BY job_id, stage")]
    conn.execute(
        "CREATE TEMP TRIGGER reject_second_dependent BEFORE UPDATE ON job_stage_states "
        "WHEN NEW.stage = 'apply' BEGIN SELECT RAISE(ABORT, 'fixture dependent write failed'); END"
    )
    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    with pytest.raises(sqlite3.IntegrityError, match="fixture dependent write failed"):
        preparation.derive_preparation_targets(preparation.DerivePreparationTargetsInput())
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_stage_states ORDER BY job_id, stage")] == before
    _assert_writer_released(conn, peer)


def test_preparation_rejects_inherited_writes_without_committing_or_rolling_back(database, monkeypatch):
    from jobctrl.pipeline import preparation

    conn, peer = database
    job_id = _seed_terminal_tailor(conn)
    conn.execute("UPDATE jobs SET title = 'pending caller edit' WHERE job_id = ?", (str(job_id),))
    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    with pytest.raises(sqlite3.OperationalError, match="within a transaction"):
        preparation.derive_preparation_targets(preparation.DerivePreparationTargetsInput())
    assert conn.in_transaction
    assert (
        conn.execute("SELECT title FROM jobs WHERE job_id = ?", (str(job_id),)).fetchone()[0] == "pending caller edit"
    )
    assert peer.execute("SELECT title FROM jobs WHERE job_id = ?", (str(job_id),)).fetchone()[0] == "Engineer"
    conn.rollback()
    _assert_writer_released(conn, peer)


@pytest.mark.asyncio
@pytest.mark.parametrize("connected", [True, False])
@pytest.mark.parametrize("source_fails", [False, True])
async def test_real_discover_workflow_closes_empty_fanout_before_enrichment(
    tmp_path, monkeypatch, connected, source_fails
):
    """Real workflow/activities/SQLite; source, Chrome and LLM I/O are owned fixtures."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from contextlib import nullcontext
    from types import SimpleNamespace
    from uuid import uuid4

    from temporalio import activity
    from temporalio.client import WorkflowFailureError
    from temporalio.exceptions import ApplicationError
    from temporalio.worker import UnsandboxedWorkflowRunner, Worker
    from jobctrl import config, database as db_module
    from jobctrl.discovery.activities import discovery_enrichment_activity, discovery_preparation_fanout_activity
    from jobctrl.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
    from jobctrl.infrastructure.discovery.sqlite_execution_repository import SqliteDiscoveryExecutionRepository
    from jobctrl.infrastructure.network import PublicUrlDecision
    from jobctrl.infrastructure.temporal import run_in_activity
    from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
    from jobctrl.pipeline import preparation
    from jobctrl.state import ensure_job_stage_rows
    from .live_browser_helpers import FixtureBrowserBroker
    from .politeness_helpers import offline_gateway
    from .temporal_env import time_skipping_env
    from .test_enrichment_politeness_gate import _OfflineLlm, _SpyPage
    from .test_workflow_discovery import _automatic_compensation_refresh, _check_spend_budget

    path = tmp_path / "workflow.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.setattr(db_module, "DB_PATH", path)
    monkeypatch.setattr(config, "load_search_config", lambda: {})
    conn = init_db(path)
    terminal = _seed_terminal_tailor(conn)
    original_terminal = [
        tuple(row)
        for row in conn.execute("SELECT * FROM job_stage_states WHERE job_id = ? ORDER BY stage", (str(terminal),))
    ]
    description = "Lead engineering teams and build reliable distributed systems with Python and TypeScript. " * 10
    posting = {
        "@type": "JobPosting",
        "description": description,
        "url": "https://fixture.example/apply",
        "directApply": True,
    }
    html = (
        '<html><body><script type="application/ld+json">'
        + json.dumps(posting)
        + "</script><main>"
        + description
        + "</main></body></html>"
    )
    anonymous_urls = []
    source_jobs = []
    starts = []

    class Page(_SpyPage):
        def goto(self, url, **kwargs):
            self.url = url
            return super().goto(url, **kwargs)

        def query_selector_all(self, selector):
            assert selector == 'script[type="application/ld+json"]'
            return [SimpleNamespace(inner_text=lambda: json.dumps(posting))]

        def query_selector(self, _selector):
            return SimpleNamespace(inner_text=lambda: description, inner_html=lambda: description)

    page = Page(anonymous_urls)
    browser = SimpleNamespace(close=lambda: None)
    browser.new_context = lambda **_kwargs: SimpleNamespace(new_page=lambda: page)
    playwright = SimpleNamespace(chromium=SimpleNamespace(launch=lambda **_kwargs: browser))
    broker = FixtureBrowserBroker(
        tmp_path,
        lambda url: {
            "status": "succeeded",
            "finalUrl": url,
            "statusCode": 200,
            "contentType": "text/html",
            "title": "Engineering lead",
            "bodyText": description,
            "bodyHtml": html,
        },
        connected=connected,
    )
    monkeypatch.setattr(detail, "LiveChromeDiscoveryClient", broker.client)
    monkeypatch.setattr(detail, "sync_playwright", lambda: nullcontext(playwright))
    monkeypatch.setattr(detail, "PolitenessGateway", offline_gateway)
    monkeypatch.setattr(detail, "get_llm_adapter", _OfflineLlm)
    monkeypatch.setattr(detail, "validate_public_http_url", lambda _url: PublicUrlDecision(True))
    monkeypatch.setattr(detail, "LinkedInApplyUrlResolver", lambda **_kwargs: pytest.fail("copied profile opened"))

    async def start_owned_preparation(spec):
        # Scoring/material generation is outside this transport/transaction fixture.
        starts.append(spec.workflow_id)
        return SimpleNamespace(id=spec.workflow_id)

    monkeypatch.setattr(preparation, "default_workflow_starter", start_owned_preparation)

    @activity.defn(name="plan_discovery_sources")
    async def plan_source(_payload) -> PlanDiscoverySourcesOutput:
        return PlanDiscoverySourcesOutput(families=["jobspy"], progress_total=3, start_count=0, max_parallel_families=1)

    @activity.defn(name="discovery_source_family")
    async def persist_source(payload: DiscoverySourceActivityInput) -> DiscoverySourceActivityOutput:
        # This independent event-loop writer runs after the backlog activity's
        # executor returned. Production lineage/persistence still owns the rows.
        source_conn = db_module.get_connection()
        execution = payload.discovery_execution
        assert execution is not None
        for suffix in ("already-retried", "healthy-peer"):
            url = f"https://www.linkedin.com/jobs/view/{suffix}"
            job_id = _seed_discovered(source_conn, url)
            source_conn.execute("UPDATE jobs SET site = 'linkedin' WHERE job_id = ?", (str(job_id),))
            ensure_job_stage_rows(source_conn, job_id)
            source_conn.commit()
            if suffix == "already-retried":
                _mark_robots_blocked(source_conn, job_id)
                source_conn.execute(
                    "UPDATE job_stage_states SET metadata_json = ? WHERE job_id = ? AND stage = 'enrich'",
                    (
                        json.dumps({"lastRobotsRetryWorkflow": f"{execution.workflow_id}:{execution.temporal_run_id}"}),
                        str(job_id),
                    ),
                )
                source_conn.commit()
            SqliteDiscoveryExecutionRepository(source_conn).link_job(
                execution,
                job_id,
                cohort_kind="observed_this_run",
                source_family="jobspy",
                source_run_id="fixture-source",
            )
            source_jobs.append(job_id)
        record_job_event(source_conn, None, "discover", "FixtureSourcePersisted", message="Owned source persisted")
        source_conn.commit()
        if source_fails:
            raise ApplicationError(
                "fixture source failed after partial intake", type="source_unavailable", non_retryable=True
            )
        return DiscoverySourceActivityOutput(family="jobspy", status="ok", result={"new": 2})

    previous_executor = run_in_activity._activity_executor()
    monkeypatch.setattr(run_in_activity, "_RETIRED_ACTIVITY_EXECUTORS", [])
    pool = ThreadPoolExecutor(max_workers=2)
    run_in_activity.set_activity_executor(pool)
    try:
        queue = f"transaction-fixture-{uuid4()}"
        async with time_skipping_env() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[DiscoverWorkflow],
                activities=[
                    _check_spend_budget,
                    record_workflow_started,
                    record_workflow_outcome,
                    plan_source,
                    persist_source,
                    discovery_preparation_fanout_activity,
                    discovery_enrichment_activity,
                    _automatic_compensation_refresh,
                ],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    DiscoverWorkflow.run, DiscoverWorkflowInput(tenant_id="local", limit=2), id=queue, task_queue=queue
                )
                if source_fails:
                    with pytest.raises(WorkflowFailureError) as failed:
                        await asyncio.wait_for(handle.result(), timeout=40)
                    assert isinstance(failed.value.cause, ApplicationError)
                    assert failed.value.cause.type == "discovery_source_failed"
                else:
                    result = await asyncio.wait_for(handle.result(), timeout=40)
                    assert result.families_completed == ["jobspy"]
                    assert result.families_failed == []
                    assert result.enrichment_status == "ok"
                history = await handle.fetch_history()
        assert source_jobs and len(source_jobs) == 2
        retry, healthy = source_jobs
        aggregate = detail.SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, healthy)
        assert aggregate is not None and aggregate.is_enriched
        assert aggregate.full_description.text == description.strip()
        retry_row = conn.execute(
            "SELECT state, attempt_count FROM job_stage_states WHERE job_id = ? AND stage = 'enrich'", (str(retry),)
        ).fetchone()
        assert tuple(retry_row) == ("blocked", 0)
        assert (
            conn.execute(
                "SELECT state FROM job_stage_states WHERE job_id = ? AND stage = 'enrich'", (str(healthy),)
            ).fetchone()[0]
            == "succeeded"
        )
        assert [
            tuple(row)
            for row in conn.execute("SELECT * FROM job_stage_states WHERE job_id = ? ORDER BY stage", (str(terminal),))
        ] == original_terminal
        completed_steps = [
            json.loads(row[0])
            for row in conn.execute("SELECT payload_json FROM job_events WHERE event_type = 'PipelineStepCompleted'")
        ]
        assert any(row["stepKind"] == "existing_backlog_sweep" for row in completed_steps)
        assert any(row["stepKind"] == "enrichment_pass" for row in completed_steps)
        terminal_event = "WorkflowFailed" if source_fails else "WorkflowCompleted"
        assert (
            conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type = ?", (terminal_event,)).fetchone()[0] == 1
        )
        assert (
            conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type = 'FixtureSourcePersisted'").fetchone()[0]
            == 1
        )
        terminal_attribute = (
            "workflow_execution_failed_event_attributes"
            if source_fails
            else "workflow_execution_completed_event_attributes"
        )
        assert any(event.HasField(terminal_attribute) for event in history.events)
        assert starts
        healthy_url = "https://www.linkedin.com/jobs/view/healthy-peer"
        assert broker.visited == ([healthy_url] if connected else [])
        assert anonymous_urls == ([] if connected else [healthy_url])
        assert broker.tasks == {}
        assert not conn.in_transaction
    finally:
        # Both executor-thread caches must close on their owning threads.
        import threading

        barrier = threading.Barrier(2)

        def close_owned_thread():
            close_connection(path)
            barrier.wait(timeout=5)

        loop = asyncio.get_running_loop()
        active_pool = run_in_activity._activity_executor()
        await asyncio.gather(*(loop.run_in_executor(active_pool, close_owned_thread) for _ in range(2)))
        run_in_activity.shutdown_activity_executors()
        pool.shutdown(wait=True)
        if active_pool is not None:
            active_pool.shutdown(wait=True)
        run_in_activity.set_activity_executor(previous_executor)
        close_connection(path)
