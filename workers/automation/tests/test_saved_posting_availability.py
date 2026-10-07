"""Source-bound saved-posting observation regressions (synthetic employer data)."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
import multiprocessing
import threading
import time

from tests.page_fakes import interpreter
from jobctrl.database import init_db
from jobctrl.enrichment import availability as availability

import pytest

from jobctrl.domain.enrichment.snapshot_services import ActiveStateVerifier
from jobctrl.domain.enrichment.value_objects import DetailPage

URL = "https://careers.example.org/jobs/role-123"


def active_page(**kwargs):
    return DetailPage(
        url=URL,
        final_url=URL,
        status=200,
        html='<main><div class="job-description">'
        "Our historical launch applications are closed.</div><button>Apply</button></main>",
        page_title="Synthetic role",
        json_ld=({"@type": "JobPosting", "url": URL, "description": "Our historical launch applications are closed."},),
        **kwargs,
    )


@pytest.mark.parametrize("status", [403, 429, 500, 502, 503])
def test_error_body_cannot_prove_active(status):
    assert (
        ActiveStateVerifier(page_interpreter=interpreter()).verify(replace(active_page(), status=status))[0].value
        == "unknown"
    )


def test_slow_trickle_read_has_monotonic_deadline_and_closes_response(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(
        "jobctrl.infrastructure.network.url_safety.validate_public_http_url", lambda _: SimpleNamespace(allowed=True)
    )
    instant = [0.0]
    closed = []

    class SlowResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            closed.append(True)

        def read1(self, _size):
            instant[0] += 19
            return b"x"

        read = read1

    monkeypatch.setattr(availability.time, "monotonic", lambda: instant[0])
    monkeypatch.setattr(
        "jobctrl.infrastructure.network.public_http.build_public_http_opener",
        lambda **_: SimpleNamespace(open=lambda *_a, **_k: SlowResponse()),
    )
    with pytest.raises(availability.DeferredCheck, match="request_deadline"):
        availability._public_get_in_process(URL)
    assert instant[0] == 38 and closed == [True]


def test_total_request_deadline_cancels_and_reaps_owned_transport(monkeypatch):
    from types import SimpleNamespace

    events = []

    class Process:
        alive = True

        def start(self):
            events.append("started")

        def is_alive(self):
            return self.alive

        def terminate(self):
            self.alive = False
            events.append("terminated")

        def join(self, **_):
            events.append("reaped")

        def close(self):
            events.append("closed")

    receiver = SimpleNamespace(poll=lambda timeout: events.append(timeout) or False, close=lambda: None)
    sender = SimpleNamespace(close=lambda: None)
    context = SimpleNamespace(Pipe=lambda **_: (receiver, sender), Process=lambda **_: Process())
    monkeypatch.setattr(availability.multiprocessing, "get_context", lambda _: context)
    with pytest.raises(availability.DeferredCheck, match="request_deadline"):
        availability.public_get(URL)
    assert events == ["started", 20, "terminated", "reaped", "closed"]


def _blocking_owned_transport(_url, _sender):
    threading.Event().wait(60)


def test_actual_spawned_transport_is_cancelled_and_no_child_survives_the_deadline(monkeypatch):
    before = {process.pid for process in multiprocessing.active_children()}
    monkeypatch.setattr(availability, "_transport_process", _blocking_owned_transport)
    started = time.monotonic()
    with pytest.raises(availability.DeferredCheck, match="request_deadline"):
        availability.public_get(URL, timeout=0.15)
    assert time.monotonic() - started < 2
    assert {process.pid for process in multiprocessing.active_children()} == before


def test_aggregate_acquisition_deadline_stops_before_lease_can_expire(saved_job, monkeypatch):
    instant = [0.0]
    monkeypatch.setattr(availability.time, "monotonic", lambda: instant[0])
    monkeypatch.setattr(availability, "_now", lambda: NOW + timedelta(seconds=instant[0]))
    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)

    def slow(url):
        instant[0] = 121
        return availability.Response(url, url, 200, b"Synthetic response")

    acquisition = availability.Acquisition(saved_job, claim, transport=slow)
    with pytest.raises(availability.DeferredCheck, match="acquisition_deadline"):
        acquisition.acquire()
    assert acquisition.lineage[0]["rawHash"]
    assert availability.claim_job(saved_job, JOB_ID, now=NOW + timedelta(seconds=121))[1] == "check_in_progress"
    assert not availability._latest(saved_job, "local", "availability_lease", "host:careers.example.org").get("owner")


def test_computed_hidden_browser_status_and_control_state_survive_capture():
    from types import SimpleNamespace
    from jobctrl.infrastructure.enrichment.playwright_fetcher import _collect_status_html

    raw = '<aside class="css-hidden">Applications are closed</aside><button>Apply</button>'
    computed = "<aside hidden>Applications are closed</aside><button disabled>Apply</button>"
    html, complete, raw_hash = _collect_status_html(
        SimpleNamespace(content=lambda: raw, evaluate=lambda *_: {"statusHtml": computed})
    )
    assert complete and html == computed and len(raw_hash) == 64
    assert (
        ActiveStateVerifier(page_interpreter=interpreter()).verify(replace(active_page(), status_html=html))[0].value
        == "active"
    )


JOB_ID = "10000000-0000-4000-8000-000000000123"
NOW = datetime(2026, 10, 4, tzinfo=timezone.utc)


@pytest.fixture
def saved_job(tmp_path, monkeypatch):
    conn = init_db(tmp_path / "availability.db")
    model = __import__("tests.page_fakes", fromlist=["PageModel"]).PageModel()
    monkeypatch.setattr(
        availability,
        "build_page_interpreter",
        lambda connection=None, **kwargs: interpreter(
            model,
            __import__(
                "jobctrl.infrastructure.determinations", fromlist=["SqliteDeterminationRepository"]
            ).SqliteDeterminationRepository(connection or conn),
        ),
    )
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) "
        "VALUES ('local', ?, ?, 'Synthetic role', 'synthetic', ?)",
        (JOB_ID, URL, NOW.isoformat()),
    )
    conn.commit()
    yield conn
    conn.close()


def test_claim_coalesces_expired_recovers_and_old_owner_is_fenced(saved_job):
    first, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    assert first
    assert availability.claim_job(saved_job, JOB_ID, now=NOW)[1] == "check_in_progress"
    second, _ = availability.claim_job(saved_job, JOB_ID, now=NOW + timedelta(minutes=6))
    assert second and first.owner != second.owner
    with pytest.raises(availability.DeferredCheck, match="stale_lease"):
        availability.complete_check(
            saved_job,
            first,
            verdict="active",
            reason="exact",
            method="fixture",
            lineage=[],
            now=NOW + timedelta(minutes=6),
        )


def test_independent_sqlite_connections_have_exactly_one_owner(saved_job):
    path = saved_job.execute("PRAGMA database_list").fetchone()[2]

    def claim_one(_):
        conn = sqlite3.connect(path, timeout=5)
        try:
            return availability.claim_job(conn, JOB_ID, now=NOW)[0]
        finally:
            conn.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        owners = list(pool.map(claim_one, range(2)))
    assert sum(owner is not None for owner in owners) == 1


def _process_claim(args):
    path, job_id, instant = args
    with sqlite3.connect(path, timeout=5) as conn:
        claim, reason = availability.claim_job(conn, job_id, now=datetime.fromisoformat(instant))
        return claim.owner if claim else None, reason


def test_independent_processes_share_the_durable_job_and_workspace_claim(saved_job):
    path = saved_job.execute("PRAGMA database_list").fetchone()[2]
    with ProcessPoolExecutor(max_workers=2, mp_context=multiprocessing.get_context("spawn")) as pool:
        results = list(pool.map(_process_claim, [(path, JOB_ID, NOW.isoformat())] * 2))
    assert sum(owner is not None for owner, _ in results) == 1
    assert {reason for _, reason in results} == {"claimed", "check_in_progress"}


def _process_reserve_host(args):
    path, claim = args
    with sqlite3.connect(path, timeout=5) as conn:
        try:
            return availability.reserve_request(conn, claim, URL, now=NOW)
        except availability.DeferredCheck as error:
            return str(error)


def test_independent_processes_share_actual_host_pacing_and_inflight_reservation(saved_job):
    path = saved_job.execute("PRAGMA database_list").fetchone()[2]
    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    with ProcessPoolExecutor(max_workers=2, mp_context=multiprocessing.get_context("spawn")) as pool:
        results = list(pool.map(_process_reserve_host, [(path, claim)] * 2))
    assert sorted(results) == ["careers.example.org", "host_pacing_or_cooldown"]
    assert (
        saved_job.execute("SELECT COUNT(*) FROM job_events WHERE entity_kind = 'availability_request'").fetchone()[0]
        == 1
    )


def test_success_clock_advances_unknown_preserves_success_and_content(saved_job):
    saved_job.execute(
        "INSERT INTO job_enrichments (tenant_id, job_id, current_status, full_description, attempts_json, updated_at) "
        "VALUES ('local', ?, 'enriched', 'Accepted synthetic description', '[]', ?)",
        (JOB_ID, NOW.isoformat()),
    )
    saved_job.commit()
    before = tuple(saved_job.execute("SELECT * FROM job_enrichments").fetchone())
    for minute, verdict in [(0, "active"), (2, "active"), (4, "unknown")]:
        claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW + timedelta(minutes=minute))
        assert claim
        value = availability.complete_check(
            saved_job,
            claim,
            verdict=verdict,
            reason="fixture",
            method="fixture",
            lineage=[],
            now=NOW + timedelta(minutes=minute),
        )
    assert value["lastAttemptedAt"] == (NOW + timedelta(minutes=4)).isoformat()
    assert value["lastSuccessfullyVerifiedAt"] == (NOW + timedelta(minutes=2)).isoformat()
    assert value["verdict"] == "unknown"
    assert value["nextDueAt"] == (NOW + timedelta(minutes=9)).isoformat()
    assert tuple(saved_job.execute("SELECT * FROM job_enrichments").fetchone()) == before
    assert not availability.fresh_active(saved_job, JOB_ID, now=NOW + timedelta(minutes=4), max_age=timedelta(hours=6))


@pytest.mark.parametrize("verdict, reason", [("active", "minimum_interval"), ("unknown", "minimum_interval")])
def test_refused_explicit_check_persists_request_feedback_without_inventing_attempt(
    saved_job, monkeypatch, verdict, reason
):
    monkeypatch.setattr(availability, "_now", lambda: NOW)
    claim, _ = availability.claim_job(saved_job, JOB_ID)
    original = availability.complete_check(
        saved_job, claim, verdict=verdict, reason="fixture", method="fixture", lineage=[]
    )
    now = NOW + timedelta(seconds=10)
    monkeypatch.setattr(availability, "_now", lambda: now)
    value = availability.check_availability(
        JOB_ID, conn=saved_job, transport=lambda _: pytest.fail("deferred command acquired employer evidence")
    )
    assert value["request"] == {
        "status": "deferred",
        "reason": reason,
        "requestedAt": now.isoformat(),
        "retryAt": (NOW + timedelta(minutes=1)).isoformat(),
    }
    assert value["lastAttemptedAt"] == original["lastAttemptedAt"]
    assert value.get("lastSuccessfullyVerifiedAt") == original.get("lastSuccessfullyVerifiedAt")
    assert (
        saved_job.execute("SELECT COUNT(*) FROM job_events WHERE event_type = 'JobAvailabilityObserved'").fetchone()[0]
        == 1
    )
    assert availability.read_availability(saved_job, JOB_ID)["request"] == value["request"]


def test_closed_to_active_is_reversible_and_reads_do_no_network(saved_job, monkeypatch):
    monkeypatch.setattr(availability, "public_get", lambda url: pytest.fail("read attempted network"))
    for minute, verdict in [(0, "closed"), (2, "active")]:
        claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW + timedelta(minutes=minute))
        value = availability.complete_check(
            saved_job,
            claim,
            verdict=verdict,
            reason="fixture",
            method="fixture",
            lineage=[],
            now=NOW + timedelta(minutes=minute),
        )
    assert value["lastSuccessfulState"] == "active"
    assert availability.read_availability(saved_job, JOB_ID, now=NOW + timedelta(days=2))["overdue"]


def test_host_spacing_workspace_quota_and_failed_writer_release(saved_job):
    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    host = availability.reserve_request(saved_job, claim, URL, now=NOW)
    assert host == "careers.example.org"
    availability.release_host(saved_job, claim, host, now=NOW)
    with pytest.raises(availability.DeferredCheck, match="host_pacing"):
        availability.reserve_request(saved_job, claim, URL, now=NOW + timedelta(seconds=1))
    assert not saved_job.in_transaction
    assert availability.reserve_request(saved_job, claim, URL, now=NOW + timedelta(seconds=2)) == host
    availability.release_host(saved_job, claim, host, now=NOW + timedelta(seconds=2))
    for i in range(99):
        availability._event(saved_job, "local", "availability_acquisition", f"fixture-{i}", {}, now=NOW)
    saved_job.commit()
    # Already admitted render resources do not spend a second acquisition.
    host = availability.reserve_request(saved_job, claim, URL, now=NOW + timedelta(seconds=4))
    availability.release_host(saved_job, claim, host, now=NOW + timedelta(seconds=4))
    successor = replace(claim, owner="synthetic-new-acquisition")
    availability._event(
        saved_job,
        "local",
        "availability_lease",
        f"job:{JOB_ID}",
        {"owner": successor.owner, "expiresAt": successor.expires_at.isoformat()},
        now=NOW,
    )
    saved_job.commit()
    with pytest.raises(availability.DeferredCheck, match="workspace_hourly_quota"):
        availability.reserve_request(saved_job, successor, URL, now=NOW + timedelta(seconds=6))
    assert not saved_job.in_transaction


def test_completed_enrichment_is_due_without_discovery(saved_job):
    saved_job.execute(
        "INSERT INTO job_enrichments (tenant_id, job_id, current_status, full_description, attempts_json, updated_at) "
        "VALUES ('local', ?, 'enriched', 'Accepted synthetic description', '[]', ?)",
        (JOB_ID, NOW.isoformat()),
    )
    saved_job.commit()
    assert availability.due_jobs(saved_job, now=NOW) == [JOB_ID]
    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    availability.complete_check(
        saved_job, claim, verdict="active", reason="fixture", method="fixture", lineage=[], now=NOW
    )
    assert availability.due_jobs(saved_job, now=NOW + timedelta(hours=23)) == []
    assert availability.due_jobs(saved_job, now=NOW + timedelta(hours=25)) == [JOB_ID]


@pytest.mark.parametrize(
    "kind, url, endpoint, payload",
    [
        (
            "greenhouse",
            "https://boards.greenhouse.io/acme/jobs/123",
            "https://boards-api.greenhouse.io/v1/boards/acme/jobs/123",
            {
                "id": 123,
                "absolute_url": "https://boards.greenhouse.io/acme/jobs/123",
                "title": "Role",
                "content": "Job content",
            },
        ),
        (
            "lever",
            "https://jobs.eu.lever.co/acme/123",
            "https://api.eu.lever.co/v0/postings/acme/123?mode=json",
            {"id": "123", "hostedUrl": "https://jobs.eu.lever.co/acme/123", "text": "Role"},
        ),
        (
            "ashby",
            "https://jobs.ashbyhq.com/acme/123",
            "https://api.ashbyhq.com/posting-api/job-board/acme",
            {"jobs": [{"jobUrl": "https://jobs.ashbyhq.com/acme/123", "title": "Role", "isListed": False}]},
        ),
    ],
)
def test_api_first_exact_source_identity_and_hash(saved_job, kind, url, endpoint, payload):
    saved_job.execute("UPDATE jobs SET url = ?", (url,))
    saved_job.commit()
    claim, _ = availability.claim_job(saved_job, JOB_ID)
    calls = []

    def transport(request_url):
        # Another connection can acquire a writer while the transport is running.
        path = saved_job.execute("PRAGMA database_list").fetchone()[2]
        with sqlite3.connect(path, timeout=0.1) as peer:
            peer.execute("BEGIN IMMEDIATE")
            peer.rollback()
        calls.append(request_url)
        return availability.Response(endpoint, endpoint, 200, json.dumps(payload).encode())

    acquisition = availability.Acquisition(
        saved_job, claim, transport=transport, browser=lambda url: pytest.fail("API success rendered browser")
    )
    assert acquisition.acquire() == ("active", "model_determination", f"{kind}_api")
    assert calls == [endpoint]
    assert len(acquisition.lineage[0]["rawHash"]) == 64


@pytest.mark.parametrize("status", [301, 400, 401, 402, 403, 405, 429, 500, 503])
def test_exact_provider_error_response_cannot_become_active(saved_job, status):
    url = "https://jobs.eu.lever.co/acme/123"
    saved_job.execute("UPDATE jobs SET url = ?", (url,))
    saved_job.commit()
    claim, _ = availability.claim_job(saved_job, JOB_ID)
    payload = {"id": "123", "hostedUrl": url, "text": "Synthetic role"}
    acquisition = availability.Acquisition(
        saved_job,
        claim,
        transport=lambda endpoint: availability.Response(endpoint, endpoint, status, json.dumps(payload).encode()),
        browser=lambda _: pytest.fail("provider error fell through to browser"),
    )
    assert acquisition.acquire() == ("unknown", "http_error", "lever_api")
    assert acquisition.lineage[0]["status"] == status


@pytest.mark.parametrize(
    "confidence, overridden, expected",
    [
        ("high", False, "none"),
        ("medium", False, "none"),
        ("low", False, "low_confidence_extraction"),
        ("low", True, "none"),
    ],
)
def test_reversal_restores_content_confidence_and_override_policy(confidence, overridden, expected):
    from jobctrl.domain.enrichment.snapshot_set import PostingSnapshotSet
    from jobctrl.domain.enrichment.snapshot_value_objects import (
        ActiveState,
        FilterOverrideAudit,
        QuarantineReason,
        SnapshotConfidence,
        SnapshotDescriptionHash,
    )
    from jobctrl.domain.identifiers import JobId
    from jobctrl.domain.tenant import LOCAL_TENANT

    audit = (
        FilterOverrideAudit(
            "synthetic", "low_confidence_extraction", "Approved synthetic source", "user", NOW.isoformat()
        )
        if overridden
        else None
    )
    snapshot_set = PostingSnapshotSet.empty(tenant_id=LOCAL_TENANT, job_id=JobId(JOB_ID), updated_at=NOW.isoformat())
    snapshot_set, _ = snapshot_set.record_snapshot(
        source_id="synthetic",
        extraction_tier="css_selectors",
        description_hash=SnapshotDescriptionHash("a" * 64),
        apply_url=None,
        active_state=ActiveState.CLOSED,
        confidence=SnapshotConfidence(confidence),
        quarantine_reason=QuarantineReason.POSTING_INACTIVE,
        captured_at=NOW.isoformat(),
        filter_override=audit,
        evidence=("Accepted synthetic content",),
    )
    reopened, previous = snapshot_set.mark_active_state(active_state=ActiveState.ACTIVE, verified_at=NOW.isoformat())
    assert previous is ActiveState.CLOSED
    assert reopened.latest_snapshot.quarantine_reason.value == expected
    assert reopened.latest_snapshot.confidence is SnapshotConfidence(confidence)
    assert reopened.latest_snapshot.filter_override == audit
    assert reopened.latest_snapshot.description_hash == snapshot_set.latest_snapshot.description_hash


@pytest.mark.parametrize("enrichment_status", [None, "failed", "enriched"])
def test_all_visible_saved_jobs_are_immediately_due_before_first_observation(saved_job, enrichment_status):
    if enrichment_status:
        saved_job.execute(
            "INSERT INTO job_enrichments (tenant_id, job_id, current_status, updated_at) VALUES ('local', ?, ?, ?)",
            (JOB_ID, enrichment_status, NOW.isoformat()),
        )
        saved_job.commit()
    assert availability.due_jobs(saved_job, now=NOW) == [JOB_ID]


def test_overdue_catchup_is_bounded_prioritized_and_excludes_user_or_application_terminal_state(saved_job):
    ids = [f"10000000-0000-4000-8000-{i:012d}" for i in range(1, 31)]
    for i, job_id in enumerate(ids):
        saved_job.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) VALUES ('local', ?, ?, 'Synthetic role', 'synthetic', ?)",
            (job_id, f"{URL}-{i}", (NOW + timedelta(seconds=i + 1)).isoformat()),
        )
    saved_job.execute(
        "INSERT INTO jobctrl_hidden_jobs (tenant_id, job_id, hidden_at) VALUES ('local', ?, ?)",
        (ids[0], NOW.isoformat()),
    )
    saved_job.execute(
        "INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at) VALUES ('local', ?, ?)",
        (ids[1], NOW.isoformat()),
    )
    saved_job.execute(
        "INSERT INTO application_outcomes (tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at) VALUES ('local', 'outcome', ?, 'offer', 'user', ?, ?)",
        (ids[2], NOW.isoformat(), NOW.isoformat()),
    )
    saved_job.execute(
        "INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at) VALUES ('local', ?, 'apply', 'running', ?)",
        (ids[3], NOW.isoformat()),
    )
    saved_job.execute(
        "INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at) VALUES ('local', ?, 'score', 'pending', ?)",
        (ids[-1], NOW.isoformat()),
    )
    saved_job.commit()
    selected = availability.due_jobs(saved_job, now=NOW)
    assert len(selected) == 25 and selected[0] == ids[-1] and selected[1] == JOB_ID
    assert not set(ids[:4]).intersection(selected)


def test_anonymous_browser_guard_failure_retains_hash_and_cannot_authorize(saved_job, monkeypatch):
    monkeypatch.setattr(
        availability,
        "build_page_interpreter",
        lambda *args, **kwargs: interpreter(
            __import__("tests.page_fakes", fromlist=["PageModel"]).PageModel(availability="unknown")
        ),
    )
    from types import SimpleNamespace
    from contextlib import nullcontext
    from jobctrl.infrastructure.network import url_safety
    from jobctrl.enrichment import detail

    class Page:
        def route(self, pattern, handler):
            self.handler = handler

        def unroute(self, *args):
            pass

        def wait_for_load_state(self, *_args, **_kwargs):
            pass

        def goto(self, url, **kwargs):
            self.handler(
                SimpleNamespace(abort=lambda *_: None),
                SimpleNamespace(url="https://careers.example.org/status-module.js", method="GET", headers={}),
            )
            return SimpleNamespace(status=200)

    page = Page()
    context = SimpleNamespace(
        new_page=lambda: page,
        route=page.route,
        unroute=page.unroute,
        route_web_socket=lambda *_: None,
        add_init_script=lambda *_: None,
        pages=[],
    )
    browser = SimpleNamespace(new_context=lambda **_: context, close=lambda: None)
    monkeypatch.setattr(
        "playwright.sync_api.sync_playwright",
        lambda: nullcontext(SimpleNamespace(chromium=SimpleNamespace(launch=lambda **_: browser))),
    )
    monkeypatch.setattr(
        url_safety, "validate_public_http_url", lambda *_args, **_kwargs: url_safety.PublicUrlDecision(True)
    )
    monkeypatch.setattr(detail, "_page_to_detail_page", lambda *_: replace(active_page(), raw_html_hash="b" * 64))

    def refused(*_args):
        raise availability.DeferredCheck("request_budget")

    rendered = availability._anonymous_browser_in_process(URL, fetcher=refused, deadline=time.monotonic() + 120)
    assert not rendered.status_evidence_complete
    claim, _ = availability.claim_job(saved_job, JOB_ID)
    acquisition = availability.Acquisition(
        saved_job,
        claim,
        transport=lambda url: availability.Response(url, url, 200, b"<main>Rendering shell</main>"),
        browser=lambda _: rendered,
    )
    assert acquisition.acquire()[:2] == ("unknown", "browser_guard: request_budget")
    assert acquisition.lineage[-1]["rawHash"] == "b" * 64
    assert acquisition.lineage[-1]["signals"] == [
        {"kind": "acquisition_failure", "value": "browser_guard: request_budget"}
    ]


def test_query_posting_identity_is_preserved_and_only_tracking_ignored():
    url = "https://careers.example.org/career?career_job_req_id=123"
    other = "https://careers.example.org/career?career_job_req_id=999"
    page = replace(
        active_page(), url=url, final_url=other, json_ld=({"@type": "JobPosting", "url": other, "description": "Role"},)
    )
    assert ActiveStateVerifier(page_interpreter=interpreter()).verify(page)[0].value == "unknown"
    from jobctrl.domain.enrichment.snapshot_services import same_posting_url

    assert same_posting_url(url, url + "&utm_source=fixture")
    assert not same_posting_url(url, other)


def test_disabled_apply_survives_cleaning():
    from jobctrl.infrastructure.enrichment.playwright_fetcher import _clean_content_html

    html = f'<link rel="canonical" href="{URL}"><form action="{URL}/apply"><button disabled>Apply</button></form>'
    assert "disabled" in _clean_content_html(html)
    page = replace(active_page(), html=_clean_content_html(html), json_ld=())
    model = __import__("tests.page_fakes", fromlist=["PageModel"]).PageModel()
    ActiveStateVerifier(page_interpreter=interpreter(model)).verify(page)
    assert "disabled" in html


def test_source_unavailability_cannot_delete_hide_or_change_outcomes(saved_job, monkeypatch):
    saved_job.execute(
        "INSERT INTO job_artifacts (tenant_id, job_id, stage, artifact_type, status, path, created_at) VALUES ('local', ?, 'tailor', 'resume_pdf', 'approved', '/synthetic/resume.pdf', ?)",
        (JOB_ID, NOW.isoformat()),
    )
    saved_job.execute(
        "INSERT INTO job_materials (tenant_id, job_id, generation, status, created_at, updated_at) VALUES ('local', ?, 1, 'approved', ?, ?)",
        (JOB_ID, NOW.isoformat(), NOW.isoformat()),
    )
    saved_job.execute(
        "INSERT INTO application_review_decisions (tenant_id, decision_id, job_id, decision, decided_at, materials_generation, application_url) VALUES ('local', 'accepted', ?, 'approve_submit', ?, 1, ?)",
        (JOB_ID, NOW.isoformat(), URL),
    )
    saved_job.execute(
        "INSERT INTO application_outcomes (tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at) VALUES ('local', 'withdrawn', ?, 'withdrawn', 'user', ?, ?)",
        (JOB_ID, NOW.isoformat(), NOW.isoformat()),
    )
    saved_job.commit()
    before = {
        name: saved_job.execute(f"SELECT * FROM {name}").fetchall()
        for name in [
            "jobs",
            "jobctrl_deleted_jobs",
            "jobctrl_hidden_jobs",
            "application_outcomes",
            "job_artifacts",
            "job_materials",
            "application_review_decisions",
        ]
    }
    for minute, verdict in [(0, "removed"), (2, "active"), (4, "unknown")]:
        claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW + timedelta(minutes=minute))
        availability.complete_check(
            saved_job,
            claim,
            verdict=verdict,
            reason="exact",
            method="fixture",
            lineage=[],
            now=NOW + timedelta(minutes=minute),
        )
        for name, rows in before.items():
            assert saved_job.execute(f"SELECT * FROM {name}").fetchall() == rows
    assert not saved_job.execute("SELECT 1 FROM job_events WHERE event_type = 'JobDeleted'").fetchone()


@pytest.mark.parametrize(
    "payload",
    [
        b"broken",
        b"[]",
        b'{"id":999,"absolute_url":"https://boards.greenhouse.io/acme/jobs/999","title":"Peer"}',
        b'{"id":123,"absolute_url":"https://boards.greenhouse.io/acme/jobs/999","title":"Peer"}',
    ],
)
def test_malformed_or_mismatched_exact_api_cannot_fall_back_into_active(saved_job, payload):
    url = "https://boards.greenhouse.io/acme/jobs/123"
    saved_job.execute("UPDATE jobs SET url = ?", (url,))
    saved_job.commit()
    claim, _ = availability.claim_job(saved_job, JOB_ID)
    calls = []

    def transport(endpoint):
        calls.append(endpoint)
        return availability.Response(endpoint, endpoint, 200, payload)

    acquisition = availability.Acquisition(saved_job, claim, transport=transport)
    assert acquisition.acquire()[0] == "unknown"
    assert len(calls) == 1 and acquisition.lineage[0]["rawHash"]


def test_missing_ashby_inventory_never_proves_closure_and_browser_lineage_is_retained(saved_job, monkeypatch):
    from tests.page_fakes import PageModel

    models = iter([PageModel(availability="unknown"), PageModel()])
    monkeypatch.setattr(availability, "build_page_interpreter", lambda *args, **kwargs: interpreter(next(models)))
    url = "https://jobs.ashbyhq.com/acme/123"
    saved_job.execute("UPDATE jobs SET url = ?", (url,))
    saved_job.commit()
    claim, _ = availability.claim_job(saved_job, JOB_ID)

    def transport(endpoint):
        return availability.Response(
            endpoint, endpoint, 200, b'{"jobs":[]}' if "posting-api" in endpoint else b"<main>Shell</main>"
        )

    rendered = replace(
        active_page(),
        url=url,
        final_url=url,
        json_ld=({"@type": "JobPosting", "url": url, "description": "Synthetic role"},),
        status_html="<main>Full rendered evidence</main>",
        raw_html_hash="b" * 64,
    )
    acquisition = availability.Acquisition(saved_job, claim, transport=transport, browser=lambda _: rendered)
    assert acquisition.acquire()[0] == "active"
    assert [step["method"] for step in acquisition.lineage] == ["ashby_api", "public_http", "anonymous_browser"]
    assert acquisition.lineage[-1]["rawHash"] == "b" * 64


def test_canonical_redirect_is_reserved_and_hashed_but_board_landing_loses_identity(saved_job):
    claim, _ = availability.claim_job(saved_job, JOB_ID)
    calls = []

    def transport(url):
        calls.append(url)
        if len(calls) == 1:
            return availability.Response(url, url, 302, b"canonical redirect", redirect_url=url + "?utm_source=fixture")
        return availability.Response(url, url, 404, b"exact posting removed")

    acquisition = availability.Acquisition(saved_job, claim, transport=transport)
    assert acquisition.acquire()[:2] == ("removed", "http_status")
    assert len(calls) == 2 and all(len(step["rawHash"]) == 64 for step in acquisition.lineage)


def test_pairing_extension_cannot_fabricate_active_access_limited_evidence(saved_job, monkeypatch):
    monkeypatch.setattr(
        availability,
        "build_page_interpreter",
        lambda *args, **kwargs: interpreter(
            __import__("tests.page_fakes", fromlist=["PageModel"]).PageModel(
                availability="unknown", access="login_required"
            )
        ),
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.LiveChromeDiscoveryClient",
        lambda *a, **k: pytest.fail("availability selected a paired Discovery extension"),
    )
    claim, _ = availability.claim_job(saved_job, JOB_ID)
    acquisition = availability.Acquisition(
        saved_job,
        claim,
        transport=lambda url: availability.Response(url, url, 200, b'<form><input type="password"></form>'),
        browser=lambda url: pytest.fail("login failure triggered another transport"),
    )
    assert acquisition.acquire()[:2] == ("unknown", "access_challenge")


def test_unknown_backoff_caps_and_safety_bounds_cannot_be_bypassed(saved_job):
    instant = NOW
    for attempt in range(11):
        claim, _ = availability.claim_job(saved_job, JOB_ID, now=instant)
        assert claim
        value = availability.complete_check(
            saved_job, claim, verdict="unknown", reason="timeout", method="fixture", lineage=[], now=instant
        )
        due = datetime.fromisoformat(value["nextDueAt"])
        assert due - instant == timedelta(seconds=min(86400, 300 * 2 ** min(attempt, 9)))
        assert (
            availability.claim_job(saved_job, JOB_ID, now=instant + timedelta(minutes=2), explicit=False)[1]
            == "retry_backoff"
        )
        instant = due
    assert availability._retry_after("9999999") == 300


def test_prep_freshness_is_stricter_than_background_cadence_and_changed_url_is_fenced(saved_job, monkeypatch):
    from jobctrl.domain.errors import MissingInputError

    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    availability.complete_check(
        saved_job, claim, verdict="active", reason="fixture", method="fixture", lineage=[], now=NOW
    )
    assert availability.fresh_active(saved_job, JOB_ID, max_age=timedelta(hours=6), now=NOW + timedelta(hours=5))
    assert not availability.fresh_active(
        saved_job, JOB_ID, max_age=timedelta(minutes=15), now=NOW + timedelta(minutes=16)
    )
    monkeypatch.setattr(
        availability, "check_availability", lambda *a, **k: pytest.fail("fresh guard unexpectedly fetched")
    )
    monkeypatch.setattr(availability, "_now", lambda: NOW)
    with pytest.raises(MissingInputError, match="candidate changed"):
        availability.require_fresh_active(JOB_ID, conn=saved_job, expected_posting_url=URL + "-old")


def test_shared_host_slot_wait_cannot_outlive_acquisition_deadline(saved_job, monkeypatch):
    from jobctrl.infrastructure.network import politeness
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    limiter = HostRateLimiter()
    monkeypatch.setattr(politeness, "get_shared_rate_limiter", lambda: limiter)
    monkeypatch.setattr(availability, "ACQUISITION_TIMEOUT_SECONDS", 0.03)
    with limiter.slot("careers.example.org", min_interval_seconds=0, max_concurrency=1):
        started = time.monotonic()
        value = availability.check_availability(
            JOB_ID, conn=saved_job, transport=lambda _: pytest.fail("busy shared host admitted outbound request")
        )
        assert time.monotonic() - started < 0.3
    assert value["requestStatus"] == "deferred" and value["requestReason"] == "shared_host_cooldown"
    assert not value.get("lastAttemptedAt") and not value.get("consecutiveFailures")
    assert not saved_job.execute("SELECT 1 FROM job_events WHERE event_type = 'JobAvailabilityObserved'").fetchone()
    assert not value["checkInProgress"] and not saved_job.in_transaction
    assert not availability._latest(saved_job, "local", "availability_lease", "host:careers.example.org").get("owner")


@pytest.mark.parametrize(
    "fault,code",
    [
        ("unavailable", "provider_unavailable"),
        ("budget", "budget_denied"),
        ("json", "malformed_json"),
        ("extra", "schema_violation"),
        ("enum", "schema_violation"),
        ("foreign", "foreign_source_id"),
        ("quote", "non_verbatim_quote"),
        ("number", "mismatched_value"),
    ],
)
def test_failed_determination_refresh_records_distinct_failure_and_retains_success(saved_job, monkeypatch, fault, code):
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.domain.enrichment.page_interpretation import ModelPageInterpreter
    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
    from tests.page_fakes import PageModel

    def captured_get(acquisition, url, method, **kwargs):
        response = acquisition.transport(url)
        acquisition.lineage.append(
            {
                "sourceUrl": url,
                "finalUrl": url,
                "status": 200,
                "method": method,
                "rawHash": hashlib.sha256(response.body).hexdigest(),
            }
        )
        return response

    import hashlib

    monkeypatch.setattr(availability.Acquisition, "_get", captured_get)
    accepted = availability.check_availability(
        JOB_ID,
        conn=saved_job,
        transport=lambda url: availability.Response(url, url, 200, b"<main>Owned successful capture 10</main>"),
    )
    assert accepted["verdict"] == "active"
    count = saved_job.execute("SELECT count(*) FROM semantic_determinations").fetchone()[0]
    now = availability._now() + timedelta(minutes=2)
    monkeypatch.setattr(availability, "_now", lambda: now)

    class FaultModel(PageModel):
        def chat_json(self, messages, **kwargs):
            if fault == "json":
                raise json.JSONDecodeError("invalid", "", 0)
            result = super().chat_json(messages, **kwargs)
            if fault == "extra":
                result["unsolicited"] = True
            if fault == "enum":
                result["availability"]["value"] = "invented"
            cite = result["availability"]["citations"][0]
            if fault == "foreign":
                cite["source_id"] = "another-page"
            if fault == "quote":
                cite["quote"] = "absent-from-captured-page"
            if fault == "number":
                cite["exact_values"] = ["11"]
            return result

    def preflight():
        if fault == "budget":
            raise DeterminationFailure("budget_denied")

    port = ModelPageInterpreter(
        llm=None if fault == "unavailable" else FaultModel(),
        repository=SqliteDeterminationRepository(saved_job),
        tenant_id="local",
        provider="synthetic",
        model="synthetic",
        lane="enrichment",
        preflight=preflight,
    )
    monkeypatch.setattr(availability, "build_page_interpreter", lambda *args, **kwargs: port)
    value = availability.check_availability(
        JOB_ID,
        conn=saved_job,
        transport=lambda url: availability.Response(url, url, 200, b"<main>Owned refreshed capture 10</main>"),
        browser=lambda url: pytest.fail("failed determination used a fallback"),
    )
    assert value["attemptStatus"] == "blocked" and value["failureCode"] == code, value
    assert value["lastSuccessfulState"] == "active"
    assert value["lastSuccessfulEvidenceRef"] == accepted["lastSuccessfulEvidenceRef"]
    assert value["lastSuccessfullyVerifiedAt"] == accepted["lastSuccessfullyVerifiedAt"]
    assert saved_job.execute("SELECT count(*) FROM semantic_determinations").fetchone()[0] == count
    assert not saved_job.in_transaction
