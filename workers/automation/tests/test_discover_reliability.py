"""Regression tests for the discovery-enrichment reliability fixes.

These reproduce the production incident where a missing Playwright browser
binary crashed the whole enrichment stage and the failure collapsed to the
useless message ``discover:enrichment failed: failed``. Every test is
network-free: scraping and browsers are stubbed.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

import pytest
from temporalio.exceptions import ApplicationError

from jobhunter.database import close_connection, init_db
from jobhunter.discovery import activities
from jobhunter.discovery.activities import (
    DiscoveryEnrichmentActivityInput,
    DiscoverySourceActivityInput,
    _is_success_status,
    _stage_failure_error,
)
from jobhunter.domain.errors import ConfigurationError, TransientNetworkError
from jobhunter.enrichment import detail
from jobhunter.pipeline import runner


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


def _seed_pending(conn: sqlite3.Connection, url: str, site: str) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, site, discovered_at) VALUES (?, ?, ?, ?)",
        (url, "Engineer", site, "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()


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
        "jobhunter.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )

    async def fake_run_blocking(fn, **_kwargs):
        return fn()

    monkeypatch.setattr(
        "jobhunter.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    monkeypatch.setattr(
        "jobhunter.pipeline.runner.run_discovery_enrichment_stage",
        lambda **_kwargs: {
            "status": "failed",
            "error_class": "Error",
            "error_message": "BrowserType.launch: Executable doesn't exist at /x",
            "error_code": "configuration",
            "retryable": False,
        },
    )
    monkeypatch.setattr("jobhunter.pipeline.runner.run_discovery_hygiene", lambda _label: 0)
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
        "jobhunter.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )

    async def fake_run_blocking(fn, **_kwargs):
        return fn()

    monkeypatch.setattr(
        "jobhunter.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    monkeypatch.setattr(
        "jobhunter.pipeline.runner.run_discovery_enrichment_stage",
        lambda **_kwargs: {
            "status": "partial",
            "passes": 2,
            "pending": 0,
            "site_errors": {"linkedin": {"error_class": "Error", "error_message": "boom"}},
        },
    )
    monkeypatch.setattr("jobhunter.pipeline.runner.run_discovery_hygiene", lambda _label: 0)
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_a, **_k: None)

    result = await activities.discovery_enrichment_activity(
        DiscoveryEnrichmentActivityInput(tenant_id="local")
    )

    assert result.status == "partial"
    assert result.site_errors == {"linkedin": {"error_class": "Error", "error_message": "boom"}}


@pytest.mark.asyncio
async def test_discovery_source_family_activity_treats_skipped_limit_as_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobhunter.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )

    async def fake_run_blocking(fn, **_kwargs):
        return fn()

    monkeypatch.setattr(
        "jobhunter.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
        fake_run_blocking,
    )
    monkeypatch.setattr(
        "jobhunter.pipeline.runner.run_discovery_source_family",
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

        def fake_batch(_conn, site, jobs, delay=2.0, max_jobs=None, cancel_event=None):
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

        def fake_batch(_conn, site, jobs, delay=2.0, max_jobs=None, cancel_event=None):
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

        def fake_batch(_conn, site, jobs, delay=2.0, max_jobs=None, cancel_event=None):
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

        def fake_batch(_conn, site, jobs, delay=2.0, max_jobs=None, cancel_event=None):
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
        _seed_pending(conn, bad_url, "RemoteOK")
        _seed_pending(conn, good_url, "RemoteOK")

        monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())

        def fake_scrape(_page, url):
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
            conn, "RemoteOK", [(bad_url, "Bad"), (good_url, "Good")], delay=0
        )

        assert stats["error"] == 1
        assert stats["ok"] == 1

        bad_state = conn.execute(
            "SELECT state, error_code FROM job_stage_states WHERE job_url = ? AND stage = 'enrich'",
            (bad_url,),
        ).fetchone()
        assert bad_state["state"] == "failed"
        assert bad_state["error_code"] == "ENRICH_INTERNAL_ERROR"

        bad_event = conn.execute(
            """
            SELECT payload_json
            FROM job_events
            WHERE job_url = ? AND event_type = 'StageFailed'
            ORDER BY event_id DESC
            LIMIT 1
            """,
            (bad_url,),
        ).fetchone()
        payload = json.loads(bad_event["payload_json"])
        assert payload["errorCode"] == "ENRICH_INTERNAL_ERROR"
        assert payload["retryable"] is True

        good = conn.execute(
            "SELECT current_status FROM job_enrichments WHERE job_url = ?",
            (good_url,),
        ).fetchone()
        assert good["current_status"] == "enriched"
    finally:
        close_connection(db_path)


# ---------------------------------------------------------------------------
# Until-idle drain semantics
# ---------------------------------------------------------------------------


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

    def fake_enrich(*, workers, limit, cancel_event=None, reset_linkedin_candidates=True):
        reset_flags.append(reset_linkedin_candidates)
        return {"status": "ok"}

    monkeypatch.setattr(runner, "_run_enrich", fake_enrich)

    done = threading.Event()
    done.set()
    result: dict = {}
    runner._run_discovery_enrichment_until_idle(done, result, workers=1, limit=0)

    assert reset_flags == [True, False]
    assert result["status"] == "ok"


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

    def fake_until_idle(discovery_done, result, *, workers, limit, cancel_event=None):
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


def test_stage_progress_emits_failed_with_real_cause(monkeypatch: pytest.MonkeyPatch) -> None:
    events = _capture_pipeline_events(monkeypatch)

    def fake_until_idle(discovery_done, result, *, workers, limit, cancel_event=None):
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

    def fake_until_idle(discovery_done, result, *, workers, limit, cancel_event=None):
        result.update({"status": "ok", "passes": 0, "pending": 0})

    monkeypatch.setattr(runner, "_run_discovery_enrichment_until_idle", fake_until_idle)

    runner.run_discovery_enrichment_stage(progress_completed=0, progress_total=0)

    assert events == []
