from __future__ import annotations

import json
from pathlib import Path

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.enrichment import detail
from jobhunter.enrichment.detail import (
    _detail_failure_retryable,
    _record_posting_snapshot_from_cascade,
    scrape_detail_page,
)

from .politeness_helpers import offline_gateway, offline_session


class _FakeResponse:
    status = 200


class _FakePage:
    url = "https://example.com/jobs/closed"

    def goto(self, *_args, **_kwargs):
        return _FakeResponse()

    def wait_for_load_state(self, *_args, **_kwargs) -> None:
        return None

    def title(self) -> str:
        return "Closed engineering role"


def _long_description() -> str:
    return "Build reliable distributed systems with Python, TypeScript, and Postgres. " * 8


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


class _OfflineLlmPort:
    """LlmPort stub for the Tier-3 extractor.

    Staleness detection wins at Tier 1 (JSON-LD) or Tier 2 (CSS), so the
    Tier-3 LLM extractor is only constructed by the cascade, never invoked.
    The stub keeps that construction from resolving a real provider (which
    needs API keys and network) and raises if the cascade ever falls through
    to the LLM tier, so a regression can't quietly reroute staleness detection
    through the model.
    """

    def chat(self, *_args, **_kwargs) -> str:
        raise AssertionError("LLM tier must not run during staleness detection")

    def chat_json(self, *_args, **_kwargs) -> dict:
        raise AssertionError("LLM tier must not run during staleness detection")

    def ask(self, *_args, **_kwargs) -> str:
        raise AssertionError("LLM tier must not run during staleness detection")


@pytest.fixture
def offline_llm_tier(monkeypatch: pytest.MonkeyPatch) -> None:
    """Swap the LlmPort the detail cascade resolves so Tier-3 construction stays
    offline-deterministic (no keys, no network)."""
    monkeypatch.setattr(detail, "get_llm_adapter", lambda: _OfflineLlmPort())


@pytest.mark.usefixtures("offline_llm_tier")
def test_scrape_detail_page_reports_expired_json_ld_as_inactive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        detail,
        "_collect_json_ld",
        lambda _page: [
            {
                "@type": "JobPosting",
                "description": _long_description(),
                "directApply": True,
                "url": "https://example.com/jobs/closed/apply",
                "validThrough": "2000-01-01T00:00:00+00:00",
            }
        ],
    )
    monkeypatch.setattr(detail, "_collect_main_content", lambda _page: "<main>Expired role</main>")

    result = scrape_detail_page(
        _FakePage(), "https://example.com/jobs/closed", session=offline_session()
    )

    assert result["status"] == "inactive"
    assert result["active_state"] == "expired"
    assert result["verification_method"] == "json_ld_valid_through"
    assert result["full_description"]


@pytest.mark.usefixtures("offline_llm_tier")
def test_scrape_detail_page_reports_closed_marker_as_inactive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(detail, "_collect_json_ld", lambda _page: [])
    monkeypatch.setattr(
        detail,
        "_collect_main_content",
        lambda _page: (
            "<main><p>This position is no longer accepting applications.</p>"
            f"<div id='job-description'>{_long_description()}</div></main>"
        ),
    )

    result = scrape_detail_page(
        _FakePage(), "https://example.com/jobs/closed", session=offline_session()
    )

    assert result["status"] == "inactive"
    assert result["active_state"] == "closed"
    assert result["verification_method"] == "closed_marker"
    assert result["full_description"]


def test_verified_no_data_extracted_detail_failure_stays_retryable() -> None:
    assert _detail_failure_retryable(
        {
            "status": "error",
            "error": "no data extracted",
            "active_state": "active",
            "verification_method": "default_body_present",
        }
    ) is True


def test_page_load_detail_failure_stays_retryable() -> None:
    assert _detail_failure_retryable({"status": "error", "error": "timeout"}) is True


def test_verified_inactive_detail_failure_is_not_retryable() -> None:
    assert _detail_failure_retryable(
        {
            "status": "inactive",
            "error": "posting removed",
            "active_state": "removed",
            "verification_method": "http_status",
        }
    ) is False


def test_scrape_site_batch_uses_discovery_description_when_detail_extracts_no_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    job_url = "https://www.linkedin.com/jobs/view/4375576106"
    description = _long_description()
    try:
        conn.execute(
            """
            INSERT INTO jobs (
                url, title, description, full_description, location, site,
                strategy, discovered_at, application_url, company
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_url,
                "Director of Engineering",
                description,
                description,
                "Barcelona, Catalonia, Spain",
                "linkedin",
                "jobspy",
                "2026-06-04T15:55:20+00:00",
                None,
                "Checkatrade",
            ),
        )
        conn.commit()

        # Force the anonymous browser path so the gate uses the injected offline
        # gateway (deterministic, no authenticated-session shared limiter).
        monkeypatch.setenv("JOBHUNTER_LINKEDIN_APPLY_RESOLVER", "0")
        monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())
        monkeypatch.setattr(
            detail,
            "scrape_detail_page",
            lambda _page, _url, session=None: {
                "status": "error",
                "tier_used": 3,
                "full_description": None,
                "application_url": None,
                "error": "no data extracted",
                "elapsed": 12.0,
                "active_state": "active",
                "verification_method": "default_body_present",
                "http_status": 200,
            },
        )

        stats = detail.scrape_site_batch(
            conn, "linkedin", [(job_url, "Director")], gateway=offline_gateway()
        )

        assert stats["processed"] == 1
        assert stats["partial"] == 1
        assert stats["error"] == 0

        enrichment = conn.execute(
            """
            SELECT current_status, full_description, attempts_json
            FROM job_enrichments
            WHERE job_url = ?
            """,
            (job_url,),
        ).fetchone()
        assert enrichment["current_status"] == "enriched"
        assert enrichment["full_description"] == description.strip()
        attempts = json.loads(enrichment["attempts_json"])
        assert attempts[-1]["status"] == "succeeded"

        stage = conn.execute(
            """
            SELECT state, metadata_json
            FROM job_stage_states
            WHERE job_url = ? AND stage = 'enrich'
            """,
            (job_url,),
        ).fetchone()
        assert stage["state"] == "succeeded"
        assert json.loads(stage["metadata_json"]) == {
            "fallbackSource": "discovery",
            "detailStatus": "error",
            "detailError": "no data extracted",
        }

        event = conn.execute(
            """
            SELECT payload_json
            FROM job_events
            WHERE job_url = ? AND event_type = 'StageCompleted'
            ORDER BY event_id DESC
            LIMIT 1
            """,
            (job_url,),
        ).fetchone()
        payload = json.loads(event["payload_json"])
        assert payload["fallbackSource"] == "discovery"
        assert payload["detailError"] == "no data extracted"
    finally:
        close_connection(db_path)


def test_selected_enrichment_filters_retry_to_requested_job(monkeypatch: pytest.MonkeyPatch) -> None:
    from jobhunter.enrichment.activities import EnrichActivityInput, _run_selected_enrichment

    calls: list[dict[str, object]] = []

    monkeypatch.setattr(detail, "_run_detail_scraper", lambda *args, **kwargs: calls.append(kwargs) or {
        "processed": 1,
        "ok": 1,
        "partial": 0,
        "error": 0,
        "tiers": {1: 1},
    })
    monkeypatch.setattr("jobhunter.database.get_connection", lambda: object())

    result = _run_selected_enrichment(
        EnrichActivityInput(
            tenant_id="local",
            job_urls=(
                "https://example.com/jobs/selected",
                "https://example.com/jobs/selected",
                "",
            ),
            limit=1,
        )
    )

    assert result["status"] == "ok"
    assert calls == [
        {
            "max_per_site": 1,
            "workers": 1,
            "job_urls": ("https://example.com/jobs/selected",),
        }
    ]


def test_inactive_cascade_snapshot_persists_closed_state(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        _record_posting_snapshot_from_cascade(
            conn,
            url="https://example.com/jobs/closed",
            source_id="jobspy",
            title="Closed engineering role",
            cascade_result={
                "status": "inactive",
                "tier_used": 1,
                "full_description": _long_description(),
                "application_url": "https://example.com/jobs/closed/apply",
                "active_state": "closed",
                "verification_method": "closed_marker",
            },
            captured_at="2026-05-29T12:00:00+00:00",
        )

        snapshot_set = conn.execute(
            """
            SELECT latest_active_state
            FROM posting_snapshot_sets
            WHERE tenant_id = 'local' AND job_url = ?
            """,
            ("https://example.com/jobs/closed",),
        ).fetchone()
        event = conn.execute(
            """
            SELECT payload_json
            FROM job_events
            WHERE event_type = 'JobActiveStateChanged'
            ORDER BY event_id DESC
            LIMIT 1
            """
        ).fetchone()

        assert snapshot_set["latest_active_state"] == "closed"
        assert json.loads(event["payload_json"])["active_state"] == "closed"
    finally:
        close_connection(db_path)
