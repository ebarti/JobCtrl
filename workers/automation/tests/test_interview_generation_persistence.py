"""Exercise generation with the packaged catalog and actual v12 canonical owners."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from temporalio.exceptions import ApplicationError

from jobctrl.database import close_connection
from jobctrl.domain.interview.catalog import InterviewSelectionError, load_interview_catalog
from jobctrl.domain.interview.use_cases import GenerateInterviewPrepUseCase
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from jobctrl.infrastructure.profile import SqliteProfileRepository
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.interview import activities
from jobctrl.interview.activities import GenerateInterviewPrepActivityInput, generate_interview_prep_activity
from tests.test_interview_prep_generation import JOB_ID, _FakeLlm, _init_conn, _job, _judge_pass, _profile_snapshot
from tests.test_interview_question_generation import _question_candidate
from tests.test_sqlite_profile_repository import _valid_profile


def _request():
    return dict(tenant_id=LOCAL_TENANT, job=_job(), profile_snapshot=_profile_snapshot(),
                evidence_entries=(), evidence_gaps=(), requirements=(),
                selection_input={"selectedQuestionIds": ["B01"], "evidenceProfileVersion": 1,
                                 "evidenceSelections": [{"questionId": "B01", "evidenceIds": ["ev-platform-latency"]}]})


def _candidate():
    return _question_candidate("B01", "Reduced API latency by 30% using Python.",
                               ids=["ev-platform-latency"], support="accepted_profile_fact")


@pytest.mark.parametrize("fault", ["provider", "judge", "item_write"])
def test_failed_refresh_preserves_saved_context_notes_and_retry_does_not_spend(tmp_path: Path, fault: str) -> None:
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        accepted = GenerateInterviewPrepUseCase(repository=repository, llm=_FakeLlm([_candidate(), _judge_pass()]))
        original = accepted.execute(origin_run_id="accepted-run", **_request()).prep
        saved = repository.load(LOCAL_TENANT, JOB_ID, generation=1)
        assert saved.to_read_model() == original.to_read_model()
        context = original.generation_context
        assert context["selectedQuestions"][0]["snapshot"] == load_interview_catalog()["questions"][
            next(i for i, card in enumerate(load_interview_catalog()["questions"]) if card["id"] == "B01")]
        note = repository.save_note(LOCAL_TENANT, JOB_ID, "B01", expected_revision=0,
                                    note_text="Owned synthetic note retained during refresh.", source_generation=1,
                                    bindings={"contextDigest": context["contextDigest"], "catalogBinding": context["catalogBinding"]})
        if fault == "item_write":
            conn.execute("""CREATE TEMP TRIGGER fail_new_interview_item BEFORE INSERT ON job_interview_prep_items
                            WHEN NEW.generation > 1 BEGIN SELECT RAISE(ABORT, 'synthetic item failure'); END""")
        responses = ([_candidate(), _judge_pass()] if fault == "item_write" else [_candidate()] if fault == "judge" else [])
        llm = _FakeLlm(responses)
        use_case = GenerateInterviewPrepUseCase(repository=repository, llm=llm)
        failed = use_case.execute(origin_run_id="failed-run", **_request())
        assert failed.status == "failed"
        error_code = {"provider": "generation_error", "judge": "judge_error", "item_write": "persistence_error"}[fault]
        assert error_code in " ".join(failed.errors)
        retried = use_case.execute(origin_run_id="failed-run", **_request())
        assert retried.prep.to_read_model() == failed.prep.to_read_model()
        assert len(llm.calls) == (1 if fault == "provider" else 2)
        assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == original.to_read_model()
        assert repository.load_note(LOCAL_TENANT, JOB_ID, "B01") == note
        assert repository.load_note_history(LOCAL_TENANT, JOB_ID, "B01") == [note]
        history = repository.load_history(LOCAL_TENANT, JOB_ID)
        assert [row["status"] for row in history] == ["failed", "accepted"]
        assert history[0]["generationContext"]["selectedQuestions"][0]["selectedEvidenceIds"] == ["ev-platform-latency"]
    finally:
        close_connection(tmp_path / "jobs.db")


def test_activity_reads_current_canonical_profile_and_keeps_no_evidence_choice(tmp_path: Path, monkeypatch) -> None:
    conn = _init_conn(tmp_path)
    try:
        profiles = SqliteProfileRepository(conn, publisher=InProcessEventBus())
        raw = _valid_profile()
        raw["resume"]["experience_entries"] = _profile_snapshot().as_dict()["resume"]["experience_entries"]
        profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, raw))
        before = profiles.load_snapshot(LOCAL_TENANT).as_dict()
        candidate = _question_candidate("B01", "Clarify the actual contribution before choosing an example.", support="needs_clarification",
                                       gaps=[{"prompt": "Which accepted example would you like to use?", "reason": "No evidence was selected."}])
        llm = _FakeLlm([candidate, _judge_pass()])
        monkeypatch.setattr(activities, "get_connection", lambda: conn)
        monkeypatch.setattr(activities, "get_profile_repository", lambda: profiles)
        monkeypatch.setattr(activities, "LlmAdapter", lambda **_kwargs: llm)
        selection = {"selectedQuestionIds": ["B01"], "evidenceProfileVersion": 1,
                     "evidenceSelections": [{"questionId": "B01", "evidenceIds": []}]}
        result = activities.generate_interview_prep_by_job_id(JOB_ID, tenant_id=LOCAL_TENANT,
                                                             origin_run_id="activity-run", selection=selection)
        assert result.status == "accepted"
        repository = SqliteInterviewPrepRepository(conn)
        saved = repository.load_latest(LOCAL_TENANT, JOB_ID)
        assert saved.generation_context["profile"]["profileId"] == "default"
        assert saved.generation_context["selectedQuestions"][0]["selectedEvidenceIds"] == []
        assert saved.items[0].question_metadata["evidenceLinks"] == []
        assert profiles.load_snapshot(LOCAL_TENANT).as_dict() == before
        assert conn.execute("SELECT version FROM candidate_profiles WHERE tenant_id='local'").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM job_requirement_fit_reports").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM application_outcomes").fetchone()[0] == 0
        events = conn.execute("SELECT payload_json FROM job_events WHERE event_type='InterviewPrepGenerated'").fetchall()
        assert len(events) == 1
        assert "Clarify" not in events[0]["payload_json"] and "ev-platform-latency" not in events[0]["payload_json"]
        ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT).refresh()
        projections = conn.execute("SELECT interview_prep_json FROM job_detail_projections WHERE tenant_id='local' AND job_id=?", (JOB_ID,)).fetchone()
        assert json.loads(projections[0])["generationContext"] == saved.generation_context
        retry = activities.generate_interview_prep_by_job_id(JOB_ID, tenant_id=LOCAL_TENANT,
                                                            origin_run_id="activity-run", selection=selection)
        assert retry.generation == 1 and len(llm.calls) == 2
        selected_before_save = {**selection, "evidenceProfileVersion": 1}
        profiles.save(LOCAL_TENANT, profiles.load(LOCAL_TENANT))
        created: list[object] = []
        monkeypatch.setattr(activities, "LlmAdapter", lambda **_kwargs: created.append(object()))
        with pytest.raises(InterviewSelectionError) as caught:
            activities.generate_interview_prep_by_job_id(JOB_ID, tenant_id=LOCAL_TENANT,
                                                        origin_run_id="stale-run", selection=selected_before_save)
        assert caught.value.code == "evidence_profile_changed"
        assert not created and len(repository.load_history(LOCAL_TENANT, JOB_ID)) == 1
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.asyncio
async def test_activity_selection_failures_are_safe_non_retryable_domain_codes(monkeypatch) -> None:
    async def failed(*_args, **_kwargs):
        raise InterviewSelectionError("evidence_profile_changed")
    monkeypatch.setattr(activities.activity, "info", lambda: SimpleNamespace(workflow_run_id="run"))
    monkeypatch.setattr("jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat", failed)
    with pytest.raises(ApplicationError) as caught:
        await generate_interview_prep_activity(GenerateInterviewPrepActivityInput(tenant_id="local", job_id=JOB_ID))
    assert caught.value.type == "evidence_profile_changed" and caught.value.non_retryable
    assert str(caught.value).endswith("evidence_profile_changed")


@pytest.mark.parametrize("unavailable_kind", ["missing", "relative", "final_symlink", "parent_symlink", "over_budget"])
def test_approved_material_unavailable_paths_are_excluded_and_labeled(tmp_path: Path, unavailable_kind: str) -> None:
    conn = _init_conn(tmp_path)
    try:
        path = tmp_path / "registered-resume.txt"
        path.write_bytes(b"Synthetic public fixture")
        registered_path = str(path)
        if unavailable_kind == "missing":
            path.unlink()
        elif unavailable_kind == "relative":
            registered_path = path.name
        elif unavailable_kind == "final_symlink":
            link = tmp_path / "linked-resume.txt"
            link.symlink_to(path)
            registered_path = str(link)
        elif unavailable_kind == "parent_symlink":
            link = tmp_path / "linked-parent"
            link.symlink_to(tmp_path, target_is_directory=True)
            registered_path = str(link / path.name)
        else:
            path.write_bytes(b"x" * 1_048_577)
        conn.execute("INSERT INTO job_materials(tenant_id,job_id,generation,status,created_at,updated_at) VALUES('local',?,1,'resume_in_progress','now','now')", (JOB_ID,))
        conn.execute("INSERT INTO job_materials_artifacts(tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) VALUES('local',?,1,'tailored_resume','synthetic-approved','approved',?,'text','now')", (JOB_ID, registered_path))
        materials = activities._load_accepted_materials(conn, LOCAL_TENANT, JOB_ID)
        assert len(materials) == 1 and set(materials[0]) == {"inputWarning"}
        assert registered_path not in materials[0]["inputWarning"]
        outcome = GenerateInterviewPrepUseCase(repository=SqliteInterviewPrepRepository(conn), llm=_FakeLlm([_candidate(), _judge_pass()])).execute(
            **_request(), accepted_materials=materials)
        assert outcome.status == "accepted", outcome.errors
        assert outcome.prep.generation_context["approvedMaterials"] == []
        assert materials[0]["inputWarning"] in outcome.prep.gate_audit.warnings
    finally:
        close_connection(tmp_path / "jobs.db")
