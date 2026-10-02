"""Reproduce independent review findings against canonical v12 inputs."""

from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl.database import close_connection
from jobctrl.domain.interview.catalog import InterviewSelectionError
from jobctrl.domain.interview.use_cases import GenerateInterviewPrepUseCase
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from jobctrl.infrastructure.profile import SqliteProfileRepository
from jobctrl.interview import activities
from tests.test_interview_prep_generation import JOB_ID, _FakeLlm, _init_conn, _job, _judge_pass, _profile_snapshot, _requirements
from tests.test_interview_question_generation import _question_candidate
from tests.test_sqlite_profile_repository import _valid_profile


@pytest.mark.parametrize("support", ["hypothetical", "needs_clarification"])
@pytest.mark.parametrize("text", [
    "I saved $2 million by migrating the platform to Kubernetes.",
    "At Acme, I supervised 50 direct reports and delivered a 75% margin increase.",
    "I would compare options, but I saved $2 million using Kubernetes.",
    "I would mentor my team after my previous team saved $2 million.",
    "If you need an example, I saved $2 million using Kubernetes.",
])
def test_nonfactual_labels_cannot_accept_unsupported_personal_assertions(tmp_path: Path, support: str, text: str) -> None:
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        request = dict(tenant_id=LOCAL_TENANT, job=_job(), profile_snapshot=_profile_snapshot(),
                       evidence_entries=(), evidence_gaps=(), requirements=(), selection_input={"selectedQuestionIds": ["B11"]})
        prior = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([
            _question_candidate("B11", "Compare alternatives with the information available."), _judge_pass()]))
        accepted = prior.execute(origin_run_id="accepted", **request).prep
        assert accepted.status == "accepted"
        llm = _FakeLlm([_question_candidate("B11", text, support=support), _judge_pass()])
        outcome = GenerateInterviewPrepUseCase(repository=repository, llm=llm).execute(origin_run_id="false-claim", **request)
        assert outcome.status == "failed"
        assert len(llm.calls) == 1
        assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == accepted.to_read_model()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("text", [
    "Compare criteria and realistic alternatives with the information available.",
    "Compare Kubernetes with simpler deployment alternatives before committing.",
    "I would compare Kubernetes with simpler deployment alternatives before committing.",
    "If the role had 50 direct reports, I would delegate coaching with explicit feedback loops.",
])
def test_legitimate_principles_and_hypothetical_intentions_need_no_historical_facts(tmp_path: Path, text: str) -> None:
    conn = _init_conn(tmp_path)
    try:
        outcome = GenerateInterviewPrepUseCase(repository=SqliteInterviewPrepRepository(conn), llm=_FakeLlm([
            _question_candidate("B11", text), _judge_pass()])).execute(
                tenant_id=LOCAL_TENANT, job=_job(), profile_snapshot=_profile_snapshot(),
                evidence_entries=(), evidence_gaps=(), requirements=_requirements("req-k8s", "Kubernetes deployment"),
                selection_input={"selectedQuestionIds": ["B11"]})
        assert outcome.status == "accepted", outcome.errors
        assert outcome.prep.items[0].question_metadata["evidenceLinks"] == []
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("mutation,selected_id", [
    ("delete", "role_1_bullet_1"),
    ("confirmation", "role_1_bullet_1"),
    ("padded", "PaddedExact"),
    ("duplicate_ineligible", "role_1_bullet_1"),
])
def test_activity_rejects_synthetic_or_coerced_evidence_before_adapter(tmp_path: Path, monkeypatch, mutation: str, selected_id: str) -> None:
    conn = _init_conn(tmp_path)
    try:
        profiles = SqliteProfileRepository(conn, publisher=InProcessEventBus())
        profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, _valid_profile()))
        if mutation == "delete":
            conn.execute("DELETE FROM candidate_profile_achievement_evidence WHERE tenant_id='local' AND profile_id='default'")
        elif mutation == "confirmation":
            conn.execute("UPDATE candidate_profile_achievement_evidence SET user_confirmed=2 WHERE tenant_id='local' AND profile_id='default'")
        elif mutation == "padded":
            conn.execute("UPDATE candidate_profile_achievement_evidence SET evidence_id=' PaddedExact ' WHERE tenant_id='local' AND profile_id='default' AND evidence_index=0")
        else:
            conn.execute("UPDATE candidate_profile_achievement_evidence SET evidence_id='role_1_bullet_1',user_confirmed=2 WHERE tenant_id='local' AND profile_id='default' AND evidence_index=1")
        created: list[object] = []
        llm = _FakeLlm([_question_candidate("B11", "Compare alternatives and uncertainty."), _judge_pass()])
        def adapter(**_kwargs):
            created.append(llm)
            return llm
        monkeypatch.setattr(activities, "get_connection", lambda: conn)
        monkeypatch.setattr(activities, "get_profile_repository", lambda: profiles)
        monkeypatch.setattr(activities, "LlmAdapter", adapter)
        with pytest.raises(InterviewSelectionError) as caught:
            activities.generate_interview_prep_by_job_id(JOB_ID, tenant_id=LOCAL_TENANT, origin_run_id="raw-canonical",
                selection={"selectedQuestionIds": ["B11"], "evidenceProfileVersion": 1,
                           "evidenceSelections": [{"questionId": "B11", "evidenceIds": [selected_id]}]})
        assert caught.value.code == "invalid_evidence_selection"
        assert not created and not llm.calls
        assert conn.execute("SELECT COUNT(*) FROM job_interview_prep").fetchone()[0] == 0
    finally:
        close_connection(tmp_path / "jobs.db")


def test_activity_automatic_selection_uses_only_exact_current_rows_and_preserves_padded_id(tmp_path: Path, monkeypatch) -> None:
    conn = _init_conn(tmp_path)
    try:
        profiles = SqliteProfileRepository(conn, publisher=InProcessEventBus())
        profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, _valid_profile()))
        monkeypatch.setattr(activities, "get_connection", lambda: conn)
        monkeypatch.setattr(activities, "get_profile_repository", lambda: profiles)
        conn.execute("UPDATE candidate_profile_achievement_evidence SET evidence_id=' PaddedExact ' WHERE tenant_id='local' AND profile_id='default' AND evidence_index=0")
        llm = _FakeLlm([_question_candidate("B11", "Compare alternatives and uncertainty."), _judge_pass()])
        monkeypatch.setattr(activities, "LlmAdapter", lambda **_kwargs: llm)
        result = activities.generate_interview_prep_by_job_id(JOB_ID, tenant_id=LOCAL_TENANT, origin_run_id="exact-raw-id",
            selection={"selectedQuestionIds": ["B11"], "evidenceProfileVersion": 1,
                       "evidenceSelections": [{"questionId": "B11", "evidenceIds": [" PaddedExact "]}]})
        assert result.status == "accepted"
        saved = SqliteInterviewPrepRepository(conn).load_latest(LOCAL_TENANT, JOB_ID)
        assert saved.generation_context["selectedQuestions"][0]["selectedEvidenceIds"] == [" PaddedExact "]
        assert saved.items[0].question_metadata["evidenceLinks"][0]["evidenceId"] == " PaddedExact "
        conn.execute("DELETE FROM candidate_profile_achievement_evidence WHERE tenant_id='local' AND profile_id='default'")
        llm = _FakeLlm([_question_candidate("B11", "Compare alternatives and uncertainty."), _judge_pass()])
        result = activities.generate_interview_prep_by_job_id(JOB_ID, tenant_id=LOCAL_TENANT, origin_run_id="no-canonical-rows",
                                                             selection={"selectedQuestionIds": ["B11"]})
        assert result.status == "accepted"
        saved = SqliteInterviewPrepRepository(conn).load_latest(LOCAL_TENANT, JOB_ID)
        assert saved.generation_context["profile"]["evidence"] == []
        assert saved.items[0].question_metadata["evidenceLinks"] == []
        assert "role_1_bullet_1" not in llm.calls[0]["messages"][1].content
        assert conn.execute("SELECT COUNT(*) FROM candidate_profile_achievement_evidence").fetchone()[0] == 0
    finally:
        close_connection(tmp_path / "jobs.db")
