"""Coaching authority, source binding, persistence and distinct failure states."""

import json
import sqlite3
from types import SimpleNamespace
import pytest
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.profile.required_bullet_coaching import coach_required_bullets
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.infrastructure.rpc import handlers
from jobctrl.llm_lanes import current_llm_lane

REFERENCE = "profile:v7:experience[0]:bullet[0]:required[0]"
TEXT = "Synthetic saved bullet 40%"
SOURCE = {
    "reference": REFERENCE,
    "originalText": TEXT,
    "experienceTitle": "Synthetic role",
    "experienceCompany": "Synthetic employer",
    "evidence": [],
}


class Model:
    def __init__(self, finding=False, failure=None):
        self.finding, self.failure, self.calls = finding, failure, []

    def chat_json(self, messages, **kwargs):
        assert current_llm_lane() == "profile"
        data = json.loads(messages[1].content)
        self.calls.append(data)
        if self.failure:
            raise self.failure
        citation = {"source_id": REFERENCE, "quote": TEXT, "exact_values": []}
        result = {
            "suggestions": [
                {
                    "reference": REFERENCE,
                    "kind": "missing_evidence",
                    "guidance": "Explicit model advice",
                    "proposedText": None,
                    "citations": [citation],
                }
            ]
            if self.finding
            else [],
            "citations": [citation],
            "rationale": "Explicit model judgment",
        }
        if self.finding == "extra":
            result["unexpected"] = True
        if self.finding == "enum":
            result["suggestions"][0]["kind"] = "unknown"
        if self.finding == "foreign":
            citation["source_id"] = "foreign"
        if self.finding == "quote":
            citation["quote"] = "Not in the saved source"
        if self.finding == "number":
            citation["exact_values"] = ["50%"]
        return result


def storage():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_exact_v14_schema(conn)
    return conn


def dependencies(conn, model, preflight=lambda: None):
    return dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="synthetic",
        model="synthetic",
        lane="profile",
        preflight=preflight,
    )


def invoke(conn, model, preflight=lambda: None):
    return coach_required_bullets(
        [SOURCE],
        maximum=12,
        profile_version=7,
        entity_id="profile:required_bullets",
        **dependencies(conn, model, preflight),
    )


def test_identical_source_follows_opposite_model_decisions_and_caches_receipts():
    for finding in [False, True]:
        conn, model = storage(), Model(finding)
        result, envelope = invoke(conn, model)
        assert bool(result.suggestions) == finding
        assert json.loads(model.calls[0]["sources"][0]["text"]) == SOURCE
        assert envelope.result == result.model_dump()
        assert envelope.prompt_version and envelope.model == "synthetic" and envelope.input_fingerprint
        assert invoke(conn, model)[1].determination_id == envelope.determination_id
        assert len(model.calls) == 1
        conn.close()


@pytest.mark.parametrize(
    "mode,code",
    [
        ("extra", "schema_violation"),
        ("enum", "schema_violation"),
        ("foreign", "foreign_source_id"),
        ("quote", "non_verbatim_quote"),
        ("number", "mismatched_value"),
    ],
)
def test_invalid_model_decisions_have_distinct_private_text_free_failures(mode, code):
    conn = storage()
    with pytest.raises(DeterminationFailure, match=code):
        invoke(conn, Model(mode))
    assert conn.execute("SELECT count(*) FROM semantic_determinations").fetchone()[0] == 0
    assert conn.execute("SELECT failure_code FROM semantic_stage_states").fetchone()[0] == code


@pytest.mark.parametrize(
    "failure,code",
    [
        (json.JSONDecodeError("PRIVATE", "", 0), "malformed_json"),
        (DeterminationFailure("provider_unavailable"), "provider_unavailable"),
    ],
)
def test_provider_failure_has_no_lexical_fallback(failure, code):
    with pytest.raises(DeterminationFailure, match=code) as error:
        invoke(storage(), Model(failure=failure))
    assert "PRIVATE" not in str(error.value)


def test_spend_admission_precedes_model_call():
    model = Model()

    def denied():
        assert current_llm_lane() == "profile"
        raise RuntimeError("PRIVATE")

    with pytest.raises(DeterminationFailure, match="budget_denied"):
        invoke(storage(), model, denied)
    assert model.calls == []


def runtime(monkeypatch, model):
    from jobctrl.infrastructure.profile import factory
    from jobctrl import database
    from jobctrl.infrastructure import determinations

    conn = storage()
    snapshot = SimpleNamespace(version=7)
    profile = {
        "experience_entries": [
            {
                "id": "exp",
                "title": SOURCE["experienceTitle"],
                "company": SOURCE["experienceCompany"],
                "bullets": [TEXT],
                "achievement_evidence": [],
            }
        ],
        "tailoring_rules": {"required_bullets_by_experience_id": {"exp": [TEXT]}},
    }
    repository = SimpleNamespace(load_saved_resume=lambda _: (snapshot.version, profile))
    monkeypatch.setattr(handlers, "assert_expected_runtime", lambda **_: None)
    monkeypatch.setattr(factory, "get_profile_repository", lambda: repository)
    monkeypatch.setattr(database, "init_db", lambda: conn)
    monkeypatch.setattr(
        determinations, "determination_dependencies", lambda connection, **kw: dependencies(connection, model)
    )
    return snapshot


def request():
    return dict(
        tenantId="local",
        expectedAppDir="/synthetic",
        expectedDbPath="/synthetic/owned.db",
        expectedProfileVersion=7,
        maximumSuggestions=12,
        sources=[dict(SOURCE)],
    )


def test_rpc_reads_only_canonical_sources_and_returns_persisted_proof(monkeypatch):
    model = Model(True)
    runtime(monkeypatch, model)
    result = handlers.profile_required_bullet_suggestions(request())
    assert result["profileVersion"] == 7
    assert result["determination"]["kind"] == "required_bullet_coaching"
    assert result["suggestions"][0]["citations"][0]["source_id"] == REFERENCE
    assert len(model.calls) == 1


@pytest.mark.parametrize("change", ["text", "version", "reference", "evidence"])
def test_rpc_rejects_forged_or_stale_sources_before_a_model_call(monkeypatch, change):
    model = Model()
    runtime(monkeypatch, model)
    params = request()
    if change == "version":
        params["expectedProfileVersion"] = 8
    else:
        params["sources"][0][{"text": "originalText", "reference": "reference", "evidence": "evidence"}[change]] = (
            [] if change == "evidence" else "Forged input"
        )
    if change == "evidence":
        params["sources"][0]["evidence"] = [{"outcome": "Foreign proof"}]
    with pytest.raises(Exception):
        handlers.profile_required_bullet_suggestions(params)
    assert model.calls == []


def test_rpc_fences_a_concurrent_profile_save(monkeypatch):
    model = Model()
    snapshot = runtime(monkeypatch, model)
    chat = model.chat_json

    def concurrently(*args, **kwargs):
        result = chat(*args, **kwargs)
        snapshot.version = 8
        return result

    model.chat_json = concurrently
    with pytest.raises(Exception, match="stale_profile_version"):
        handlers.profile_required_bullet_suggestions(request())
