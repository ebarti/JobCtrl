"""Regression tests for the discovery-enrichment reliability fixes.

These reproduce the production incident where a missing Playwright browser
binary crashed the whole enrichment stage and the failure collapsed to the
useless message ``discover:enrichment failed: failed``. Every test is
network-free: scraping and browsers are stubbed.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import sqlite3
import threading
from pathlib import Path
from types import SimpleNamespace
from uuid import NAMESPACE_URL, uuid5

import pytest
from temporalio.exceptions import ApplicationError

from jobctrl.database import close_connection, init_db
from jobctrl.discovery import activities
from jobctrl.discovery.activities import (
    DiscoveryEnrichmentActivityInput,
    DiscoveryPreparationFanoutInput,
    DiscoverySourceActivityInput,
    _is_success_status,
    _stage_failure_error,
)
from jobctrl.domain.errors import ConfigurationError, TransientNetworkError
from jobctrl.domain.enrichment import (
    EnrichmentExecutionLease,
    EnrichmentError,
    ExtractionTier,
    FullDescription,
    JobEnrichment,
    StaleEnrichmentExecutionLease,
)
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.scheduler import SourceQualitySnapshot
from jobctrl.domain.discovery.source_registry import (
    BROAD_BOARD_LEAD_POLICY,
    SourceKind,
    SourcePriority,
    SourceRegistryEntry,
    SourceState,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment import detail
from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
from jobctrl.pipeline import runner

from .politeness_helpers import offline_gateway


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


def _long_description() -> str:
    return "Build reliable distributed systems with Python and TypeScript. " * 8


class _FakeBrowser:
    def new_context(self, **_kwargs):
        return self

    def new_page(self):
        return object()

    def close(self) -> None:
        return None


class _FakeChromium:
    def launch(self, **_kwargs):
        return _FakeBrowser()


class _FakePlaywright:
    chromium = _FakeChromium()

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None


def _seed_pending(conn: sqlite3.Connection, url: str, site: str) -> JobId:
    job_id = JobId(str(uuid5(NAMESPACE_URL, url)))
    discovered_at = "2026-01-01T00:00:00+00:00"
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            str(LOCAL_TENANT),
            str(job_id),
            url,
            "Engineer",
            site,
            discovered_at,
        ),
    )
    conn.execute(
        "INSERT INTO job_locators (tenant_id, job_id, locator_kind, locator_value, "
        "is_current, first_seen_at, last_seen_at) VALUES (?, ?, 'posting_url', ?, 1, ?, ?)",
        (str(LOCAL_TENANT), str(job_id), url, discovered_at, discovered_at),
    )
    conn.commit()
    return job_id


# ---------------------------------------------------------------------------
# Activity error fidelity (regression for "failed: failed")
# ---------------------------------------------------------------------------


def test_stage_failure_error_carries_real_class_and_message() -> None:
    err = _stage_failure_error(
        "discover:enrichment",
        {
            "status": "failed",
            "error_class": "ConfigurationError",
            "error_message": "BrowserType.launch: Executable doesn't exist at /x",
            "error_code": "configuration",
            "retryable": False,
            "passes": 3,
            "pending": 5,
            "site_errors": {"linkedin": {"error_class": "Error", "error_message": "boom"}},
            "error_traceback": "Traceback (most recent call last): ...",
        },
    )

    assert isinstance(err, ApplicationError)
    assert "ConfigurationError" in str(err)
    assert "Executable doesn't exist" in str(err)
    assert "failed: failed" not in str(err)
    assert err.type == "configuration"
    assert err.non_retryable is True
    detail_payload = err.details[0]
    assert detail_payload["errorClass"] == "ConfigurationError"
    assert detail_payload["passes"] == 3
    assert detail_payload["pending"] == 5
    assert detail_payload["siteErrors"] == {
        "linkedin": {"error_class": "Error", "error_message": "boom"}
    }
    assert detail_payload["traceback"].startswith("Traceback")


def test_stage_failure_error_falls_back_to_status_without_class() -> None:
    err = _stage_failure_error("discover:enrichment", {"status": "stuck: 5 pending"})
    assert err.message == "discover:enrichment failed: stuck: 5 pending"
    assert err.type == "stage_failed"
    assert err.non_retryable is False


@pytest.mark.parametrize(
    "status,expected",
    [
        ("ok", True),
        ("partial", True),
        ("skipped", True),
        ("already_done", True),
        ("skipped_limit", True),
        ("skipped_disabled", True),
        ("skipped_quality", True),
        ("failed", False),
        ("stuck: 5 pending detail jobs after 3 passes", False),
    ],
)
def test_is_success_status(status: str, expected: bool) -> None:
    assert _is_success_status(status) is expected


@pytest.mark.asyncio
async def test_discovery_enrichment_activity_raises_real_cause_not_failed_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )

    async def fake_run_blocking(fn, **_kwargs):
        return fn()

    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    monkeypatch.setattr(
        "jobctrl.pipeline.runner.run_discovery_enrichment_stage",
        lambda **_kwargs: {
            "status": "failed",
            "error_class": "Error",
            "error_message": "BrowserType.launch: Executable doesn't exist at /x",
            "error_code": "configuration",
            "retryable": False,
        },
    )
    monkeypatch.setattr("jobctrl.pipeline.runner.run_discovery_hygiene", lambda _label: 0)
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_a, **_k: None)

    with pytest.raises(ApplicationError) as excinfo:
        await activities.discovery_enrichment_activity(
            DiscoveryEnrichmentActivityInput(tenant_id="local")
        )

    err = excinfo.value
    assert "Executable doesn't exist" in str(err)
    assert "failed: failed" not in str(err)
    assert err.type == "configuration"
    assert err.non_retryable is True


@pytest.mark.asyncio
async def test_discovery_enrichment_activity_reports_partial_with_site_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )

    async def fake_run_blocking(fn, **_kwargs):
        return fn()

    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    monkeypatch.setattr(
        "jobctrl.pipeline.runner.run_discovery_enrichment_stage",
        lambda **_kwargs: {
            "status": "partial",
            "passes": 2,
            "pending": 0,
            "site_errors": {"linkedin": {"error_class": "Error", "error_message": "boom"}},
        },
    )
    monkeypatch.setattr("jobctrl.pipeline.runner.run_discovery_hygiene", lambda _label: 0)
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_a, **_k: None)

    result = await activities.discovery_enrichment_activity(
        DiscoveryEnrichmentActivityInput(tenant_id="local")
    )

    assert result.status == "partial"
    assert result.site_errors == {"linkedin": {"error_class": "Error", "error_message": "boom"}}


@pytest.mark.asyncio
async def test_discovery_enrichment_activity_reuses_execution_key_across_activity_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )

    async def fake_run_blocking(fn, **_kwargs):
        return fn()

    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    captured: list[str | None] = []

    def fake_run_stage(**kwargs):
        captured.append(kwargs.get("recovery_key"))
        return {"status": "ok", "passes": 1, "pending": 0}

    monkeypatch.setattr(
        "jobctrl.pipeline.runner.run_discovery_enrichment_stage",
        fake_run_stage,
    )
    monkeypatch.setattr("jobctrl.pipeline.runner.run_discovery_hygiene", lambda _label: 0)
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_a, **_k: None)
    monkeypatch.setattr(activities, "begin_pipeline_step_attempt", lambda _scope: None)
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-workflow-1",
        temporal_run_id="temporal-run-1",
    )
    payload = DiscoveryEnrichmentActivityInput(
        tenant_id="local",
        discovery_execution=execution,
    )

    await activities.discovery_enrichment_activity(payload)
    await activities.discovery_enrichment_activity(payload)

    assert captured == [
        "discover-workflow-1:temporal-run-1",
        "discover-workflow-1:temporal-run-1",
    ]


@pytest.mark.asyncio
async def test_live_enrichment_cancellation_does_not_persist_a_false_terminal_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )

    async def canceled_run(_fn, **_kwargs):
        raise asyncio.CancelledError()

    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        canceled_run,
    )

    monkeypatch.setattr(
        activities,
        "begin_pipeline_step_attempt",
        lambda _scope: pytest.fail("live enrichment must stay runtime-only"),
    )
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-workflow-1",
        temporal_run_id="temporal-run-1",
    )

    with pytest.raises(asyncio.CancelledError):
        await activities.discovery_enrichment_activity(
            DiscoveryEnrichmentActivityInput(
                tenant_id="local",
                discovery_execution=execution,
                stream_while_discovering=True,
            )
        )



@pytest.mark.asyncio
async def test_discovery_source_family_activity_treats_skipped_limit_as_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )

    async def fake_run_blocking(fn, **_kwargs):
        return fn()

    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    monkeypatch.setattr(
        "jobctrl.pipeline.runner.run_discovery_source_family",
        lambda *_a, **_k: {
            "family": "ats_api",
            "status": "skipped_limit",
            "result": {},
            "source_ids": ["ats:x"],
        },
    )

    result = await activities.discovery_source_family_activity(
        DiscoverySourceActivityInput(tenant_id="local", family="ats_api")
    )

    assert result.status == "skipped_limit"
    assert result.source_ids == ["ats:x"]


@pytest.mark.parametrize(
    ("worker_shutdown", "expected_set"),
    [(True, False), (False, True)],
)
def test_source_cancellation_keeps_worker_shutdown_recoverable(
    monkeypatch: pytest.MonkeyPatch,
    worker_shutdown: bool,
    expected_set: bool,
) -> None:
    cancel_event = threading.Event()
    monkeypatch.setattr(
        activities.activity,
        "cancellation_details",
        lambda: SimpleNamespace(worker_shutdown=worker_shutdown),
    )

    activities._signal_source_cancellation(cancel_event)

    assert cancel_event.is_set() is expected_set


def test_explicit_source_selection_overrides_adaptive_quality_demotion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_id = "jobspy:indeed"
    entry = SourceRegistryEntry(
        tenant_id=LOCAL_TENANT,
        source_id=source_id,
        kind=SourceKind.BROAD_BOARD,
        display_name="JobStreaming Indeed",
        owner="system",
        priority=SourcePriority.LEAD_GENERATOR,
        state=SourceState.EXPERIMENTAL,
        policy=BROAD_BOARD_LEAD_POLICY,
        adapter_config={"board": "indeed"},
    )
    monkeypatch.setattr(
        runner.config,
        "load_source_registry",
        lambda **_kwargs: [entry],
    )
    monkeypatch.setattr(
        runner,
        "_load_source_quality_snapshots",
        lambda: (
            SourceQualitySnapshot(
                source_id=source_id,
                consecutive_failures=5,
            ),
        ),
    )

    automatic = runner._plan_discovery_schedule(500)
    selected = runner._plan_discovery_schedule(500, source_ids=(source_id,))

    assert automatic.sources[0].should_run is False
    assert automatic.sources[0].recommended_state == "disabled"
    assert selected.sources[0].should_run is True
    assert selected.sources[0].reason == "no quality history"


@pytest.mark.asyncio
async def test_discovery_next_run_settings_stay_frozen_after_planning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    persisted = {
        "boards": ["indeed"],
        "defaults": {"results_per_site": 20, "hours_old": 48},
        "role_filter": {"mode": "auto", "model": None},
        "crawl_user_agent": {"product": "JobCtrl", "contact": "old@example.test"},
    }
    planned_settings = runner._snapshot_discovery_next_run_settings(persisted)
    monkeypatch.setattr(
        runner,
        "plan_discovery_source_families",
        lambda **_kwargs: {
            "families": ["jobspy"],
            "progress_total": 3,
            "start_count": 0,
            "max_parallel_families": 1,
            "next_run_settings": planned_settings,
        },
    )
    plan = activities.plan_discovery_sources(
        activities.PlanDiscoverySourcesInput(tenant_id="local")
    )

    persisted = {
        "boards": ["linkedin"],
        "defaults": {"results_per_site": 99, "hours_old": 1},
        "role_filter": {"mode": "llm", "model": "claude:sonnet"},
        "crawl_user_agent": {"product": "Changed", "contact": "new@example.test"},
    }
    captured: dict[str, object] = {}

    async def fake_run_blocking(fn, **_kwargs):
        return fn()

    def fake_run_family(family: str, **kwargs):
        captured.update(kwargs)
        return {"family": family, "status": "ok", "result": {}, "source_ids": []}

    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    monkeypatch.setattr(runner, "run_discovery_source_family", fake_run_family)

    await activities.discovery_source_family_activity(
        DiscoverySourceActivityInput(
            tenant_id="local",
            family="jobspy",
            next_run_settings=plan.next_run_settings,
        )
    )

    assert captured["next_run_settings"] == planned_settings
    captured_settings = captured["next_run_settings"]
    assert isinstance(captured_settings, dict)
    effective = runner._apply_discovery_next_run_settings(
        persisted,
        captured_settings,
    )
    assert effective["boards"] == ["indeed"]
    assert effective["defaults"] == {"results_per_site": 20, "hours_old": 48}
    assert effective["role_filter"] == {"mode": "llm", "model": "claude:sonnet"}
    assert effective["crawl_user_agent"] == {
        "product": "Changed",
        "contact": "new@example.test",
    }


def test_source_planning_does_not_run_hygiene_before_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runner, "init_db", lambda: object())
    monkeypatch.setattr(runner.config, "load_search_config", lambda: {})
    monkeypatch.setattr(runner.config, "load_source_registry", lambda **_kwargs: [])
    monkeypatch.setattr(runner, "seed_discovery_control_queues", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        runner,
        "_plan_discovery_schedule",
        lambda *_args, **_kwargs: runner.DiscoverySchedule(()),
    )
    monkeypatch.setattr(runner, "_pipeline_job_count", lambda: 0)
    monkeypatch.setattr(
        runner,
        "run_discovery_hygiene",
        lambda _label: pytest.fail("source planning must not block on historical-job hygiene"),
    )

    plan = runner.plan_discovery_source_families(limit=500)

    assert plan["families"] == ["jobspy", "workday", "smartextract"]


# ---------------------------------------------------------------------------
# Per-site fault isolation (THE incident shape)
# ---------------------------------------------------------------------------


def _healthy_stats() -> dict:
    return {"processed": 2, "ok": 2, "partial": 0, "error": 0, "tiers": {1: 2}}


@pytest.mark.parametrize("workers", [1, 2])
def test_run_detail_scraper_isolates_failed_site(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, workers: int
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        _seed_pending(conn, "https://remoteok.com/1", "RemoteOK")
        _seed_pending(conn, "https://jobbank.ca/1", "Job Bank Canada")

        def fake_batch(
            _conn,
            site,
            jobs,
            max_jobs=None,
            cancel_event=None,
            on_job_enriched=None,
            **_politeness,
        ):
            if site == "RemoteOK":
                raise RuntimeError("BrowserType.launch: Executable doesn't exist at /x")
            return _healthy_stats()

        monkeypatch.setattr(detail, "scrape_site_batch", fake_batch)

        stats = detail._run_detail_scraper(conn, workers=workers, reset_linkedin_candidates=False)

        assert stats["processed"] == 2
        assert stats["ok"] == 2
        assert "Job Bank Canada" not in stats["site_errors"]
        assert stats["site_errors"]["RemoteOK"]["error_class"] == "RuntimeError"
        assert "Executable doesn't exist" in stats["site_errors"]["RemoteOK"]["error_message"]
    finally:
        close_connection(db_path)


def test_run_detail_scraper_raises_configuration_error_when_all_sites_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        _seed_pending(conn, "https://remoteok.com/1", "RemoteOK")
        _seed_pending(conn, "https://jobbank.ca/1", "Job Bank Canada")

        def fake_batch(
            _conn,
            site,
            jobs,
            max_jobs=None,
            cancel_event=None,
            on_job_enriched=None,
            **_politeness,
        ):
            raise RuntimeError(f"BrowserType.launch: Executable doesn't exist at /{site}")

        monkeypatch.setattr(detail, "scrape_site_batch", fake_batch)

        with pytest.raises(ConfigurationError) as excinfo:
            detail._run_detail_scraper(conn, workers=1, reset_linkedin_candidates=False)

        message = str(excinfo.value)
        assert "RemoteOK" in message
        assert "Job Bank Canada" in message
        assert "Executable doesn't exist" in message
    finally:
        close_connection(db_path)


def test_run_detail_scraper_transient_network_still_all_sites_fail_stays_retryable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """All sites failing for a non-environment reason stays retryable."""
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        _seed_pending(conn, "https://remoteok.com/1", "RemoteOK")

        def fake_batch(
            _conn,
            site,
            jobs,
            max_jobs=None,
            cancel_event=None,
            on_job_enriched=None,
            **_politeness,
        ):
            raise RuntimeError("net::ERR_TIMED_OUT")

        monkeypatch.setattr(detail, "scrape_site_batch", fake_batch)

        with pytest.raises(TransientNetworkError):
            detail._run_detail_scraper(conn, workers=1, reset_linkedin_candidates=False)
    finally:
        close_connection(db_path)


@pytest.mark.parametrize("workers", [1, 2])
def test_run_detail_scraper_propagates_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, workers: int
) -> None:
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        first = _seed_pending(conn, "https://remoteok.com/1", "RemoteOK")
        second = _seed_pending(conn, "https://jobbank.ca/1", "Job Bank Canada")
        blocked = _seed_pending(conn, "https://remoteok.com/blocked", "RemoteOK")
        unrelated = _seed_pending(conn, "https://remoteok.com/unrelated", "RemoteOK")
        ensure_job_stage_rows(conn, blocked, tenant_id=LOCAL_TENANT)
        set_stage_state(
            conn,
            blocked,
            "enrich",
            "blocked",
            tenant_id=LOCAL_TENANT,
            error_code="ENRICH_ROBOTS_DISALLOWED",
            error_message="retryable robots block",
            retryable=True,
        )
        conn.commit()
        cancel_event = threading.Event()

        def fake_batch(
            _conn,
            site,
            jobs,
            max_jobs=None,
            cancel_event=None,
            on_job_enriched=None,
            **_politeness,
        ):
            assert cancel_event is not None
            cancel_event.set()
            raise TransientNetworkError("enrichment canceled")

        monkeypatch.setattr(detail, "scrape_site_batch", fake_batch)

        with pytest.raises(TransientNetworkError):
            detail._run_detail_scraper(
                conn,
                workers=workers,
                job_ids=(first, second, blocked),
                cancel_event=cancel_event,
                reset_linkedin_candidates=True,
                workflow_id="workflow-cancel-test",
                workflow_run_id="temporal-run-cancel-test",
            )

        states = {
            row[0]: row[1]
            for row in conn.execute(
                "SELECT job_id, state FROM job_stage_states "
                "WHERE tenant_id = ? AND stage = 'enrich'",
                (str(LOCAL_TENANT),),
            ).fetchall()
        }
        assert states[str(first)] == "canceled"
        assert states[str(second)] == "canceled"
        assert states[str(blocked)] == "canceled"
        assert states.get(str(unrelated), "pending") == "pending"
        canceled_payloads = [
            json.loads(row[0] or "{}")
            for row in conn.execute(
                "SELECT payload_json FROM job_events "
                "WHERE event_type = 'StageCanceled' ORDER BY event_id"
            ).fetchall()
        ]
        assert {payload["jobId"] for payload in canceled_payloads} == {
            str(first),
            str(second),
            str(blocked),
        }
        assert all(
            payload["workflowId"] == "workflow-cancel-test"
            and payload["temporalRunId"] == "temporal-run-cancel-test"
            for payload in canceled_payloads
        )
    finally:
        close_connection(db_path)


def test_selected_enrich_workflow_picks_up_api_prequeued_job(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = _seed_pending(conn, "https://remoteok.com/prequeued", "RemoteOK")
        ensure_job_stage_rows(conn, job_id, tenant_id=LOCAL_TENANT)
        set_stage_state(
            conn,
            job_id,
            "enrich",
            "queued",
            tenant_id=LOCAL_TENANT,
            metadata={
                "workflowId": "workflow-prequeued",
                "temporalRunId": "temporal-prequeued",
            },
        )
        conn.commit()
        selected: list[JobId] = []

        def fake_batch(_conn, _site, jobs, **_kwargs):
            selected.extend(job[0] for job in jobs)
            return _healthy_stats()

        monkeypatch.setattr(detail, "scrape_site_batch", fake_batch)
        detail._run_detail_scraper(
            conn,
            workers=1,
            job_ids=(job_id,),
            reset_linkedin_candidates=False,
            workflow_id="workflow-prequeued",
            workflow_run_id="temporal-prequeued",
        )

        assert selected == [job_id]
    finally:
        close_connection(db_path)


def test_selected_enrich_workflow_does_not_steal_another_queued_owner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = _seed_pending(conn, "https://remoteok.com/owned", "RemoteOK")
        ensure_job_stage_rows(conn, job_id, tenant_id=LOCAL_TENANT)
        set_stage_state(
            conn,
            job_id,
            "enrich",
            "queued",
            tenant_id=LOCAL_TENANT,
            metadata={
                "workflowId": "workflow-owner-a",
                "temporalRunId": "temporal-owner-a",
            },
        )
        conn.commit()
        batch = monkeypatch.setattr(
            detail,
            "scrape_site_batch",
            lambda *_args, **_kwargs: pytest.fail("foreign-owned row was selected"),
        )

        result = detail._run_detail_scraper(
            conn,
            workers=1,
            job_ids=(job_id,),
            reset_linkedin_candidates=False,
            workflow_id="workflow-owner-b",
            workflow_run_id="temporal-owner-b",
        )

        assert batch is None
        assert result["processed"] == 0
        row = conn.execute(
            "SELECT state, metadata_json FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        assert row[0] == "queued"
        assert json.loads(row[1]) == {
            "workflowId": "workflow-owner-a",
            "temporalRunId": "temporal-owner-a",
        }
    finally:
        close_connection(db_path)


def test_linkedin_prepass_persists_owner_before_navigation_and_restart_cancels_it(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.cli import _reconcile_canceled_enrichment_cohorts
    from jobctrl.infrastructure.enrichment.execution_lease import (
        claim_enrichment_execution_lease_for_run,
    )
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    failed_id = _seed_pending(
        conn,
        "https://www.linkedin.com/jobs/view/prepass-failed",
        "linkedin",
    )
    enriched_id = _seed_pending(
        conn,
        "https://www.linkedin.com/jobs/view/prepass-enriched",
        "linkedin",
    )
    repo = SqliteEnrichmentRepository(conn)
    failed = (
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT,
            job_id=failed_id,
            updated_at="2026-08-05T00:02:00+00:00",
        )
        .start_attempt(
            extraction_tier=ExtractionTier.CSS_SELECTORS,
            started_at="2026-08-05T00:02:00+00:00",
        )
        .fail_attempt(
            error=EnrichmentError(
                code="DETAIL_ERROR",
                message="authenticated retry required",
                retryable=True,
            ),
            finished_at="2026-08-05T00:02:01+00:00",
        )
    )
    enriched = (
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT,
            job_id=enriched_id,
            updated_at="2026-08-05T00:01:00+00:00",
        )
        .start_attempt(
            extraction_tier=ExtractionTier.JSON_LD,
            started_at="2026-08-05T00:01:00+00:00",
        )
        .succeed_attempt(
            full_description=FullDescription(text=_long_description()),
            application_url=None,
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at="2026-08-05T00:01:01+00:00",
        )
    )
    repo.save(failed)
    repo.save(enriched)
    for job_id, state in ((failed_id, "failed"), (enriched_id, "succeeded")):
        ensure_job_stage_rows(conn, job_id)
        set_stage_state(
            conn,
            job_id,
            "enrich",
            state,
            error_code="DETAIL_ERROR" if state == "failed" else None,
            retryable=True,
            validate_transition=False,
        )
    conn.commit()

    workflow_id = "workflow-linkedin-prepass"
    run_id = "run-linkedin-prepass"
    lease = claim_enrichment_execution_lease_for_run(
        conn,
        tenant_id=LOCAL_TENANT,
        workflow_id=workflow_id,
        run_id=run_id,
        owner_token="activity-prepass:attempt-1",
        activity_phase=1,
        activity_attempt=1,
    )
    resolver_started = threading.Event()
    resolver_release = threading.Event()
    cancel_event = threading.Event()

    class _BlockingResolver:
        def resolve(self, _url: str):
            resolver_started.set()
            assert resolver_release.wait(timeout=10)
            return None

        def close(self) -> None:
            return None

    class _AllowedSession:
        @contextmanager
        def guard(self, _url: str):
            yield SimpleNamespace(allowed=True)

    monkeypatch.setattr(detail, "linkedin_apply_resolver_enabled", lambda: True)
    monkeypatch.setattr(
        detail,
        "_default_linkedin_apply_resolver_factory",
        _BlockingResolver,
    )
    monkeypatch.setattr(
        detail,
        "_enrichment_session",
        lambda *_args, **_kwargs: _AllowedSession(),
    )
    monkeypatch.setattr(
        detail,
        "scrape_site_batch",
        lambda *_args, **_kwargs: pytest.fail(
            "normal cohort started before cancellation"
        ),
    )
    thread_errors: list[BaseException] = []

    def _run() -> None:
        thread_conn = init_db(db_path)
        try:
            detail._run_detail_scraper(
                thread_conn,
                workers=1,
                job_ids=(failed_id, enriched_id),
                cancel_event=cancel_event,
                reset_linkedin_candidates=True,
                activity_lease=lease,
                workflow_id=workflow_id,
                workflow_run_id=run_id,
            )
        except BaseException as exc:  # noqa: BLE001 - capture thread result
            thread_errors.append(exc)
        finally:
            thread_conn.close()

    worker = threading.Thread(target=_run, daemon=True)
    worker.start()
    assert resolver_started.wait(timeout=10)

    durable = conn.execute(
        "SELECT state, metadata_json FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
        (str(LOCAL_TENANT), str(failed_id)),
    ).fetchone()
    assert durable[0] == "queued"
    assert json.loads(durable[1])["workflowId"] == workflow_id
    assert json.loads(durable[1])["temporalRunId"] == run_id
    assert repo.load(LOCAL_TENANT, failed_id).is_pending

    conn.execute(
        "INSERT INTO workflow_run_projections ("
        "workflow_id, tenant_id, workflow_type, status, input_summary_json, "
        "retryable, started_at, finished_at, temporal_run_id, events_json) "
        "VALUES (?, 'local', 'JobPipelineWorkflow', 'canceled', '{}', 0, ?, ?, ?, '[]')",
        (
            workflow_id,
            "2026-08-05T00:00:00+00:00",
            "2026-08-05T00:03:00+00:00",
            run_id,
        ),
    )
    conn.commit()
    cancel_event.set()
    assert _reconcile_canceled_enrichment_cohorts(conn, tenant_id="local") == 1
    resolver_release.set()
    worker.join(timeout=10)
    assert not worker.is_alive()
    assert thread_errors and isinstance(
        thread_errors[0],
        (TransientNetworkError, StaleEnrichmentExecutionLease),
    )
    final = conn.execute(
        "SELECT state, metadata_json FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
        (str(LOCAL_TENANT), str(failed_id)),
    ).fetchone()
    assert final[0] == "canceled"
    assert json.loads(final[1])["workflowId"] == workflow_id
    close_connection(db_path)


def test_reconcile_settled_canceled_cohort_performs_no_further_writes(
    tmp_path: Path,
) -> None:
    """A settled canceled cohort must stop costing write transactions.

    The reconciler runs on the 15s worker heartbeat; once a canceled run's
    cohort is terminal and its phase-3 cancellation lease is claimed, later
    passes must be read-only or the single-writer database pays two write
    locks per historical canceled run forever.
    """

    from jobctrl.cli import _reconcile_canceled_enrichment_cohorts
    from jobctrl.infrastructure.enrichment.execution_lease import (
        claim_enrichment_execution_lease_for_run,
    )
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = _seed_pending(
            conn, "https://remoteok.com/settled-cohort", "RemoteOK"
        )
        ensure_job_stage_rows(conn, job_id, tenant_id=LOCAL_TENANT)
        workflow_id = "workflow-settled-cohort"
        run_id = "run-settled-cohort"
        set_stage_state(
            conn,
            job_id,
            "enrich",
            "queued",
            tenant_id=LOCAL_TENANT,
            metadata={"workflowId": workflow_id, "temporalRunId": run_id},
        )
        conn.commit()
        claim_enrichment_execution_lease_for_run(
            conn,
            tenant_id=LOCAL_TENANT,
            workflow_id=workflow_id,
            run_id=run_id,
            owner_token="activity-settled:attempt-1",
            activity_phase=1,
            activity_attempt=1,
        )
        conn.execute(
            "INSERT INTO workflow_run_projections ("
            "workflow_id, tenant_id, workflow_type, status, input_summary_json, "
            "retryable, started_at, finished_at, temporal_run_id, events_json) "
            "VALUES (?, 'local', 'JobPipelineWorkflow', 'canceled', '{}', 0, ?, ?, ?, '[]')",
            (
                workflow_id,
                "2026-08-06T00:00:00+00:00",
                "2026-08-06T00:01:00+00:00",
                run_id,
            ),
        )
        conn.commit()

        assert _reconcile_canceled_enrichment_cohorts(conn, tenant_id="local") == 1
        state = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()[0]
        assert state == "canceled"

        statements: list[str] = []
        conn.set_trace_callback(statements.append)
        try:
            assert (
                _reconcile_canceled_enrichment_cohorts(conn, tenant_id="local") == 0
            )
        finally:
            conn.set_trace_callback(None)
        writes = [
            statement
            for statement in statements
            if statement.strip().upper().startswith(
                ("BEGIN", "INSERT", "UPDATE", "DELETE", "REPLACE")
            )
        ]
        assert writes == []

        # The settled marker is the phase-3 lease, not a permanent tombstone:
        # a live row re-bound to the same canceled run must still recover.
        set_stage_state(
            conn,
            job_id,
            "enrich",
            "queued",
            tenant_id=LOCAL_TENANT,
            metadata={"workflowId": workflow_id, "temporalRunId": run_id},
            validate_transition=False,
        )
        conn.commit()
        assert _reconcile_canceled_enrichment_cohorts(conn, tenant_id="local") == 1
        state = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()[0]
        assert state == "canceled"
    finally:
        close_connection(db_path)


def test_cancel_enrich_cohort_preserves_committed_outcomes(
    tmp_path: Path,
) -> None:
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        enriched_id = _seed_pending(
            conn, "https://example.test/cancel-committed", "RemoteOK"
        )
        failed_id = _seed_pending(
            conn, "https://example.test/cancel-failed", "RemoteOK"
        )
        unfinished_id = _seed_pending(
            conn, "https://example.test/cancel-unfinished", "RemoteOK"
        )
        started_at = "2026-08-05T00:00:00+00:00"
        finished_at = "2026-08-05T00:01:00+00:00"
        repo = SqliteEnrichmentRepository(conn)
        enriched = JobEnrichment.empty(
            tenant_id=LOCAL_TENANT,
            job_id=enriched_id,
            updated_at=started_at,
        ).start_attempt(
            extraction_tier=ExtractionTier.JSON_LD,
            started_at=started_at,
        ).succeed_attempt(
            full_description=FullDescription(text=_long_description()),
            application_url=None,
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at=finished_at,
        )
        failed = JobEnrichment.empty(
            tenant_id=LOCAL_TENANT,
            job_id=failed_id,
            updated_at=started_at,
        ).start_attempt(
            extraction_tier=ExtractionTier.JSON_LD,
            started_at=started_at,
        ).fail_attempt(
            error=EnrichmentError(
                code="DETAIL_ERROR",
                message="committed extraction failure",
                retryable=True,
            ),
            finished_at=finished_at,
        )
        repo.save(enriched)
        repo.save(failed)
        for job_id in (enriched_id, failed_id, unfinished_id):
            ensure_job_stage_rows(conn, job_id)
            set_stage_state(
                conn,
                job_id,
                "enrich",
                "running",
                metadata={
                    "workflowId": "workflow-cancel-commit-test",
                    "temporalRunId": "temporal-cancel-commit-test",
                },
            )
        conn.commit()

        canceled = detail.cancel_enrichment_cohort(
            conn,
            (enriched_id, failed_id, unfinished_id),
            workflow_id="workflow-cancel-commit-test",
            workflow_run_id="temporal-cancel-commit-test",
        )

        states = {
            str(row[0]): (str(row[1]), row[2])
            for row in conn.execute(
                "SELECT job_id, state, error_code FROM job_stage_states "
                "WHERE tenant_id = ? AND stage = 'enrich' "
                "AND job_id IN (?, ?, ?)",
                (
                    str(LOCAL_TENANT),
                    str(enriched_id),
                    str(failed_id),
                    str(unfinished_id),
                ),
            ).fetchall()
        }
        assert canceled == 1
        assert states[str(enriched_id)] == ("succeeded", None)
        assert states[str(failed_id)] == ("failed", "DETAIL_ERROR")
        assert states[str(unfinished_id)] == ("canceled", None)
    finally:
        close_connection(db_path)


def test_cancellation_does_not_mutate_successor_owned_enrich_row(
    tmp_path: Path,
) -> None:
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = _seed_pending(
            conn,
            "https://example.test/successor-owner",
            "RemoteOK",
        )
        ensure_job_stage_rows(conn, job_id)
        set_stage_state(
            conn,
            job_id,
            "enrich",
            "queued",
            metadata={
                "workflowId": "workflow-successor",
                "temporalRunId": "run-successor",
            },
        )
        conn.commit()

        canceled = detail.cancel_enrichment_cohort(
            conn,
            (job_id,),
            workflow_id="workflow-canceled-predecessor",
            workflow_run_id="run-canceled-predecessor",
        )

        row = conn.execute(
            "SELECT state, metadata_json FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        assert canceled == 0
        assert row[0] == "queued"
        assert json.loads(row[1]) == {
            "workflowId": "workflow-successor",
            "temporalRunId": "run-successor",
        }
    finally:
        close_connection(db_path)


def test_cancellation_terminal_lease_rejects_abandoned_activity_failure_write(
    tmp_path: Path,
) -> None:
    from jobctrl.infrastructure.enrichment.execution_lease import (
        claim_enrichment_execution_lease_for_run,
    )
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = _seed_pending(
            conn,
            "https://example.test/abandoned-activity",
            "RemoteOK",
        )
        ensure_job_stage_rows(conn, job_id)
        set_stage_state(
            conn,
            job_id,
            "enrich",
            "queued",
            metadata={
                "workflowId": "workflow-abandoned",
                "temporalRunId": "run-abandoned",
            },
        )
        conn.commit()
        stale_lease = claim_enrichment_execution_lease_for_run(
            conn,
            tenant_id=LOCAL_TENANT,
            workflow_id="workflow-abandoned",
            run_id="run-abandoned",
            owner_token="activity:attempt-1",
            activity_phase=1,
            activity_attempt=1,
        )
        assert detail.cancel_enrichment_cohort(
            conn,
            (job_id,),
            workflow_id="workflow-abandoned",
            workflow_run_id="run-abandoned",
        ) == 1

        with pytest.raises(StaleEnrichmentExecutionLease):
            detail._record_enrich_job_failure(
                conn,
                job_id,
                "https://example.test/abandoned-activity",
                RuntimeError("late stale activity write"),
                activity_lease=stale_lease,
            )

        stage = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        aggregate = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, job_id)
        assert stage[0] == "canceled"
        assert aggregate is None or aggregate.is_pending
    finally:
        close_connection(db_path)


def test_stale_cleanup_cannot_release_successor_activity_owner(tmp_path: Path) -> None:
    from jobctrl.infrastructure.enrichment.execution_lease import (
        claim_enrichment_execution_lease_for_run,
    )

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = _seed_pending(
            conn,
            "https://example.test/successor-activity-cleanup",
            "RemoteOK",
        )
        workflow_id = "workflow-successor-cleanup"
        run_id = "run-successor-cleanup"
        stale_lease = claim_enrichment_execution_lease_for_run(
            conn,
            tenant_id=LOCAL_TENANT,
            workflow_id=workflow_id,
            run_id=run_id,
            owner_token="activity:attempt-1",
            activity_phase=1,
            activity_attempt=1,
        )
        detail._queue_enrichment_cohort(
            conn,
            (job_id,),
            tenant_id=LOCAL_TENANT,
            workflow_id=workflow_id,
            workflow_run_id=run_id,
            activity_lease=stale_lease,
        )
        successor_lease = claim_enrichment_execution_lease_for_run(
            conn,
            tenant_id=LOCAL_TENANT,
            workflow_id=workflow_id,
            run_id=run_id,
            owner_token="activity:attempt-2",
            activity_phase=1,
            activity_attempt=2,
        )
        detail._queue_enrichment_cohort(
            conn,
            (job_id,),
            tenant_id=LOCAL_TENANT,
            workflow_id=workflow_id,
            workflow_run_id=run_id,
            activity_lease=successor_lease,
        )

        detail._release_unstarted_enrichment_cohort(
            conn,
            (job_id,),
            tenant_id=LOCAL_TENANT,
            workflow_id=workflow_id,
            workflow_run_id=run_id,
            activity_lease=stale_lease,
        )

        row = conn.execute(
            "SELECT state, metadata_json FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        assert row[0] == "queued"
        assert json.loads(row[1]) == {
            "activityAttempt": 2,
            "activityOwner": "activity:attempt-2",
            "leaseEpoch": successor_lease.epoch,
            "temporalRunId": run_id,
            "workflowId": workflow_id,
        }
    finally:
        close_connection(db_path)


def test_stale_cleanup_cannot_release_after_terminal_lease(tmp_path: Path) -> None:
    from jobctrl.infrastructure.enrichment.execution_lease import (
        claim_enrichment_execution_lease_for_run,
    )

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = _seed_pending(
            conn,
            "https://example.test/terminal-cleanup",
            "RemoteOK",
        )
        workflow_id = "workflow-terminal-cleanup"
        run_id = "run-terminal-cleanup"
        activity_lease = claim_enrichment_execution_lease_for_run(
            conn,
            tenant_id=LOCAL_TENANT,
            workflow_id=workflow_id,
            run_id=run_id,
            owner_token="activity:attempt-1",
            activity_phase=1,
            activity_attempt=1,
        )
        detail._queue_enrichment_cohort(
            conn,
            (job_id,),
            tenant_id=LOCAL_TENANT,
            workflow_id=workflow_id,
            workflow_run_id=run_id,
            activity_lease=activity_lease,
        )
        claim_enrichment_execution_lease_for_run(
            conn,
            tenant_id=LOCAL_TENANT,
            workflow_id=workflow_id,
            run_id=run_id,
            owner_token=f"cancellation:{workflow_id}:{run_id}",
            activity_phase=3,
            activity_attempt=1,
        )

        detail._release_unstarted_enrichment_cohort(
            conn,
            (job_id,),
            tenant_id=LOCAL_TENANT,
            workflow_id=workflow_id,
            workflow_run_id=run_id,
            activity_lease=activity_lease,
        )

        row = conn.execute(
            "SELECT state, metadata_json FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        assert row[0] == "queued"
        assert json.loads(row[1]) == {
            "activityAttempt": 1,
            "activityOwner": "activity:attempt-1",
            "leaseEpoch": activity_lease.epoch,
            "temporalRunId": run_id,
            "workflowId": workflow_id,
        }
    finally:
        close_connection(db_path)


# ---------------------------------------------------------------------------
# Per-job fault isolation
# ---------------------------------------------------------------------------


def test_scrape_site_batch_isolates_single_job_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    bad_url = "https://remoteok.com/bad"
    good_url = "https://remoteok.com/good"
    try:
        bad_job_id = _seed_pending(conn, bad_url, "RemoteOK")
        good_job_id = _seed_pending(conn, good_url, "RemoteOK")

        monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())

        def fake_scrape(_page, url, session=None):
            if url == bad_url:
                raise ValueError("boom parsing page")
            return {
                "status": "ok",
                "tier_used": 1,
                "full_description": _long_description(),
                "application_url": "https://apply.example/x",
                "error": None,
                "elapsed": 1.0,
                "active_state": "active",
                "verification_method": "json_ld",
                "http_status": 200,
            }

        monkeypatch.setattr(detail, "scrape_detail_page", fake_scrape)

        stats = detail.scrape_site_batch(
            conn,
            "RemoteOK",
            [(bad_job_id, "Bad"), (good_job_id, "Good")],
            gateway=offline_gateway(),
        )

        assert stats["error"] == 1
        assert stats["ok"] == 1

        bad_state = conn.execute(
            "SELECT state, error_code FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(bad_job_id)),
        ).fetchone()
        assert bad_state["state"] == "failed"
        assert bad_state["error_code"] == "ENRICH_INTERNAL_ERROR"

        bad_enrichment = conn.execute(
            """
            SELECT current_status, attempts_json
            FROM job_enrichments
            WHERE tenant_id = ? AND job_id = ?
            """,
            (str(LOCAL_TENANT), str(bad_job_id)),
        ).fetchone()
        assert bad_enrichment["current_status"] == "failed"
        attempts = json.loads(bad_enrichment["attempts_json"])
        assert attempts[-1]["status"] == "failed"
        assert attempts[-1]["error"]["code"] == "ENRICH_INTERNAL_ERROR"
        assert "boom parsing page" in attempts[-1]["error"]["message"]

        bad_event = conn.execute(
            """
            SELECT payload_json
            FROM job_events
            WHERE tenant_id = ? AND job_id = ? AND event_type = 'StageFailed'
            ORDER BY event_id DESC
            LIMIT 1
            """,
            (str(LOCAL_TENANT), str(bad_job_id)),
        ).fetchone()
        payload = json.loads(bad_event["payload_json"])
        assert payload["errorCode"] == "ENRICH_INTERNAL_ERROR"
        assert payload["retryable"] is True

        good = conn.execute(
            "SELECT current_status FROM job_enrichments "
            "WHERE tenant_id = ? AND job_id = ?",
            (str(LOCAL_TENANT), str(good_job_id)),
        ).fetchone()
        assert good["current_status"] == "enriched"
    finally:
        close_connection(db_path)


def test_scrape_site_batch_requeues_transiently_interrupted_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = _seed_pending(conn, "https://remoteok.com/interrupted", "RemoteOK")
        monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())

        def interrupted(_page, _url, session=None):
            raise TransientNetworkError("enrichment canceled")

        monkeypatch.setattr(detail, "scrape_detail_page", interrupted)

        with pytest.raises(TransientNetworkError, match="enrichment canceled"):
            detail.scrape_site_batch(
                conn,
                "RemoteOK",
                [(job_id, "Interrupted")],
                gateway=offline_gateway(),
            )

        stage = conn.execute(
            "SELECT state, retryable, metadata_json FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        assert stage["state"] == "pending"
        assert stage["retryable"] == 1
        assert json.loads(stage["metadata_json"])["recoveryReason"] == (
            "transient_interruption"
        )
        event = conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE tenant_id = ? AND job_id = ? AND event_type = 'StageReset' "
            "ORDER BY event_id DESC LIMIT 1",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        assert json.loads(event["payload_json"])["reason"] == "transient_interruption"
    finally:
        close_connection(db_path)


def test_scrape_site_batch_commits_terminal_state_under_activity_lease(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = _seed_pending(conn, "https://remoteok.com/leased", "RemoteOK")
        monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())
        monkeypatch.setattr(
            detail,
            "scrape_detail_page",
            lambda _page, _url, session=None: {
                "status": "ok",
                "tier_used": 1,
                "full_description": _long_description(),
                "application_url": None,
                "error": None,
                "elapsed": 1.0,
                "active_state": "active",
                "verification_method": "json_ld",
                "http_status": 200,
            },
        )
        monkeypatch.setattr(runner, "get_connection", lambda: conn)
        execution = DiscoveryExecutionRef(
            tenant_id="local",
            workflow_id="discover-local",
            temporal_run_id="run-leased-write",
        )
        lease = runner._claim_execution_enrichment_lease(
            execution,
            owner_token="activity-live:attempt-1",
            activity_phase=1,
            activity_attempt=1,
        )

        stats = detail.scrape_site_batch(
            conn,
            "RemoteOK",
            [(job_id, "Leased")],
            gateway=offline_gateway(),
            activity_lease=lease,
        )

        assert stats["ok"] == 1
        stage = conn.execute(
            "SELECT state, version, metadata_json FROM job_stage_states "
            "WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'",
            (str(job_id),),
        ).fetchone()
        assert stage["state"] == "succeeded"
        assert stage["version"] == 2
        assert json.loads(stage["metadata_json"])["activityOwner"] == lease.owner_token
        aggregate = conn.execute(
            "SELECT current_status FROM job_enrichments "
            "WHERE tenant_id = 'local' AND job_id = ?",
            (str(job_id),),
        ).fetchone()
        assert aggregate["current_status"] == "enriched"
        snapshot = conn.execute(
            "SELECT latest_snapshot_version FROM posting_snapshot_sets "
            "WHERE tenant_id = 'local' AND job_id = ?",
            (str(job_id),),
        ).fetchone()
        assert snapshot["latest_snapshot_version"] == 1
    finally:
        close_connection(db_path)


def test_inactive_snapshot_rolls_back_with_leased_terminal_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        job_id = _seed_pending(conn, "https://remoteok.com/inactive", "RemoteOK")
        monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())
        monkeypatch.setattr(
            detail,
            "scrape_detail_page",
            lambda _page, _url, session=None: {
                "status": "inactive",
                "tier_used": 1,
                "full_description": _long_description(),
                "application_url": None,
                "error": "posting inactive",
                "elapsed": 1.0,
                "active_state": "inactive",
                "verification_method": "json_ld",
                "http_status": 410,
            },
        )
        monkeypatch.setattr(runner, "get_connection", lambda: conn)
        execution = DiscoveryExecutionRef(
            tenant_id="local",
            workflow_id="discover-local",
            temporal_run_id="run-inactive-atomicity",
        )
        lease = runner._claim_execution_enrichment_lease(
            execution,
            owner_token="activity-live:attempt-1",
            activity_phase=1,
            activity_attempt=1,
        )
        original_save = SqliteEnrichmentRepository.save
        save_calls = 0

        def fail_first_save(self, enrichment, *, commit=True):
            nonlocal save_calls
            save_calls += 1
            if save_calls == 1:
                raise RuntimeError("crash after snapshot before aggregate")
            return original_save(self, enrichment, commit=commit)

        monkeypatch.setattr(SqliteEnrichmentRepository, "save", fail_first_save)

        stats = detail.scrape_site_batch(
            conn,
            "RemoteOK",
            [(job_id, "Inactive")],
            gateway=offline_gateway(),
            activity_lease=lease,
        )

        assert stats["error"] == 2
        assert (
            conn.execute(
                "SELECT 1 FROM posting_snapshot_sets "
                "WHERE tenant_id = 'local' AND job_id = ?",
                (str(job_id),),
            ).fetchone()
            is None
        )
        aggregate = conn.execute(
            "SELECT current_status FROM job_enrichments "
            "WHERE tenant_id = 'local' AND job_id = ?",
            (str(job_id),),
        ).fetchone()
        assert aggregate["current_status"] == "failed"
        stage = conn.execute(
            "SELECT state, error_code FROM job_stage_states "
            "WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'",
            (str(job_id),),
        ).fetchone()
        assert stage["state"] == "failed"
        assert stage["error_code"] == "ENRICH_INTERNAL_ERROR"
    finally:
        close_connection(db_path)


def test_scrape_site_batch_hands_off_each_job_as_it_is_enriched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R9 Phase 2 promptness proof: the per-job handoff fires immediately after
    each job is enriched (and committed), BEFORE the next sibling in the same
    family is scraped — the structural proxy for lower per-job TTFS. A job that
    fails enrichment produces no handoff."""
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    first = "https://remoteok.com/first"
    bad = "https://remoteok.com/bad"
    second = "https://remoteok.com/second"
    events: list[tuple[str, str]] = []
    try:
        first_job_id = _seed_pending(conn, first, "RemoteOK")
        bad_job_id = _seed_pending(conn, bad, "RemoteOK")
        second_job_id = _seed_pending(conn, second, "RemoteOK")

        monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())

        def fake_scrape(_page, url, session=None):
            events.append(("scrape", url))
            if url == bad:
                return {
                    "status": "error",
                    "tier_used": None,
                    "full_description": "",
                    "application_url": None,
                    "error": "not found",
                    "elapsed": 1.0,
                    "active_state": "active",
                    "http_status": 404,
                }
            return {
                "status": "ok",
                "tier_used": 1,
                "full_description": _long_description(),
                "application_url": "https://apply.example/x",
                "error": None,
                "elapsed": 1.0,
                "active_state": "active",
                "verification_method": "json_ld",
                "http_status": 200,
            }

        monkeypatch.setattr(detail, "scrape_detail_page", fake_scrape)

        def on_job_enriched(job_id: JobId) -> None:
            events.append(("handoff", str(job_id)))

        detail.scrape_site_batch(
            conn,
            "RemoteOK",
            [(first_job_id, "First"), (bad_job_id, "Bad"), (second_job_id, "Second")],
            gateway=offline_gateway(),
            on_job_enriched=on_job_enriched,
        )

        # Each successful job is handed off right after it is enriched, before
        # the next job is scraped. The failed job produces no handoff.
        assert events == [
            ("scrape", first),
            ("handoff", str(first_job_id)),
            ("scrape", bad),
            ("scrape", second),
            ("handoff", str(second_job_id)),
        ]
    finally:
        close_connection(db_path)


def test_scrape_site_batch_handoff_error_does_not_break_enrichment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A per-job handoff failure is isolated: enrichment still succeeds and is
    not mis-recorded as an enrichment error."""
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    url = "https://remoteok.com/job"
    try:
        job_id = _seed_pending(conn, url, "RemoteOK")
        monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())
        monkeypatch.setattr(
            detail,
            "scrape_detail_page",
            lambda _page, _url, session=None: {
                "status": "ok",
                "tier_used": 1,
                "full_description": _long_description(),
                "application_url": "https://apply.example/x",
                "error": None,
                "elapsed": 1.0,
                "active_state": "active",
                "verification_method": "json_ld",
                "http_status": 200,
            },
        )

        def exploding_handoff(_job_id: JobId) -> None:
            raise RuntimeError("temporal unreachable")

        stats = detail.scrape_site_batch(
            conn,
            "RemoteOK",
            [(job_id, "Job")],
            gateway=offline_gateway(),
            on_job_enriched=exploding_handoff,
        )

        assert stats["ok"] == 1
        assert stats["error"] == 0
        state = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        assert state["state"] == "succeeded"
    finally:
        close_connection(db_path)


# ---------------------------------------------------------------------------
# Until-idle drain semantics
# ---------------------------------------------------------------------------


def test_live_enrichment_selector_is_scoped_to_the_current_execution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    current = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-current",
    )
    try:
        current_job_id = _seed_pending(conn, "https://example.test/current", "Indeed")
        other_job_id = _seed_pending(conn, "https://example.test/other", "Indeed")
        conn.executemany(
            "INSERT INTO discovery_execution_jobs ("
            "tenant_id, discover_workflow_id, discover_run_id, job_id, "
            "cohort_kind, source_family, work_plan_state, linked_at"
            ") VALUES ('local', 'discover-local', ?, ?, 'observed_this_run', "
            "'jobspy', 'pending', '2026-01-01T00:00:00+00:00')",
            [
                ("run-current", str(current_job_id)),
                ("run-other", str(other_job_id)),
            ],
        )
        conn.commit()
        monkeypatch.setattr(runner, "get_connection", lambda: conn)

        assert runner._execution_pending_enrichment_job_ids(current) == (current_job_id,)
    finally:
        close_connection(db_path)


def test_activity_retry_recovers_only_execution_scoped_orphaned_enrichment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    current = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-current",
    )
    try:
        current_job_id = _seed_pending(
            conn, "https://example.test/current-orphan", "Indeed"
        )
        other_job_id = _seed_pending(
            conn, "https://example.test/other-orphan", "Indeed"
        )
        for job_id in (current_job_id, other_job_id):
            ensure_job_stage_rows(conn, job_id)
        set_stage_state(conn, other_job_id, "enrich", "running")
        conn.executemany(
            "INSERT INTO discovery_execution_jobs ("
            "tenant_id, discover_workflow_id, discover_run_id, job_id, "
            "cohort_kind, source_family, work_plan_state, linked_at"
            ") VALUES ('local', 'discover-local', ?, ?, 'observed_this_run', "
            "'jobspy', 'pending', '2026-01-01T00:00:00+00:00')",
            [
                ("run-current", str(current_job_id)),
                ("run-other", str(other_job_id)),
            ],
        )
        conn.commit()
        monkeypatch.setattr(runner, "get_connection", lambda: conn)

        first_lease = runner._claim_execution_enrichment_lease(
            current,
            owner_token="activity-live:attempt-1",
            activity_phase=1,
            activity_attempt=1,
        )
        assert runner._reconcile_execution_enrichment_stages(first_lease) == ()
        first_claim_version = detail._claim_enrich_job_for_activity(
            conn,
            current_job_id,
            started_at="2026-01-01T00:01:00+00:00",
            tenant_id=LOCAL_TENANT,
            activity_lease=first_lease,
        )
        conn.commit()
        assert runner._execution_pending_enrichment_job_ids(current) == ()

        retry_lease = runner._claim_execution_enrichment_lease(
            current,
            owner_token="activity-live:attempt-2",
            activity_phase=1,
            activity_attempt=2,
        )
        assert runner._reconcile_execution_enrichment_stages(retry_lease) == (
            current_job_id,
        )
        with pytest.raises(StaleEnrichmentExecutionLease):
            detail._fence_enrich_job_write(
                conn,
                current_job_id,
                tenant_id=LOCAL_TENANT,
                activity_lease=first_lease,
                claim_version=first_claim_version,
            )
        assert runner._execution_pending_enrichment_job_ids(current) == (current_job_id,)

        states = {
            row["job_id"]: row
            for row in conn.execute(
                "SELECT job_id, state, started_at, version FROM job_stage_states "
                "WHERE tenant_id = 'local' AND stage = 'enrich' "
                "AND job_id IN (?, ?)",
                (str(current_job_id), str(other_job_id)),
            ).fetchall()
        }
        assert states[str(current_job_id)]["state"] == "pending"
        assert states[str(current_job_id)]["started_at"] is None
        assert states[str(current_job_id)]["version"] == 2
        assert states[str(other_job_id)]["state"] == "running"
        event = conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE tenant_id = 'local' AND job_id = ? AND event_type = 'StageReset' "
            "ORDER BY event_id DESC LIMIT 1",
            (str(current_job_id),),
        ).fetchone()
        assert json.loads(event["payload_json"])["activityAttempt"] == 2
    finally:
        close_connection(db_path)


def test_delayed_old_enrichment_claim_cannot_supersede_new_workflow_order(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-semantic-lease-order",
    )
    try:
        monkeypatch.setattr(runner, "get_connection", lambda: conn)
        retry = runner._claim_execution_enrichment_lease(
            execution,
            owner_token="activity-live:attempt-2",
            activity_phase=1,
            activity_attempt=2,
        )
        with pytest.raises(StaleEnrichmentExecutionLease):
            runner._claim_execution_enrichment_lease(
                execution,
                owner_token="delayed-activity-live:attempt-1",
                activity_phase=1,
                activity_attempt=1,
            )
        runner.fence_enrichment_execution_lease(conn, retry)
        conn.rollback()

        terminal = runner._claim_execution_enrichment_lease(
            execution,
            owner_token="activity-terminal:attempt-1",
            activity_phase=2,
            activity_attempt=1,
        )
        with pytest.raises(StaleEnrichmentExecutionLease):
            runner._claim_execution_enrichment_lease(
                execution,
                owner_token="delayed-activity-live:attempt-99",
                activity_phase=1,
                activity_attempt=99,
            )
        runner.fence_enrichment_execution_lease(conn, terminal)
        conn.rollback()
        assert conn.execute(
            "SELECT COUNT(*) FROM job_events "
            "WHERE entity_kind = 'discovery_enrichment_lease'"
        ).fetchone()[0] == 2
    finally:
        close_connection(db_path)


def test_delayed_old_enrichment_attempt_cannot_emit_stale_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    delayed_execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-delayed-progress",
    )
    superseded_execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-superseded-progress",
    )
    try:
        monkeypatch.setattr(runner, "get_connection", lambda: conn)
        monkeypatch.setattr(
            runner, "_record_pipeline_observation_event", lambda *_args: None
        )
        runner._claim_execution_enrichment_lease(
            delayed_execution,
            owner_token="current-terminal:attempt-2",
            activity_phase=2,
            activity_attempt=2,
        )
        with pytest.raises(StaleEnrichmentExecutionLease):
            runner.run_discovery_enrichment_stage(
                progress_total=1,
                discovery_execution=delayed_execution,
                activity_owner_token="delayed-terminal:attempt-1",
                activity_attempt=1,
            )
        assert conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE stage = 'discover' "
            "AND event_type = 'StageStarted'"
        ).fetchone()[0] == 0

        def supersede_during_drain(_done, result, **_kwargs):
            runner._claim_execution_enrichment_lease(
                superseded_execution,
                owner_token="current-terminal:attempt-2",
                activity_phase=2,
                activity_attempt=2,
            )
            result.update({"status": "ok", "passes": 1, "pending": 0})

        monkeypatch.setattr(
            runner, "_run_discovery_enrichment_until_idle", supersede_during_drain
        )
        with pytest.raises(StaleEnrichmentExecutionLease):
            runner.run_discovery_enrichment_stage(
                progress_total=1,
                discovery_execution=superseded_execution,
                activity_owner_token="superseded-terminal:attempt-1",
                activity_attempt=1,
            )
        event_types = [
            row[0]
            for row in conn.execute(
                "SELECT event_type FROM job_events WHERE stage = 'discover' "
                "ORDER BY event_id"
            ).fetchall()
        ]
        assert event_types == ["StageStarted"]
    finally:
        close_connection(db_path)


def test_superseded_enrichment_attempt_cannot_run_canonical_hygiene(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-stale-hygiene",
    )
    try:
        monkeypatch.setattr(runner, "get_connection", lambda: conn)
        stale = runner._claim_execution_enrichment_lease(
            execution,
            owner_token="superseded-terminal:attempt-1",
            activity_phase=2,
            activity_attempt=1,
        )
        runner._claim_execution_enrichment_lease(
            execution,
            owner_token="current-terminal:attempt-2",
            activity_phase=2,
            activity_attempt=2,
        )
        hygiene_called = False

        def forbidden_hygiene(*_args, **_kwargs):
            nonlocal hygiene_called
            hygiene_called = True
            raise AssertionError("stale owner reached canonical hygiene writes")

        monkeypatch.setattr(runner, "retire_invalid_source_jobs", forbidden_hygiene)

        with pytest.raises(StaleEnrichmentExecutionLease):
            runner.run_discovery_hygiene("after", activity_lease=stale)
        assert hygiene_called is False
        assert conn.execute(
            "SELECT COUNT(*) FROM jobctrl_deleted_jobs"
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type = 'JobDeleted'"
        ).fetchone()[0] == 0
    finally:
        close_connection(db_path)


def test_terminal_hygiene_runs_before_final_leased_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    order: list[str] = []

    def fake_until_idle(_done, result, **_kwargs):
        result.update({"status": "ok", "passes": 1, "pending": 0})

    monkeypatch.setattr(
        runner, "_run_discovery_enrichment_until_idle", fake_until_idle
    )
    monkeypatch.setattr(
        runner,
        "run_discovery_hygiene",
        lambda _label, **_kwargs: order.append("hygiene") or 0,
    )
    monkeypatch.setattr(
        runner,
        "_record_pipeline_event",
        lambda _stage, event_type, *_args, **_kwargs: order.append(event_type),
    )

    runner.run_discovery_enrichment_stage(progress_total=1)

    assert order == ["StageStarted", "hygiene", "StageCompleted"]


def test_terminal_activity_reconciles_committed_enrichment_aggregates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-terminal",
    )
    finished_at = "2026-01-01T00:02:00+00:00"
    try:
        enriched_id = _seed_pending(
            conn, "https://example.test/terminal-enriched", "Indeed"
        )
        failed_id = _seed_pending(
            conn, "https://example.test/terminal-failed", "Indeed"
        )
        repo = SqliteEnrichmentRepository(conn)
        enriched = JobEnrichment.empty(
            tenant_id=LOCAL_TENANT,
            job_id=enriched_id,
            updated_at="2026-01-01T00:01:00+00:00",
        ).start_attempt(
            extraction_tier=ExtractionTier.JSON_LD,
            started_at="2026-01-01T00:01:00+00:00",
        ).succeed_attempt(
            full_description=FullDescription(text=_long_description()),
            application_url=None,
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at=finished_at,
        )
        failed = JobEnrichment.empty(
            tenant_id=LOCAL_TENANT,
            job_id=failed_id,
            updated_at="2026-01-01T00:01:00+00:00",
        ).start_attempt(
            extraction_tier=ExtractionTier.JSON_LD,
            started_at="2026-01-01T00:01:00+00:00",
        ).fail_attempt(
            error=EnrichmentError(
                code="DETAIL_ERROR",
                message="temporary browser failure",
                retryable=True,
            ),
            finished_at=finished_at,
        )
        repo.save(enriched)
        repo.save(failed)
        for job_id in (enriched_id, failed_id):
            ensure_job_stage_rows(conn, job_id)
            set_stage_state(conn, job_id, "enrich", "running")
        conn.executemany(
            "INSERT INTO discovery_execution_jobs ("
            "tenant_id, discover_workflow_id, discover_run_id, job_id, "
            "cohort_kind, source_family, work_plan_state, linked_at"
            ") VALUES ('local', 'discover-local', 'run-terminal', ?, "
            "'observed_this_run', 'jobspy', 'pending', ?)",
            [
                (str(enriched_id), finished_at),
                (str(failed_id), finished_at),
            ],
        )
        conn.commit()
        monkeypatch.setattr(runner, "get_connection", lambda: conn)

        terminal_lease = runner._claim_execution_enrichment_lease(
            execution,
            owner_token="activity-terminal:attempt-1",
            activity_phase=2,
            activity_attempt=1,
        )
        recovered = runner._reconcile_execution_enrichment_stages(terminal_lease)
        assert set(recovered) == {
            enriched_id,
            failed_id,
        }
        handed_off: list[JobId] = []
        runner._handoff_reconciled_enriched_jobs(
            recovered,
            on_job_enriched=handed_off.append,
            tenant_id="local",
        )
        assert handed_off == [enriched_id]

        states = {
            row["job_id"]: row
            for row in conn.execute(
                "SELECT job_id, state, error_code, retryable "
                "FROM job_stage_states WHERE tenant_id = 'local' "
                "AND stage = 'enrich' AND job_id IN (?, ?)",
                (str(enriched_id), str(failed_id)),
            ).fetchall()
        }
        assert states[str(enriched_id)]["state"] == "succeeded"
        assert states[str(failed_id)]["state"] == "failed"
        assert states[str(failed_id)]["error_code"] == "DETAIL_ERROR"
        assert states[str(failed_id)]["retryable"] == 1
    finally:
        close_connection(db_path)


def test_live_recovery_selector_is_scoped_and_retryable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    current = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-current",
    )
    try:
        retryable_id = _seed_pending(
            conn,
            "https://www.linkedin.com/jobs/view/retryable",
            "linkedin",
        )
        nonretryable_id = _seed_pending(
            conn,
            "https://www.linkedin.com/jobs/view/nonretryable",
            "linkedin",
        )
        legacy_guard_id = _seed_pending(
            conn,
            "https://www.linkedin.com/jobs/view/legacy-public-write",
            "linkedin",
        )
        other_run_id = _seed_pending(
            conn,
            "https://www.linkedin.com/jobs/view/other-run",
            "linkedin",
        )
        for job_id, retryable in (
            (retryable_id, True),
            (nonretryable_id, False),
            (legacy_guard_id, False),
            (other_run_id, True),
        ):
            error_message = (
                "Unsupported public route method: POST"
                if job_id == legacy_guard_id
                else "browser closed"
            )
            detail._record_enrich_job_failure(
                conn,
                job_id,
                "https://www.linkedin.com/jobs/view/test",
                RuntimeError(error_message),
            )
            ensure_job_stage_rows(conn, job_id)
            set_stage_state(
                conn,
                job_id,
                "enrich",
                "failed",
                error_code=(
                    "DETAIL_UNSAFE_URL"
                    if job_id == legacy_guard_id
                    else "DETAIL_ERROR"
                ),
                error_message=error_message,
                retryable=retryable,
                validate_transition=False,
            )
        conn.executemany(
            "INSERT INTO discovery_execution_jobs ("
            "tenant_id, discover_workflow_id, discover_run_id, job_id, "
            "cohort_kind, source_family, work_plan_state, linked_at"
            ") VALUES ('local', 'discover-local', ?, ?, 'observed_this_run', "
            "'jobspy', 'pending', '2026-01-01T00:00:00+00:00')",
            [
                ("run-current", str(retryable_id)),
                ("run-current", str(nonretryable_id)),
                ("run-current", str(legacy_guard_id)),
                ("run-other", str(other_run_id)),
            ],
        )
        conn.commit()
        monkeypatch.setattr(runner, "get_connection", lambda: conn)

        assert set(runner._execution_recoverable_enrichment_job_ids(current)) == {
            retryable_id,
            legacy_guard_id,
        }
    finally:
        close_connection(db_path)


def test_until_idle_records_systemic_failure_with_full_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runner, "_count_pending", lambda *_a, **_k: 1)

    def boom(*_a, **_k):
        raise ConfigurationError("All enrichment sites failed: linkedin: Error: boom")

    monkeypatch.setattr(runner, "_run_enrich", boom)

    done = threading.Event()
    done.set()
    result: dict = {}
    runner._run_discovery_enrichment_until_idle(done, result, workers=1, limit=0)

    assert result["status"] == "failed"
    assert result["error_class"] == "ConfigurationError"
    assert "All enrichment sites failed" in result["error_message"]
    assert result["error_code"] == "configuration"
    assert result["retryable"] is False
    assert result["error_traceback"]


def test_until_idle_partial_pass_does_not_abort_and_reports_site_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pending = iter([1, 0, 0])
    monkeypatch.setattr(runner, "_count_pending", lambda *_a, **_k: next(pending))
    monkeypatch.setattr(
        runner,
        "_run_enrich",
        lambda **_k: {
            "status": "partial",
            "site_errors": {"linkedin": {"error_class": "Error", "error_message": "boom"}},
        },
    )

    done = threading.Event()
    done.set()
    result: dict = {}
    runner._run_discovery_enrichment_until_idle(done, result, workers=1, limit=0)

    assert result["status"] == "partial"
    assert result["passes"] == 1
    assert result["pending"] == 0
    assert result["site_errors"] == {"linkedin": {"error_class": "Error", "error_message": "boom"}}


def test_until_idle_resets_linkedin_candidates_only_on_first_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pending = iter([2, 1, 1, 0, 0])
    monkeypatch.setattr(runner, "_count_pending", lambda *_a, **_k: next(pending))

    reset_flags: list[bool] = []

    def fake_enrich(*, workers, limit, cancel_event=None, reset_linkedin_candidates=True, on_job_enriched=None):
        reset_flags.append(reset_linkedin_candidates)
        return {"status": "ok"}

    monkeypatch.setattr(runner, "_run_enrich", fake_enrich)

    done = threading.Event()
    done.set()
    result: dict = {}
    runner._run_discovery_enrichment_until_idle(done, result, workers=1, limit=0)

    assert reset_flags == [True, False]
    assert result["status"] == "ok"


def test_until_idle_runs_one_recovery_pass_for_retryable_robots_blocks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pending = iter([0, 0, 0])
    monkeypatch.setattr(runner, "_count_pending", lambda *_a, **_k: next(pending))
    monkeypatch.setattr(runner, "_count_retryable_enrichment_blocked", lambda: 4)

    reset_flags: list[bool] = []

    def fake_enrich(
        *,
        workers,
        limit,
        cancel_event=None,
        reset_linkedin_candidates=True,
        on_job_enriched=None,
    ):
        reset_flags.append(reset_linkedin_candidates)
        return {"status": "ok"}

    monkeypatch.setattr(runner, "_run_enrich", fake_enrich)

    done = threading.Event()
    done.set()
    result: dict = {}
    runner._run_discovery_enrichment_until_idle(done, result, workers=1, limit=0)

    assert reset_flags == [True]
    assert result == {"status": "ok", "passes": 1, "pending": 0}


def test_until_idle_live_pass_enriches_only_the_current_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-current",
    )
    current_job_id = JobId("00000000-0000-4000-8000-000000000001")
    pending = iter([(current_job_id,), (), ()])
    monkeypatch.setattr(
        runner,
        "_execution_pending_enrichment_job_ids",
        lambda selected: next(pending) if selected == execution else (),
    )
    monkeypatch.setattr(
        runner,
        "_execution_recoverable_enrichment_job_ids",
        lambda _selected: (),
    )
    captured_job_ids: list[tuple[JobId, ...]] = []

    def fake_enrich(**kwargs):
        captured_job_ids.append(kwargs["job_ids"])
        return {"status": "ok"}

    monkeypatch.setattr(runner, "_run_enrich", fake_enrich)

    done = threading.Event()
    done.set()
    result: dict = {}
    runner._run_discovery_enrichment_until_idle(
        done,
        result,
        workers=1,
        limit=0,
        discovery_execution=execution,
    )

    assert captured_job_ids == [(current_job_id,)]
    assert result == {"status": "ok", "passes": 1, "pending": 0}


def test_until_idle_live_retries_reobserved_failure_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-current",
    )
    recoverable_job_id = JobId("00000000-0000-4000-8000-000000000002")
    monkeypatch.setattr(
        runner,
        "_execution_pending_enrichment_job_ids",
        lambda _selected: (),
    )
    monkeypatch.setattr(
        runner,
        "_execution_recoverable_enrichment_job_ids",
        lambda selected: (recoverable_job_id,) if selected == execution else (),
    )
    calls: list[dict[str, object]] = []

    def fake_enrich(**kwargs):
        calls.append(kwargs)
        return {"status": "ok"}

    monkeypatch.setattr(runner, "_run_enrich", fake_enrich)

    done = threading.Event()
    done.set()
    result: dict = {}
    runner._run_discovery_enrichment_until_idle(
        done,
        result,
        workers=1,
        limit=0,
        discovery_execution=execution,
    )

    assert [call["job_ids"] for call in calls] == [(recoverable_job_id,)]
    assert [call["reset_linkedin_candidates"] for call in calls] == [True]
    assert result == {"status": "ok", "passes": 1, "pending": 0}


# ---------------------------------------------------------------------------
# Stage progress events
# ---------------------------------------------------------------------------


def _capture_pipeline_events(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    events: list[dict] = []

    def capture(stage, event_type, level, message, payload=None):
        events.append(
            {
                "stage": stage,
                "event_type": event_type,
                "level": level,
                "message": message,
                "payload": payload or {},
            }
        )

    monkeypatch.setattr(runner, "_record_pipeline_event", capture)
    return events


def test_stage_progress_emits_started_and_completed(monkeypatch: pytest.MonkeyPatch) -> None:
    events = _capture_pipeline_events(monkeypatch)

    def fake_until_idle(discovery_done, result, *, workers, limit, cancel_event=None, on_job_enriched=None):
        result.update({"status": "ok", "passes": 1, "pending": 0})

    monkeypatch.setattr(runner, "_run_discovery_enrichment_until_idle", fake_until_idle)
    monkeypatch.setattr(
        runner,
        "run_discovery_hygiene",
        lambda _label, **_kwargs: 0,
    )

    runner.run_discovery_enrichment_stage(progress_completed=4, progress_total=6)

    assert [e["event_type"] for e in events] == ["StageStarted", "StageCompleted"]
    assert all(e["stage"] == "discover" for e in events)
    started_progress = events[0]["payload"]["progress"]
    assert started_progress["completed"] == 4
    assert started_progress["currentStep"] == "Detail enrichment"
    completed_progress = events[1]["payload"]["progress"]
    assert completed_progress["completed"] == 5


def test_terminal_enrichment_activity_reconciles_and_passes_its_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="run-terminal-stage",
    )
    lease = EnrichmentExecutionLease(
        tenant_id=LOCAL_TENANT,
        workflow_id=execution.workflow_id,
        run_id=execution.temporal_run_id,
        owner_token="terminal-owner",
        epoch=7,
        generation=2,
        activity_phase=2,
        activity_attempt=1,
    )
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        runner,
        "_claim_execution_enrichment_lease",
        lambda *_args, **_kwargs: lease,
    )
    monkeypatch.setattr(
        runner,
        "_reconcile_execution_enrichment_stages",
        lambda current: captured.setdefault("reconciled", current) and (),
    )

    def fake_until_idle(discovery_done, result, **kwargs):
        captured["done"] = discovery_done.is_set()
        captured["lease"] = kwargs.get("activity_lease")
        result.update({"status": "ok", "passes": 0, "pending": 0})

    monkeypatch.setattr(runner, "_run_discovery_enrichment_until_idle", fake_until_idle)
    monkeypatch.setattr(
        runner,
        "run_discovery_hygiene",
        lambda _label, **kwargs: captured.setdefault(
            "hygiene_lease", kwargs.get("activity_lease")
        )
        and 0,
    )

    runner.run_discovery_enrichment_stage(
        discovery_execution=execution,
        activity_attempt=1,
        activity_owner_token="terminal-owner",
        stream_while_discovering=False,
    )

    assert captured == {
        "reconciled": lease,
        "done": True,
        "lease": lease,
        "hygiene_lease": lease,
    }


def test_stage_progress_emits_partial_site_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    events = _capture_pipeline_events(monkeypatch)

    def fake_until_idle(discovery_done, result, *, workers, limit, cancel_event=None, on_job_enriched=None):
        result.update(
            {
                "status": "partial",
                "passes": 1,
                "pending": 0,
                "site_errors": {
                    "indeed": {"error_class": "RuntimeError", "error_message": "boom"}
                },
            }
        )

    monkeypatch.setattr(runner, "_run_discovery_enrichment_until_idle", fake_until_idle)

    runner.run_discovery_enrichment_stage(progress_completed=4, progress_total=6)

    assert [e["event_type"] for e in events] == ["StageStarted", "StageCompleted"]
    completed = events[1]
    assert completed["level"] == "warn"
    assert completed["message"] == "Detail enrichment partially complete"
    assert completed["payload"]["siteErrors"] == {
        "indeed": {"error_class": "RuntimeError", "error_message": "boom"}
    }
    assert completed["payload"]["progress"]["status"] == "partial"
    assert completed["payload"]["progress"]["completed"] == 5


def test_stage_progress_emits_failed_with_real_cause(monkeypatch: pytest.MonkeyPatch) -> None:
    events = _capture_pipeline_events(monkeypatch)

    def fake_until_idle(discovery_done, result, *, workers, limit, cancel_event=None, on_job_enriched=None):
        result.update(
            {
                "status": "failed",
                "error_class": "ConfigurationError",
                "error_message": "BrowserType.launch: Executable doesn't exist at /x",
                "error_code": "configuration",
            }
        )

    monkeypatch.setattr(runner, "_run_discovery_enrichment_until_idle", fake_until_idle)

    runner.run_discovery_enrichment_stage(progress_completed=4, progress_total=6)

    assert [e["event_type"] for e in events] == ["StageStarted", "StageFailed"]
    failed = events[1]
    assert failed["level"] == "error"
    assert "Executable doesn't exist" in failed["message"]
    assert failed["payload"]["errorCode"] == "configuration"
    assert failed["payload"]["progress"]["status"] == "failed"
    assert failed["payload"]["progress"]["completed"] == 5


def test_stage_progress_silent_without_total(monkeypatch: pytest.MonkeyPatch) -> None:
    events = _capture_pipeline_events(monkeypatch)

    def fake_until_idle(discovery_done, result, *, workers, limit, cancel_event=None, on_job_enriched=None):
        result.update({"status": "ok", "passes": 0, "pending": 0})

    monkeypatch.setattr(runner, "_run_discovery_enrichment_until_idle", fake_until_idle)

    runner.run_discovery_enrichment_stage(progress_completed=0, progress_total=0)

    assert events == []


# ---------------------------------------------------------------------------
# Review follow-ups: message fallback corners + Preparation progress step
# ---------------------------------------------------------------------------


def test_stage_failure_error_with_class_only_never_collapses() -> None:
    err = _stage_failure_error(
        "discover:enrichment", {"status": "failed", "error_class": "ValueError"}
    )
    assert "ValueError" in err.message
    assert "failed: failed" not in err.message


def test_stage_failure_error_bare_failed_status_never_collapses() -> None:
    err = _stage_failure_error("discover:enrichment", {"status": "failed"})
    assert "failed: failed" not in err.message
    assert "no recorded error detail" in err.message


def test_record_preparation_progress_emits_legacy_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = _capture_pipeline_events(monkeypatch)

    activities._record_preparation_progress(
        "StageCompleted",
        "info",
        "Discovery preparation complete",
        progress_message="Preparation complete",
        completed=6,
        total=6,
    )

    assert len(events) == 1
    event = events[0]
    assert event["event_type"] == "StageCompleted"
    progress = event["payload"]["progress"]
    assert progress["completed"] == 6
    assert progress["total"] == 6
    assert progress["percent"] == 100
    assert progress["currentStep"] == "Preparation"
    assert progress["message"] == "Preparation complete"


def test_record_preparation_progress_silent_without_total(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = _capture_pipeline_events(monkeypatch)

    activities._record_preparation_progress(
        "StageStarted",
        "info",
        "Discovery preparation started",
        progress_message="Preparation started",
        completed=0,
        total=0,
    )

    assert events == []


def _fanout_activity_env(monkeypatch: pytest.MonkeyPatch, *, fail: bool) -> list[tuple]:
    """Stub the fanout activity's collaborators; return the progress-call log."""
    calls: list[tuple] = []

    async def fake_run_blocking(fn, **_kwargs):
        return fn()

    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )

    def fake_start_fanout(**_kwargs):
        if fail:
            raise RuntimeError("fanout exploded")
        return {"started": {"job_preparation": 1}, "queued": {}, "targets": 1}

    monkeypatch.setattr(
        "jobctrl.pipeline.preparation.start_discovery_preparation_workflows",
        fake_start_fanout,
    )

    def record(event_type, level, message, *, progress_message, completed, total, status="running"):
        calls.append((event_type, completed, total, status))

    monkeypatch.setattr(activities, "_record_preparation_progress", record)
    return calls


@pytest.mark.asyncio
async def test_fanout_activity_emits_preparation_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _fanout_activity_env(monkeypatch, fail=False)

    await activities.discovery_preparation_fanout_activity(
        DiscoveryPreparationFanoutInput(
            tenant_id="local", progress_completed=5, progress_total=6
        )
    )

    assert calls == [
        ("StageStarted", 5, 6, "running"),
        ("StageCompleted", 6, 6, "running"),
    ]


@pytest.mark.asyncio
async def test_fanout_activity_emits_failed_preparation_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _fanout_activity_env(monkeypatch, fail=True)

    with pytest.raises(ApplicationError):
        await activities.discovery_preparation_fanout_activity(
            DiscoveryPreparationFanoutInput(
                tenant_id="local", progress_completed=5, progress_total=6
            )
        )

    assert calls == [
        ("StageStarted", 5, 6, "running"),
        ("StageFailed", 6, 6, "failed"),
    ]
