"""Authority, source binding and version fences for interactive determinations."""

from __future__ import annotations

import copy
import json

import pytest

from jobctrl.domain.apply.form_mapping import FormQuestion, ModelFormMapper
from jobctrl.domain.determinations import DeterminationFailure, Source
from jobctrl.domain.materials.edit_intent import ModelEditIntent
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.apply.form_mapping import map_saved_profile_form
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.materials.employer_analysis_repository import SqliteEmployerAnalysisRepository
from jobctrl.infrastructure.materials.user_edit_review import review_saved_edit_intent, review_saved_resume_edit
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.llm_lanes import current_llm_lane
from tests.test_artifact_determinations import JOB_ID, PROFILE, Model, connection, seed_resume
from tests.test_materials_use_cases import request


QUESTION = {
    "question_id": "question:1",
    "descriptor": "Synthetic employer question",
    "control_type": "text",
    "options": [],
}


class InteractiveModel(Model):
    def __init__(self, *, decision="mapped", intent="style_preference", mutate=None, after_call=None, **kwargs):
        super().__init__(**kwargs)
        self.decision, self.intent, self.mutate, self.after_call = decision, intent, mutate, after_call

    def chat_json(self, messages, *, response_schema, **kwargs):
        title = response_schema["title"]
        if title not in {"FormMappings", "EditIntents"}:
            result = super().chat_json(messages, response_schema=response_schema, **kwargs)
        else:
            self.calls.append((title, current_llm_lane(), messages))
            data = json.loads(messages[1].content)
            if title == "FormMappings":
                fact = data["sources"][1]
                question = json.loads(data["sources"][0]["text"])
                mapped = self.decision == "mapped"
                choice = question["control_type"] != "text"
                result = {
                    "mappings": [
                        {
                            "question_id": question["question_id"],
                            "decision": self.decision,
                            "fact_id": fact["source_id"] if mapped else None,
                            "value": fact["text"] if mapped and not choice else "",
                            "option_id": question["options"][0]["option_id"] if mapped and choice else None,
                            "citations": [{"source_id": question["question_id"], "quote": question["descriptor"]}]
                            + ([{"source_id": fact["source_id"], "quote": fact["text"]}] if mapped else []),
                            "rationale": "Explicit model mapping decision",
                        }
                    ]
                }
            else:
                result = {
                    "edits": [
                        {
                            "edit_id": row["source_id"],
                            "kind": self.intent,
                            "citations": [{"source_id": row["source_id"], "quote": row["text"]}],
                            "rationale": "Explicit model intent decision",
                        }
                        for row in data["sources"]
                    ]
                }
            if self.mutate:
                self.mutate(result, data)
        if self.after_call:
            callback, self.after_call = self.after_call, None
            callback()
        return result


def dependencies(conn, model, *, lane="tailoring", preflight=lambda: None):
    return dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="interactive",
        lane=lane,
        preflight=preflight,
    )


def map_question(conn, model, *, question=None, preflight=lambda: None):
    return ModelFormMapper(**dependencies(conn, model, lane="apply", preflight=preflight)).map(
        entity_id="owned-form",
        questions=[FormQuestion.model_validate(question or QUESTION)],
        facts=[Source(source_id="fact:1", text="Synthetic saved answer 42")],
        page_url="https://example.test/owned",
        profile_version=1,
    )


@pytest.mark.parametrize("decision", ["mapped", "missing", "unmapped"])
def test_form_model_decision_is_authority_for_the_same_question(decision):
    conn, model = connection(), InteractiveModel(decision=decision)
    result, envelope = map_question(conn, model)
    assert result.mappings[0].decision == decision
    assert SqliteDeterminationRepository(conn).find("local", envelope.determination_id).result == result.model_dump()
    assert model.calls[0][1] == "apply"
    sources = json.loads(model.calls[0][2][1].content)["sources"]
    assert {row["source_id"] for row in sources} == {"question:1", "fact:1"}


@pytest.mark.parametrize(
    "fault,expected",
    [
        ("foreign_fact", "foreign_fact_id"),
        ("foreign_option", "foreign_option_id"),
        ("missing_question", "missing_question_citation"),
        ("non_verbatim", "non_verbatim_quote"),
        ("mismatched_value", "mismatched_value"),
        ("foreign_question", "foreign_or_missing_question_id"),
    ],
)
def test_form_binding_rejects_invalid_model_output(fault, expected):
    def mutate(result, _data):
        row = result["mappings"][0]
        if fault == "foreign_fact":
            row["fact_id"] = "not-supplied"
            row["citations"] = row["citations"][:1]
        elif fault == "foreign_option":
            row["option_id"] = "not-supplied"
        elif fault == "missing_question":
            row["citations"] = row["citations"][1:]
        elif fault == "non_verbatim":
            row["citations"][1]["quote"] = "Never supplied source"
        elif fault == "mismatched_value":
            row["value"] = "99"
        else:
            row["question_id"] = "not-supplied"

    question = copy.deepcopy(QUESTION)
    if fault == "foreign_option":
        question.update(control_type="select", options=[{"option_id": "native-option", "label": "Native label"}])
    conn = connection()
    with pytest.raises(DeterminationFailure, match=expected):
        map_question(conn, InteractiveModel(mutate=mutate), question=question)
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 0


def interpret_edits(conn, model, *, preflight=lambda: None):
    return ModelEditIntent(**dependencies(conn, model, preflight=preflight)).interpret(
        entity_id="owned-revision",
        sources=[Source(source_id="edit:1", text="Synthetic before and after")],
    )


@pytest.mark.parametrize(
    "intent", ["factual_correction", "style_preference", "claim_policy_correction", "provenance_dispute"]
)
def test_edit_intent_model_decision_is_authority_for_the_same_edit(intent):
    conn, model = connection(), InteractiveModel(intent=intent)
    result, envelope = interpret_edits(conn, model)
    assert result.edits[0].kind == intent
    assert envelope.result == result.model_dump()
    assert model.calls[0][1] == "tailoring"


@pytest.mark.parametrize(
    "fault,expected",
    [
        ("foreign_edit", "foreign_or_missing_edit_id"),
        ("foreign_citation", "foreign_source_id"),
        ("non_verbatim", "non_verbatim_quote"),
        ("mismatched_value", "mismatched_value"),
    ],
)
def test_edit_intent_citations_are_mechanical_and_cannot_be_invented(fault, expected):
    def mutate(result, _data):
        row = result["edits"][0]
        if fault == "foreign_edit":
            row["edit_id"] = "not-supplied"
        elif fault == "foreign_citation":
            row["citations"][0]["source_id"] = "not-supplied"
        elif fault == "non_verbatim":
            row["citations"][0]["quote"] = "Never supplied source"
        else:
            row["citations"][0]["exact_values"] = ["99"]

    conn = connection()
    with pytest.raises(DeterminationFailure, match=expected):
        interpret_edits(conn, InteractiveModel(mutate=mutate))
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 0


@pytest.mark.parametrize("call", [map_question, interpret_edits])
@pytest.mark.parametrize("failure", ["provider_unavailable", "budget_denied"])
def test_interactive_failures_have_distinct_status_and_no_fallback(call, failure):
    conn, model = connection(), InteractiveModel()

    def denied():
        raise RuntimeError("private budget metadata")

    with pytest.raises(DeterminationFailure, match=failure):
        call(
            conn,
            None if failure == "provider_unavailable" else model,
            preflight=denied if failure == "budget_denied" else lambda: None,
        )
    assert model.calls == []
    assert conn.execute("SELECT failure_code FROM semantic_stage_states").fetchone()[0] == failure


def save_profile(conn):
    publisher = type("Publisher", (), {"publish": lambda *_: None})()
    repository = SqliteProfileRepository(conn, publisher=publisher)
    snapshot = repository.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, PROFILE))
    conn.commit()
    return repository, snapshot


def saved_mapping(conn, model, version):
    return map_saved_profile_form(
        conn,
        tenant_id="local",
        snapshot_id="owned-snapshot",
        page_url="https://example.test/owned",
        questions=[QUESTION],
        expected_profile_version=version,
        dependencies=dependencies(conn, model, lane="apply"),
    )


def test_saved_form_uses_actual_profile_and_records_its_version():
    conn, model = connection(), InteractiveModel()
    _, snapshot = save_profile(conn)
    mapped = saved_mapping(conn, model, snapshot.version)
    assert mapped["mappings"][0]["fact_id"] == "personal.full_name"
    assert mapped["mappings"][0]["value"] == "Synthetic Person"
    assert mapped["profileVersion"] == snapshot.version
    binding = conn.execute(
        "SELECT entity_version,determination_id FROM semantic_entity_bindings WHERE entity_kind='form'"
    ).fetchone()
    assert tuple(binding) == (str(snapshot.version), mapped["determinationId"])


@pytest.mark.parametrize("changed_during_call", [False, True])
def test_saved_form_fences_stale_profile_before_and_after_the_model(changed_during_call):
    conn = connection()
    repository, snapshot = save_profile(conn)

    def change():
        repository.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, PROFILE))

    model = InteractiveModel(after_call=change if changed_during_call else None)
    if not changed_during_call:
        change()
    with pytest.raises(DeterminationFailure, match="stale_profile_version"):
        saved_mapping(conn, model, snapshot.version)
    assert len(model.calls) == int(changed_during_call)
    assert conn.execute("SELECT COUNT(*) FROM semantic_entity_bindings WHERE entity_kind='form'").fetchone()[0] == 0


def saved_edit(conn, tmp_path):
    repository, snapshot = save_profile(conn)
    seed_resume(conn, tmp_path)
    SqliteEmployerAnalysisRepository(conn).save(request(tmp_path)["employer_analysis"])
    conn.execute(
        "INSERT INTO resume_review_drafts (tenant_id,draft_id,job_id,base_generation,current_revision_id,latest_revision_number,created_at,updated_at) VALUES ('local','draft',?,1,'revision',1,'2026-10-07','2026-10-07')",
        (str(JOB_ID),),
    )
    conn.execute(
        "INSERT INTO resume_review_draft_revisions (tenant_id,revision_id,draft_id,job_id,revision_number,edited_text,created_at) VALUES ('local','revision','draft',?,1,'Synthetic edited resume','2026-10-07')",
        (str(JOB_ID),),
    )
    conn.execute(
        "INSERT INTO resume_review_edit_deltas (tenant_id,delta_id,revision_id,draft_id,job_id,kind,before_text,after_text,created_at) VALUES ('local','delta','revision','draft',?,'changed','Synthetic original','Synthetic edited resume','2026-10-07')",
        (str(JOB_ID),),
    )
    conn.commit()
    return repository, snapshot


@pytest.mark.parametrize("intent", ["factual_correction", "style_preference"])
def test_saved_edit_intent_records_the_model_choice_by_revision(tmp_path, intent):
    conn, model = connection(), InteractiveModel(intent=intent)
    saved_edit(conn, tmp_path)
    result = review_saved_edit_intent(
        conn, tenant_id="local", draft_id="draft", revision_id="revision", dependencies=dependencies(conn, model)
    )
    envelope = SqliteDeterminationRepository(conn).find("local", result["editIntentId"])
    assert envelope.entity_id == "revision"
    assert envelope.result["edits"][0]["kind"] == intent
    assert (
        conn.execute(
            "SELECT entity_version FROM semantic_entity_bindings WHERE determination_kind='edit_intent'"
        ).fetchone()[0]
        == result["textFingerprint"]
    )


@pytest.mark.parametrize("verdict", ["pass", "fail"])
def test_actual_saved_resume_review_uses_both_verdicts_and_preserves_accepted_content(tmp_path, verdict):
    conn, model = connection(), InteractiveModel(verdict=verdict)
    saved_edit(conn, tmp_path)
    before = conn.execute("SELECT artifact_id,path FROM job_materials_artifacts ORDER BY artifact_type").fetchall()
    result = review_saved_resume_edit(
        conn, tenant_id="local", draft_id="draft", revision_id="revision", dependencies=dependencies(conn, model)
    )
    assert result["passed"] is (verdict == "pass")
    assert {kind for kind, _, _ in model.calls} == {"ClaimVerification", "ArtifactQuality", "EditIntents"}
    assert result["anchors"][0]["lineId"] == "edited:line:1"
    assert (
        conn.execute("SELECT artifact_id,path FROM job_materials_artifacts ORDER BY artifact_type").fetchall() == before
    )
    assert (tmp_path / "owned-resume.txt").read_text() == "Owned synthetic accepted artifact"
    for name in ("claimVerificationId", "qualityDeterminationId", "editIntentId"):
        assert SqliteDeterminationRepository(conn).find("local", result[name]).entity_id == "revision"


@pytest.mark.parametrize("review", [review_saved_edit_intent, review_saved_resume_edit])
def test_saved_edit_revision_fence_rejects_a_change_during_model_call(tmp_path, review):
    conn = connection()
    saved_edit(conn, tmp_path)
    model = InteractiveModel(
        after_call=lambda: conn.execute("UPDATE resume_review_drafts SET current_revision_id='newer-revision'")
    )
    with pytest.raises(DeterminationFailure, match="stale_draft_revision"):
        review(
            conn, tenant_id="local", draft_id="draft", revision_id="revision", dependencies=dependencies(conn, model)
        )
    assert (
        conn.execute("SELECT COUNT(*) FROM semantic_entity_bindings WHERE entity_kind='resume_revision'").fetchone()[0]
        == 0
    )


def test_saved_resume_review_fences_profile_changes_before_binding(tmp_path):
    conn = connection()
    repository, _ = saved_edit(conn, tmp_path)
    model = InteractiveModel(after_call=lambda: repository.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, PROFILE)))
    with pytest.raises(DeterminationFailure, match="stale_profile_version"):
        review_saved_resume_edit(
            conn, tenant_id="local", draft_id="draft", revision_id="revision", dependencies=dependencies(conn, model)
        )
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM semantic_entity_bindings WHERE determination_kind IN ('claim_verification','artifact_quality')"
        ).fetchone()[0]
        == 0
    )


def test_saved_resume_review_fences_changed_employer_analysis(tmp_path):
    from dataclasses import replace

    conn = connection()
    saved_edit(conn, tmp_path)
    analysis = request(tmp_path)["employer_analysis"]
    model = InteractiveModel(after_call=lambda: SqliteEmployerAnalysisRepository(conn).save(replace(analysis, generation=2)))
    with pytest.raises(DeterminationFailure, match="stale_analysis_generation"):
        review_saved_resume_edit(conn, tenant_id="local", draft_id="draft", revision_id="revision", dependencies=dependencies(conn, model))
    assert conn.execute("SELECT COUNT(*) FROM semantic_entity_bindings WHERE determination_kind IN ('claim_verification','artifact_quality')").fetchone()[0] == 0
