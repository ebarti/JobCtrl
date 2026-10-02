"""Hand-authored embedded requests and selected-source boundary controls."""

from copy import deepcopy
from pathlib import Path

import pytest

from jobctrl.database import close_connection
from jobctrl.domain.interview.use_cases import GenerateInterviewPrepUseCase
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from tests.test_interview_prep_generation import JOB_ID, _FakeLlm, _init_conn, _judge_pass
from tests.test_interview_real_provider_framing import _candidate, _request
from tests.test_interview_prose_classifier import test_same_proposition_meaning_in_every_nonfactual_location as assert_proposition


EMBEDDED_CASES = [
    ("planned_slot", "I would explain what I deliberately stopped investigating and why.", True),
    ("planned_slots", "I would walk through one decision: the objective, what I knew at the time, and what I later learned.", True),
    ("planned_future_slot", "I would explain how I would use Kubernetes with a hypothetical $2 million budget.", True),
    ("planned_scenario_slot", "I would describe what I would do if I managed 50 engineers.", True),
    ("planned_reflection", "I would test assumptions, while being honest about whether I am rationalizing after the fact.", True),
    ("future_reflection", "How would you recognize that you were rationalizing after seeing the result?", True),
    ("embedded_subject_condition", "I would name responsibilities that would suffer if I became a critical-path implementer.", True),
    ("embedded_owner_condition", "I would monitor involvement: if my review becomes the critical path, I would redistribute it.", True),
    ("open_input", "Is there a technical decision you want to ground this answer in?", True),
    ("future_input", "The evidence list must stay empty until you confirm what to attach.", True),
    ("question_insertion", "What later evidence, if any, changed your view of that decision?", True),
    ("target_role_expectation", "What technical involvement does the Director of Platform Engineering role at Acme expect?", True),
    ("slot_metric", "I would explain how I saved $2 million.", False),
    ("slot_tool", "I would describe how I used Kubernetes.", False),
    ("slot_employer", "I would describe what I achieved at Acme.", False),
    ("slot_authority", "I would describe how I served as a Director at Acme.", False),
    ("slot_prior_premise", "I would explain what my prior role as Director at Acme taught me.", False),
    ("slot_independent_assertion", "I would explain what I learned, but I improved incident coordination.", False),
    ("slot_independent_colon", "I would explain a decision: I improved incident coordination.", False),
    ("condition_independent_assertion", "If my review becomes the critical path: I improved incident coordination.", False),
    ("open_independent_assertion", "Is there a technical decision you want to discuss? I improved incident coordination.", False),
    ("input_prior_premise", "The list stays empty until you confirm your prior role as Director at Acme.", False),
    ("target_role_biography", "What does the Director role require? I worked as Director at Acme.", False),
]


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("name,phrase,accepted", EMBEDDED_CASES)
def test_embedded_operator_has_local_scope(tmp_path: Path, name, phrase, accepted, location, support):
    assert_proposition(tmp_path, name, phrase, accepted, location, support)


@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("selected", [True, False])
def test_planned_concrete_account_requires_its_question_source(tmp_path: Path, location, selected):
    conn = _init_conn(tmp_path)
    try:
        request = _request("B11" if selected else "M02")
        repository = SqliteInterviewPrepRepository(conn)
        question_id = request["selection_input"]["selectedQuestionIds"][0]
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(question_id), _judge_pass()])).execute(
            origin_run_id="prior", **request).prep
        candidate = _candidate(question_id)
        item = candidate["items"][0]
        phrase = "I would describe how I reduced API latency by 30% using Python."
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "probe":
            item["probes"] = [phrase]
        else:
            item["gaps"][0]["prompt" if location == "gap" else "reason"] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        result = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="account", **request)
        assert result.status == ("accepted" if selected else "failed"), result.errors
        assert len(llm.calls) == (2 if selected else 1)
        if not selected:
            assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == prior.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


def test_model_receives_section_proof_relationship_before_generation(tmp_path: Path):
    conn = _init_conn(tmp_path)
    try:
        llm = _FakeLlm([_candidate("M02"), _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=SqliteInterviewPrepRepository(conn), llm=llm).execute(**_request("M02"))
        assert outcome.status == "accepted"
        first = llm.calls[0]
        prompt = first["messages"][1].content
        assert "hypothetical or needs_clarification => evidence_ids=[] without exception" in prompt
        assert "evidence_ids means accepted personal proof, never a contextual citation" in prompt
        assert "separate factual anchor" in prompt
        section = first["response_schema"]["properties"]["items"]["items"]["properties"]["outline"]["items"]["properties"]
        assert "hypothetical and needs_clarification MUST use []" in section["evidence_ids"]["description"]
        assert "requires evidence_ids=[]" in section["factual_support"]["description"]
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
def test_nonfactual_source_reference_is_rejected_without_relabeling(tmp_path: Path, support):
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        request = _request("B11")
        candidate = _candidate("B11")
        candidate["items"][0]["outline"].insert(0, {"heading": "Canonical anchor", "text": "Reduced API latency by 30% using Python.",
                                                   "evidence_ids": ["ev-platform-latency"], "factual_support": "accepted_profile_fact"})
        candidate["items"][0]["outline"][1]["text"] = "I would describe how I reduced API latency by 30% using Python."
        accepted = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([candidate, _judge_pass()])).execute(
            origin_run_id="compliant-anchor", **request).prep
        assert accepted.status == "accepted"
        assert accepted.generation_context["model"]["promptVersion"] == "interview-questions-v4"
        assert accepted.generation_context["model"]["gateVersion"] == "interview-question-grounding-v13"
        invalid = deepcopy(candidate)
        invalid["items"][0]["outline"][1].update(evidence_ids=["ev-platform-latency"], factual_support=support)
        original = deepcopy(invalid)
        llm = _FakeLlm([invalid, _judge_pass()])
        result = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="invalid-ref", **request)
        assert result.status == "failed"
        assert "nonfactual outline cannot claim accepted evidence support" in result.errors[0]
        assert len(llm.calls) == 1
        assert invalid == original
        assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == accepted.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")
