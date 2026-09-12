"""Optional acquisition with real worker clients and owned persisted fixtures."""

from __future__ import annotations

import json
import threading
from io import BytesIO
from types import SimpleNamespace

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.errors import TransientNetworkError
from jobctrl.infrastructure.discovery import live_browser
from jobctrl.infrastructure.discovery.live_browser import (
    LiveBrowserTaskError,
    LiveChromeDiscoveryClient,
    prefer_live_browser,
)

from .live_browser_helpers import FixtureBrowserBroker, retryable_page_failure
from .politeness_helpers import offline_gateway


def execution() -> DiscoveryExecutionRef:
    return DiscoveryExecutionRef("local", "optional-extension", "optional-extension-run")


@pytest.mark.parametrize(
    "payload", [b'{"connected":false}', b"{}", b'{"connected":"true"}', b'{"connected":1}', b"[]", b"invalid"]
)
def test_unavailable_or_malformed_status_selects_anonymous_before_acquisition(tmp_path, payload) -> None:
    calls = []

    def transport(method, url, data, headers, timeout):
        calls.append((method, url, data, headers, timeout))
        return 200, payload

    client = LiveChromeDiscoveryClient(execution(), source_family="ats_api", app_dir=tmp_path, transport=transport)
    assert prefer_live_browser(client) is None
    assert len(calls) == 1
    assert calls[0][0] == "GET"
    assert calls[0][1].endswith("/v1/discovery/browser-extension/status")
    assert calls[0][2] is None
    assert "Authorization" not in calls[0][3]
    assert calls[0][4] == 1.0


def test_failed_status_probe_selects_anonymous_but_programming_errors_propagate(tmp_path) -> None:
    def unavailable(*_args):
        raise OSError("fixture API unavailable")

    client = LiveChromeDiscoveryClient(execution(), source_family="workday", app_dir=tmp_path, transport=unavailable)
    assert prefer_live_browser(client) is None

    def broken(*_args):
        raise TypeError("fixture programming error")

    client = LiveChromeDiscoveryClient(execution(), source_family="workday", app_dir=tmp_path, transport=broken)
    with pytest.raises(TypeError, match="programming error"):
        prefer_live_browser(client)


@pytest.mark.parametrize("before_probe", [True, False])
def test_cancellation_never_becomes_anonymous_fallback(tmp_path, before_probe) -> None:
    canceled = threading.Event()
    calls = []
    if before_probe:
        canceled.set()

    def transport(*_args):
        calls.append("status")
        canceled.set()
        raise OSError("fixture API unavailable")

    client = LiveChromeDiscoveryClient(execution(), source_family="enrichment", app_dir=tmp_path, transport=transport)
    with pytest.raises(TransientNetworkError, match="canceled"):
        prefer_live_browser(client, cancel_event=canceled)
    assert calls == ([] if before_probe else ["status"])


def test_selected_extension_failure_does_not_reselect_transport(tmp_path) -> None:
    broker = FixtureBrowserBroker(tmp_path, lambda _url: retryable_page_failure())
    client = broker.client(execution(), source_family="enrichment")
    assert prefer_live_browser(client) is client
    broker.connected = False
    with pytest.raises(LiveBrowserTaskError, match="fixture hydration timeout"):
        client.rendered_page("https://fixture.example/jobs/1")
    assert broker.status_checks == 1
    assert broker.visited == ["https://fixture.example/jobs/1"]
    assert broker.tasks == {}


class JsonOpener:
    def __init__(self, result_for):
        self.result_for = result_for
        self.visited = []

    def open(self, request, **_kwargs):
        self.visited.append(request.full_url)
        assert request.get_header("User-agent").startswith("JobCtrl/")
        return BytesIO(json.dumps(self.result_for(request.full_url)).encode())


def assert_cohort(conn, family: str, count: int = 1) -> None:
    rows = conn.execute(
        "SELECT discover_workflow_id, discover_run_id, source_family FROM discovery_execution_jobs"
    ).fetchall()
    assert [tuple(row) for row in rows] == [(execution().workflow_id, execution().temporal_run_id, family)] * count


@pytest.mark.parametrize("connected", [True, False])
def test_ats_acquisition_and_persistence_keep_execution_on_both_transports(tmp_path, monkeypatch, connected) -> None:
    from jobctrl.domain.discovery.scheduler import DiscoveryScheduler
    from jobctrl.domain.discovery.source_registry import SourceKind
    from jobctrl.infrastructure.discovery import production_wiring
    from jobctrl.infrastructure.network import http_client
    from .test_discovery_production_wiring import _barcelona_registry, _fake_ats_http, _search_cfg

    broker = FixtureBrowserBroker(
        tmp_path,
        lambda url: {
            "status": "succeeded",
            "finalUrl": url,
            "statusCode": 200,
            "bodyText": json.dumps(_fake_ats_http(url)),
        },
        connected=connected,
    )
    opener = JsonOpener(_fake_ats_http)
    conn = init_db(tmp_path / "jobs.db")
    monkeypatch.setattr(production_wiring, "LiveChromeDiscoveryClient", broker.client)
    monkeypatch.setattr(http_client, "build_public_http_opener", lambda: opener)
    schedule = DiscoveryScheduler().plan(registry=_barcelona_registry())
    try:
        result = production_wiring.run_scheduled_ats_sources(
            conn,
            schedule.for_kinds(SourceKind.ATS_API),
            search_cfg=_search_cfg(),
            run_id="optional-ats",
            gateway=offline_gateway(),
            discovery_execution=execution(),
        )
        assert result["new_jobs"] == 3
        assert_cohort(conn, "ats_api", 3)
        assert bool(broker.visited) is connected
        assert bool(opener.visited) is not connected
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("connected", [True, False])
def test_workday_search_detail_and_persistence_keep_execution_on_both_transports(
    tmp_path, monkeypatch, connected
) -> None:
    from jobctrl.discovery import workday

    def payload(url):
        if url.endswith("/jobs"):
            return {
                "total": 1,
                "jobPostings": [
                    {"title": "Director of Engineering", "locationsText": "Remote", "externalPath": "/job/role"}
                ],
            }
        return {
            "jobPostingInfo": {
                "jobDescription": "Lead engineering and reliable services. " * 20,
                "externalUrl": "https://acme.wd1.myworkdayjobs.com/External/job/role",
                "jobReqId": "role",
            }
        }

    broker = FixtureBrowserBroker(
        tmp_path,
        lambda url: {
            "status": "succeeded",
            "finalUrl": url,
            "statusCode": 200,
            "contentType": "application/json",
            "bodyText": json.dumps(payload(url)),
        },
        connected=connected,
    )
    opener = JsonOpener(payload)
    conn = init_db(tmp_path / "jobs.db")
    monkeypatch.setattr(workday, "_politeness", None)
    monkeypatch.setattr(workday, "LiveChromeDiscoveryClient", broker.client)
    monkeypatch.setattr(workday, "get_connection", lambda: conn)
    workday.configure_workday_politeness(gateway=offline_gateway(), opener=opener, discovery_execution=execution())
    employers = {
        "acme": {
            "name": "Acme",
            "base_url": "https://acme.wd1.myworkdayjobs.com",
            "tenant": "acme",
            "site_id": "External",
            "_source_id": "workday:acme",
        }
    }
    try:
        result = workday._process_one(
            "acme", employers, "Director of Engineering", False, [], [], discovery_execution=execution()
        )
        assert result["new"] == 1
        assert_cohort(conn, "workday")
        assert broker.status_checks == 1  # search and detail share the selected client
        assert len(broker.visited if connected else opener.visited) == 2
        assert (opener.visited if connected else broker.visited) == []
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("connected", [True, False])
def test_smartextract_parses_and_persists_on_both_transports(tmp_path, monkeypatch, connected) -> None:
    from jobctrl.discovery import smartextract

    job = {
        "@type": "JobPosting",
        "title": "Director of Engineering",
        "company": "Acme",
        "location": "Remote",
        "url": "https://careers.example/jobs/1",
        "description": "Lead engineering and reliable systems. " * 180,
    }
    html = (
        '<html><script type="application/ld+json">'
        + json.dumps(job)
        + "</script><body>"
        + job["description"]
        + "</body></html>"
    )

    def result_for(url):
        if url.endswith("robots.txt"):
            return {"status": "succeeded", "finalUrl": url, "statusCode": 404, "bodyText": ""}
        return {
            "status": "succeeded",
            "finalUrl": url,
            "statusCode": 200,
            "bodyText": job["description"],
            "bodyHtml": html,
        }

    broker = FixtureBrowserBroker(tmp_path, result_for, connected=connected)
    anonymous = []

    def collect(url, **_kwargs):
        anonymous.append(url)
        return smartextract.collect_live_page_intelligence(
            url,
            live_browser.LiveBrowserResult(
                final_url=url,
                status_code=200,
                content_type="text/html",
                title="Careers",
                body_text=html,
            ),
        )

    conn = init_db(tmp_path / "jobs.db")
    monkeypatch.setattr(smartextract, "init_db", lambda: conn)
    monkeypatch.setattr(smartextract, "LiveChromeDiscoveryClient", broker.client)
    monkeypatch.setattr(smartextract, "collect_page_intelligence", collect)
    plan = json.dumps(
        {
            "strategy": "json_ld",
            "extraction": {key: key for key in ("title", "company", "location", "url", "description")},
        }
    )
    monkeypatch.setattr(smartextract, "ask_llm", lambda _prompt: (plan, 0, {"response_chars": len(plan)}))
    try:
        result = smartextract._run_all(
            [{"name": "Acme", "url": "https://careers.example/jobs"}], [], [], discovery_execution=execution()
        )
        assert result["total_new"] == 1
        assert_cohort(conn, "smartextract")
        assert broker.status_checks == 1
        assert anonymous == ([] if connected else ["https://careers.example/jobs"])
        assert bool(broker.visited) is connected
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("connected", [True, False])
def test_jobstreaming_selected_transport_keeps_checkpoint_and_execution_cohort(
    tmp_path, monkeypatch, connected
) -> None:
    import jobstreaming
    from jobstreaming import AdapterCapabilities, AdapterRegistry, JobPost, JobResponse, Location, Scraper, Site
    from jobctrl.discovery import jobspy
    from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import SqliteDiscoverySearchUnitRepository
    from .test_jobstreaming_resumable_discovery import _NoopLimiter, _config

    body = {"title": "Director of Engineering", "description": "Lead engineering and reliable systems. " * 20}
    anonymous = []

    class HttpSession:
        headers = {}

        def get(self, url):
            anonymous.append(url)
            return SimpleNamespace(json=lambda: body)

    class Adapter(Scraper):
        capabilities = AdapterCapabilities(filters=frozenset({"location", "is_remote", "hours_old"}))

        def __init__(self, **_kwargs):
            super().__init__(Site.INDEED)
            self.session = HttpSession()

        def scrape(self, request, context=None):
            data = self.session.get("https://fixture.example/api/jobs").json()
            context.emit_job(
                JobPost(
                    id="fixture-1",
                    title=data["title"],
                    description=data["description"],
                    company_name="Acme",
                    job_url="https://fixture.example/jobs/1",
                    location=Location(city="Remote"),
                    is_remote=True,
                ),
                {"next": 1},
            )
            return JobResponse()

    source = AdapterRegistry()
    source.register(Site.INDEED, Adapter)
    broker = FixtureBrowserBroker(
        tmp_path,
        lambda url: {
            "status": "succeeded",
            "finalUrl": url,
            "statusCode": 200,
            "bodyText": json.dumps(body),
        },
        connected=connected,
    )
    conn = init_db(tmp_path / "jobs.db")
    monkeypatch.setattr(jobspy, "init_db", lambda: conn)
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    monkeypatch.setattr(jobstreaming, "default_registry", lambda: source)
    monkeypatch.setattr(live_browser, "_urllib_transport", broker.transport)
    monkeypatch.setattr(live_browser.config, "APP_DIR", tmp_path)
    try:
        registry = live_browser.live_jobstreaming_registry(execution())
        result = jobspy.run_discovery(
            cfg=_config(),
            discovery_execution=execution(),
            activity_attempt=1,
            activity_owner_token="optional-owner",
            adapter_registry=registry,
        )
        assert result["new"] == 1
        assert_cohort(conn, "jobspy")
        unit = SqliteDiscoverySearchUnitRepository(conn).list_units(execution())[0]
        assert unit.state == "completed"
        assert unit.checkpoint_revision > 0
        assert bool(anonymous) is not connected
        assert bool(broker.visited) is connected
    finally:
        close_connection(tmp_path / "jobs.db")
