"""PR 1048 regressions at the content, ledger, scheduler and network boundaries."""

from datetime import timedelta
import json
from types import SimpleNamespace

import pytest

from jobctrl.enrichment import availability, detail
from jobctrl.domain.enrichment.value_objects import DetailPage
from .test_saved_posting_availability import saved_job as _saved_job, JOB_ID, NOW, URL

saved_job = _saved_job


@pytest.mark.parametrize(
    "posting",
    [
        {"@type": "JobPosting", "description": "Build reliable synthetic systems. " * 30},
        {
            "@type": "JobPosting",
            "description": "Build reliable synthetic systems. " * 30,
            "url": URL,
            "validThrough": "2099-01-01",
        },
        {"@type": "JobPosting", "description": "Build reliable synthetic systems. " * 30, "url": URL + "-canonical"},
    ],
)
def test_unknown_enrichment_retains_extracted_description_and_retryability(posting, monkeypatch):
    # The existing cascade constructs its fallback adapter eagerly. Own that
    # port without requiring credentials; deterministic extraction must not use it.
    monkeypatch.setattr(
        detail,
        "get_llm_adapter",
        lambda: SimpleNamespace(chat=lambda *_a, **_kw: pytest.fail("deterministic content used the LLM fallback")),
    )
    page = DetailPage(url=URL, final_url=URL, status=200, json_ld=(posting,))
    from tests.page_fakes import PageModel, interpreter

    result = detail._extract_detail_page(
        page, {}, 0, status_code=200, page_interpreter=interpreter(PageModel(availability="unknown"))
    )
    assert result["active_state"] == "unknown"
    assert result["status"] in {"ok", "partial"}
    assert "Build reliable synthetic systems." in result["full_description"]
    assert detail._detail_failure_retryable(result)


def test_latest_and_due_queries_ignore_large_unrelated_ledger(saved_job):
    saved_job.execute(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<300000) "
        "INSERT INTO job_events (tenant_id, identity_version, stage, event_type, entity_kind, entity_ref, occurred_at, payload_json) "
        "SELECT 'local', 1, 'enrich', 'AvailabilityLeaseChanged', 'unrelated', 'ledger', ?, '{}' FROM n",
        (NOW.isoformat(),),
    )
    saved_job.executemany(
        "INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at) VALUES ('local', ?, ?, 'Synthetic', ?)",
        [(f"20000000-0000-4000-8000-{i:012d}", URL + str(i), NOW.isoformat()) for i in range(500)],
    )
    saved_job.commit()
    steps = [0]

    def progress():
        steps[0] += 1000
        return int(steps[0] > 200000)

    saved_job.set_progress_handler(progress, 1000)
    try:
        assert availability._latest(saved_job, "local", "posting_availability", JOB_ID) == {}
        assert len(availability.due_jobs(saved_job, now=NOW)) == 25
    finally:
        saved_job.set_progress_handler(None, 0)
    assert steps[0] < 200000


def test_unrelated_job_can_be_claimed_during_sweep(saved_job):
    other = "20000000-0000-4000-8000-000000000001"
    saved_job.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at) VALUES ('local', ?, ?, 'Synthetic', ?)",
        (other, "https://other.example.org/role", NOW.isoformat()),
    )
    saved_job.commit()
    assert availability.claim_job(saved_job, JOB_ID, now=NOW, automatic=True)[0]
    assert availability.claim_job(saved_job, other, now=NOW)[0]


@pytest.mark.parametrize("reason", ["workspace_hourly_quota", "host_pacing_or_cooldown", "shared_host_cooldown"])
def test_local_refusal_is_not_an_evidence_failure(saved_job, monkeypatch, reason):
    monkeypatch.setattr(availability, "_now", lambda: NOW)

    def refuse(_self):
        raise availability.DeferredCheck(reason)

    monkeypatch.setattr(availability.Acquisition, "acquire", refuse)
    availability.check_availability(JOB_ID, conn=saved_job)
    assert not availability._latest(saved_job, "local", "posting_availability", JOB_ID)
    assert not availability.read_availability(saved_job, JOB_ID)["checkInProgress"]


def test_automatic_refusals_do_not_create_user_requests(saved_job):
    availability.claim_job(saved_job, JOB_ID)
    for _ in range(3):
        availability.check_availability(JOB_ID, conn=saved_job, automatic=True)
    assert not saved_job.execute("SELECT 1 FROM job_events WHERE entity_kind='posting_availability_request'").fetchone()


@pytest.mark.parametrize(
    "url",
    [
        "file:///private/tmp/posting",
        "ftp://example.org/role",
        "data:text/plain,role",
        "http://127.0.0.1/role",
        "http://169.254.169.254/role",
    ],
)
def test_public_transport_rejects_unsafe_top_level_before_open(monkeypatch, url):
    opened = []
    monkeypatch.setattr(
        "jobctrl.infrastructure.network.public_http.build_public_http_opener",
        lambda **_: SimpleNamespace(open=lambda *_a, **_k: opened.append(True)),
    )
    with pytest.raises(availability.DeferredCheck, match="unsafe_posting_url"):
        availability._public_get_in_process(url)
    assert not opened


@pytest.mark.parametrize(
    "source_url, html",
    [
        (
            "https://www.linkedin.com/jobs/view/synthetic-role",
            '<main class="description__text">Build reliable systems</main>',
        ),
        ("https://www.indeed.com/viewjob?jk=synthetic", "<main>Build reliable systems</main>"),
        ("https://www.ziprecruiter.com/jobs/synthetic/role", "<main>Build reliable systems</main>"),
        (
            "https://acme.myworkdayjobs.com/en-US/jobs/job/synthetic",
            '<main><div id="challenge-form">Verify you are human</div></main>',
        ),
        ("https://careers.example.org/greenhouse/role", "<main>Build reliable systems</main>"),
    ],
)
def test_unknown_supported_page_keeps_preparation_and_supervised_path_available(
    saved_job, monkeypatch, source_url, html
):
    from jobctrl.domain.errors import SourceUnavailableError
    from tests.page_fakes import PageModel
    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository

    monkeypatch.setattr(
        "jobctrl.enrichment.availability.build_page_interpreter",
        lambda conn, **kwargs: __import__("tests.page_fakes", fromlist=["interpreter"]).interpreter(
            PageModel(availability="unknown"), SqliteDeterminationRepository(conn)
        ),
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.enrichment.page_interpretation.determination_dependencies",
        lambda conn, **kwargs: dict(
            llm=PageModel(availability="unknown"),
            repository=SqliteDeterminationRepository(conn),
            tenant_id="local",
            provider="synthetic",
            model="synthetic",
            lane="enrichment",
            preflight=lambda: None,
        ),
    )
    saved_job.execute("UPDATE jobs SET url=?", (source_url,))
    saved_job.commit()
    value = availability.check_availability(
        JOB_ID,
        conn=saved_job,
        transport=lambda url: availability.Response(url, url, 200, html.encode()),
        browser=lambda url: DetailPage(url=url, final_url=url, status=200, html=html),
    )
    assert value["verdict"] == "unknown"
    availability.require_fresh_active(JOB_ID, conn=saved_job, expected_posting_url=source_url, allow_unknown=True)
    with pytest.raises(SourceUnavailableError):
        availability.require_fresh_active(JOB_ID, conn=saved_job, expected_posting_url=source_url)
    saved_job.execute("BEGIN IMMEDIATE")
    try:
        availability.assert_fresh_candidate(saved_job, JOB_ID, source_url, allow_unknown=True)
    finally:
        saved_job.rollback()
    assert availability.read_availability(saved_job, JOB_ID)["verdict"] == "unknown"


def test_explicit_retry_bypasses_evidence_backoff_but_automatic_does_not(saved_job):
    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    availability.complete_check(
        saved_job, claim, verdict="unknown", reason="timeout", method="fixture", lineage=[], now=NOW
    )
    later = NOW + timedelta(minutes=2)
    assert availability.claim_job(saved_job, JOB_ID, now=later, automatic=True)[1] == "retry_backoff"
    assert availability.claim_job(saved_job, JOB_ID, now=later)[0]


def test_background_acquisitions_preserve_foreground_capacity(saved_job):
    for i in range(80):
        availability._event(saved_job, "local", "availability_acquisition", f"fixture-{i}", {}, now=NOW)
    saved_job.commit()
    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW, automatic=True)
    with pytest.raises(availability.DeferredCheck, match="workspace_hourly_quota"):
        availability.reserve_request(saved_job, claim, URL, now=NOW)
    availability.complete_check(
        saved_job, claim, verdict="unknown", reason="workspace_hourly_quota", method="fixture", lineage=[], now=NOW
    )
    foreground, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    assert foreground
    assert availability.reserve_request(saved_job, foreground, URL, now=NOW) == "careers.example.org"


def test_repeated_explicit_deferral_is_coalesced(saved_job, monkeypatch):
    monkeypatch.setattr(availability, "_now", lambda: NOW)
    availability.claim_job(saved_job, JOB_ID, now=NOW)
    for _ in range(3):
        availability.check_availability(JOB_ID, conn=saved_job)
    assert (
        saved_job.execute(
            "SELECT COUNT(*) FROM job_events WHERE entity_kind='posting_availability_request'"
        ).fetchone()[0]
        == 1
    )


def test_approval_poll_and_manual_ats_do_not_acquire_employer_evidence(saved_job, monkeypatch):
    from jobctrl.apply import launcher
    from .test_apply_regressions import _insert_ready_job

    for i in range(25):
        _insert_ready_job(saved_job, url=f"https://example.com/job-{i}")
    monkeypatch.setattr(launcher, "get_connection", lambda: saved_job)
    monkeypatch.setattr(
        availability, "require_fresh_active", lambda *_a, **_kw: pytest.fail("approval poll acquired evidence")
    )
    for _ in range(3):
        assert launcher.acquire_job() is None
    monkeypatch.setattr("jobctrl.config.is_manual_ats", lambda _: True)
    assert launcher.acquire_job(approval_required=False) is None


@pytest.mark.parametrize("reviewed", [False, True])
def test_only_chosen_candidate_is_checked_and_unknown_needs_bound_review(saved_job, monkeypatch, reviewed):
    from jobctrl.apply import launcher
    from .test_apply_regressions import _insert_ready_job, _seed_current_apply_binding, _insert_review_decision

    monkeypatch.setattr(launcher, "_utc_now", lambda: NOW.isoformat())
    jobs = [_insert_ready_job(saved_job, url=f"https://example.com/job-{i}") for i in range(25)]
    selected = jobs[0]
    if reviewed:
        _seed_current_apply_binding(saved_job, job_id=selected)
        _insert_review_decision(
            saved_job,
            job_id=selected,
            decision="approve_submit",
            decided_at=NOW.isoformat(),
            materials_generation=1,
            profile_version=1,
            application_url="https://example.com/apply",
        )
    for job in jobs:
        claim, _ = availability.claim_job(saved_job, job)
        availability.complete_check(
            saved_job, claim, verdict="unknown", reason="access_challenge", method="fixture", lineage=[]
        )
    monkeypatch.setattr(launcher, "get_connection", lambda: saved_job)
    checks = []
    real_guard = availability.require_fresh_active

    def guard(job_id, **kwargs):
        assert not saved_job.in_transaction
        checks.append(job_id)
        real_guard(job_id, **kwargs)

    monkeypatch.setattr(availability, "require_fresh_active", guard)
    before = saved_job.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplyRunStarted'").fetchone()[0]
    result = launcher.acquire_job(approval_required=reviewed)
    # Backoff-bound unknown candidates are skipped locally; an approved
    # candidate alone reaches the preflight/claim boundary.
    assert checks == ([selected] if reviewed else [])
    assert bool(result) is reviewed
    if reviewed:
        with launcher._authorize_posting_before_submit(
            "local", selected, "https://example.com/job-0", result["apply_run_id"]
        ):
            assert saved_job.in_transaction
    assert saved_job.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplyRunStarted'").fetchone()[
        0
    ] == before + int(reviewed)


def test_stale_active_preflight_refreshes_before_background_due(saved_job, monkeypatch):
    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    availability.complete_check(
        saved_job, claim, verdict="active", reason="fixture", method="fixture", lineage=[], now=NOW
    )
    later = NOW + timedelta(minutes=16)
    monkeypatch.setattr(availability, "_now", lambda: later)
    html = (
        '<script type="application/ld+json">'
        + json.dumps({"@type": "JobPosting", "url": URL, "description": "Synthetic role"})
        + "</script>"
    )
    monkeypatch.setattr(availability, "public_get", lambda url: availability.Response(url, url, 200, html.encode()))
    availability.require_fresh_active(JOB_ID, conn=saved_job, max_age=timedelta(minutes=15), expected_posting_url=URL)
    assert availability.read_availability(saved_job, JOB_ID)["lastSuccessfullyVerifiedAt"] == later.isoformat()


@pytest.mark.parametrize("status", [401, 403, 429, 503])
def test_unknown_access_during_content_extraction_is_retryable(status):
    assert detail._detail_failure_retryable(
        {"active_state": "unknown", "http_status": status, "verification_method": "http_error", "status": "error"}
    )


def test_local_contention_cannot_fail_preparation_with_stale_accepted_active_evidence(saved_job, monkeypatch):
    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    availability.complete_check(
        saved_job, claim, verdict="active", reason="fixture", method="fixture", lineage=[], now=NOW
    )
    monkeypatch.setattr(availability, "_now", lambda: NOW + timedelta(hours=7))
    for i in range(100):
        availability._event(saved_job, "local", "availability_acquisition", f"fixture-{i}", {})
    saved_job.commit()
    availability.require_fresh_active(JOB_ID, conn=saved_job, expected_posting_url=URL, allow_unknown=True)
    value = availability.read_availability(saved_job, JOB_ID)
    assert value["lastAttemptedAt"] == NOW.isoformat()
    assert value["consecutiveFailures"] == 0
    assert not value.get("request")


def test_unknown_cannot_reopen_a_confirmed_closed_posting(saved_job, monkeypatch):
    for minute, verdict in [(0, "closed"), (2, "unknown")]:
        claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW + timedelta(minutes=minute))
        availability.complete_check(
            saved_job,
            claim,
            verdict=verdict,
            reason="fixture",
            method="fixture",
            lineage=[],
            now=NOW + timedelta(minutes=minute),
        )
    monkeypatch.setattr(availability, "_now", lambda: NOW + timedelta(minutes=2))
    assert not availability.candidate_ready(saved_job, JOB_ID, max_age=timedelta(hours=6), allow_unknown=True)
