"""Server throttling never enters extraction and paces subsequent host requests."""
from __future__ import annotations

import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.discovery.source_registry import ENRICHMENT_CRAWL_POLICY
from jobctrl.domain.ports.politeness import HonestUserAgent
from jobctrl.enrichment import detail
from jobctrl.infrastructure.discovery.live_browser import LiveBrowserResult
from jobctrl.infrastructure.enrichment import playwright_fetcher
from jobctrl.infrastructure.network import (
    HostRateLimiter, PolitenessGateway, PolitenessSession, PolitenessSourceContext,
    PublicUrlDecision, RunBudgetCounter,
)
from .politeness_helpers import VirtualClock

URL = "https://jobs.example/role"


class Page:
    def __init__(self, status=429, headers=None):
        self.status = status
        self.headers = headers or {}
        self.url = URL
        self.navigations = 0

    def goto(self, url, **kwargs):
        self.url = url
        self.navigations += 1
        return SimpleNamespace(status=self.status, headers=self.headers)

    def wait_for_load_state(self, *args, **kwargs):
        pass


def no_capture(*args, **kwargs):
    pytest.fail("Rate-limited responses must not enter posting capture or extraction")


@pytest.fixture
def acquisition(tmp_path, monkeypatch):
    path = tmp_path / "jobs.db"
    conn = init_db(path)
    clock = VirtualClock()
    gateway = PolitenessGateway(
        user_agent=HonestUserAgent("Synthetic", "1"),
        rate_limiter=HostRateLimiter(clock=clock.now, sleep=clock.sleep),
    )
    session = PolitenessSession(
        gateway, policy=ENRICHMENT_CRAWL_POLICY, budget=RunBudgetCounter(10),
        context=PolitenessSourceContext(stage="enrich", source_id="synthetic"), recorder_conn=conn,
    )
    monkeypatch.setattr(detail, "validate_public_http_url", lambda _: PublicUrlDecision(True))
    monkeypatch.setattr(playwright_fetcher, "validate_public_http_url", lambda _: PublicUrlDecision(True))
    monkeypatch.setattr(detail, "_page_to_detail_page", no_capture)
    monkeypatch.setattr(detail, "_live_result_to_detail_page", no_capture)
    monkeypatch.setattr(playwright_fetcher, "_collect_json_ld", no_capture)
    yield conn, clock, session
    close_connection(path)


@pytest.mark.parametrize("status,headers,delay", [
    (429, {"retry-after": "120"}, 120),
    (503, {"Retry-After": "45"}, 45),
    (429, {}, 60),
    (429, {"Retry-After": "invalid"}, 60),
    (429, {"Retry-After": "²"}, 60),
    (429, {"Retry-After": "9" * 400}, 60),
    (429, {"Retry-After": "0"}, 2),
])
def test_browser_response_defers_same_host_without_extraction(acquisition, status, headers, delay):
    conn, clock, session = acquisition
    page = Page(status, headers)
    result = detail.scrape_detail_page(page, URL, session=session)
    assert result["status"] == "blocked"
    assert result["http_status"] == status
    assert result["politeness_outcome"] == "rate_limited"
    assert str(status) in result["error"]
    assert page.navigations == 1
    with session.guard("https://other.example/role") as decision:
        assert decision.allowed and clock.now() == 0
    with session.guard(URL) as decision:
        assert decision.allowed and clock.now() == delay
    rows = conn.execute("SELECT * FROM operational_attempt_metrics WHERE failure_category='rate_limited'").fetchall()
    assert len(rows) == 1
    assert rows[0]["is_scrape_failure"] == 0


def test_extreme_retry_after_prevents_second_browser_navigation(acquisition):
    conn, clock, session = acquisition
    page = Page(429, {"Retry-After": "9999999"})
    assert detail.scrape_detail_page(page, URL, session=session)["status"] == "blocked"
    assert detail.scrape_detail_page(page, URL, session=session)["politeness_outcome"] == "rate_limited"
    assert page.navigations == 1
    assert clock.now() == 0
    assert session.budget.consumed() == 1
    assert conn.execute("SELECT count(*) FROM operational_attempt_metrics WHERE failure_category='rate_limited'").fetchone()[0] == 2


@pytest.mark.parametrize("raises,status", [(False, 429), (True, 429), (True, 503)])
def test_one_off_fetcher_records_rate_limit_before_capture(acquisition, monkeypatch, raises, status):
    conn, clock, session = acquisition
    page = Page(status, {"Retry-After": "120"})
    browser = SimpleNamespace(new_page=lambda: page, close=lambda: None)
    browser.new_context = lambda **kwargs: browser

    @contextmanager
    def playwright():
        yield SimpleNamespace(chromium=SimpleNamespace(launch=lambda **kwargs: browser))

    monkeypatch.setattr("playwright.sync_api.sync_playwright", playwright)
    fetcher = playwright_fetcher.PlaywrightDetailPageFetcher(session=session, raise_on_unavailable=raises)
    if raises:
        expected = playwright_fetcher.DetailPageFetchBlocked if status == 429 else playwright_fetcher.DetailPageFetchUnavailable
        with pytest.raises(expected):
            fetcher.fetch(URL)
    else:
        result = fetcher.fetch(URL)
        assert result.status == status and result.html == "" and result.json_ld == ()
    with session.guard(URL) as decision:
        assert decision.allowed and clock.now() == 120
    assert conn.execute("SELECT count(*) FROM operational_attempt_metrics WHERE failure_category='rate_limited'").fetchone()[0] == 1


def test_connected_enrichment_rate_limit_uses_default_cooldown(acquisition):
    _, clock, session = acquisition
    result = LiveBrowserResult(URL, 429, "text/html", "Rate limited", "Retry later")
    browser = SimpleNamespace(rendered_page=lambda *args, **kwargs: result)
    scraped = detail.scrape_detail_page_via_live_chrome(browser, URL, session=session)
    assert scraped["status"] == "blocked" and scraped["http_status"] == 429
    with session.guard(URL):
        assert clock.now() == 60


def test_rate_limit_is_recorded_before_releasing_connected_host_slot(acquisition, monkeypatch):
    _, _, session = acquisition
    held = False
    guard = session.guard
    record = session.record_server_rate_limit

    @contextmanager
    def held_guard(url):
        nonlocal held
        with guard(url) as decision:
            held = True
            try:
                yield decision
            finally:
                held = False

    def record_while_held(*args, **kwargs):
        assert held, "Another same-host request must not be admitted before response feedback"
        record(*args, **kwargs)

    monkeypatch.setattr(session, "guard", held_guard)
    monkeypatch.setattr(session, "record_server_rate_limit", record_while_held)
    result = LiveBrowserResult(URL, 429, "text/html", "Rate limited", "Retry later")
    browser = SimpleNamespace(rendered_page=lambda *args, **kwargs: result)
    assert detail.scrape_detail_page_via_live_chrome(browser, URL, session=session)["status"] == "blocked"


def test_batch_rate_limit_preserves_accepted_content_and_processes_next_target(acquisition, monkeypatch):
    from jobctrl.domain.enrichment import ApplicationUrl, ExtractionTier, FullDescription, JobEnrichment
    from jobctrl.domain.identifiers import generate_job_id
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
    from jobctrl.state import ensure_job_stage_rows

    conn, clock, _ = acquisition
    job_ids = [generate_job_id(), generate_job_id()]
    urls = [URL, "https://other.example/role"]
    repo = SqliteEnrichmentRepository(conn)
    for job_id, url in zip(job_ids, urls, strict=True):
        conn.execute("INSERT INTO jobs (tenant_id,job_id,url,title,site,discovered_at) VALUES ('local',?,?,'Role','example','2026-01-01')", (str(job_id), url))
        conn.execute("INSERT INTO job_locators (tenant_id,job_id,locator_kind,locator_value,is_current,first_seen_at,last_seen_at) VALUES ('local',?,'posting_url',?,1,'2026-01-01','2026-01-01')", (str(job_id), url))
        ensure_job_stage_rows(conn, job_id)
    accepted = JobEnrichment.empty(tenant_id=LOCAL_TENANT, job_id=job_ids[0], updated_at="2026-01-01")
    accepted = accepted.start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="2026-01-01")
    accepted = accepted.succeed_attempt(
        full_description=FullDescription("Previously accepted posting content."),
        application_url=ApplicationUrl("https://employer.example/apply"),
        extraction_tier=ExtractionTier.JSON_LD, finished_at="2026-01-01",
    )
    repo.save(accepted.reset(reset_at="2026-01-02"))
    conn.commit()
    page = Page(429, {"Retry-After": "120"})
    browser = SimpleNamespace(new_page=lambda: page, close=lambda: None)
    browser.new_context = lambda **kwargs: browser

    @contextmanager
    def playwright():
        yield SimpleNamespace(chromium=SimpleNamespace(launch=lambda **kwargs: browser))

    monkeypatch.setattr(detail, "sync_playwright", playwright)
    gateway = PolitenessGateway(user_agent=HonestUserAgent("Synthetic", "1"), rate_limiter=HostRateLimiter(clock=clock.now, sleep=clock.sleep))
    stats = detail.scrape_site_batch(conn, "example", [(job_id, "Role") for job_id in job_ids], gateway=gateway)
    assert stats["processed"] == 2 and stats["blocked"] == 2 and stats["error"] == 0
    assert page.navigations == 2 and clock.now() == 0
    retained = repo.load(LOCAL_TENANT, job_ids[0])
    assert retained.full_description == accepted.full_description
    assert retained.application_url == accepted.application_url
    assert retained.enriched_at == accepted.enriched_at
    assert retained.attempts[:-1] == accepted.attempts
    assert retained.attempts[-1].error.retryable
    assert retained.attempts[-1].error.code == "ENRICH_POLITENESS_DEFERRED"
    events = conn.execute("SELECT payload_json FROM job_events WHERE event_type='StageFailed'").fetchall()
    assert len(events) == 2
    assert all(json.loads(row[0])["httpStatus"] == 429 for row in events)
    assert all(json.loads(row[0])["retryAfterSeconds"] == 120 for row in events)
