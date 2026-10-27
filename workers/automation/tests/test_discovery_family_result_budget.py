"""Execution result admission through actual family runners and independent SQLite writers."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
import sqlite3
import threading
from types import SimpleNamespace
from uuid import uuid4

import pytest
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl import config, database
from jobctrl.database import close_connection, close_thread_connections, init_db
from jobctrl.discovery import jobspy, smartextract, workday
from jobctrl.discovery.activities import discovery_source_family_activity, plan_discovery_sources
from jobctrl.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
from jobctrl.domain.discovery import AtsKind
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.source_registry import (
    SourceKind, SourcePolicy, SourcePolicyMethod, SourcePriority, SourceRegistryEntry, SourceState,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.discovery import production_wiring
from jobctrl.infrastructure.discovery.result_budget import DiscoveryResultBudget
from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobctrl.infrastructure.temporal import run_in_activity
from jobctrl.pipeline import runner
from tests.smart_posting_fakes import install_smart_posting_models
from tests.temporal_env import time_skipping_env
from tests.test_captured_posting_recovery import capture
from tests.test_discovery_identity import _job
from tests.test_jobstreaming_source_result_budget import ManyIndeed, ManyLinkedIn
from tests.test_jobstreaming_resumable_discovery import _config, _NoopLimiter
from tests.test_workflow_discovery import (
    _automatic_compensation_refresh, _cancel_enrichment_cohort, _check_spend_budget,
    _discovery_enrichment, _discovery_preparation_fanout, _record_workflow_outcome, _record_workflow_started,
)
from tests.workflow_determination_fakes import install_page_models

ATS = "greenhouse:owned"
WORKDAY = "workday:owned"
SMART = "custom:owned-careers"
BOARD = "jobspy:indeed"
SOURCES = (ATS, WORKDAY, SMART, BOARD)
FAMILIES = ("ats_api", "workday", "smartextract", "jobspy")
EXECUTION = DiscoveryExecutionRef("local", "owned-family-limit", "owned-family-run")


def entry(source, kind, adapter):
    return SourceRegistryEntry(
        LOCAL_TENANT, source, kind, source, "system", SourcePriority.CANONICAL, SourceState.ACTIVE,
        SourcePolicy("owned-policy", (SourcePolicyMethod.API,), max_pages_per_run=7), adapter,
    )


@pytest.fixture
def owned(tmp_path, monkeypatch):
    path = tmp_path / "owned-family.db"
    conn = init_db(path)
    monkeypatch.setattr(database, "DB_PATH", path)
    monkeypatch.setattr(config, "DB_PATH", path)
    cfg = _config(boards=("indeed",))
    cfg.update(max_parallel_discovery_families=2, exact_title_exclusions=[])
    state = SimpleNamespace(conn=conn, path=path, cfg=cfg, key="one", cards=3, requests=[])
    registry = [
        entry(ATS, SourceKind.ATS_API, {"ats_kind": "greenhouse", "board_token": "owned"}),
        entry(WORKDAY, SourceKind.ATS_API, {"employer_key": "owned"}),
        entry(SMART, SourceKind.EMPLOYER_CAREERS_PAGE, {"name": "Owned Careers", "url": "https://example.test/careers"}),
        entry(BOARD, SourceKind.BROAD_BOARD, {"board": "indeed"}),
    ]
    monkeypatch.setattr(config, "load_source_registry", lambda **k: list(registry))
    monkeypatch.setattr(config, "load_search_config", lambda: cfg)
    monkeypatch.setattr(config, "load_sites_config", lambda: {})
    monkeypatch.setattr(config, "load_employers_config", lambda: {"employers": {
        "owned": {"name": "Owned Workday", "base_url": "https://owned.test", "site_id": "careers"},
    }})
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    from jobstreaming import AdapterRegistry, Site
    providers = AdapterRegistry()

    class OwnedIndeed(ManyIndeed):
        def scrape(self, request, context=None):
            return super().scrape(request.model_copy(update={"results_wanted": state.cards}), context)

    providers.register(Site.INDEED, OwnedIndeed)
    providers.register(Site.LINKEDIN, ManyLinkedIn)
    ManyIndeed.requests = []
    monkeypatch.setattr("jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *a, **k: providers)
    monkeypatch.setattr(smartextract, "prefer_live_browser", lambda *a, **k: None)
    monkeypatch.setattr("jobctrl.infrastructure.discovery.live_browser.prefer_live_browser", lambda *a, **k: None)
    install_page_models(monkeypatch)
    install_smart_posting_models(monkeypatch)

    def posting(index):
        from jobctrl.domain.ports.discovery import ScrapedJobPosting
        from jobctrl.domain.discovery import Employer, JobMetadata, PostingUrl, SearchStrategy, Source
        key = f"{state.key}-{index}"
        url = f"https://example.test/ats/{key}"
        return ScrapedJobPosting(
            posting_url=PostingUrl(url), source=Source("greenhouse"), employer=Employer(f"Owned ATS {key}"),
            metadata=JobMetadata(title=f"Owned ATS role {key}"), strategy=SearchStrategy.WORKDAY_API,
            source_id=ATS, source_native_id=key, canonical_url=url, ats_kind=AtsKind.GREENHOUSE,
        )

    class Adapter:
        source_id = ATS

        def scrape(self, **kwargs):
            state.requests.append("ats_api")
            yield from (posting(i) for i in range(state.cards))

    monkeypatch.setattr(production_wiring, "_adapter_for_source", lambda *a, **k: Adapter())

    def search_workday(*a, **k):
        state.requests.append("workday")
        return {"employer": "Owned Workday", "found": state.cards, "new": 0, "existing": 0, "jobs": [
            {"employer_key": "owned", "employer_name": f"Owned Workday {state.key}-{i}",
             "apply_url": f"https://example.test/workday/{state.key}-{i}", "title": f"Workday role {state.key}-{i}"}
            for i in range(state.cards)
        ]}

    monkeypatch.setattr(workday, "_search_and_fetch_one", search_workday)

    def smart_site(*a, **k):
        state.requests.append("smartextract")
        return {"name": "Owned Careers", "status": "OK", "strategy": "json_ld", "total": state.cards,
                "jobs": [{"url": f"https://example.test/smart/{state.key}-{i}", "title": f"Smart role {i}",
                          "company": f"Owned Smart {state.key}-{i}", "description": f"Owned posting {state.key}-{i}. " * 30}
                         for i in range(state.cards)]}

    monkeypatch.setattr(smartextract, "_run_one_site", smart_site)
    yield state
    close_connection(path)


def plan(state, *, limit=1, sources=SOURCES, execution=EXECUTION):
    result = runner.plan_discovery_source_families(
        limit=limit, source_ids=sources, discovery_execution=execution, use_source_result_budget=True,
    )
    return dict(
        limit=limit, source_ids=sources, start_count=result["start_count"], discovery_execution=execution,
        use_source_result_budget=result["use_source_result_budget"], source_result_limits=result["source_result_limits"],
        activity_attempt=1, activity_owner_token="owned-first",
    )


def receipts(conn, execution=EXECUTION):
    rows = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND event_type='DiscoveryNewJobAdmitted' "
        "AND json_extract(payload_json,'$.discovery_workflow_id')=? AND json_extract(payload_json,'$.discovery_run_id')=?",
        (execution.tenant_id, execution.workflow_id, execution.temporal_run_id),
    )
    return [json.loads(row[0]) for row in rows]


@pytest.mark.parametrize("family,source", tuple(zip(FAMILIES, SOURCES)))
@pytest.mark.parametrize("limit,cards,expected", [(1, 3, 1), (5, 2, 2)])
def test_actual_family_intake_uses_only_execution_receipts(owned, family, source, limit, cards, expected):
    owned.cards = cards
    kwargs = plan(owned, limit=limit, sources=(source,))
    # Independent writers commit after planning without changing this cap.
    with sqlite3.connect(owned.path) as control:
        control.row_factory = sqlite3.Row
        control.execute("PRAGMA foreign_keys=ON")
        for tenant in ("local", "foreign"):
            SqliteJobRepository(control).save(replace(
                _job(f"https://example.test/unrelated/{tenant}"), tenant_id=TenantId(tenant),
            ))
    other = DiscoveryExecutionRef("local", EXECUTION.workflow_id, "unrelated-run")
    other_budget = DiscoveryResultBudget(owned.conn, other, limit=1, start_count=0, source_limits={source: 1})
    repo = SqliteJobRepository(owned.conn, discovery_execution=other, source_family=family,
                             result_budget=other_budget, result_budget_source_id=source)
    from jobctrl.domain.discovery import CanonicalJobIdentity, JobSourceObservation
    job = _job("https://example.test/unrelated/other-run")
    repo.claim_new_job(job, CanonicalJobIdentity(job.posting_url.value, AtsKind.OTHER, "control", 1.0),
                       JobSourceObservation("control-observation", source, "control", job.posting_url.value, "control-source", "2026-01-01T00:00:00Z"))
    result = runner.run_discovery_source_family(family, **kwargs)
    assert result["status"] == "ok" and result["result"]["new"] == expected
    assert len(receipts(owned.conn)) == expected
    assert len(receipts(owned.conn, other)) == 1
    assert owned.conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == expected + 3
    again = runner.run_discovery_source_family(family, **{**kwargs, "activity_attempt": 2, "activity_owner_token": "owned-retry"})
    assert again["result"]["new"] == expected
    assert len(receipts(owned.conn)) == expected
    assert owned.conn.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.parametrize("trial", range(3))
@pytest.mark.parametrize("families,sources", [
    (("ats_api", "workday"), (ATS, WORKDAY)),
    (("ats_api", "smartextract"), (ATS, SMART)),
    (("workday", "jobspy"), (WORKDAY, BOARD)),
])
def test_concurrent_actual_families_race_independent_connections(owned, monkeypatch, trial, families, sources):
    kwargs = plan(owned, sources=sources)
    barrier = threading.Barrier(2)
    connections = set()
    claim = SqliteJobRepository.claim_new_job

    def overlap(repo, *args):
        if repo._result_budget is not None:
            connections.add(id(repo._conn))
            barrier.wait(timeout=10)
        return claim(repo, *args)

    monkeypatch.setattr(SqliteJobRepository, "claim_new_job", overlap)

    def run(family):
        try:
            return runner.run_discovery_source_family(family, **kwargs)
        finally:
            close_thread_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, families))
    assert len(connections) == 2
    assert all(result["status"] == "ok" for result in results)
    assert sum(result["result"]["new"] for result in results) == 1
    assert len(receipts(owned.conn)) == 1
    assert owned.conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    monkeypatch.setattr(SqliteJobRepository, "claim_new_job", claim)
    for family in families:
        assert runner.run_discovery_source_family(family, **kwargs)["status"] == "ok"
    assert len(receipts(owned.conn)) == 1


@pytest.mark.parametrize("family,source", tuple(zip(FAMILIES, SOURCES)))
def test_exhausted_zero_never_becomes_positive_source_allowance(owned, family, source):
    kwargs = plan(owned, sources=(source,))
    capture(owned.conn, "last-slot", source=source)
    # Recovery wins the last allowance before the fresh family fetch starts.
    result = runner.run_discovery_source_family(family, **kwargs)
    assert result["status"] == "ok" and result["result"]["new"] == 1
    assert len(receipts(owned.conn)) == 1
    assert not owned.requests and not ManyIndeed.requests
    assert owned.conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is not None


def test_per_source_cap_leaves_other_family_capacity(owned):
    kwargs = plan(owned, limit=3, sources=(ATS, WORKDAY))
    kwargs["source_result_limits"][ATS] = 1
    first = runner.run_discovery_source_family("ats_api", **kwargs)
    second = runner.run_discovery_source_family("workday", **kwargs)
    assert first["result"]["new"] == 1
    assert second["result"]["new"] == 2
    assert sorted(row["source_id"] for row in receipts(owned.conn)) == [ATS, WORKDAY, WORKDAY]


def test_foreign_observation_cannot_spend_another_source_allowance(owned):
    from tests.test_discovery_result_budget import prepared, EXECUTION as INTAKE_EXECUTION
    allowance = DiscoveryResultBudget(owned.conn, INTAKE_EXECUTION, limit=1, start_count=0, source_limits={BOARD: 1})
    parts = list(prepared(owned.conn, allowance))
    parts[-1] = replace(parts[-1], source_id=ATS)
    with pytest.raises(ValueError, match="observation source does not match"):
        parts[0].claim_new_job(*parts[1:])
    assert owned.conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


@pytest.mark.parametrize("family,source", tuple(zip(FAMILIES, SOURCES)))
def test_canceled_family_cannot_admit_or_start_another_provider(owned, family, source):
    kwargs = plan(owned, sources=(source,))
    cancel = threading.Event()
    cancel.set()
    result = runner.run_discovery_source_family(family, **kwargs, cancel_event=cancel)
    assert result["result"]["new"] == 0
    assert not receipts(owned.conn) and not owned.requests and not ManyIndeed.requests


def test_unbounded_user_request_retains_deliberate_semantics(owned):
    kwargs = plan(owned, limit=0, sources=(ATS, WORKDAY))
    assert kwargs["use_source_result_budget"] is False
    for family in ("ats_api", "workday"):
        assert runner.run_discovery_source_family(family, **kwargs)["status"] == "ok"
    assert owned.conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 6
    assert receipts(owned.conn) == []


@pytest.mark.parametrize("legacy", ["flag_false", "missing_plan", "missing_execution"])
def test_old_pending_bounded_payload_refuses_before_any_effect(owned, monkeypatch, legacy):
    kwargs = plan(owned, sources=(ATS, WORKDAY))
    capture(owned.conn, "retained", source=ATS)
    before = [tuple(row) for row in owned.conn.execute("SELECT * FROM posting_triage")]
    if legacy == "flag_false":
        kwargs["use_source_result_budget"] = False
    elif legacy == "missing_plan":
        kwargs.pop("source_result_limits")
    else:
        kwargs.pop("discovery_execution")
    monkeypatch.setattr(config, "load_search_config", lambda: pytest.fail("unsafe payload reached source planning"))
    from jobctrl.domain.errors import ConfigurationError
    with pytest.raises(ConfigurationError, match="Restart Discovery after upgrading"):
        runner.run_discovery_source_family("ats_api", **kwargs)
    assert [tuple(row) for row in owned.conn.execute("SELECT * FROM posting_triage")] == before
    assert not receipts(owned.conn) and not owned.requests
    assert owned.conn.execute("SELECT COUNT(*) FROM discovery_runs").fetchone()[0] == 0


def test_current_direct_bounded_path_defaults_to_safe_authority(owned):
    recorded = runner.plan_discovery_source_families(limit=1, source_ids=(ATS,), discovery_execution=EXECUTION)
    assert recorded["use_source_result_budget"] is True and recorded["start_count"] == 0
    result = runner.run_discovery_source_family(
        "ats_api", limit=1, source_ids=(ATS,), discovery_execution=EXECUTION,
        source_result_limits=recorded["source_result_limits"],
    )
    assert result["result"]["new"] == len(receipts(owned.conn)) == 1


def test_old_bounded_planning_payload_refuses_before_persistence(owned, monkeypatch):
    monkeypatch.setattr(runner, "init_db", lambda: pytest.fail("unsafe payload initialized storage"))
    from jobctrl.domain.errors import ConfigurationError
    with pytest.raises(ConfigurationError, match="Restart Discovery after upgrading"):
        runner.plan_discovery_source_families(limit=1, discovery_execution=EXECUTION, use_source_result_budget=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["planning", "source"])
async def test_actual_old_activity_refuses_before_lifecycle_or_provider_effects(owned, monkeypatch, kind):
    from temporalio.exceptions import ApplicationError
    from temporalio.testing import ActivityEnvironment
    from jobctrl.discovery.activities import DiscoverySourceActivityInput, PlanDiscoverySourcesInput
    monkeypatch.setattr(
        "jobctrl.discovery.activities.begin_pipeline_step_attempt",
        lambda *a, **k: pytest.fail("unsafe old activity persisted lifecycle state"),
    )
    function = plan_discovery_sources if kind == "planning" else discovery_source_family_activity
    payload = (PlanDiscoverySourcesInput(tenant_id="local", limit=1, discovery_execution=EXECUTION)
               if kind == "planning" else DiscoverySourceActivityInput(
                   tenant_id="local", family="ats_api", limit=1, discovery_execution=EXECUTION,
               ))
    with pytest.raises(ApplicationError, match="Restart Discovery after upgrading") as failure:
        output = ActivityEnvironment().run(function, payload)
        if asyncio.iscoroutine(output):
            await output
    assert failure.value.type == "configuration" and failure.value.non_retryable
    assert owned.conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
    assert not owned.requests


@pytest.mark.asyncio
async def test_real_temporal_family_admission_and_replay(owned, monkeypatch):
    # Real plan/source activities, runner and SQLite; only provider seams and
    # unrelated downstream enrichment/preparation/compensation are controlled.
    monkeypatch.setattr("jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime", lambda **k: None)
    monkeypatch.setattr("jobctrl.infrastructure.temporal.concurrency.resolved_max_parallel_discovery_families", lambda *a: 2)
    previous = run_in_activity._activity_executor()
    pool = run_in_activity.ActivityThreadPoolExecutor(max_workers=4)
    run_in_activity.set_activity_executor(pool)
    queue = f"owned-admission-{uuid4()}"
    try:
        async with time_skipping_env() as env:
            async with Worker(
                env.client, task_queue=queue, workflows=[DiscoverWorkflow],
                activities=[_check_spend_budget, _record_workflow_started, _record_workflow_outcome,
                            _cancel_enrichment_cohort, plan_discovery_sources, discovery_source_family_activity,
                            _discovery_enrichment, _discovery_preparation_fanout, _automatic_compensation_refresh],
                activity_executor=pool, workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    DiscoverWorkflow.run, DiscoverWorkflowInput(tenant_id="local", limit=1, source_ids=(ATS, WORKDAY)),
                    id=queue, task_queue=queue,
                )
                result = await asyncio.wait_for(handle.result(), 60)
                history = await handle.fetch_history()
        execution = DiscoveryExecutionRef("local", queue, handle.first_execution_run_id)
        assert result.families_failed == []
        assert result.families_completed == ["ats_api", "workday"]
        assert len(receipts(owned.conn, execution)) == 1
        assert owned.conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
        await Replayer(workflows=[DiscoverWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
    finally:
        run_in_activity.shutdown_activity_executors()
        pool.shutdown(wait=True)
        run_in_activity.set_activity_executor(previous)
