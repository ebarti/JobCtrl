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
from tests.test_interview_prose_classifier import (
    test_actual_heading_claim_requires_its_own_selected_source as assert_actual_heading,
    test_same_proposition_meaning_in_every_nonfactual_location as assert_proposition,
)


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
    ("reduced_if_metric", "I would review options if needed but I saved $2 million using Kubernetes.", False),
    ("reduced_if_role", "I would review options if needed but I actually served as Director at Acme.", False),
    ("reduced_if_history", "I would review options if needed but I rescued every critical launch.", False),
    ("reduced_if_and_history", "I would review options if appropriate and I rescued every critical launch.", False),
    ("modified_reduced_if", "I would review options if absolutely necessary but I rescued every critical launch.", False),
    ("generic_reduced_if", "I would review options if practical but I saved $2 million using Kubernetes.", False),
    ("generic_modified_reduced_if", "I would review options if politically prudent but I actually served as Director at Acme.", False),
    ("adjunct_reduced_if", "I would review options if needed for the design but I rescued every critical launch.", False),
    ("reduced_if_implicit_history", "I would review options if needed but rescued every critical launch.", False),
    ("reduced_if_implicit_metric", "I would review options if needed and saved $2 million using Kubernetes.", False),
    ("independent_future", "I would review options if needed but I would compare criteria before committing.", True),
    ("modified_independent_future", "I would review options if needed but I actually would compare criteria before committing.", True),
    ("implicit_future", "I would review options if needed and compare criteria before committing.", True),
    ("full_conditional_contrast", "If you managed a team but you had limited authority, how would you compare criteria?", True),
    ("full_conditional_coordination", "If you and your hypothetical team managed 50 engineers, how would you compare criteria?", True),
    ("nominal_conditional_coordination", "If workload increased and you managed 50 engineers, how would you compare criteria?", True),
    ("personal_conditional_assumption", "If I saved $2 million using Kubernetes, I would compare criteria.", True),
    ("nested_conditional_assumption", "I would monitor whether a review is needed and step back if my review becomes the critical path.", True),
    ("full_embedded_conditional_assumptions", "I would review options if I managed 50 engineers and I had limited authority.", True),
    ("full_embedded_actual_metric", "I would review options if I managed a team but I actually saved $2 million using Kubernetes.", False),
    ("full_embedded_actual_role", "I would review options if I managed a team but I previously served as Director at Acme.", False),
    ("full_embedded_actual_history", "I would review options if I managed a team but I actually rescued every critical launch.", False),
    ("fronted_actual_hypothesis", "If I actually saved $2 million using Kubernetes, I would compare criteria.", True),
    ("embedded_actual_assumption", "I would review options if I actually managed 50 engineers and I had limited authority.", True),
]


ACTUALITY_BINDING_CASES = [
    (f"I would review options if I managed a team but {clause}.", False)
    for past, base, participle in [
        ("saved $2 million using Kubernetes", "save $2 million using Kubernetes", "saved $2 million using Kubernetes"),
        ("served as Director at Acme", "serve as Director at Acme", "served as Director at Acme"),
        ("rescued every critical launch", "rescue every critical launch", "rescued every critical launch"),
    ]
    for clause in [f"in reality I {past}", f"I did in fact {base}", f"I have in fact {participle}", f"in fact I {past}"]
] + [
    ("I would review options if I managed a team but in reality I would compare criteria.", True),
    ("I would review options if I managed a team but I in reality would compare criteria.", True),
    ("I would review options if I managed a team but I in fact would compare criteria.", True),
    ("I would review options if I managed a team but I actually would compare criteria.", True),
    ("I would review options if I managed a team but in reality I would compare criteria and I rescued every critical launch.", False),
    ("I would review options if I managed a team but I in fact would compare criteria and rescued every critical launch.", False),
    ("If in reality I saved $2 million using Kubernetes, I would compare criteria.", True),
    ("If I did in fact save $2 million using Kubernetes, I would compare criteria.", True),
    ("If I have in fact served as Director at Acme, I would compare criteria.", True),
    ("I would review options if in reality I managed 50 engineers and I had limited authority.", True),
    ("I would review options if I did in fact manage 50 engineers and I had limited authority.", True),
    ("If I managed 50 engineers but in reality I had limited authority, I would compare criteria.", True),
    ("I would compare criteria: If I managed 50 engineers but in reality I had limited authority, I would delegate coaching.", True),
    ("I would compare criteria. If I managed 50 engineers but in reality I had limited authority, I would delegate coaching.", True),
    ("If I would compare criteria if I managed 50 engineers but I did in fact have limited authority, I would delegate coaching.", True),
    ("I would review options if I managed a team but did in fact rescue every critical launch.", False),
    ("I would review options if I managed a team but in fact would compare criteria and I rescued every critical launch.", False),
    ("I would review options if I managed a team but in fact would compare criteria.", True),
    ("If I managed a team but did in fact rescue every critical launch, I would compare criteria.", True),
    ("I would review options if I managed 50 engineers and I had limited authority.", True),
    ("I would review options if I managed 50 engineers but I had limited authority.", True),
]


WHOLE_PREDICATE_CASES = [
    (f"I would review options if I managed a team but {predicate}.", False)
    for verb, rest in [("saved", "$2 million using Kubernetes"), ("served", "as Director at Acme"),
                       ("rescued", "every critical launch")]
    for predicate in [f"I {verb} in reality {rest}", f"I {verb} {rest} in reality", f"I {verb} {rest}, in fact",
                      f"{verb} {rest} in reality"]
] + [
    ("If I saved in reality $2 million using Kubernetes, I would compare criteria.", True),
    ("If I served as Director at Acme in reality, I would compare criteria.", True),
    ("If I rescued every critical launch, in fact, I would compare criteria.", True),
    ("I would compare criteria if I saved $2 million using Kubernetes in reality and I had limited authority.", True),
    ("I would review options if I managed a team but I would save in reality $2 million using Kubernetes.", True),
    ("I would review options if I managed a team but I would serve as Director at Acme in reality.", True),
    ("I would review options if I managed a team but I would rescue every critical launch, in fact.", True),
    ("If I managed a team but served as Director at Acme in reality, I would compare criteria.", True),
    ("I would review options if I managed a team but I referred to \"in reality\" as a phrase.", True),
    ("I rescued every critical launch if in reality I had limited authority.", False),
]


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("name,phrase,accepted", EMBEDDED_CASES)
def test_embedded_operator_has_local_scope(tmp_path: Path, name, phrase, accepted, location, support):
    assert_proposition(tmp_path, name, phrase, accepted, location, support)


@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("phrase,accepted", [
    ("I would review options if I managed 50 engineers and I had limited authority.", True),
    ("I would review options if I actually managed 50 engineers and I actually had limited authority.", True),
    ("If I actually saved $2 million using Kubernetes, I would compare criteria.", True),
    ("I would review options if I managed a team but I actually saved $2 million using Kubernetes.", False),
    ("I would review options if I managed a team but I previously served as Director at Acme.", False),
    ("I would review options if I managed a team but I actually rescued every critical launch.", False),
] + ACTUALITY_BINDING_CASES + WHOLE_PREDICATE_CASES)
def test_full_antecedent_pairs_keep_selected_and_empty_scope(tmp_path: Path, question_id, location, support, phrase, accepted):
    conn = _init_conn(tmp_path)
    try:
        request = _request(question_id)
        repository = SqliteInterviewPrepRepository(conn)
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(question_id), _judge_pass()])).execute(
            origin_run_id="prior", **request).prep
        candidate = _candidate(question_id)
        item = candidate["items"][0]
        item["outline"][0]["factual_support"] = support
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "probe":
            item["probes"] = [phrase]
        else:
            item["gaps"][0]["prompt" if location == "gap" else "reason"] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="full-range", **request)
        assert outcome.status == ("accepted" if accepted else "failed"), outcome.errors
        assert len(llm.calls) == (2 if accepted else 1)
        if accepted:
            links = outcome.prep.items[0].question_metadata["evidenceLinks"]
            assert [link["evidenceId"] for link in links] == (["ev-platform-latency"] if question_id == "B11" else [])
        else:
            assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == prior.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification", "accepted_profile_fact"])
@pytest.mark.parametrize("heading", [
    "I would review options if I managed a team but I saved $2 million using Kubernetes in reality.",
    "I would review options if I managed a team but I served as Director at Acme in reality.",
    "I would review options if I managed a team but I rescued every critical launch, in fact.",
    "I would review options if I managed a team but I saved in reality $2 million using Kubernetes.",
    "I would review options if I managed a team but I served in fact as Director at Acme.",
    "I would review options if I managed a team but I rescued in reality every critical launch.",
])
def test_whole_predicate_actual_heading_has_its_own_source(tmp_path: Path, support, heading):
    assert_actual_heading(tmp_path, support, heading)


@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("selected", [True, False])
@pytest.mark.parametrize("phrase", ["I would describe how I reduced API latency by 30% using Python.",
                                    "I would review options if needed, but how did you reduce API latency by 30% using Python?",
                                    "I would review options if I managed a team but how did you reduce API latency by 30% using Python?"])
def test_planned_concrete_account_requires_its_question_source(tmp_path: Path, location, selected, phrase):
    conn = _init_conn(tmp_path)
    try:
        request = _request("B11" if selected else "M02")
        repository = SqliteInterviewPrepRepository(conn)
        question_id = request["selection_input"]["selectedQuestionIds"][0]
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(question_id), _judge_pass()])).execute(
            origin_run_id="prior", **request).prep
        candidate = _candidate(question_id)
        item = candidate["items"][0]
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
        assert accepted.generation_context["model"]["gateVersion"] == "interview-question-grounding-v16"
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
