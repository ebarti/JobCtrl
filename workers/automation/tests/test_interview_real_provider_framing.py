"""Bounded hand-authored framing cases from owned synthetic product QA."""

from pathlib import Path

import pytest

from jobctrl.database import close_connection
from jobctrl.domain.interview.use_cases import GenerateInterviewPrepUseCase
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from tests.interview_question_fixtures import canonical_evidence
from tests.test_interview_prep_generation import JOB_ID, _FakeLlm, _init_conn, _job, _judge_pass, _profile_snapshot
from tests.test_interview_question_generation import _question_candidate


CASES = [
    ("manager_heading", "M02", "heading", "Technical involvement principle for a first-time manager"),
    ("advertised_role", "M02", "gap", "What are the advertised technical expectations for this Director of Platform Engineering role, and do they match how you prefer to spend your time?"),
    ("scope_reason", "B11", "reason", "Scope is labeled transferable; clarifying ownership prevents overstating authority and keeps first-time-manager framing accurate."),
    ("scope_question", "B11", "gap", "What was your actual scope and authority in the incident/platform work — were you coordinating across teams, deciding, or recommending?"),
    ("inspection_purpose", "M02", "text", "I would inspect decisions through design reviews, incident retrospectives, and targeted deep dives on high-stakes work, so I can assess quality without owning every implementation. I would pick selective engagement proportionate to risk rather than becoming a mandatory reviewer of everything."),
    ("preferred_option", "TS09", "gap", "Which requirement makes your preferred option better?"),
    ("approach_question", "M02", "gap", "No evidence was selected for M02 — which concrete episode of choosing to engage, coach, or step back would you use to illustrate your technical-involvement approach?"),
    ("purpose_budget", "M02", "text", "I would compare alternatives and inspect the scenario, so I can allocate a hypothetical $2 million budget."),
    ("launch_principle", "TS09", "text", "I would assess whether a design that worked at launch still fits today's constraints."),
    ("launch_question", "TS09", "gap", "If it worked at launch but became expensive two years later, does that make the original decision bad?"),
    ("language_origin", "TS09", "text", "I would compare a tool developed in Python with alternatives."),
]


def _request(question_id):
    profile = _profile_snapshot()
    evidence_ids = ["ev-platform-latency"] if question_id == "B11" else []
    return dict(tenant_id=LOCAL_TENANT, job={**_job(), "title": "Director of Platform Engineering"},
                profile_snapshot=profile, canonical_evidence=canonical_evidence(profile),
                evidence_entries=(), evidence_gaps=(), requirements=(),
                selection_input={"selectedQuestionIds": [question_id], "roleLens": "first_time_manager",
                                 "interviewStage": "management", "interviewFormat": "video",
                                 "evidenceProfileVersion": 1,
                                 "evidenceSelections": [{"questionId": question_id, "evidenceIds": evidence_ids}]})


def _candidate(question_id):
    return _question_candidate(question_id, "Compare criteria and realistic alternatives.",
                               gaps=[{"prompt": "Which details should be clarified?", "reason": "Details are missing."}])


@pytest.mark.parametrize("_name,question_id,location,phrase", CASES)
def test_neutral_roles_open_scope_and_conditional_purpose_are_not_personal_history(tmp_path: Path, _name, question_id, location, phrase):
    conn = _init_conn(tmp_path)
    try:
        candidate = _candidate(question_id)
        item = candidate["items"][0]
        if location in {"heading", "text"}:
            item["outline"][0][location] = phrase
        elif location == "reason":
            item["gaps"][0]["reason"] = phrase
        else:
            item["gaps"][0]["prompt"] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=SqliteInterviewPrepRepository(conn), llm=llm).execute(**_request(question_id))
        assert outcome.status == "accepted", outcome.errors
        assert len(llm.calls) == 2
        links = outcome.prep.items[0].question_metadata["evidenceLinks"]
        assert [link["evidenceId"] for link in links] == (["ev-platform-latency"] if question_id == "B11" else [])
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("phrase", [
    "My relevant background is transferable incident and platform coordination across teams.",
    "I would stay close to important work; my experience here is transferable incident and cross-team coordination, not direct reports.",
    "Technical involvement principle: I was a Director at Acme.",
    "I can assess quality because I supervised 50 direct reports at Acme.",
    "I would inspect designs, and I can assess quality because I supervised 50 direct reports.",
    "I would review designs. So I can manage a team of 50 direct reports.",
    "I would compare alternatives. How would you apply your prior experience supervising 50 direct reports at Acme?",
])
def test_explicit_empty_management_evidence_cannot_borrow_personal_background(tmp_path: Path, phrase: str):
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        request = _request("M02")
        accepted = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate("M02"), _judge_pass()])).execute(
            origin_run_id="accepted", **request).prep
        assert accepted.status == "accepted"
        candidate = _candidate("M02")
        candidate["items"][0]["outline"][0]["text"] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="borrowed-background", **request)
        assert outcome.status == "failed"
        assert len(llm.calls) == 1
        assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == accepted.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


def test_selected_fact_for_one_question_cannot_supply_empty_question_background(tmp_path: Path):
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        request = _request("M02")
        request["selection_input"]["selectedQuestionIds"] = ["B11", "TS09", "M02"]
        request["selection_input"]["evidenceSelections"].insert(0, {"questionId": "B11", "evidenceIds": ["ev-platform-latency"]})
        candidate = {"items": [
            _question_candidate("B11", "Reduced API latency by 30% using Python.",
                                ids=["ev-platform-latency"], support="accepted_profile_fact")["items"][0],
            _candidate("TS09")["items"][0], _candidate("M02")["items"][0],
        ]}
        accepted = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([candidate, _judge_pass()])).execute(
            origin_run_id="question-scoped", **request).prep
        assert accepted.status == "accepted"
        assert [link["evidenceId"] for link in accepted.items[0].question_metadata["evidenceLinks"]] == ["ev-platform-latency"]
        assert accepted.items[2].question_metadata["evidenceLinks"] == []
        assert accepted.generation_context["model"]["promptVersion"] == "interview-questions-v4"
        candidate["items"][2]["outline"][0]["text"] = "My relevant background is API latency optimization using Python."
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="cross-question", **request)
        assert outcome.status == "failed"
        assert len(llm.calls) == 1
        assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == accepted.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("location", ["heading", "text"])
@pytest.mark.parametrize("phrase", [
    "Technical involvement principle learned as Director at Acme.",
    "Technical involvement principle served as Director at Acme.",
    "Technical involvement principle from a previous role as Director at Acme.",
    "First-time-manager framing learned as Director at Acme.",
    "Advertised technical involvement principle learned at Acme.",
    "Technical involvement principle from experience as Director at Acme.",
    "First-time-manager framing learned as director at Acme.",
    "Technical involvement principle worked as a Director at Acme.",
])
def test_neutral_role_topics_cannot_hide_pronounless_biography(tmp_path: Path, location: str, phrase: str):
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        request = _request("M02")
        accepted = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate("M02"), _judge_pass()])).execute(
            origin_run_id="accepted", **request).prep
        assert accepted.status == "accepted"
        candidate = _candidate("M02")
        candidate["items"][0]["outline"][0][location] = phrase
        llm = _FakeLlm([candidate, _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="past-role", **request)
        assert outcome.status == "failed"
        assert len(llm.calls) == 1
        assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == accepted.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")
