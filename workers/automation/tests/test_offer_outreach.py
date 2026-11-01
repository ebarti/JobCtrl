"""Offer sources and model authority through real registered outreach RPC.

Synthetic state only; verdicts are explicit port choices, not language-quality labels.
"""

import json
from copy import deepcopy

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.contact.outreach import OutreachDraftKind
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.contact.offer_sources import load_offer_context
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.rpc.handlers import generate_outreach_draft
from tests.determination_fakes import VerificationModel
from tests.test_outreach_draft_gates import _setup, _profile

JOB = "00000000-0000-4000-8000-000000000001"
REVISION = "00000000-0000-4000-8000-000000000101"
SOURCE = {
    "reference": "Synthetic employer letter",
    "quote": "Base EUR 90000 per year. Other terms unknown.",
    "capturedAt": "2026-10-18T10:00:00Z",
    "userConfirmed": True,
}


def seed_terms(conn, revision=REVISION):
    value = {
        "revisionId": revision,
        "expectedRevisionId": None,
        "recordedAt": SOURCE["capturedAt"],
        "terms": {
            "source": SOURCE,
            "cash": [
                {"component": "base_salary", "amount": 90000, "currency": "EUR", "period": "year", "source": SOURCE}
            ],
            "equity": None,
            "benefits": None,
            "decisionDeadline": None,
        },
    }
    conn.execute(
        "INSERT INTO job_events(tenant_id,job_id,identity_version,event_type,occurred_at,payload_json,entity_kind,entity_ref) VALUES ('local',?,1,'OfferRecordChanged',?,?,'offer',?)",
        (JOB, SOURCE["capturedAt"], json.dumps({"termsRevision": value}), JOB),
    )
    conn.commit()
    return value


class OfferModel(VerificationModel):
    provider_id = "synthetic"
    model = "synthetic"

    def __init__(self, verdict="pass", failure=None):
        super().__init__(verdict)
        self.failure = failure
        self.generated = []

    def chat_json(self, messages, *, response_schema, **kwargs):
        if self.failure:
            raise self.failure
        if response_schema["title"] == "GeneratedProseDraft":
            data = json.loads(messages[1].content)
            self.generated.append((messages, data))
            return {
                "lines": [
                    {
                        "line_id": "offer:message",
                        "text": "Could we discuss the confirmed base salary?",
                        "evidence_ids": [],
                        "requirement_ids": ["offer:" + REVISION],
                        "transform_type": "rephrase",
                        "reason": "Explicit synthetic source selection",
                    }
                ]
            }
        return super().chat_json(messages, response_schema=response_schema, **kwargs)


def prepare(tmp_path, monkeypatch, model):
    conn, contacts, threads, contact = _setup(tmp_path)
    seed_terms(conn)
    import jobctrl.database
    import jobctrl.config
    import jobctrl.infrastructure.profile.factory
    import jobctrl.infrastructure.llm.llm_client
    import jobctrl.infrastructure.determinations
    from types import SimpleNamespace

    monkeypatch.setattr(jobctrl.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(jobctrl.config, "DB_PATH", tmp_path / "jobctrl.db")
    monkeypatch.setattr(jobctrl.database, "get_connection", lambda *args, **kwargs: conn)
    monkeypatch.setattr(
        jobctrl.infrastructure.profile.factory,
        "get_profile_repository",
        lambda: SimpleNamespace(load_snapshot=lambda tenant: SimpleNamespace(as_dict=_profile)),
    )
    monkeypatch.setattr(jobctrl.infrastructure.llm.llm_client, "get_llm_adapter", lambda: model)
    preflights = []

    def dependencies(connection, *, tenant_id, lane, adapter):
        return dict(
            llm=adapter,
            repository=SqliteDeterminationRepository(connection),
            tenant_id=str(tenant_id),
            provider="synthetic",
            model="synthetic",
            lane=lane,
            preflight=lambda: preflights.append(lane),
        )

    monkeypatch.setattr(jobctrl.infrastructure.determinations, "determination_dependencies", dependencies)
    params = dict(
        tenantId="local",
        expectedAppDir=str(tmp_path),
        expectedDbPath=str(tmp_path / "jobctrl.db"),
        threadId="offer-thread",
        contactId=str(contact.contact_id),
        jobId=JOB,
        kind="offer_negotiation",
        offerRevisionId=REVISION,
    )
    return conn, threads, params, preflights


@pytest.mark.parametrize("verdict,passed", [("pass", True), ("fail", False)])
def test_rpc_model_controls_gate_for_same_canonical_offer(tmp_path, monkeypatch, verdict, passed):
    model = OfferModel(verdict)
    conn, threads, params, preflights = prepare(tmp_path, monkeypatch, model)
    from jobctrl.infrastructure.rpc.server import JsonRpcServer
    from jobctrl.domain.rpc.messages import JsonRpcRequest

    server = JsonRpcServer()
    from jobctrl.infrastructure.rpc.handlers import register_default_handlers

    register_default_handlers(server, canceler=lambda *args, **kwargs: None)
    response = server.dispatch(JsonRpcRequest(id=1, method="generate_outreach_draft", params=params))
    assert response.error is None, response
    draft = threads.load(LOCAL_TENANT, "offer-thread").latest_draft
    assert draft.gate_results.passed is passed
    assert preflights == ["contact"] * 3
    assert draft.gate_results.source_context["binding"]["termsRevisionId"] == REVISION
    sources = draft.gate_results.source_context["sources"]
    assert sources[0]["source_id"] == "offer:" + REVISION
    assert json.loads(sources[0]["text"])["terms"]["decisionDeadline"] is None
    prompt, data = model.generated[0]
    assert "Never invent ROI" in prompt[0].content
    assert "unknown" in prompt[0].content
    assert any(row["source_id"] == "offer:" + REVISION for row in data["contact"])
    assert len(draft.gate_results.determination_ids) == 2
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 2
    conn.close()


@pytest.mark.parametrize("kind", ["offer_acceptance", "offer_decline"])
def test_decision_messages_require_current_matching_user_attestation(tmp_path, kind):
    conn, *_ = _setup(tmp_path)
    seed_terms(conn)
    with pytest.raises(DeterminationFailure, match="offer_decision_required"):
        load_offer_context(conn, "local", JOB, kind)
    decision = {
        "decisionId": "decision-1",
        "termsRevisionId": REVISION,
        "decision": "accepted" if kind == "offer_acceptance" else "declined",
    }
    conn.execute(
        "INSERT INTO job_events(tenant_id,job_id,identity_version,event_type,occurred_at,payload_json,entity_kind,entity_ref) VALUES ('local',?,1,'OfferRecordChanged',?,?,'offer',?)",
        (JOB, SOURCE["capturedAt"], json.dumps({"decision": decision}), JOB),
    )
    context = load_offer_context(conn, "local", JOB, kind)
    assert context["binding"]["decisionId"] == "decision-1"
    conn.close()


def test_foreign_tenant_job_and_revision_fail_before_model_use(tmp_path):
    conn, *_ = _setup(tmp_path)
    seed_terms(conn)
    for tenant, job, revision in [
        ("foreign", JOB, None),
        ("local", "00000000-0000-4000-8000-000000000002", None),
        ("local", JOB, "foreign"),
    ]:
        with pytest.raises(DeterminationFailure, match="offer_terms_changed_or_missing"):
            load_offer_context(conn, tenant, job, "offer_negotiation", revision)
    assert load_offer_context(conn, "local", JOB, "intro_request") is None
    assert OutreachDraftKind("offer_clarification").value == "offer_clarification"
    conn.close()


@pytest.mark.parametrize(
    "failure", [RuntimeError("Synthetic provider unavailable"), DeterminationFailure("budget_denied")]
)
def test_failed_refresh_keeps_last_approved_offer_message(tmp_path, monkeypatch, failure):
    model = OfferModel()
    conn, threads, params, _ = prepare(tmp_path, monkeypatch, model)
    generate_outreach_draft(params)
    thread = threads.load(LOCAL_TENANT, "offer-thread")
    thread = thread.approve_draft(thread.latest_draft.draft_id, approved_at=SOURCE["capturedAt"])
    threads.save(LOCAL_TENANT, thread)
    before = deepcopy(threads.load(LOCAL_TENANT, "offer-thread"))
    model.failure = failure
    with pytest.raises(Exception):
        generate_outreach_draft(params)
    assert threads.load(LOCAL_TENANT, "offer-thread") == before
    conn.close()


def test_offer_source_correction_during_model_call_fences_persistence(tmp_path, monkeypatch):
    model = OfferModel()
    conn, threads, params, _ = prepare(tmp_path, monkeypatch, model)
    original = model.chat_json

    def change_source(messages, **kwargs):
        result = original(messages, **kwargs)
        if kwargs["response_schema"]["title"] == "GeneratedProseDraft":
            seed_terms(conn, "00000000-0000-4000-8000-000000000102")
        return result

    model.chat_json = change_source
    with pytest.raises(DeterminationFailure, match="offer_sources_changed"):
        generate_outreach_draft(params)
    assert threads.load(LOCAL_TENANT, "offer-thread") is None
    conn.close()


def test_runtime_mismatch_stops_before_any_model_call(tmp_path, monkeypatch):
    model = OfferModel()
    conn, threads, params, _ = prepare(tmp_path, monkeypatch, model)
    params["expectedDbPath"] = str(tmp_path / "foreign.db")
    with pytest.raises(DeterminationFailure, match="offer_runtime_mismatch"):
        generate_outreach_draft(params)
    assert model.generated == [] and model.calls == []
    assert threads.load(LOCAL_TENANT, "offer-thread") is None
    conn.close()


def test_identical_edited_offer_reuses_both_recorded_determinations(tmp_path, monkeypatch):
    model = OfferModel()
    conn, threads, params, preflights = prepare(tmp_path, monkeypatch, model)
    generate_outreach_draft(params)
    edited = {**params, "editedBodyText": "Could we discuss the confirmed base salary?"}
    generate_outreach_draft(edited)
    before = (len(model.calls), len(preflights))
    generate_outreach_draft(edited)
    assert (len(model.calls), len(preflights)) == before
    assert len(threads.load(LOCAL_TENANT, "offer-thread").drafts) == 3
    conn.close()


def test_large_offer_provenance_is_structurally_bounded_and_unknowns_remain_explicit(tmp_path):
    from jobctrl.infrastructure.contact.offer_sources import context_sources

    conn, *_ = _setup(tmp_path)
    terms = seed_terms(conn)
    terms["terms"]["cash"] = [
        dict(component="other", amount=index, currency=None, period="unknown", source={**SOURCE, "quote": "q" * 8000})
        for index in range(20)
    ]
    conn.execute(
        "UPDATE job_events SET payload_json=? WHERE entity_kind='offer'", (json.dumps({"termsRevision": terms}),)
    )
    context = load_offer_context(conn, "local", JOB, "offer_negotiation")
    assert len(context_sources(context)) == 22
    assert all(len(source.text) <= 64000 for source in context_sources(context))
    assert json.loads(context["sources"][0]["text"])["terms"]["equity"] is None
    assert json.loads(context["sources"][0]["text"])["terms"]["cash"][0]["currency"] is None
    conn.close()


def test_posted_compensation_joins_its_canonical_receipt_and_keeps_offer_authority_separate(tmp_path):
    from jobctrl.domain.compensation.posted import ModelPostedPayExtractor
    from jobctrl.infrastructure.compensation.sqlite_repository import SqlitePostedCompensationRepository
    from tests.test_remaining_determinations import Model

    conn, *_ = _setup(tmp_path)
    seed_terms(conn)
    text = "Synthetic posting EUR 100000 110000 per year"
    conn.execute("UPDATE jobs SET salary=? WHERE tenant_id='local' AND job_id=?", (text, JOB))
    conn.commit()
    output = dict(
        parse_state="parsed_range",
        currency="EUR",
        period="year",
        component="base_salary",
        minimum_amount=100000,
        maximum_amount=110000,
        confidence="high",
        warnings=[],
        citations=[dict(source_id="posted_compensation_source", quote=text, exact_values=[])],
        rationale="Explicit synthetic model decision",
    )
    extractor = ModelPostedPayExtractor(
        llm=Model(output),
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="synthetic",
        model="synthetic",
        lane="compensation",
        preflight=lambda: None,
    )
    fact = SqlitePostedCompensationRepository(conn, extractor=extractor).parse_and_save_job_salary(JOB, text)
    context = load_offer_context(conn, "local", JOB, "offer_negotiation")
    posted = next(source for source in context["sources"] if source["source_id"].startswith("compensation:posted:"))
    saved = json.loads(posted["text"])
    assert saved["sourceText"] == text
    assert saved["determination"]["result"]["minimum_amount"] == fact.minimum_amount
    assert json.loads(context["sources"][0]["text"])["terms"]["cash"][0]["amount"] == 90000
    assert "not actual offer terms" in saved["label"]
    conn.close()


@pytest.mark.parametrize("fault", ["extra_field", "foreign_id", "non_verbatim"])
def test_invalid_offer_verification_has_no_fallback_and_preserves_approved(tmp_path, monkeypatch, fault):
    model = OfferModel()
    conn, threads, params, _ = prepare(tmp_path, monkeypatch, model)
    generate_outreach_draft(params)
    thread = threads.load(LOCAL_TENANT, "offer-thread")
    threads.save(LOCAL_TENANT, thread.approve_draft(thread.latest_draft.draft_id, approved_at=SOURCE["capturedAt"]))
    before = deepcopy(threads.load(LOCAL_TENANT, "offer-thread"))
    original = model.chat_json

    def invalid(messages, **kwargs):
        result = original(messages, **kwargs)
        if kwargs["response_schema"]["title"] == "ClaimVerification":
            if fault == "extra_field":
                result["unexpected"] = True
            else:
                citation = result["lines"][0]["served_requirements"][0]["citation"]
                citation["source_id" if fault == "foreign_id" else "quote"] = "foreign synthetic value"
        return result

    model.chat_json = invalid
    with pytest.raises(DeterminationFailure):
        generate_outreach_draft({**params, "editedBodyText": "A new synthetic clarification request."})
    assert threads.load(LOCAL_TENANT, "offer-thread") == before
    conn.close()
