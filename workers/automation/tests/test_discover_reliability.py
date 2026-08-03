"""Regression tests for the discovery-enrichment reliability fixes.

These reproduce the production incident where a missing Playwright browser
binary crashed the whole enrichment stage and the failure collapsed to the
useless message ``discover:enrichment failed: failed``. Every test is
network-free: scraping and browsers are stubbed.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from pathlib import Path
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
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment import detail
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
            raise TransientNetworkError("enrichment canceled")

        monkeypatch.setattr(detail, "scrape_site_batch", fake_batch)

        with pytest.raises(TransientNetworkError):
            detail._run_detail_scraper(
                conn,
                workers=workers,
                cancel_event=threading.Event(),
                reset_linkedin_candidates=False,
            )
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

    runner.run_discovery_enrichment_stage(progress_completed=4, progress_total=6)

    assert [e["event_type"] for e in events] == ["StageStarted", "StageCompleted"]
    assert all(e["stage"] == "discover" for e in events)
    started_progress = events[0]["payload"]["progress"]
    assert started_progress["completed"] == 4
    assert started_progress["currentStep"] == "Detail enrichment"
    completed_progress = events[1]["payload"]["progress"]
    assert completed_progress["completed"] == 5


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
