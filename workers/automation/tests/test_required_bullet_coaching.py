from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from jobctrl.domain.profile.required_bullet_coaching import coach_required_bullets
from jobctrl.infrastructure.rpc import handlers
from jobctrl.llm_lanes import current_llm_lane

REFERENCE = "profile:v7:experience[0]:bullet[0]:required[0]"
TEXT = "Worked on the payments API, cutting p99 latency 40%"
SOURCE = {"reference": REFERENCE, "originalText": TEXT,
          "experienceTitle": "Synthetic Engineer", "experienceCompany": "Synthetic Co", "evidence": []}


class Model:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def chat_json(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def test_model_decides_findings_from_exact_claim_and_evidence():
    finding = {"reference": REFERENCE, "kind": "missing_evidence",
               "guidance": "Which saved latency trace supports the 40% p99 change?", "proposedText": None}
    model = Model({"suggestions": [finding]})
    assert coach_required_bullets([SOURCE], llm=model, maximum=12) == {"suggestions": [finding]}
    assert len(model.calls) == 1
    messages, kwargs = model.calls[0]
    assert json.loads(messages[1].content)["sources"] == [SOURCE]
    assert kwargs["response_schema"]["additionalProperties"] is False
    model.response = {"suggestions": []}
    assert coach_required_bullets([SOURCE], llm=model, maximum=12) == {"suggestions": []}


@pytest.mark.parametrize("response", [
    OSError("Provider unavailable"),
    {"suggestions": [{"reference": "invented", "kind": "grammar", "guidance": "Spacing.", "proposedText": None}]},
    {"suggestions": [{"reference": REFERENCE, "kind": "grammar", "guidance": "Spacing.", "proposedText": None, "sourceId": "Invented source"}]},
    {"suggestions": [{"reference": REFERENCE, "kind": "grammar", "guidance": " ", "proposedText": None}]},
    {"suggestions": [{"reference": REFERENCE, "kind": "grammar", "guidance": "Spacing.", "proposedText": None}] * 2},
])
def test_failure_propagates_without_heuristic_fallback(response):
    model = Model(response)
    with pytest.raises((OSError, ValueError)):
        coach_required_bullets([SOURCE], llm=model, maximum=12)
    assert len(model.calls) == 1


def runtime(monkeypatch, model):
    from jobctrl.infrastructure.profile import factory
    from jobctrl.infrastructure.llm import llm_client
    from jobctrl import llm
    profile = {"resume": {"experience_entries": [{"id": "exp-1", "title": SOURCE["experienceTitle"],
        "company": SOURCE["experienceCompany"], "bullets": [TEXT], "achievement_evidence": []}],
        "tailoring_rules": {"required_bullets_by_experience_id": {"exp-1": [TEXT]}}}}
    snapshot = SimpleNamespace(version=7, as_dict=lambda: profile)
    repository = SimpleNamespace(load_snapshot=lambda _: snapshot)
    monkeypatch.setattr(handlers, "assert_expected_runtime", lambda **_: None)
    monkeypatch.setattr(factory, "get_profile_repository", lambda: repository)
    monkeypatch.setattr(llm_client, "get_llm_adapter", lambda: model)
    admissions = []
    monkeypatch.setattr(llm, "enforce_spend_budget", lambda **kw: admissions.append((kw, current_llm_lane())))
    return snapshot, admissions


def params():
    return {"tenantId": "local", "expectedAppDir": "/synthetic", "expectedDbPath": "/synthetic/jobctrl.db",
            "expectedProfileVersion": 7, "maximumSuggestions": 12, "sources": [dict(SOURCE)]}


def test_rpc_checks_canonical_sources_and_calls_configured_model_in_profile_lane(monkeypatch):
    model = Model({"suggestions": []})
    _, admissions = runtime(monkeypatch, model)
    assert handlers.profile_required_bullet_suggestions(params()) == {"profileVersion": 7, "suggestions": []}
    assert len(model.calls) == 1
    assert admissions == [({"lane": "profile"}, "profile")]


@pytest.mark.parametrize("change", ["text", "version", "reference", "evidence"])
def test_rpc_rejects_forged_or_stale_sources_before_model_call(monkeypatch, change):
    model = Model({"suggestions": []})
    _, admissions = runtime(monkeypatch, model)
    request = params()
    if change == "version":
        request["expectedProfileVersion"] = 8
    elif change == "text":
        request["sources"][0]["originalText"] = "Forged claim"
    elif change == "reference":
        request["sources"][0]["reference"] = "profile:v7:experience[0]:bullet[9]:required[0]"
    else:
        request["sources"][0]["evidence"] = [{"outcome": "Invented proof"}]
    with pytest.raises(Exception):
        handlers.profile_required_bullet_suggestions(request)
    assert model.calls == []
    assert admissions == []


def test_rpc_rechecks_saved_version_after_the_model_call(monkeypatch):
    model = Model({"suggestions": []})
    snapshot, _ = runtime(monkeypatch, model)
    original = model.chat_json

    def concurrent_save(*args, **kwargs):
        result = original(*args, **kwargs)
        snapshot.version = 8
        return result

    monkeypatch.setattr(model, "chat_json", concurrent_save)
    with pytest.raises(Exception, match="stale_profile_version"):
        handlers.profile_required_bullet_suggestions(params())
    assert len(model.calls) == 1


def test_registered_rpc_reads_real_canonical_repository_without_profile_writes(monkeypatch, tmp_path):
    from jobctrl.domain.profile.aggregate import Profile
    from jobctrl.domain.rpc.messages import JsonRpcRequest
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
    from jobctrl.infrastructure.profile.factory import build_profile_repository
    from jobctrl.infrastructure.profile import factory
    from jobctrl.infrastructure.rpc.server import JsonRpcServer

    model = Model({"suggestions": []})
    runtime(monkeypatch, model)
    raw = {"personal": {"full_name": "Synthetic Candidate", "email": "synthetic@example.test"},
           "resume": {"executive_profile": {"baseline_text": "Synthetic engineer."},
           "experience_entries": [{"id": "exp-1", "title": "Synthetic Engineer", "company": "Synthetic Co",
           "bullets": [TEXT], "achievement_evidence": [{"id": "qa-evidence", "source_text": TEXT,
           "action": "Changed synthetic API caching", "metrics": ["40%"], "outcome": "Reduced synthetic p99 latency",
           "evidence_strength": "supported", "user_confirmed": True}]}],
           "education_entries": [], "skill_categories": [],
           "tailoring_rules": {"required_bullets_by_experience_id": {"exp-1": [TEXT]}}}}
    repository = build_profile_repository(db_path=tmp_path / "jobctrl.db", publisher=InProcessEventBus())
    saved = repository.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, raw))
    monkeypatch.setattr(factory, "get_profile_repository", lambda: repository)
    profile = saved.as_dict()
    evidence = profile["resume"]["experience_entries"][0]["achievement_evidence"][0]
    request = params()
    request["expectedProfileVersion"] = saved.version
    request["sources"][0]["reference"] = f"profile:v{saved.version}:experience[0]:bullet[0]:required[0]"
    request["sources"][0]["evidence"] = [{key: evidence[key] for key in (
        "id", "source_text", "metrics", "outcome", "evidence_strength", "user_confirmed")}]
    server = JsonRpcServer()
    handlers.register_default_handlers(server, canceler=lambda *_args, **_kwargs: None)
    response = server.dispatch(JsonRpcRequest(id=1, method="profile_required_bullet_suggestions", params=request))
    assert response.error is None
    assert response.result == {"profileVersion": saved.version, "suggestions": []}
    assert len(model.calls) == 1
    assert json.loads(model.calls[0][0][1].content)["sources"][0]["evidence"][0] == request["sources"][0]["evidence"][0]
    after = repository.load_snapshot(LOCAL_TENANT)
    assert after.version == saved.version
    assert after.as_dict() == profile
