"""Optional acquisition with real worker clients and owned persisted fixtures."""

from __future__ import annotations

import json
import threading
from io import BytesIO

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


@pytest.mark.parametrize(
    ("removable_prefix", "main_container"),
    [(False, True), (True, True), (True, False)],
    ids=["oversized-tail", "removable-prefix-main", "removable-prefix-body"],
)
def test_disconnected_guest_linkedin_persists_clean_description_without_llm(
    tmp_path, monkeypatch, public_provider_network, removable_prefix, main_container
) -> None:
    from contextlib import nullcontext
    from types import SimpleNamespace

    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.enrichment import detail
    from jobctrl.infrastructure.enrichment.sqlite_repository import SqlitePostingSnapshotSetRepository
    from .test_enrichment_extractors import _GUEST_DESCRIPTION, _GuestLinkedInPage, _guest_linkedin_html
    from .test_enrichment_politeness_gate import _SpyPage
    from .test_enrichment_queue_selectors import _seed_discovered

    url = "https://www.linkedin.com/jobs/view/synthetic-guest-description"
    navigations, llm_calls, closed = [], [], []

    class Page(_GuestLinkedInPage, _SpyPage):
        def goto(self, target, **kwargs):
            self.url = target
            return _SpyPage.goto(self, target, **kwargs)

    page = Page(_guest_linkedin_html(
        oversized=True, removable_prefix=removable_prefix, main_container=main_container,
    ))
    _SpyPage.__init__(page, navigations)
    browser = SimpleNamespace(
        close=lambda: closed.append(True),
        new_context=lambda **_kwargs: SimpleNamespace(new_page=lambda: page),
    )
    playwright = SimpleNamespace(chromium=SimpleNamespace(launch=lambda **_kwargs: browser))
    broker = FixtureBrowserBroker(
        tmp_path, lambda _url: pytest.fail("disconnected extension must not receive page tasks"), connected=False
    )

    def reject_llm(*_args, **_kwargs):
        llm_calls.append(True)
        pytest.fail("known guest markup must be extracted without an LLM")

    monkeypatch.setattr(detail, "LiveChromeDiscoveryClient", broker.client)
    monkeypatch.setattr(detail, "sync_playwright", lambda: nullcontext(playwright))
    monkeypatch.setattr(detail, "get_llm_adapter", lambda: SimpleNamespace(chat=reject_llm))
    monkeypatch.setattr(detail, "LinkedInApplyUrlResolver", lambda **_kw: pytest.fail("personal profile opened"))
    path = tmp_path / "guest-enrichment.db"
    conn = init_db(path)
    try:
        job_id = _seed_discovered(conn, url)
        notified = []
        stats = detail.scrape_site_batch(
            conn, "linkedin", [(job_id, "Synthetic engineering role")],
            gateway=offline_gateway(), discovery_execution=execution(), on_job_enriched=notified.append,
        )
        assert stats["processed"] == 1
        assert stats["partial"] == 1  # The description succeeds without an external application URL.
        assert stats["error"] == stats["blocked"] == 0
        assert stats["tiers"] == {1: 0, 2: 1, 3: 0}
        assert broker.status_checks == 1
        assert broker.visited == [] and broker.tasks == {}
        assert navigations == [url]
        assert page.body_fallback_calls == int(not main_container)
        assert llm_calls == []
        assert notified == [job_id]
        assert closed == [True]
        assert not conn.in_transaction

        # Reopen SQLite to prove the accepted description and provenance were committed.
        close_connection(path)
        conn = init_db(path)
        saved = detail.SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, job_id)
        assert saved is not None and saved.is_enriched
        assert saved.full_description.text == _GUEST_DESCRIPTION.strip()
        assert saved.application_url is None
        stage = conn.execute(
            "SELECT state, error_code FROM job_stage_states WHERE job_id = ? AND stage = 'enrich'", (str(job_id),)
        ).fetchone()
        assert tuple(stage) == ("succeeded", None)
        snapshots = SqlitePostingSnapshotSetRepository(conn).load(LOCAL_TENANT, job_id)
        assert snapshots is not None and snapshots.latest_snapshot is not None
        assert snapshots.latest_snapshot.extraction_tier == "css_selectors"
        assert not snapshots.latest_snapshot.is_quarantined
        event = conn.execute(
            "SELECT payload_json FROM job_events WHERE job_id = ? AND stage = 'enrich' AND event_type = 'StageCompleted'",
            (str(job_id),),
        ).fetchone()
        assert event is not None
        assert json.loads(event[0])["descriptionChars"] == len(_GUEST_DESCRIPTION.strip())
    finally:
        close_connection(path)


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
        assert not url.endswith("robots.txt"), "acquisition must not request robots.txt"
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
    tmp_path, monkeypatch, connected, public_provider_network
) -> None:
    import requests
    import jobstreaming
    from jobstreaming import AdapterCapabilities, AdapterRegistry, JobPost, JobResponse, Location, Scraper, Site
    from jobctrl.discovery import jobspy
    from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import SqliteDiscoverySearchUnitRepository
    from .test_jobstreaming_resumable_discovery import _NoopLimiter, _config

    body = {"title": "Director of Engineering", "description": "Lead engineering and reliable systems. " * 20}
    anonymous = []

    def send(_adapter, request, **_kwargs):
        anonymous.append(request.url)
        return _provider_response(request, body=json.dumps(body).encode())

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)

    class Adapter(Scraper):
        capabilities = AdapterCapabilities(filters=frozenset({"location", "is_remote", "hours_old"}))

        def __init__(self, **_kwargs):
            super().__init__(Site.INDEED)
            self.session = self.track_transport(requests.Session())

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


@pytest.fixture
def public_provider_network(monkeypatch, tmp_path):
    """Controlled DNS and a hard socket sentinel: no source traffic is possible."""
    import socket

    def resolve(_host, port, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]

    def no_socket(*_args, **_kwargs):
        pytest.fail("unexpected network socket in provider fixture")

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setattr(socket, "socket", no_socket)
    monkeypatch.setattr(socket, "create_connection", no_socket)
    for variable in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ):
        monkeypatch.delenv(variable, raising=False)
    empty_netrc = tmp_path / "empty-netrc"
    empty_netrc.write_text("")
    monkeypatch.setenv("NETRC", str(empty_netrc))
    return resolve


@pytest.fixture
def offline_provider_registry(monkeypatch, public_provider_network):
    from jobctrl.domain.errors import ConfigurationError

    def unavailable(_client):
        raise ConfigurationError("fixture extension offline")

    monkeypatch.setattr(live_browser.LiveChromeDiscoveryClient, "ensure_available", unavailable)
    return live_browser.live_jobstreaming_registry(execution())


def _provider_response(request, status=200, *, body=b"", headers=None):
    import requests

    response = requests.Response()
    response.status_code = status
    response.url = request.url
    response.request = request
    response.headers.update(headers or {})
    response._content = body
    response.raw = BytesIO(body)
    return response


@pytest.fixture(params=["environment", "default"])
def owned_provider_netrc(monkeypatch, tmp_path, offline_provider_registry, request):
    """A real synthetic netrc entry, with no access to personal credential files."""
    import requests.sessions
    import requests.utils

    netrc = tmp_path / "fixture-netrc"
    netrc.write_text("default login fixture-user password fixture-secret\n")
    netrc.chmod(0o600)
    if request.param == "environment":
        monkeypatch.setenv("NETRC", str(netrc))
    else:
        monkeypatch.delenv("NETRC")
        expanduser = requests.utils.os.path.expanduser
        monkeypatch.setattr(
            requests.utils.os.path,
            "expanduser",
            lambda path: str(netrc) if path in ("~/.netrc", "~/_netrc") else expanduser(path),
        )
    lookups = []
    get_netrc_auth = requests.sessions.get_netrc_auth

    def lookup(url, *args, **kwargs):
        lookups.append(url)
        return get_netrc_auth(url, *args, **kwargs)

    monkeypatch.setattr(requests.sessions, "get_netrc_auth", lookup)
    return lookups


def _anonymous_provider_session(provider, site_name):
    if site_name == "bdjobs":
        return provider._detail_session()
    if site_name in ("glassdoor", "zip_recruiter"):
        return provider._get_detail_session()
    return provider.session


@pytest.mark.parametrize("site_name", ["linkedin", "glassdoor", "zip_recruiter", "bdjobs"])
def test_anonymous_provider_sessions_do_not_read_netrc(
    monkeypatch, offline_provider_registry, owned_provider_netrc, site_name
):
    import requests
    from jobstreaming import Site

    sent = []

    def send(_adapter, request, **_kwargs):
        sent.append(request.headers.get("Authorization"))
        redirects = {"/start": "https://jobs.example/middle", "/middle": "https://other.example/final"}
        location = redirects.get(request.path_url)
        return _provider_response(request, 302 if location else 200, headers={"Location": location} if location else {})

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    provider = offline_provider_registry.create(Site(site_name))
    try:
        session = _anonymous_provider_session(provider, site_name)
        response = session.get("https://jobs.example/start", allow_redirects=True)
        assert response.status_code == 200 and len(response.history) == 2
        assert sent == [None, None, None]
        assert owned_provider_netrc == []

        # Provider protocol auth survives same-origin redirects; Requests still
        # removes it at an origin change without consulting ambient credentials.
        session.headers["Authorization"] = "Bearer provider-fixture"
        session.get("https://jobs.example/start", allow_redirects=True)
        assert sent[3:] == ["Bearer provider-fixture", "Bearer provider-fixture", None]
        assert owned_provider_netrc == []
    finally:
        provider.close()


def test_recreated_google_sessions_do_not_read_netrc(monkeypatch, offline_provider_registry, owned_provider_netrc):
    import requests
    from jobstreaming import ScraperInput, Site

    sent = []
    monkeypatch.setattr(
        requests.adapters.HTTPAdapter,
        "send",
        lambda _adapter, request, **_kw: (
            sent.append(request.headers.get("Authorization")) or _provider_response(request)
        ),
    )
    provider = offline_provider_registry.create(Site.GOOGLE)
    query = ScraperInput(site_type=[Site.GOOGLE], search_term="fixture", results_wanted=1)
    try:
        assert provider.scrape(query).jobs == ()
        initial = provider.session
        assert provider.scrape(query).jobs == ()
        assert provider.session is not initial
        assert sent == [None, None]
        assert owned_provider_netrc == []
    finally:
        provider.close()


@pytest.mark.parametrize("auth_source", ["request", "session"])
def test_anonymous_provider_preserves_explicit_auth(
    monkeypatch, offline_provider_registry, owned_provider_netrc, auth_source
):
    import requests
    from jobstreaming import Site

    sent = []

    def send(_adapter, request, **_kwargs):
        sent.append(request.headers.get("Authorization"))
        return _provider_response(request)

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    provider = offline_provider_registry.create(Site.LINKEDIN)
    try:
        auth = ("explicit-fixture", "explicit-password")
        if auth_source == "session":
            provider.session.auth = auth
        provider.session.get("https://jobs.example/start", **({"auth": auth} if auth_source == "request" else {}))
        assert sent == [requests.auth._basic_auth_str(*auth)]
        assert owned_provider_netrc == []
    finally:
        provider.close()


@pytest.mark.parametrize("redirect", [False, True])
def test_real_linkedin_provider_search_rejects_private_destinations(monkeypatch, offline_provider_registry, redirect):
    import requests
    from jobstreaming import ScraperInput, Site
    from jobctrl.infrastructure.network.public_http import UnsafePublicDestinationError

    sent = []

    def send(_adapter, request, **_kwargs):
        sent.append(request.url)
        return _provider_response(request, 302, headers={"Location": "http://127.0.0.1:17699/private"})

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    provider = offline_provider_registry.create(Site.LINKEDIN)
    if not redirect:
        provider.base_url = "http://127.0.0.1:17699"
    try:
        with pytest.raises(UnsafePublicDestinationError, match="not a public"):
            provider.scrape(
                ScraperInput(site_type=[Site.LINKEDIN], search_term="fixture", location="Remote", results_wanted=1)
            )
        assert len(sent) == int(redirect)
        if redirect:
            assert sent[0].startswith("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?")
    finally:
        provider.close()


def test_real_google_recreated_search_session_is_guarded(monkeypatch, offline_provider_registry):
    import requests
    from jobstreaming import ScraperInput, Site
    from jobctrl.infrastructure.network.public_http import UnsafePublicDestinationError

    sent = []
    monkeypatch.setattr(
        requests.adapters.HTTPAdapter,
        "send",
        lambda _adapter, request, **_kw: sent.append(request.url) or _provider_response(request),
    )
    provider = offline_provider_registry.create(Site.GOOGLE)
    request = ScraperInput(site_type=[Site.GOOGLE], search_term="fixture", results_wanted=1)
    try:
        assert provider.scrape(request).jobs == ()
        original_session = provider.session
        assert len(sent) == 1 and sent[0].startswith("https://www.google.com/search?")
        provider.url = "http://169.254.169.254/latest/meta-data"
        with pytest.raises(UnsafePublicDestinationError, match="not a public"):
            provider.scrape(request)
        assert provider.session is not original_session
        assert len(sent) == 1
    finally:
        provider.close()


@pytest.mark.parametrize("site_name", ["glassdoor", "zip_recruiter", "bdjobs"])
def test_real_provider_detail_sessions_preserve_options_and_remain_guarded(
    monkeypatch, offline_provider_registry, site_name
):
    import requests
    import tls_client.sessions
    from jobstreaming import Site
    from jobctrl.infrastructure.network.public_http import UnsafePublicDestinationError

    monkeypatch.setattr(tls_client.sessions, "request", lambda *_a, **_kw: pytest.fail("unguarded native TLS request"))
    sent = []

    def send(_adapter, request, **kwargs):
        sent.append((request, kwargs))
        return _provider_response(request, body=b'{"posting":"fixture"}')

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    provider = offline_provider_registry.create(Site(site_name))
    try:
        detail_session = provider._detail_session if site_name == "bdjobs" else provider._get_detail_session
        session = detail_session()
        assert detail_session() is session
        session.headers["X-Fixture"] = "detail"
        session.cookies.set("fixture", "present", domain="jobs.example")
        response = session.post(
            "https://jobs.example/detail",
            params={"page": 2},
            json={"id": "fixture"},
            **({"timeout": 7} if site_name == "bdjobs" else {"timeout_seconds": 7}),
        )
        assert response.json() == {"posting": "fixture"}
        assert sent[0][0].url == "https://jobs.example/detail?page=2"
        assert json.loads(sent[0][0].body) == {"id": "fixture"}
        assert sent[0][0].headers["X-Fixture"] == "detail"
        if site_name == "bdjobs":
            assert "Cookie" not in sent[0][0].headers  # provider deliberately clears its cookie jar
        else:
            assert "fixture=present" in sent[0][0].headers["Cookie"]
        assert sent[0][1]["timeout"] == 7
        with pytest.raises(UnsafePublicDestinationError, match="not a public"):
            session.get("http://[::1]/private")
        assert len(sent) == 1
    finally:
        provider.close()


class _ProviderWireSocket:
    """HTTP wire fixture that records numeric connects without opening sockets."""

    def __init__(self, reply):
        self.reply = reply
        self.address = None
        self.sent = bytearray()
        self.timeout = None

    def connect(self, address):
        self.address = address

    def settimeout(self, timeout):
        self.timeout = timeout

    def sendall(self, data):
        self.sent.extend(data)

    def makefile(self, *_args, **_kwargs):
        return BytesIO(self.reply)

    def close(self):
        pass


def _provider_wire(monkeypatch, replies):
    import socket

    sockets = []

    def create(*_args, **_kwargs):
        assert len(sockets) < len(replies), "unexpected extra network attempt"
        sock = _ProviderWireSocket(replies[len(sockets)])
        sockets.append(sock)
        return sock

    monkeypatch.setattr(socket, "socket", create)
    return sockets


def test_real_provider_socket_path_pins_public_redirects_and_preserves_requests_semantics(
    monkeypatch, offline_provider_registry
):
    from jobstreaming import Site

    sockets = _provider_wire(
        monkeypatch,
        [
            b"HTTP/1.1 302 Found\r\nLocation: http://other.example/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nSet-Cookie: accepted=yes; Path=/\r\nConnection: close\r\n\r\n{"ok":true}',
        ],
    )
    provider = offline_provider_registry.create(Site.LINKEDIN)
    try:
        response = provider.session.get(
            "http://jobs.example/start", params={"page": 2}, headers={"Authorization": "Bearer fixture"}, timeout=9
        )
        assert response.json() == {"ok": True}
        assert response.url == "http://other.example/final"
        assert [item.status_code for item in response.history] == [302]
        assert provider.session.cookies.get("accepted") == "yes"
        assert [sock.address for sock in sockets] == [("93.184.216.34", 80)] * 2
        assert all(sock.timeout == 9 for sock in sockets)
        assert b"GET /start?page=2 HTTP/1.1" in sockets[0].sent
        assert b"Authorization: Bearer fixture" in sockets[0].sent
        assert b"Authorization:" not in sockets[1].sent
    finally:
        provider.close()


def test_real_provider_socket_path_blocks_private_redirect_before_second_connect(
    monkeypatch, offline_provider_registry
):
    from jobstreaming import Site
    from jobctrl.infrastructure.network.public_http import UnsafePublicDestinationError

    sockets = _provider_wire(
        monkeypatch,
        [
            b"HTTP/1.1 302 Found\r\nLocation: http://10.0.0.1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        ],
    )
    provider = offline_provider_registry.create(Site.LINKEDIN)
    try:
        with pytest.raises(UnsafePublicDestinationError, match="not a public"):
            provider.session.get("http://jobs.example/start")
        assert len(sockets) == 1
        assert sockets[0].address == ("93.184.216.34", 80)
    finally:
        provider.close()


@pytest.mark.parametrize("change_after_validation", [False, True])
def test_real_provider_socket_path_blocks_private_dns_and_rebinding(
    monkeypatch, offline_provider_registry, change_after_validation
):
    import socket
    from jobstreaming import Site
    from jobctrl.infrastructure.network.public_http import UnsafePublicDestinationError

    resolutions = []

    def resolve(host, port, **_kwargs):
        resolutions.append(host)
        address = "93.184.216.34" if change_after_validation and len(resolutions) == 1 else "10.0.0.1"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    provider = offline_provider_registry.create(Site.LINKEDIN)
    try:
        with pytest.raises(UnsafePublicDestinationError, match="non-public"):
            provider.session.get("http://jobs.example/start")
        assert len(resolutions) == (2 if change_after_validation else 1)
    finally:
        provider.close()


@pytest.mark.parametrize("proxy", ["http://proxy.example:8080", "socks5://proxy.example:1080"])
@pytest.mark.parametrize("site_name", ["linkedin", "glassdoor"])
def test_anonymous_provider_rejects_proxy_routing_before_socket_io(offline_provider_registry, proxy, site_name):
    from jobstreaming import Site
    from jobctrl.domain.errors import ConfigurationError

    provider = offline_provider_registry.create(Site(site_name), proxies=[proxy])
    try:
        with pytest.raises(ConfigurationError, match="cannot pin destination DNS through a proxy"):
            _anonymous_provider_session(provider, site_name).get("https://jobs.example/start")
    finally:
        provider.close()


@pytest.mark.parametrize("site_name", ["linkedin", "glassdoor"])
@pytest.mark.parametrize(
    "variable", ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
)
def test_anonymous_provider_rejects_environment_proxy_routing(
    monkeypatch, offline_provider_registry, variable, site_name
):
    from jobstreaming import Site
    from jobctrl.domain.errors import ConfigurationError

    provider = offline_provider_registry.create(Site(site_name))
    try:
        session = _anonymous_provider_session(provider, site_name)
        monkeypatch.setenv(variable, "http://proxy.example:8080")
        scheme = "http" if variable.lower() == "http_proxy" else "https"
        with pytest.raises(ConfigurationError, match="cannot pin destination DNS through a proxy"):
            session.get(f"{scheme}://jobs.example/start")
    finally:
        provider.close()


@pytest.mark.parametrize("site_name", ["linkedin", "glassdoor"])
def test_anonymous_provider_rechecks_environment_proxy_after_no_proxy_redirect(
    monkeypatch, offline_provider_registry, site_name
):
    import requests
    from jobstreaming import Site
    from jobctrl.domain.errors import ConfigurationError

    sent = []

    def send(_adapter, request, **_kwargs):
        sent.append(request.url)
        return _provider_response(request, 302, headers={"Location": "https://other.example/final"})

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:8080")
    monkeypatch.setenv("NO_PROXY", "jobs.example")
    provider = offline_provider_registry.create(Site(site_name))
    try:
        with pytest.raises(ConfigurationError, match="cannot pin destination DNS through a proxy"):
            _anonymous_provider_session(provider, site_name).get("https://jobs.example/start", allow_redirects=True)
        assert sent == ["https://jobs.example/start"]
    finally:
        provider.close()


def test_anonymous_provider_cancellation_during_dns_never_reaches_socket(monkeypatch, offline_provider_registry):
    import socket
    from jobstreaming import Site

    cancel = threading.Event()
    registry = live_browser.live_jobstreaming_registry(execution(), cancel_event=cancel)
    provider = registry.create(Site.LINKEDIN)

    def resolve(_host, port, **_kwargs):
        cancel.set()
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    try:
        with pytest.raises(TransientNetworkError, match="canceled"):
            provider.session.get("http://jobs.example/start")
    finally:
        provider.close()
