"""Posting authority and binding faults, using owned synthetic sources only."""

from dataclasses import replace
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from jobctrl.database import init_db
from jobctrl.discovery.smartextract import _store_jobs
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.discovery.posting_qualification import ModelPostingQualifier
from jobctrl.domain.enrichment.page_interpretation import ModelPagePostingExtractor
from jobctrl.domain.errors import TransientNetworkError
from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake
from jobctrl.infrastructure.enrichment.posting_sources import posting_page_sources
from jobctrl.infrastructure.network.url_safety import PublicUrlDecision
from jobctrl.llm_lanes import current_llm_lane
from tests.smart_posting_fakes import (
    PageFetcher,
    PostingModel,
    allow_url,
    model_dependencies,
    posting_page,
)
from tests.test_semantic_determinations import Repository


URL = "https://jobs.example.test/posting/one"
CARD = {"url": URL, "title": "Synthetic Labs is hiring people", "company": "", "location": ""}
RULES = {"confirmed_targets": {"locations": ["Synthetic place"], "work_models": ["Remote,Hybrid"]}}


def intake(conn, model=None, *, page=None, preflight=lambda: None, **kwargs):
    model = model or PostingModel()
    return SmartPostingIntake(
        conn,
        source_id="smartextract:Synthetic",
        run_id="owned-run",
        search_cfg=RULES,
        fetcher=PageFetcher(page or posting_page(URL)),
        dependencies=model_dependencies(conn, model, preflight),
        url_validator=allow_url,
        **kwargs,
    )


def store(conn, selected, cards=None, **kwargs):
    return _store_jobs(conn, cards or [CARD], "Synthetic", "css_selectors", search_cfg=RULES, intake=selected, **kwargs)


@pytest.mark.parametrize("verdict,new,held", [("match", 1, 0), ("mismatch", 0, 0), ("unknown", 0, 1)])
def test_model_controls_location_admission_for_identical_inputs(tmp_path, verdict, new, held):
    conn = init_db(tmp_path / f"{verdict}.db")
    model = PostingModel(location=verdict)
    selected = intake(conn, model)
    assert store(conn, selected) == (new, 0)
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == new
    assert conn.execute("SELECT count(*) FROM manual_capture_queue").fetchone()[0] == held
    receipt = json.loads(
        conn.execute(
            "SELECT envelope_json FROM semantic_determinations WHERE kind='discovery_posting_qualification'"
        ).fetchone()[0]
    )
    assert receipt["result"]["location_match"]["value"] == verdict
    assert receipt["lane"] == "discovery"
    inputs = {source["source_id"]: source["text"] for source in model.calls[-1][1]["sources"]}
    assert inputs["saved_locations"] == json.dumps(RULES["confirmed_targets"])
    if new:
        job = conn.execute("SELECT title,company,location,description FROM jobs").fetchone()
        assert tuple(job) == (
            "Platform Director",
            "Synthetic Labs",
            "Synthetic place",
            "Lead the platform team and delivery.",
        )
        enrichment = conn.execute("SELECT current_status,full_description FROM job_enrichments").fetchone()
        assert tuple(enrichment) == ("enriched", job[3])
        assert conn.execute("SELECT state FROM job_stage_states WHERE stage='enrich'").fetchone()[0] == "succeeded"
        snapshots = conn.execute("SELECT * FROM posting_snapshot_sets").fetchall()
        assert len(snapshots) == 1
        assert receipt["determination_id"] in str(tuple(snapshots[0]))
        accepted = json.loads(
            conn.execute(
                "SELECT payload_json FROM job_events WHERE event_type='StageProgress' AND job_id IS NOT NULL"
            ).fetchone()[0]
        )
        assert accepted["determinationIds"]["discovery_posting_qualification"] == receipt["determination_id"]


@pytest.mark.parametrize("role,quality", [("not_specific", "high"), ("unknown", "high"), ("specific_role", "low")])
def test_unverified_title_or_incomplete_description_is_held(tmp_path, role, quality):
    conn = init_db(tmp_path / "held.db")
    assert store(conn, intake(conn, PostingModel(role=role, quality=quality))) == (0, 0)
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
    row = conn.execute("SELECT status,retry_context_json FROM manual_capture_queue").fetchone()
    assert row[0] == "pending"
    context = json.loads(row[1])
    assert context["card"] == CARD
    assert len(context["determination_ids"]) == 3


@pytest.mark.parametrize(
    "kind,availability,access",
    [
        ("listing", "active", "clear"),
        ("unknown", "unknown", "clear"),
        ("posting", "unknown", "login_required"),
        ("posting", "closed", "clear"),
    ],
)
def test_page_meaning_precedes_extraction_and_job_creation(tmp_path, kind, availability, access):
    conn = init_db(tmp_path / "page.db")
    model = PostingModel()
    model.page.page_kind, model.page.availability, model.page.access = kind, availability, access
    assert store(conn, intake(conn, model)) == (0, 0)
    assert [call[0] for call in model.calls] == ["PageInterpretation"]
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0


def test_absent_employer_is_not_inferred_from_feed_title_or_url(tmp_path):
    conn = init_db(tmp_path / "employer.db")
    model = PostingModel()
    model.fields = {
        "title": "Platform Director",
        "employer": "",
        "description": "Lead the platform team and delivery.",
        "location": "Synthetic place",
        "salary": "",
        "application_url": "",
    }
    assert store(conn, intake(conn, model)) == (0, 0)
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
    context = json.loads(conn.execute("SELECT retry_context_json FROM manual_capture_queue").fetchone()[0])
    assert context["reason"] == "posting_employer_unknown"


def test_qualification_retains_structured_residence_restrictions_outside_description(tmp_path):
    conn = init_db(tmp_path / "residence.db")
    page = posting_page(URL)
    structured = {
        **page.json_ld[0],
        "jobLocationType": "TELECOMMUTE",
        "applicantLocationRequirements": {"@type": "Country", "name": "Synthetic other country"},
    }
    page = replace(page, json_ld=(structured,))
    model = PostingModel(location="mismatch")
    assert store(conn, intake(conn, model, page=page)) == (0, 0)
    request = model.calls[-1][1]
    captured = next(source for source in request["sources"] if source["source_id"] == "posting:0:structured")
    assert json.loads(captured["text"])["applicantLocationRequirements"] == structured["applicantLocationRequirements"]
    assert request["context"]["captured_source_urls"]["posting:0:structured"] == URL


def test_unchanged_capture_reuses_all_determinations_and_accepted_enrichment(tmp_path):
    conn = init_db(tmp_path / "cache.db")
    model = PostingModel()
    selected = intake(conn, model)
    assert store(conn, selected) == (1, 0)
    before = tuple(conn.execute("SELECT * FROM job_enrichments").fetchone())
    assert len(model.calls) == 3
    assert store(conn, selected) == (0, 1)
    assert len(model.calls) == 3
    assert tuple(conn.execute("SELECT * FROM job_enrichments").fetchone()) == before


@pytest.mark.parametrize(
    "fault,code",
    [
        ("provider", "provider_unavailable"),
        ("budget", "budget_denied"),
        ("json", "malformed_json"),
        ("extra", "schema_violation"),
        ("enum", "schema_violation"),
        ("foreign", "foreign_source_id"),
        ("quote", "non_verbatim_quote"),
        ("numeric", "mismatched_value"),
        ("binding", "field_binding_invalid"),
    ],
)
def test_determination_fault_never_falls_back_or_overwrites_accepted_job(tmp_path, fault, code):
    conn = init_db(tmp_path / "fault.db")
    assert store(conn, intake(conn)) == (1, 0)
    job_before = tuple(conn.execute("SELECT * FROM jobs").fetchone())
    enrichment_before = tuple(conn.execute("SELECT * FROM job_enrichments").fetchone())
    snapshot_before = [tuple(row) for row in conn.execute("SELECT * FROM posting_snapshot_sets")]

    class FaultModel(PostingModel):
        def chat_json(self, messages, *, response_schema, **kwargs):
            assert current_llm_lane() == "discovery"
            if response_schema["title"] != "PostingQualification":
                return super().chat_json(messages, response_schema=response_schema, **kwargs)
            if fault == "provider":
                raise DeterminationFailure("provider_unavailable")
            if fault == "json":
                raise json.JSONDecodeError("synthetic", "", 0)
            result = super().chat_json(messages, response_schema=response_schema, **kwargs)
            field = result["location_match"]
            if fault == "extra":
                result["extra"] = True
            elif fault == "enum":
                field["value"] = "guess"
            elif fault == "foreign":
                field["citations"][0]["source_id"] = "foreign"
            elif fault == "quote":
                field["citations"][0]["quote"] = "not a source span"
            elif fault == "numeric":
                field["citations"][0]["exact_values"] = ["999%"]
            elif fault == "binding":
                field["citations"] = [field["citations"][1]]
            return result

    events = []

    def preflight():
        assert current_llm_lane() == "discovery"
        events.append("preflight")
        if fault == "budget":
            raise ValueError("synthetic budget denial")

    selected = intake(conn, FaultModel(), preflight=preflight)
    # Changed saved rules require a new decision, while the accepted Job and its
    # immutable enrichment remain the preservation controls.
    selected.search_cfg = {"locations": [{"location": "A different saved place", "remote": True}]}
    with pytest.raises(DeterminationFailure) as raised:
        store(conn, selected)
    assert raised.value.code == code
    assert events
    assert tuple(conn.execute("SELECT * FROM jobs").fetchone()) == job_before
    assert tuple(conn.execute("SELECT * FROM job_enrichments").fetchone()) == enrichment_before
    assert [tuple(row) for row in conn.execute("SELECT * FROM posting_snapshot_sets")] == snapshot_before


def test_private_redirect_is_held_before_any_model_call(tmp_path):
    conn = init_db(tmp_path / "url.db")
    model = PostingModel()
    selected = intake(conn, model, page=replace(posting_page(URL), final_url="http://127.0.0.1/private"))
    selected.url_validator = lambda url: PublicUrlDecision(allowed=url == URL)
    assert store(conn, selected) == (0, 0)
    assert model.calls == []
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0


def test_cancellation_after_model_prevents_job_creation(tmp_path):
    conn = init_db(tmp_path / "cancel.db")
    canceled = threading.Event()

    class CancelModel(PostingModel):
        def chat_json(self, *args, **kwargs):
            result = super().chat_json(*args, **kwargs)
            canceled.set()
            return result

    with pytest.raises(TransientNetworkError):
        store(conn, intake(conn, CancelModel(), cancel_event=canceled))
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0


@pytest.mark.parametrize("excluded,new", [("Platform Director", 0), ("Synthetic Labs is hiring people", 1)])
def test_literal_exclusion_uses_verified_role_not_feed_headline(tmp_path, excluded, new):
    conn = init_db(tmp_path / "literal.db")
    result = _store_jobs(
        conn,
        [CARD],
        "Synthetic",
        "css_selectors",
        search_cfg={**RULES, "exact_title_exclusions": [excluded]},
        intake=intake(conn),
    )
    assert result == (new, 0)
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == new


def test_concurrent_identical_qualification_calls_model_once(tmp_path):
    conn = init_db(tmp_path / "concurrent.db")
    model = PostingModel()
    sources, origins = posting_page_sources(posting_page(URL), entity_id=URL)
    extraction, receipt = ModelPagePostingExtractor(**model_dependencies(conn, model)).extract(
        entity_id=URL,
        sources=sources,
        source_urls=origins,
    )
    repository = Repository()
    dependencies = {**model_dependencies(conn, model), "repository": repository}
    qualifier = ModelPostingQualifier(**dependencies)
    before = len(model.calls)

    def run():
        return qualifier.qualify(
            entity_id=URL,
            extraction=extraction,
            extraction_id=receipt.determination_id,
            locations=RULES["confirmed_targets"],
        )[1].determination_id

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: run(), range(2)))
    assert results[0] == results[1]
    assert len(model.calls) == before + 1


@pytest.mark.asyncio
@pytest.mark.parametrize("code,retryable", [("schema_violation", False), ("provider_error", True)])
async def test_source_activity_preserves_determination_failure_authority(tmp_path, monkeypatch, code, retryable):
    from temporalio.exceptions import ApplicationError
    from jobctrl.discovery.activities import DiscoverySourceActivityInput, discovery_source_family_activity
    from jobctrl.domain.discovery.scheduler import ScheduledSource
    from jobctrl.domain.discovery.source_registry import SourceKind, SourcePriority, SourceState
    from jobctrl.pipeline import runner

    conn = init_db(tmp_path / "source-failure.db")
    source = ScheduledSource(
        source_id="smart_extract:synthetic",
        display_name="Synthetic",
        source_kind=SourceKind.SMART_EXTRACT,
        priority=SourcePriority.STANDARD,
        configured_state=SourceState.ACTIVE,
        crawl_budget=1,
        decision="run",
        reason="owned test",
        recommended_state="active",
    )
    monkeypatch.setattr(runner, "get_connection", lambda: conn)
    monkeypatch.setattr("jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime", lambda **_kw: None)

    async def blocking(fn, **_kwargs):
        return fn()

    monkeypatch.setattr("jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat", blocking)

    def failure():
        raise DeterminationFailure(code)

    monkeypatch.setattr(
        runner,
        "run_discovery_source_family",
        lambda *_a, **_kw: runner._run_discovery_source(
            "smartextract",
            "Synthetic",
            (source,),
            failure,
        ),
    )
    with pytest.raises(ApplicationError) as raised:
        await discovery_source_family_activity(DiscoverySourceActivityInput(tenant_id="local", family="smartextract"))
    assert raised.value.type == code
    assert raised.value.non_retryable is not retryable
    payload = json.loads(
        conn.execute(
            "SELECT payload_json FROM job_events WHERE event_type='DiscoveryRunFailed' ORDER BY event_id DESC LIMIT 1"
        ).fetchone()[0]
    )
    assert payload["retryable"] is retryable
