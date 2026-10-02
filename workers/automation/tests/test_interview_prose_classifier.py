"""Minimal pairs distinguish asserted facts from unknowns and explicit scenarios."""

from pathlib import Path

import pytest

from jobctrl.database import close_connection
from jobctrl.domain.interview.use_cases import GenerateInterviewPrepUseCase
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from tests.test_interview_prep_generation import JOB_ID, _FakeLlm, _init_conn, _judge_pass
from tests.test_interview_real_provider_framing import _candidate, _request
from tests.test_interview_question_generation import _question_candidate


PROPOSITIONS = [
    ("role_assertion", "I worked as a manager at Acme.", False),
    ("role_unknown", "Have you worked as a manager before?", True),
    ("role_condition", "If you worked as a manager, how would you approach technical involvement?", True),
    ("role_presupposition", "How would you apply your prior experience as Director at Acme?", False),
    ("employer_assertion", "I worked at Acme.", False),
    ("employer_unknown", "Have you worked at Acme?", True),
    ("employer_condition", "If you worked at Acme, how would you approach technical involvement?", True),
    ("employer_biography", "Technical involvement principle learned at Acme.", False),
    ("past_value_assertion", "Your previous role was Director at Acme.", False),
    ("past_value_unknown", "What was your previous role?", True),
    ("past_value_unknown_conjunction", "What was your previous role, and what would you do next?", True),
    ("past_value_presupposition", "What was your prior savings of $2 million?", False),
    ("learned_assertion", "Technical involvement principle learned as Director at Acme.", False),
    ("learned_unknown", "Did you learn as a Director at Acme?", True),
    ("learned_condition", "If you had learned as a Director at Acme, how would you approach technical involvement?", True),
    ("learned_presupposition", "What lessons were learned as Director at Acme?", False),
    ("served_assertion", "Technical involvement principle served as Director at Acme.", False),
    ("served_unknown", "Have you served as a Director at Acme?", True),
    ("served_condition", "If you served as a manager, I would compare realistic alternatives.", True),
    ("served_presupposition", "How would you use lessons from your previous role as Director at Acme?", False),
    ("mixed_question", "Have you worked at Acme, where you supervised 50 direct reports?", False),
    ("mixed_condition", "If you worked as a manager, I supervised 50 direct reports at Acme.", False),
    ("unrelated_condition", "If you need an example, technical involvement principle learned as Director at Acme.", False),
    ("unrelated_condition_colon", "If you need an example: I improved incident coordination.", False),
    ("unrelated_condition_numeric_comma", "If you managed 3, I improved incident coordination.", False),
    ("possessive_hypothesis", "Suppose your hypothetical team had 50 engineers. How would you prioritize coaching?", True),
    ("possessive_imagine", "Imagine your hypothetical team had 50 engineers; I would prioritize coaching.", True),
    ("subject_hypothesis", "Suppose you managed a hypothetical team of 50 engineers. How would you prioritize coaching?", True),
    ("possessive_numeric_ratio", "Suppose your hypothetical team used a 1:2 coaching ratio; I would compare feedback.", True),
    ("possessive_hypothesis_actual", "Suppose your hypothetical team had 50 engineers: I improved incident coordination.", False),
    ("mixed_future", "I would compare options, but I saved $2 million using Kubernetes.", False),
    ("numeric_assertion", "I saved $2 million by migrating the platform to Kubernetes.", False),
    ("authority_assertion", "At Acme, I supervised 50 direct reports and delivered a 75% margin increase.", False),
    ("numeric_condition", "If the role had 50 direct reports, I would delegate coaching with explicit feedback loops.", True),
    ("numeric_future", "What would you do with a $2 million budget?", True),
    ("numeric_presupposition", "How would you use your prior savings of $2 million from migrating the platform to Kubernetes?", False),
    ("unicode_intention", "I’d compare alternatives before committing.", True),
    ("unicode_history", "I’d overseen 50 direct reports at Acme.", False),
    ("neutral_topic", "Technical involvement principle for a first-time manager", True),
    ("neutral_role_lens", "For a first-time manager, compare criteria before choosing an approach.", True),
    ("role_lens_assertion", "I am a first-time manager.", False),
    ("role_lens_unrelated_title", "For a first-time manager, Director at Acme.", False),
    ("target_question", "What are the advertised technical expectations for this Director of Platform Engineering role?", True),
    ("empty_biography", "My relevant background is transferable incident and platform coordination across teams.", False),
    ("generic_invitation", "Tell me about a time you handled conflict.", True),
    ("recollection_relative_when", "Describe a time when you handled conflict.", True),
    ("recollection_relative_where", "Share an example where you improved incident coordination.", True),
    ("recollection_coordinated_owner", "Describe a time when you and your team handled conflict.", True),
    ("recollection_coordinated_actual", "Describe a time when you and your team handled conflict. I improved incident coordination.", False),
    ("neutral_tool_guidance", "Compare Kubernetes with alternatives for a hypothetical design.", True),
    ("recollection_mixed_colon", "Tell me about a time you handled conflict: I improved incident coordination.", False),
    ("recollection_mixed_metric", "Tell me about a time you handled conflict. I saved $2 million.", False),
    ("recollection_mixed_employer", "Tell me about a time you handled conflict. I worked at Acme.", False),
    ("local_question_abbreviation", "Which technical decision would you use (e.g., retain a monolith or adopt a tool), and what criterion mattered?", True),
    ("local_question_abbreviation_assertion", "Which technical decision would you use (e.g., retain a monolith)? I improved incident coordination.", False),
    ("generic_decision", "What did you learn from a difficult decision?", True),
    ("generic_outcome", "How did you achieve reliable operations?", True),
    ("generic_event", "What did you learn from coordinating the incident?", True),
    ("named_employer_premise", "How did you coordinate the incident at Acme?", False),
    ("named_employer_unknown", "Have you ever coordinated the incident at Acme?", True),
    ("named_tool_premise", "How did you use Kubernetes to coordinate the incident?", False),
    ("named_tool_unknown", "Have you ever used Kubernetes to coordinate the incident?", True),
    ("named_tool_future", "How would you use Kubernetes to coordinate a hypothetical incident?", True),
    ("numeric_method_premise", "How did you reduce latency by 40% while managing 50 engineers?", False),
    ("target_method_premise", "How did you supervise 50 engineers for this advertised Director role?", False),
]


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("_name,phrase,accepted", PROPOSITIONS)
def test_same_proposition_meaning_in_every_nonfactual_location(tmp_path: Path, _name, phrase, accepted, location, support):
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        request = _request("M02")
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate("M02"), _judge_pass()])).execute(
            origin_run_id="accepted", **request).prep
        assert prior.status == "accepted"
        candidate = _candidate("M02")
        item = candidate["items"][0]
        item["outline"][0]["factual_support"] = support
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "gap":
            item["gaps"][0]["prompt"] = phrase
        elif location == "reason":
            item["gaps"][0]["reason"] = phrase
        else:
            item["probes"] = [phrase]
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="matrix", **request)
        assert outcome.status == ("accepted" if accepted else "failed"), outcome.errors
        assert len(llm.calls) == (2 if accepted else 1)
        latest = repository.load_latest(LOCAL_TENANT, JOB_ID)
        if accepted:
            assert latest.to_read_model() == outcome.prep.to_read_model()
            assert latest.items[0].question_metadata["evidenceLinks"] == []
        else:
            assert latest.to_read_model() == prior.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("assertion", ["I improved incident coordination", "I rescued every critical launch", "You led incident coordination"])
@pytest.mark.parametrize("guidance", ["Tell me about a time you handled conflict", "I would compare criteria before committing"])
@pytest.mark.parametrize("boundary", [". ", "\n", ", but "])
@pytest.mark.parametrize("prepend", [True, False])
def test_independent_guidance_composition_cannot_waive_an_actual_assertion(tmp_path: Path, support, location, assertion, guidance, boundary, prepend):
    phrase = boundary.join([guidance, assertion] if prepend else [assertion, guidance]) + "."
    test_same_proposition_meaning_in_every_nonfactual_location(tmp_path, "composition", phrase, False, location, support)


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification", "accepted_profile_fact"])
@pytest.mark.parametrize("heading", ["I rescued every critical launch.", "My achievements include leading incident coordination.",
                                     "Experience acquired leading incident coordination.", "I led incident coordination.",
                                     "Tell me about a time you handled conflict. I rescued every critical launch.",
                                     "Describe a time you handled conflict; I led incident coordination."])
def test_actual_heading_claim_requires_its_own_selected_source(tmp_path: Path, support: str, heading: str):
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        request = _request("B11")
        candidate = (_question_candidate("B11", "Reduced API latency by 30% using Python.",
                                         ids=["ev-platform-latency"], support=support)
                     if support == "accepted_profile_fact" else _candidate("B11"))
        candidate["items"][0]["outline"][0]["factual_support"] = support
        accepted = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([candidate, _judge_pass()])).execute(
            origin_run_id="accepted", **request).prep
        assert accepted.status == "accepted"
        candidate["items"][0]["outline"][0]["heading"] = heading
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="unsupported-heading", **request)
        assert outcome.status == "failed"
        assert len(llm.calls) == 1
        assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == accepted.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("question_id,accepted", [("B11", True), ("M02", False)])
@pytest.mark.parametrize("surrounding", ["none", "prefix_invitation", "suffix_invitation", "prefix_future", "suffix_future",
                                        "prefix_future_conjunct", "suffix_future_conjunct", "prefix_neutral", "suffix_neutral"])
@pytest.mark.parametrize("query", ["How did you reduce API latency by 30% using Python?",
                                   "Describe a time when you and your team reduced API latency by 30% using Python."])
def test_concrete_past_question_uses_only_its_selected_source(tmp_path: Path, location: str, question_id: str, accepted: bool, surrounding: str, query: str):
    conn = _init_conn(tmp_path)
    try:
        candidate = _candidate(question_id)
        repository = SqliteInterviewPrepRepository(conn)
        request = _request(question_id)
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([candidate, _judge_pass()])).execute(
            origin_run_id="accepted", **request).prep
        assert prior.status == "accepted"
        phrase = query
        if surrounding.endswith("conjunct"):
            clause = "What would you do next"
            phrase = ", and ".join([clause, phrase[:-1]] if surrounding.startswith("prefix") else [phrase[:-1], clause]) + "?"
        elif surrounding != "none":
            clause = ("Compare Kubernetes with alternatives for a hypothetical design." if surrounding.endswith("neutral")
                      else "Tell me about a time you handled conflict." if surrounding.endswith("invitation") else "What would you do next?")
            phrase = "\n".join([clause, phrase] if surrounding.startswith("prefix") else [phrase, clause])
        item = candidate["items"][0]
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "gap":
            item["gaps"][0]["prompt"] = phrase
        elif location == "reason":
            item["gaps"][0]["reason"] = phrase
        else:
            item["probes"] = [phrase]
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="source-composition", **request)
        assert outcome.status == ("accepted" if accepted else "failed"), outcome.errors
        assert len(llm.calls) == (2 if accepted else 1)
        latest = repository.load_latest(LOCAL_TENANT, JOB_ID)
        assert latest.to_read_model() == (outcome.prep if accepted else prior).to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


COORDINATED_SOURCE_PAIRS = [
    ("How did you reduce API latency by 30% and use Kubernetes?", False, False),
    ("How did you reduce API latency by 30% and use Python?", True, False),
    ("How did you use Python and reduce API latency by 30%?", True, False),
    ("How did you use Python and reduce API latency by 40%?", False, False),
    ("How did you use Python and work at Acme?", False, False),
    ("How did you use Python and manage 50 direct reports?", False, False),
    ("How did you use Python and reduce API latency by 30% and use Kubernetes?", False, False),
    ("Describe a time you reduced API latency by 30% and used Python.", True, False),
    ("Describe a time you reduced API latency by 30% and used Kubernetes.", False, False),
    ("Have you ever used Python and Kubernetes?", True, True),
    ("Have you ever used Python and supervised 50 direct reports?", True, True),
    ("Have you ever used Python and managed 50 direct reports?", True, True),
    ("How would you use Python and manage a hypothetical team of 50 engineers?", True, True),
    ("I would compare Python and Kubernetes for a hypothetical design.", True, True),
    ("How did you reduce API latency by 30%, and how would you evaluate Kubernetes for a hypothetical change?", True, False),
    ("How did you reduce API latency by 30%, and I improved incident coordination.", False, False),
    ("How did you reduce API latency by 30% and I rescued every critical launch?", False, False),
    ("Tell me about a time you handled conflict, and I improved incident coordination.", False, False),
    ("I would compare criteria and I improved incident coordination.", False, False),
    ("I would compare criteria and saved $2 million.", False, False),
    ("I would compare criteria and led incident coordination.", False, False),
    ("How would you use Python and apply your prior experience managing 50 engineers at Acme?", False, False),
    ("I would compare Python and use my prior savings of $2 million.", False, False),
]


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("location", ["heading", "text", "gap", "reason", "probe"])
@pytest.mark.parametrize("question_id", ["B11", "M02"])
@pytest.mark.parametrize("phrase,b11_accepted,m02_accepted", COORDINATED_SOURCE_PAIRS)
def test_dependent_predicate_retains_actor_operator_and_selected_sources(
    tmp_path: Path, support: str, location: str, question_id: str, phrase: str, b11_accepted: bool, m02_accepted: bool,
):
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        request = _request(question_id)
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(question_id), _judge_pass()])).execute(
            origin_run_id="accepted", **request).prep
        assert prior.status == "accepted"
        candidate = _candidate(question_id)
        item = candidate["items"][0]
        item["outline"][0]["factual_support"] = support
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "gap":
            item["gaps"][0]["prompt"] = phrase
        elif location == "reason":
            item["gaps"][0]["reason"] = phrase
        else:
            item["probes"] = [phrase]
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="dependent-source", **request)
        accepted = b11_accepted if question_id == "B11" else m02_accepted
        assert outcome.status == ("accepted" if accepted else "failed"), outcome.errors
        assert len(llm.calls) == (2 if accepted else 1)
        assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == (outcome.prep if accepted else prior).to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")
