"""Cited model admission, durable intake, distinct failures and cached batches."""

import json
import sqlite3
from types import SimpleNamespace
import pandas as pd
import pytest
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.search_units import DiscoverySearchSpec
from jobctrl.domain.discovery.triage import Listing
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import SqliteDiscoverySearchUnitRepository
from jobctrl.infrastructure.discovery.triage import triage_listings
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.llm_lanes import current_llm_lane


CFG = {"confirmed_targets": {"profile_version": 1, "roles": ["Synthetic target"]}, "triage_batch_size": 20}


class Model:
    def __init__(self, verdict="admit", failure=None):
        self.verdict, self.failure, self.calls = verdict, failure, []

    def chat_json(self, messages, **kwargs):
        assert current_llm_lane() == "discovery"
        data = json.loads(messages[1].content)
        self.calls.append(data)
        if self.failure:
            raise self.failure
        listings = data["context"].get("listings")
        assert listings is not None
        return {
            "listings": [
                {
                    "listing_id": row["listing_id"],
                    "verdict": self.verdict,
                    "reason_code": "compatible" if self.verdict == "admit" else "insufficient_information",
                    "rationale": "Model determination",
                    "citations": [{"source_id": f"listing:{row['listing_id']}:title", "quote": row["title"]}],
                }
                for row in listings
            ]
        }


def setup(model, preflight=lambda: None):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_exact_v14_schema(conn)
    deps = dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="fake",
        lane="discovery",
        preflight=preflight,
    )
    return conn, deps


def listings(count):
    return [
        Listing(
            listing_id=f"listing-{index}",
            source_id="jobspy:test",
            url=f"https://example.test/{index}",
            title="Synthetic title",
            company="Synthetic employer",
            location="Synthetic location",
            remote=None,
        )
        for index in range(count)
    ]


@pytest.mark.parametrize("verdict", ["admit", "reject", "uncertain"])
def test_same_listing_follows_model_and_exposes_persisted_reason(verdict):
    conn, deps = setup(Model(verdict))
    assert triage_listings(conn, listings(1), search_cfg=CFG, dependencies=deps) == {"listing-0": verdict}
    row = conn.execute("SELECT status,reason_code,determination_id FROM posting_triage").fetchone()
    envelope = deps["repository"].find("local", row[2])
    assert row[0] == verdict
    assert envelope.result["listings"][0]["verdict"] == verdict
    assert row[1] == envelope.result["listings"][0]["reason_code"]
    assert envelope.input_fingerprint and envelope.prompt_version and envelope.model == "fake"


def test_default_batches_and_unchanged_rerun_make_zero_calls():
    model = Model()
    conn, deps = setup(model)
    triage_listings(conn, listings(41), search_cfg=CFG, dependencies=deps)
    assert [len(call["context"]["listings"]) for call in model.calls] == [20, 20, 1]
    triage_listings(conn, listings(41), search_cfg=CFG, dependencies={**deps, "llm": None})
    assert len(model.calls) == 3
    changed = {**CFG, "confirmed_targets": {**CFG["confirmed_targets"], "profile_version": 2}}
    triage_listings(conn, listings(1), search_cfg=changed, dependencies=deps)
    assert len(model.calls) == 4


def test_triage_cannot_cite_a_different_listings_fields():
    class CrossListingModel(Model):
        def chat_json(self, messages, **kwargs):
            result = super().chat_json(messages, **kwargs)
            result["listings"][0]["citations"] = result["listings"][1]["citations"]
            return result

    conn, deps = setup(CrossListingModel())
    with pytest.raises(DeterminationFailure, match="foreign_source_id"):
        triage_listings(conn, listings(2), search_cfg=CFG, dependencies=deps)
    assert [tuple(row) for row in conn.execute("SELECT status,failure_code FROM posting_triage")] == [
        ("pending_triage", "foreign_source_id"),
        ("pending_triage", "foreign_source_id"),
    ]


@pytest.mark.parametrize("initial_verdict", [None, "admit"])
def test_later_discovery_drains_intake_without_the_source_returning_it_again(initial_verdict):
    from jobctrl.domain.discovery.identity import AtsKind
    from jobctrl.domain.discovery.value_objects import Employer, JobMetadata, PostingUrl, SearchStrategy, Source
    from jobctrl.domain.ports.discovery import ScrapedJobPosting
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.discovery.triage import PersistedPostingTriage, retry_pending_postings

    model = Model("admit")
    conn, deps = setup(model)
    posting = ScrapedJobPosting(
        posting_url=PostingUrl("https://example.test/persisted"),
        source=Source("Synthetic board"),
        employer=Employer("Synthetic employer"),
        metadata=JobMetadata(
            title="Synthetic title",
            description="Preserved listing description",
            salary="EUR100000/yr",
        ),
        strategy=SearchStrategy.JOBSPY,
        source_id="jobspy:test",
        source_native_id="persisted",
        canonical_url="https://example.test/persisted",
        ats_kind=AtsKind.OTHER,
        structured_remote=True,
    )
    initial = PersistedPostingTriage(
        conn, search_cfg=CFG, dependencies={**deps, "llm": model if initial_verdict else None}
    )
    if initial_verdict:
        assert initial.admit(tenant_id=LOCAL_TENANT, postings=[posting]) == [posting]
    else:
        with pytest.raises(DeterminationFailure, match="provider_unavailable"):
            initial.admit(tenant_id=LOCAL_TENANT, postings=[posting])
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    # This later activity consumes only persisted intake; there is no scraper.
    assert retry_pending_postings(conn, search_cfg=CFG, dependencies=deps) == 1
    assert len(model.calls) == 1
    assert tuple(conn.execute("SELECT title,description,salary FROM jobs").fetchone()) == (
        "Synthetic title",
        "Preserved listing description",
        "EUR100000/yr",
    )
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0]
    assert retry_pending_postings(conn, search_cfg=CFG, dependencies={**deps, "llm": None}) == 0
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


def postings(count, *, source_id="jobspy:test", start=0, strategy=None):
    from jobctrl.domain.discovery.identity import AtsKind
    from jobctrl.domain.discovery.value_objects import Employer, JobMetadata, PostingUrl, SearchStrategy, Source
    from jobctrl.domain.ports.discovery import ScrapedJobPosting

    return [
        ScrapedJobPosting(
            posting_url=PostingUrl(f"https://example.test/pending/{index}"),
            source=Source("Synthetic board"),
            employer=Employer("Synthetic employer"),
            metadata=JobMetadata(title=f"Synthetic title {index}", description=f"Synthetic description {index}"),
            strategy=strategy or SearchStrategy.JOBSPY,
            source_id=source_id,
            source_native_id=str(index),
            canonical_url=f"https://example.test/pending/{index}",
            ats_kind=AtsKind.OTHER,
        )
        for index in range(start, start + count)
    ]


def test_pending_recovery_uses_one_batch_and_preserves_the_current_run_limit():
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.discovery.triage import PersistedPostingTriage, retry_pending_postings

    model = Model()
    conn, deps = setup(model)
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        PersistedPostingTriage(conn, search_cfg=CFG, dependencies={**deps, "llm": None}).admit(
            tenant_id=LOCAL_TENANT, postings=postings(41)
        )
    assert retry_pending_postings(conn, search_cfg=CFG, dependencies=deps) == 20
    assert [len(call["context"]["listings"]) for call in model.calls] == [20]
    assert conn.execute("SELECT COUNT(*) FROM posting_triage WHERE consumed_at IS NULL").fetchone()[0] == 21
    assert retry_pending_postings(conn, search_cfg=CFG, dependencies=deps, limit=3) == 3
    assert [len(call["context"]["listings"]) for call in model.calls] == [20, 3]
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 23
    assert conn.execute("SELECT COUNT(*) FROM posting_triage WHERE consumed_at IS NULL").fetchone()[0] == 18


@pytest.mark.parametrize("cancel_after_call", [False, True])
def test_cancellation_preserves_pending_intake_and_a_completed_verdict_can_resume_without_spend(cancel_after_call):
    import threading
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.discovery.triage import PersistedPostingTriage, retry_pending_postings

    canceled = threading.Event()

    class CancelingModel(Model):
        def chat_json(self, messages, **kwargs):
            result = super().chat_json(messages, **kwargs)
            canceled.set()
            return result

    model = CancelingModel()
    conn, deps = setup(model)
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        PersistedPostingTriage(conn, search_cfg=CFG, dependencies={**deps, "llm": None}).admit(
            tenant_id=LOCAL_TENANT, postings=postings(2)
        )
    if not cancel_after_call:
        canceled.set()
    assert retry_pending_postings(conn, search_cfg=CFG, dependencies=deps, cancel_event=canceled) == 0
    assert len(model.calls) == int(cancel_after_call)
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM posting_triage WHERE consumed_at IS NULL").fetchone()[0] == 2
    if cancel_after_call:
        canceled.clear()
        assert (
            retry_pending_postings(conn, search_cfg=CFG, dependencies={**deps, "llm": None}, cancel_event=canceled) == 2
        )
        assert len(model.calls) == 1


@pytest.mark.parametrize("source_id,family", [("workday:synthetic", "workday"), ("ats:synthetic", "ats_api")])
def test_recovered_ats_posting_uses_its_original_execution_family(source_id, family):
    from jobctrl.domain.discovery.value_objects import SearchStrategy
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.discovery.triage import PersistedPostingTriage, retry_pending_postings

    conn, deps = setup(Model())
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        PersistedPostingTriage(conn, search_cfg=CFG, dependencies={**deps, "llm": None}).admit(
            tenant_id=LOCAL_TENANT, postings=postings(1, source_id=source_id, strategy=SearchStrategy.WORKDAY_API)
        )
    execution = DiscoveryExecutionRef("local", "synthetic-workflow", "synthetic-run")
    assert (
        retry_pending_postings(
            conn,
            search_cfg=CFG,
            dependencies=deps,
            source_ids=(source_id,),
            source_family=family,
            discovery_execution=execution,
        )
        == 1
    )
    assert tuple(conn.execute("SELECT source_family,cohort_kind FROM discovery_execution_jobs").fetchone()) == (
        family,
        "observed_this_run",
    )


def test_workday_intake_survives_failure_and_recovers_without_another_board_search(monkeypatch):
    from jobctrl.discovery import workday
    from jobctrl.infrastructure.discovery.triage import retry_pending_postings

    model = Model()
    conn, deps = setup(model)
    job = {
        "title": "Synthetic title",
        "location": "Synthetic location",
        "employer_key": "synthetic",
        "employer_name": "Synthetic employer",
        "job_req_id": "synthetic-id",
        "apply_url": "https://synthetic.wd1.myworkdayjobs.com/External/job/synthetic",
    }
    employers = {"synthetic": {"name": "Synthetic employer", "_source_id": "workday:synthetic"}}
    searches = []
    monkeypatch.setattr(workday, "search_employer", lambda *args, **kwargs: searches.append(args) or [job])
    monkeypatch.setattr(workday, "get_connection", lambda: conn)
    monkeypatch.setattr(
        workday,
        "triage_listings",
        lambda *args, **kwargs: triage_listings(*args, **kwargs, dependencies={**deps, "llm": None}),
    )
    monkeypatch.setattr(
        workday, "fetch_details", lambda *args, **kwargs: pytest.fail("No detail fetch before admission")
    )
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        workday._search_and_fetch_one("synthetic", employers, "Synthetic query", search_cfg=CFG)
    assert conn.execute("SELECT posting_json FROM posting_triage").fetchone()[0] is not None
    assert retry_pending_postings(conn, search_cfg=CFG, source_ids=("workday:synthetic",), dependencies=deps) == 1
    assert len(searches) == 1
    assert tuple(conn.execute("SELECT title,url FROM jobs").fetchone()) == (job["title"], job["apply_url"])
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0]


def test_failed_backlog_retry_in_source_activity_does_not_block_new_intake(monkeypatch):
    import jobctrl.infrastructure.discovery.triage as wiring
    from jobctrl.discovery import jobspy
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.pipeline import runner

    conn, deps = setup(None)
    triage = wiring.PersistedPostingTriage(conn, search_cfg=CFG, dependencies=deps)
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        triage.admit(tenant_id=LOCAL_TENANT, postings=postings(1))
    source = SimpleNamespace(source_id="jobspy:test", should_run=True)
    schedule = SimpleNamespace(
        for_prefix=lambda prefix: (source,) if prefix == "jobspy" else (), for_kinds=lambda *args: ()
    )
    monkeypatch.setattr(runner, "get_connection", lambda: conn)
    monkeypatch.setattr(runner.config, "load_search_config", lambda: CFG)
    monkeypatch.setattr(runner, "_plan_discovery_schedule", lambda *args, **kwargs: schedule)
    monkeypatch.setattr(runner, "_smart_extract_sources", lambda *args: ())
    monkeypatch.setattr(runner, "_jobspy_config_for_sources", lambda *args: {**CFG, "boards": ["test"]})
    monkeypatch.setattr(runner, "_scheduled_limit", lambda *args: 0)
    monkeypatch.setattr(wiring, "determination_dependencies", lambda *args, **kwargs: deps)
    monkeypatch.setattr(
        runner, "_run_discovery_source", lambda _family, _label, _sources, run, **kwargs: run("synthetic") and "ok"
    )
    fetched = []

    def fresh_intake(**kwargs):
        fetched.append(True)
        with pytest.raises(DeterminationFailure, match="provider_unavailable"):
            triage.admit(tenant_id=LOCAL_TENANT, postings=postings(1, start=99))
        return {"new": 0, "existing": 0, "errors": 1}

    monkeypatch.setattr(jobspy, "run_discovery", fresh_intake)
    result = runner.run_discovery_source_family("jobspy")
    assert fetched == [True]
    assert result["result"]["pending_triage_retry_failure"] == "provider_unavailable"
    assert conn.execute("SELECT COUNT(*) FROM posting_triage WHERE status='pending_triage'").fetchone()[0] == 2


def test_batch_size_is_configurable_and_preflight_runs_first():
    model = Model()
    checks = []

    def preflight():
        assert current_llm_lane() == "discovery"
        checks.append(len(model.calls))

    conn, deps = setup(model, preflight)
    triage_listings(conn, listings(5), search_cfg={**CFG, "triage_batch_size": 2}, dependencies=deps)
    assert checks == [0, 1, 2]
    assert [len(call["context"]["listings"]) for call in model.calls] == [2, 2, 1]


@pytest.mark.parametrize(
    "mode,code",
    [
        ("unavailable", "provider_unavailable"),
        ("budget", "budget_denied"),
        ("json", "malformed_json"),
        ("provider", "provider_error"),
    ],
)
def test_failure_keeps_every_intake_row_pending_and_visible(mode, code):
    model = Model(
        failure=json.JSONDecodeError("invalid", "", 0)
        if mode == "json"
        else RuntimeError("private provider text")
        if mode == "provider"
        else None
    )

    def preflight():
        if mode == "budget":
            raise RuntimeError("private budget")

    conn, deps = setup(None if mode == "unavailable" else model, preflight)
    with pytest.raises(DeterminationFailure) as error:
        triage_listings(conn, listings(2), search_cfg=CFG, dependencies=deps)
    assert error.value.code == code
    assert "private" not in str(error.value)
    assert [tuple(row) for row in conn.execute("SELECT status,failure_code,determination_id FROM posting_triage")] == [
        ("pending_triage", code, None)
    ] * 2
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations WHERE kind='posting_triage'").fetchone()[0] == 0


def test_acknowledged_intake_survives_provider_failure_then_drains_as_one_batch(monkeypatch):
    from jobctrl.discovery import jobspy
    import jobctrl.infrastructure.discovery.triage as wiring

    model = Model()
    conn, deps = setup(None)
    monkeypatch.setattr(wiring, "determination_dependencies", lambda *args, **kwargs: deps)
    execution = DiscoveryExecutionRef("local", "synthetic-workflow", "synthetic-run")
    repository = SqliteDiscoverySearchUnitRepository(conn)
    spec = DiscoverySearchSpec(
        query="Synthetic target",
        provider_location="Synthetic location",
        target_location="Synthetic location",
        sites=("indeed",),
        results_per_site=20,
        hours_old=72,
        remote_only=False,
        country_indeed="usa",
    )
    repository.plan_units(execution, [spec])
    lease = repository.claim_next(execution, owner_token="synthetic-owner", attempt=1)
    unit = repository.get_unit(execution, lease.unit_id)
    for index in range(2):
        frame = pd.DataFrame(
            [
                {
                    "job_url": f"https://example.test/{index}",
                    "title": "Synthetic title",
                    "company": "Synthetic employer",
                    "location": "Synthetic location",
                    "site": "indeed",
                    "is_remote": False,
                }
            ]
        )
        jobspy._persist_intake_event(
            conn,
            repository,
            lease,
            SimpleNamespace(
                job_key=f"key-{index}",
                site=SimpleNamespace(value="indeed"),
                job=SimpleNamespace(model_dump=lambda **kwargs: {}),
            ),
            frame,
        )
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        jobspy._drain_intake_events(
            conn, repository, lease, query=spec.query, run_id="synthetic", search_cfg=CFG, limit=0
        )
    assert conn.execute("SELECT SUM(processed) FROM discovery_intake_events").fetchone()[0] == 0
    deps["llm"] = model
    model.verdict = "reject"
    assert (
        jobspy._drain_intake_events(
            conn, repository, lease, query=unit.spec.query, run_id="synthetic", search_cfg=CFG, limit=0
        )
        is False
    )
    assert len(model.calls) == 1
    assert len(model.calls[0]["context"]["listings"]) == 2
    assert conn.execute("SELECT SUM(processed) FROM discovery_intake_events").fetchone()[0] == 2
    assert repository.execution_filtered_count(execution) == 2
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_literal_exact_exclusion_is_visible_and_never_spends_or_infers():
    model = Model()
    conn, deps = setup(model)
    cfg = {**CFG, "exact_title_exclusions": ["Synthetic title"]}
    assert triage_listings(conn, listings(1), search_cfg=cfg, dependencies={**deps, "llm": None}) == {
        "listing-0": "literal_excluded"
    }
    row = conn.execute("SELECT status,reason_code,determination_id FROM posting_triage").fetchone()
    assert tuple(row) == ("literal_excluded", "literal_exact_title_exclusion", None)
    assert model.calls == []
    other = listings(1)[0].model_copy(update={"title": "Synthetic title extended"})
    assert triage_listings(conn, [other], search_cfg=cfg, dependencies=deps) == {"listing-0": "admit"}
