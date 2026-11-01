"""One-job extension refresh keeps the accepted enrichment on success or failure."""

from __future__ import annotations

import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from jobctrl.database import init_db
from jobctrl.domain.enrichment import ExtractionTier, FullDescription, JobEnrichment
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment import detail
from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
from jobctrl.state import ensure_job_stage_rows, set_stage_state
from jobctrl.workflow_specs import build_run_stage_workflow_spec

from .live_browser_helpers import FixtureBrowserBroker


JOB_ID = canonical_job_id("a0000000-0000-4000-8000-000000000091")
POSTING = "https://www.linkedin.com/jobs/view/synthetic-refresh"
TARGET = "https://apply.example.com/position/91"
DESCRIPTION = "Accepted role description that must survive every application-target refresh."
MARKER = '<div id="JobDetails_AboutTheJob_synthetic-refresh">Accepted role</div>'


@pytest.fixture
def conn(tmp_path):
    db = init_db(tmp_path / "jobs.db")
    db.execute(
        "INSERT INTO jobs(tenant_id,job_id,url,title,site,discovered_at) "
        "VALUES('local',?,?,'Synthetic role','linkedin','2026-09-01T00:00:00Z')",
        (str(JOB_ID), POSTING),
    )
    db.execute(
        "INSERT INTO job_locators(tenant_id,job_id,locator_kind,locator_value,is_current,first_seen_at,last_seen_at) "
        "VALUES('local',?,'posting_url',?,1,'2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')",
        (str(JOB_ID), POSTING),
    )
    aggregate = JobEnrichment.empty(tenant_id=LOCAL_TENANT, job_id=JOB_ID, updated_at="2026-09-01T00:00:00Z")
    aggregate = aggregate.start_attempt(extraction_tier=ExtractionTier.CSS_SELECTORS, started_at="2026-09-01T00:00:00Z")
    aggregate = aggregate.succeed_attempt(
        full_description=FullDescription(text=DESCRIPTION), application_url=None,
        extraction_tier=ExtractionTier.CSS_SELECTORS, finished_at="2026-09-01T00:01:00Z",
    )
    SqliteEnrichmentRepository(db).save(aggregate)
    ensure_job_stage_rows(db, JOB_ID)
    set_stage_state(db, JOB_ID, "enrich", "succeeded", tenant_id=LOCAL_TENANT, validate_transition=False)
    db.execute(
        "INSERT INTO job_materials(tenant_id,job_id,generation,status,created_at,updated_at) "
        "VALUES('local',?,1,'resume_approved','2026-09-01T00:02:00Z','2026-09-01T00:02:00Z')",
        (str(JOB_ID),),
    )
    db.commit()
    yield db
    db.close()


@pytest.mark.parametrize("found", [False, True])
def test_selected_extension_refresh_preserves_accepted_rows(conn, tmp_path, monkeypatch, found):
    html = (
        '<main aria-label="Primary content">' + MARKER
        + '<a hidden aria-label="Apply on company website" href="https://other.example.com/wrong">Wrong link</a>'
        + '<a aria-label="Apply on company website" '
        'href="https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fapply.example.com%2Fposition%2F91">'
        "Apply on company website</a></main>"
        if found else '<main aria-label="Primary content">' + MARKER + "</main>"
    )
    broker = FixtureBrowserBroker(
        tmp_path,
        lambda url: {
            "status": "succeeded", "finalUrl": url, "statusCode": 200, "bodyHtml": html,
            "visibleApplyControls": ([{"href": "https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fapply.example.com%2Fposition%2F91", "jobId": "synthetic-refresh"}] if found else []),
        },
    )
    monkeypatch.setattr(detail, "LiveChromeDiscoveryClient", broker.client)
    monkeypatch.setattr(detail, "validate_public_http_url", lambda _url: SimpleNamespace(allowed=True))

    @contextmanager
    def allowed(_url):
        yield SimpleNamespace(allowed=True)

    monkeypatch.setattr(detail, "_enrichment_session", lambda *_args, **_kwargs: SimpleNamespace(guard=allowed))
    before_material = tuple(conn.execute("SELECT * FROM job_materials WHERE job_id=?", (str(JOB_ID),)).fetchone())
    before = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, JOB_ID)

    stats = detail._run_detail_scraper(
        conn, job_ids=(JOB_ID,), workflow_id="selected-refresh", workflow_run_id="selected-refresh-run",
        reset_linkedin_candidates=False, refresh_apply_url=True,
    )

    saved = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, JOB_ID)
    assert saved is not None and before is not None
    assert saved.is_enriched and saved.full_description == before.full_description
    assert saved.enriched_at == before.enriched_at and saved.extraction_tier == before.extraction_tier
    assert len(saved.attempts) == len(before.attempts) + 1
    if found:
        assert saved.application_url is not None
        assert saved.application_url.value == TARGET
    else:
        assert saved.application_url is None
    assert tuple(conn.execute("SELECT * FROM job_materials WHERE job_id=?", (str(JOB_ID),)).fetchone()) == before_material
    stage = conn.execute(
        "SELECT state, metadata_json FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='enrich'",
        (str(JOB_ID),),
    ).fetchone()
    assert stage[0] == "succeeded"
    assert json.loads(stage[1])["applyUrlOutcomeCode"] == (
        "APPLY_URL_EXTERNAL_RECOVERED" if found else "APPLY_URL_CONTROL_MISSING"
    )
    assert stats["processed"] == 1 and stats["ok"] == int(found)
    assert broker.visited == [POSTING]


def test_redirect_target_must_be_public(monkeypatch):
    monkeypatch.setattr(
        detail, "validate_public_http_url",
        lambda url: SimpleNamespace(allowed=not url.startswith("http://127.0.0.1")),
    )
    html = (
        '<main aria-label="Primary content">' + MARKER
        + '<a aria-label="Apply on company website" '
        'href="https://www.linkedin.com/safety/go/?url=http%3A%2F%2F127.0.0.1%2Fprivate">Apply</a></main>'
    )
    assert detail._external_apply_target_from_html(
        html, POSTING, POSTING,
        (("https://www.linkedin.com/safety/go/?url=http%3A%2F%2F127.0.0.1%2Fprivate", "synthetic-refresh"),),
    ) == (None, "unsafe_url")


def test_unrelated_redirect_never_binds_an_application_target(conn, tmp_path, monkeypatch):
    broker = FixtureBrowserBroker(
        tmp_path,
        lambda _url: {
            "status": "succeeded",
            "finalUrl": "https://www.linkedin.com/jobs/search/?currentJobId=other",
            "statusCode": 200,
            "bodyHtml": '<main aria-label="Primary content">' + MARKER
            + '<a aria-label="Apply on company website" href="https://other.example.com/wrong">Apply</a></main>',
            "visibleApplyControls": [{"href": "https://other.example.com/wrong", "jobId": "other"}],
        },
    )
    monkeypatch.setattr(detail, "LiveChromeDiscoveryClient", broker.client)
    monkeypatch.setattr(detail, "validate_public_http_url", lambda _url: SimpleNamespace(allowed=True))

    @contextmanager
    def allowed(_url):
        yield SimpleNamespace(allowed=True)

    monkeypatch.setattr(detail, "_enrichment_session", lambda *_args, **_kwargs: SimpleNamespace(guard=allowed))
    before = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, JOB_ID)
    stats = detail._run_detail_scraper(
        conn, job_ids=(JOB_ID,), workflow_id="redirect-refresh", workflow_run_id="redirect-run",
        reset_linkedin_candidates=False, refresh_apply_url=True,
    )
    saved = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, JOB_ID)
    assert before is not None and saved is not None
    assert saved.application_url is None and saved.full_description == before.full_description
    assert stats["processed"] == 1 and stats["ok"] == 0
    stage = conn.execute("SELECT metadata_json FROM job_stage_states WHERE job_id=? AND stage='enrich'", (str(JOB_ID),)).fetchone()
    assert json.loads(stage[0])["applyUrlOutcomeCode"] == "APPLY_URL_NAVIGATION_FAILED"


def test_ambiguous_or_other_job_controls_are_not_selected(monkeypatch):
    monkeypatch.setattr(detail, "validate_public_http_url", lambda _url: SimpleNamespace(allowed=True))
    html = (
        '<main aria-label="Primary content">' + MARKER
        + '<div data-job-id="other"><a aria-label="Apply on company website" '
        'href="https://other.example.com/wrong">Apply</a></div>'
        + '<a aria-label="Apply on company website" href="https://apply.example.com/position/91">Apply</a>'
        + '<a aria-label="Apply on company website" href="https://another.example.com/position/91">Apply</a>'
        + '</main>'
    )
    assert detail._external_apply_target_from_html(
        html, POSTING, POSTING,
        (("https://apply.example.com/position/91", "synthetic-refresh"),
         ("https://another.example.com/position/91", "synthetic-refresh")),
    ) == (None, "external_url_missing")
    wrong_job = html.replace(MARKER, '<div id="JobDetails_AboutTheJob_other">Other role</div>')
    assert detail._external_apply_target_from_html(
        wrong_job, POSTING, POSTING, ((TARGET, "synthetic-refresh"),),
    ) == (None, "external_url_missing")


def test_unbound_recommendation_link_is_not_a_current_job_target(conn, tmp_path, monkeypatch):
    html = (
        '<section aria-label="Primary content"><div class="selected-header">'
        + MARKER + '</div><section class="recommendation">'
        '<a aria-label="Apply on company website" href="https://other.example.com/wrong">Apply</a>'
        '</section></section>'
    )
    broker = FixtureBrowserBroker(
        tmp_path,
        lambda url: {
            "status": "succeeded", "finalUrl": url, "statusCode": 200,
            "bodyHtml": html, "visibleApplyControls": [],
        },
    )
    monkeypatch.setattr(detail, "LiveChromeDiscoveryClient", broker.client)
    monkeypatch.setattr(detail, "validate_public_http_url", lambda _url: SimpleNamespace(allowed=True))

    @contextmanager
    def allowed(_url):
        yield SimpleNamespace(allowed=True)

    monkeypatch.setattr(detail, "_enrichment_session", lambda *_args, **_kwargs: SimpleNamespace(guard=allowed))
    before = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, JOB_ID)
    stats = detail._run_detail_scraper(
        conn, job_ids=(JOB_ID,), workflow_id="recommendation-refresh", workflow_run_id="recommendation-run",
        reset_linkedin_candidates=False, refresh_apply_url=True,
    )
    saved = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, JOB_ID)
    assert before is not None and saved is not None
    assert saved.application_url is None and saved.full_description == before.full_description
    assert stats["processed"] == 1 and stats["ok"] == 0
    assert detail._external_apply_target_from_html(html, POSTING, POSTING, ()) == (None, "apply_button_missing")


def test_old_rendered_capture_without_visibility_observation_fails_closed():
    html = (
        '<main aria-label="Primary content">' + MARKER
        + '<a aria-label="Apply on company website" href="https://other.example.com/wrong">Apply</a></main>'
    )
    assert detail._external_apply_target_from_html(html, POSTING, POSTING, None) == (None, "external_url_missing")


def test_selected_enrichment_without_refresh_flag_leaves_accepted_row_untouched(conn, monkeypatch):
    def unexpected_browser(*_args, **_kwargs):
        raise AssertionError("accepted enrichment should not acquire a browser without explicit refresh")

    monkeypatch.setattr(detail, "LiveChromeDiscoveryClient", unexpected_browser)
    before = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, JOB_ID)
    stats = detail._run_detail_scraper(
        conn, job_ids=(JOB_ID,), workflow_id="ordinary-enrich", workflow_run_id="ordinary-run",
        reset_linkedin_candidates=False,
    )
    assert SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, JOB_ID) == before
    assert stats["processed"] == 0


def test_refresh_does_not_replace_an_accepted_application_target(conn, monkeypatch):
    conn.execute("UPDATE job_enrichments SET application_url=? WHERE job_id=?", (TARGET, str(JOB_ID)))
    conn.commit()

    def unexpected_browser(*_args, **_kwargs):
        raise AssertionError("a prior accepted target must not be refreshed")

    monkeypatch.setattr(detail, "LiveChromeDiscoveryClient", unexpected_browser)
    before = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, JOB_ID)
    stats = detail._run_detail_scraper(
        conn, job_ids=(JOB_ID,), workflow_id="accepted-target", workflow_run_id="accepted-run",
        reset_linkedin_candidates=False, refresh_apply_url=True,
    )
    assert SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, JOB_ID) == before
    assert stats["processed"] == 0


def test_refresh_flag_requires_one_selected_enrich_job():
    spec = build_run_stage_workflow_spec({
        "tenantId": "local", "stages": ["enrich"], "jobId": str(JOB_ID),
        "limit": 1, "refreshApplyUrl": True,
    })
    assert spec.args[0].refresh_apply_url is True
    for rejected in (
        {"stages": ["enrich", "score"], "jobId": str(JOB_ID), "limit": 1},
        {"stages": ["enrich"], "jobId": str(JOB_ID), "limit": 2},
        {"stages": ["enrich"], "limit": 1},
    ):
        with pytest.raises(ValueError, match="one selected Enrich job"):
            build_run_stage_workflow_spec({"tenantId": "local", "refreshApplyUrl": True, **rejected})
