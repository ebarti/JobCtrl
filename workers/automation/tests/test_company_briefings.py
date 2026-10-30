"""Owned exact-v14 product paths; injected judgments prove authority, not quality."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import sqlite3

import pytest
from typer.testing import CliRunner

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.company_briefings import public_source_url
from types import SimpleNamespace as ResearchPageFetch
from jobctrl.infrastructure.determinations import determination_dependencies
from jobctrl.infrastructure.materials.company_briefings import (
    ACCEPTED,
    ATTEMPT,
    CompanyBriefingRepository,
    refresh_briefing,
)
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.llm_lanes import current_llm_lane

JOB = "90000000-0000-4000-8000-000000000021"
SECOND_JOB = "90000000-0000-4000-8000-000000000022"
HOME = "https://company.example.com/"
URL = HOME + "about"
TEXT = "Example Company operates a public engineering laboratory."


class Model:
    model = "synthetic"
    provider_id = "fake"

    def __init__(self, *, kind="company_fact", identity="confirmed", fault=None):
        self.kind, self.identity, self.fault, self.calls = kind, identity, fault, []

    def chat_json(self, messages, **kwargs):
        assert current_llm_lane() == "enrichment"
        data = json.loads(messages[1].content)
        self.calls.append(data)
        assert set(data["context"]) == {"company", "publicSources"}
        assert "profile" not in json.dumps(data)
        if isinstance(self.fault, Exception):
            raise self.fault
        citation = {"source_id": data["sources"][0]["source_id"], "quote": TEXT, "exact_values": []}
        result = {
            "identity": self.identity,
            "identity_reason": "Synthetic identity judgment",
            "identity_citations": [citation],
            "claims": [
                {
                    "kind": self.kind,
                    "text": "Synthetic model determination",
                    "uncertainty": "Reported by one source.",
                    "event_date": None,
                    "citations": [deepcopy(citation)],
                }
            ],
        }
        if self.fault:
            self.fault(result)
        return result


class Fetcher:
    def __init__(self, callback=None):
        self.calls, self.callback = [], callback

    def fetch(self, url):
        self.calls.append(url)
        if self.callback:
            self.callback()
        return ResearchPageFetch(outcome="allowed", text=TEXT, final_url=url, status=200)


@pytest.fixture
def repository(tmp_path):
    conn = sqlite3.connect(tmp_path / "company.db")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    create_exact_v14_schema(conn)
    for job in (JOB, SECOND_JOB):
        conn.execute(
            "INSERT INTO jobs(tenant_id,job_id,url,title,company) VALUES('local',?,?,?,?)",
            (job, HOME + job, "Synthetic role", "Example Company"),
        )
    conn.commit()
    yield CompanyBriefingRepository(conn)
    conn.close()


def configured(repository, job=JOB, *, homepage=HOME, urls=(URL,)):
    return repository.configure(job, homepage_url=homepage, source_urls=urls, confirm_identity=True)


def refresh(repository, model=None, fetcher=None, **kwargs):
    model = model or Model()
    dependencies = determination_dependencies(
        repository.connection, tenant_id="local", lane="enrichment", adapter=model
    )
    preflights = []

    def preflight():
        assert current_llm_lane() == "enrichment"
        preflights.append(True)

    dependencies["preflight"] = preflight
    result = refresh_briefing(
        repository, JOB, allow_public_fetch=True, fetcher=fetcher or Fetcher(), dependencies=dependencies, **kwargs
    )
    return result, model, preflights


def test_explicit_configuration_and_cross_job_reuse(repository):
    assert repository.read(JOB) is None
    configured(repository)
    accepted, model, preflights = refresh(repository)
    assert accepted["status"] == "current"
    assert len(model.calls) == len(preflights) == 1
    configured(repository, SECOND_JOB)
    assert repository.read(SECOND_JOB)["accepted"] == accepted["accepted"]
    assert len(repository.summaries()) == 1
    no_fetch = Fetcher(lambda: pytest.fail("passive/fresh read fetched"))
    reused, _, preflights = refresh(repository, model, no_fetch)
    assert reused["accepted"] == accepted["accepted"]
    assert len(model.calls) == 1 and preflights == []
    # Explicit re-fetch of unchanged content updates observation but reuses the determination.
    refetched, _, preflights = refresh(repository, model, force=True)
    assert refetched["accepted"]["determinationId"] == accepted["accepted"]["determinationId"]
    assert len(model.calls) == 1 and preflights == []
    # Equal display names do not link an unconfirmed company identity.
    configured(repository, SECOND_JOB, homepage=HOME + "subsidiary/")
    assert repository.read(SECOND_JOB)["accepted"] is None


@pytest.mark.parametrize("kind", ["company_fact", "hypothesis"])
def test_model_controls_claim_kind_for_identical_inputs(repository, kind):
    configured(repository)
    accepted, _, _ = refresh(repository, Model(kind=kind))
    assert accepted["accepted"]["result"]["claims"][0]["kind"] == kind


def test_identity_ambiguity_has_no_lexical_fallback(repository):
    configured(repository)
    with pytest.raises(DeterminationFailure, match="briefing_identity_needs_review"):
        refresh(repository, Model(identity="needs_review"))
    assert repository.read(JOB)["accepted"] is None
    assert repository.read(JOB)["lastAttempt"]["failureCode"] == "briefing_identity_needs_review"


@pytest.mark.parametrize(
    "fault,code",
    [
        (RuntimeError("PRIVATE PROVIDER ERROR"), "provider_error"),
        (json.JSONDecodeError("private", "", 0), "malformed_json"),
        (lambda result: result.update(extra=True), "schema_violation"),
        (lambda result: result["claims"][0].update(kind="unlisted"), "schema_violation"),
        (lambda result: result["claims"][0]["citations"][0].update(source_id="foreign"), "foreign_source_id"),
        (lambda result: result["claims"][0]["citations"][0].update(quote="not in source"), "non_verbatim_quote"),
        (lambda result: result["claims"][0]["citations"][0].update(exact_values=["123"]), "mismatched_value"),
    ],
)
def test_failures_preserve_last_accepted_and_do_not_advance_clock(repository, fault, code):
    configured(repository)
    before, _, _ = refresh(repository)
    # Different source URL changes the determination fingerprint and makes old content stale.
    configured(repository, urls=(HOME + "news",))
    with pytest.raises(DeterminationFailure, match=code):
        refresh(repository, Model(fault=fault))
    after = repository.read(JOB)
    assert after["accepted"] == before["accepted"]
    assert after["lastAttempt"]["failureCode"] == code
    assert after["staleReasons"] == ["sources_changed"]
    assert "PRIVATE" not in json.dumps(after)


@pytest.mark.parametrize("failure", ["provider_unavailable", "budget_denied"])
def test_admission_failures_do_not_call_model(repository, failure):
    configured(repository)
    model = Model()
    dependencies = determination_dependencies(
        repository.connection, tenant_id="local", lane="enrichment", adapter=model
    )
    if failure == "provider_unavailable":
        dependencies["llm"] = None
    else:

        def denied():
            assert current_llm_lane() == "enrichment"
            raise RuntimeError("private budget detail")

        dependencies["preflight"] = denied
    with pytest.raises(DeterminationFailure, match=failure):
        refresh_briefing(repository, JOB, allow_public_fetch=True, fetcher=Fetcher(), dependencies=dependencies)
    assert model.calls == []
    assert repository.read(JOB)["lastAttempt"]["failureCode"] == failure


def test_date_staleness_and_changed_employer_require_review(repository):
    configured(repository)
    old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
    view, _, _ = refresh(repository, clock=lambda: old)
    assert view["accepted"]["observedAt"] == old
    assert repository.read(JOB)["staleReasons"] == ["sources_older_than_seven_days"]
    repository.connection.execute("UPDATE jobs SET company='Other employer' WHERE job_id=?", (JOB,))
    repository.connection.commit()
    assert repository.read(JOB)["status"] == "needs_review"
    with pytest.raises(DeterminationFailure, match="briefing_identity_confirmation_required"):
        refresh(repository)
    assert repository.summaries() == []
    configured(repository)
    assert repository.read(JOB)["status"] == "stale"


def test_configuration_race_fences_acceptance(repository):
    configured(repository)
    before, _, _ = refresh(repository)

    def reconfigure():
        configured(repository, urls=(HOME + "new",))

    with pytest.raises(DeterminationFailure, match="briefing_sources_changed"):
        refresh(repository, fetcher=Fetcher(reconfigure), force=True)
    assert repository.read(JOB)["accepted"] == before["accepted"]


def test_atomic_save_failure_preserves_accepted(repository, monkeypatch):
    configured(repository)
    before, _, _ = refresh(repository)
    append = repository.append

    def fail_attempt(kind, *args, **kwargs):
        if kind == ATTEMPT and args[1]["failureCode"] is None:
            raise RuntimeError("injected commit error")
        return append(kind, *args, **kwargs)

    monkeypatch.setattr(repository, "append", fail_attempt)
    with pytest.raises(DeterminationFailure, match="briefing_refresh_failed"):
        refresh(repository, force=True)
    assert repository.read(JOB)["accepted"] == before["accepted"]
    assert (
        repository.connection.execute("SELECT count(*) FROM job_events WHERE entity_kind=?", (ACCEPTED,)).fetchone()[0]
        == 1
    )


def test_configuration_and_refresh_require_explicit_opt_in(repository):
    with pytest.raises(DeterminationFailure, match="confirmation_required"):
        repository.configure(JOB, homepage_url=HOME, source_urls=[URL], confirm_identity=False)
    configured(repository)
    with pytest.raises(DeterminationFailure, match="opt_in_required"):
        refresh_briefing(repository, JOB)
    for urls in ([], [URL] * 2, [HOME + str(i) for i in range(4)]):
        with pytest.raises(DeterminationFailure, match="source_limit"):
            configured(repository, urls=urls)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost/",
        "http://127.0.0.1/",
        "http://[::1]/",
        "http://host.internal/",
        "https://user:secret@public.example/",
        "https://company.example/a?token=x",
        "https://company.example/a#x",
        "file:///etc/passwd",
        "https://company.example:8000/",
        "https://company.example/a\n",
    ],
)
def test_unsafe_or_credential_shaped_urls_rejected_before_network(url):
    with pytest.raises(DeterminationFailure, match="invalid_public_url"):
        public_source_url(url)


def test_cli_read_and_opt_in_errors_use_actual_repository(repository, monkeypatch):
    from jobctrl import company_briefing_cli
    from jobctrl.cli import app

    monkeypatch.setattr(company_briefing_cli, "repository", lambda: repository)
    runner = CliRunner()
    args = ["company-briefing", "configure", JOB, "--company-url", HOME, "--source", URL, "--json"]
    assert runner.invoke(app, args).exit_code == 1
    result = runner.invoke(app, args + ["--confirm-identity"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["status"] == "missing"
    assert runner.invoke(app, ["company-briefing", "refresh", JOB, "--json"]).exit_code == 1
    refresh(repository)
    shown = runner.invoke(app, ["company-briefing", "show", JOB])
    assert shown.exit_code == 0 and TEXT in shown.stdout and "Uncertainty:" in shown.stdout


def test_blocked_gateway_transaction_is_committed_before_failure_record(repository):
    configured(repository)
    before, _, _ = refresh(repository)

    class Blocked:
        def fetch(self, url):
            repository.connection.execute(
                "INSERT INTO job_events(tenant_id,identity_version,event_type,occurred_at) VALUES('local',1,'SyntheticGatewayBlocked','2026-01-01')"
            )
            return ResearchPageFetch(outcome="rate_limited", text="", final_url=url, status=429)

    with pytest.raises(DeterminationFailure, match="briefing_source_unavailable"):
        refresh(repository, fetcher=Blocked(), force=True)
    assert not repository.connection.in_transaction
    assert repository.read(JOB)["accepted"] == before["accepted"]
    assert repository.read(JOB)["lastAttempt"]["failureCode"] == "briefing_source_unavailable"


def test_event_dates_must_be_bound_to_cited_exact_values(repository):
    configured(repository)
    with pytest.raises(DeterminationFailure, match="mismatched_value"):
        refresh(repository, Model(fault=lambda result: result["claims"][0].update(event_date="2026-01-01")))


def test_public_fetch_bounds_and_private_redirects():
    import io
    import urllib.error
    from email.message import Message
    from jobctrl.infrastructure.materials.company_briefing_fetcher import CompanyBriefingFetcher
    from jobctrl.domain.contact.source_policy import ContactResearchSourcePolicy
    from jobctrl.infrastructure.network import (
        PolitenessGateway,
        PolitenessSession,
        PolitenessSourceContext,
        RunBudgetCounter,
    )
    from dataclasses import replace

    policy = ContactResearchSourcePolicy(domain_allowlist=("company.example.com",))
    policy = replace(policy, source_policy=replace(policy.source_policy, min_request_interval_seconds=0))

    class Response(io.BytesIO):
        status = 200

        def geturl(self):
            return URL

    class Opener:
        def __init__(self, body):
            self.body, self.requests, self.response = body, [], None

        def open(self, request, **kwargs):
            self.requests.append(request)
            if isinstance(self.body, Exception):
                raise self.body
            self.response = Response(self.body)
            return self.response

    def fetcher(opener):
        return CompanyBriefingFetcher(
            urls=[URL],
            policy=policy,
            session=PolitenessSession(
                PolitenessGateway(),
                policy=policy.source_policy,
                budget=RunBudgetCounter(6),
                context=PolitenessSourceContext(stage="enrichment", adapter="company_briefing"),
            ),
            opener=opener,
            target_resolver=lambda host, port: ("93.184.216.34",),
        )

    oversized = Opener(b"x" * (1024 * 1024 + 2))
    assert fetcher(oversized).fetch(URL).outcome == "response_too_large"
    assert len(oversized.requests) == 1
    headers = Message()
    headers["Location"] = "http://127.0.0.1/private"
    redirect = Opener(urllib.error.HTTPError(URL, 302, "redirect", headers, None))
    assert fetcher(redirect).fetch(URL).outcome == "rejected"
    assert len(redirect.requests) == 1
    ok = Opener(b"<html><body>Public page</body></html>")
    bounded = fetcher(ok)
    assert bounded.fetch(URL).text == "Public page"
    assert not ok.requests[0].has_header("Cookie")
    assert not ok.requests[0].has_header("Authorization")
    assert bounded.fetch("https://other.example.com/about").outcome == "rejected"
    assert len(ok.requests) == 1
    for _ in range(5):
        assert bounded.fetch(URL).outcome == "allowed"
    assert bounded.fetch(URL).outcome == "budget_exhausted"
    assert len(ok.requests) == 6


def test_concurrent_refreshes_reuse_one_accepted_determination(repository):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    configured(repository)
    database = repository.connection.execute("PRAGMA database_list").fetchone()[2]
    started, release = Event(), Event()
    model, fetcher = Model(), Fetcher()

    def delayed():
        started.set()
        assert release.wait(5)

    fetcher.callback = delayed

    def worker():
        connection = sqlite3.connect(database)
        try:
            return refresh(CompanyBriefingRepository(connection), model, fetcher)[0]
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(worker)
        assert started.wait(5)
        second = executor.submit(worker)
        release.set()
        one, two = first.result(), second.result()
    assert one["accepted"] == two["accepted"]
    assert len(model.calls) == len(fetcher.calls) == 1


def test_corrupt_source_binding_is_unavailable_without_losing_history(repository):
    configured(repository)
    before, _, _ = refresh(repository)
    payload = deepcopy(before["accepted"])
    payload.pop("revision")
    payload["sources"][0]["text"] = "corrupted"
    repository.connection.execute(
        "UPDATE job_events SET payload_json=? WHERE entity_kind=?", (json.dumps(payload), ACCEPTED)
    )
    repository.connection.commit()
    assert repository.read(JOB)["status"] == "unavailable"
    with pytest.raises(DeterminationFailure, match="briefing_binding_invalid"):
        refresh(repository)
    assert (
        repository.connection.execute("SELECT count(*) FROM job_events WHERE entity_kind=?", (ACCEPTED,)).fetchone()[0]
        == 1
    )


def test_digest_omits_hidden_and_deleted_job_links(repository):
    configured(repository)
    refresh(repository)
    configured(repository, SECOND_JOB)
    repository.connection.execute(
        "INSERT INTO jobctrl_hidden_jobs(tenant_id,job_id,hidden_at) VALUES('local',?,'2026-01-01')", (SECOND_JOB,)
    )
    repository.connection.commit()
    assert repository.summaries()[0]["jobId"] == JOB
    repository.connection.execute(
        "INSERT INTO jobctrl_deleted_jobs(tenant_id,job_id,deleted_at) VALUES('local',?,'2026-01-01')", (JOB,)
    )
    repository.connection.commit()
    assert repository.summaries() == []
