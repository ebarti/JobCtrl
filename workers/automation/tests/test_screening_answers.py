"""Structural model doubles exercise authority, not an answer-quality corpus."""

import json
import sqlite3
from uuid import uuid4

import pytest

from jobctrl.domain.apply.screening_answers import ScreeningAnswerService, ScreeningCommand
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.screening_answers import ScreeningAnswerGenerator
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.materials.screening_answers import ScreeningAnswerRepository
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.llm_lanes import current_llm_lane


class StructuralModel:
    provider_id = "synthetic"
    model = "structural"

    def __init__(
        self, *, context_verdict="ready", claim_verdict="pass", quality_verdict="pass", failure=None, callback=None
    ):
        self.context_verdict, self.claim_verdict, self.quality_verdict = context_verdict, claim_verdict, quality_verdict
        self.failure, self.callback = failure, callback
        self.calls = []

    def chat_json(self, messages, **kwargs):
        assert current_llm_lane() == "apply"
        data = json.loads(messages[-1].content)
        sources = {row["source_id"]: row["text"] for row in data["sources"]}
        self.calls.append(data)
        if self.callback:
            callback, self.callback = self.callback, None
            callback()
        if self.failure:
            if isinstance(self.failure, Exception):
                raise self.failure
            return self.failure
        title = kwargs["response_schema"]["title"]

        def cite(ident):
            return {"source_id": ident, "quote": sources[ident][:100], "exact_values": []}

        if title == "ScreeningInterpretation":
            ids = ["question", "context"] + (
                ["prior_question", "prior_context", "prior_answer"] if "prior_answer" in sources else []
            )
            return {
                "verdict": self.context_verdict,
                "citations": [cite(ident) for ident in ids],
                "rationale": "Injected structural decision",
            }
        if title == "ScreeningDraft":
            return {"text": "Synthetic draft", "citations": [], "uncertainty": ""}
        if title == "ClaimVerification":
            return {
                "verdict": self.claim_verdict,
                "rationale": "Injected structural decision",
                "lines": [
                    {
                        "line_id": "answer",
                        "verdict": self.claim_verdict,
                        "claims": [],
                        "findings": [],
                        "source_evidence": [],
                        "served_requirements": [],
                    }
                ],
            }
        if title == "ArtifactQuality":
            return {
                "verdict": self.quality_verdict,
                "score": 0.5,
                "findings": [],
                "evidence_corrections": [],
                "rationale": "Injected structural decision",
            }
        raise AssertionError(title)


@pytest.fixture
def workspace(tmp_path):
    path = tmp_path / "synthetic.db"
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    create_exact_v14_schema(conn)
    jobs = [str(uuid4()), str(uuid4())]
    for tenant in ("local", "other"):
        conn.execute(
            "INSERT INTO candidate_profiles(tenant_id,profile_id,version,experience_target_role,updated_at) VALUES(?, 'default',1,'Synthetic fact','2026-10-08')",
            (tenant,),
        )
        conn.execute(
            "INSERT INTO candidate_profile_experience_entries(tenant_id,profile_id,entry_id,position_index,title,company) VALUES(?,'default','entry',0,'Synthetic title','Synthetic employer')",
            (tenant,),
        )
        conn.execute(
            "INSERT INTO candidate_profile_experience_bullets VALUES(?,'default','entry',0,'Synthetic authored fact')",
            (tenant,),
        )
        for job in jobs:
            conn.execute(
                "INSERT INTO jobs(tenant_id,job_id,url,title) VALUES(?,?,?,?)",
                (tenant, job, "https://example.test/" + job, "Synthetic role"),
            )
            conn.execute(
                "INSERT INTO job_enrichments(tenant_id,job_id,current_status,full_description,application_url,updated_at) VALUES(?,?,'succeeded','Synthetic posting','https://example.test/apply','2026-10-08')",
                (tenant, job),
            )
    conn.commit()
    yield conn, jobs, tmp_path
    conn.close()


def service(conn, model=None, preflight=lambda: None):
    repo = ScreeningAnswerRepository(conn)
    generator = ScreeningAnswerGenerator(
        llm=model or StructuralModel(),
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="synthetic",
        model="structural",
        lane="apply",
        preflight=preflight,
    )
    return ScreeningAnswerService(repo, generator)


def command(action, state=None, **fields):
    return ScreeningCommand(
        action=action,
        idempotencyKey=uuid4().hex,
        expectedRevision=state["revision"] if state else 0,
        questionId=state["questionId"] if state else None,
        **fields,
    )


def capture(svc, job, **fields):
    return svc.execute(
        "local",
        job,
        command(
            "capture",
            applicationId=fields.pop("applicationId", "attempt-one"),
            question="Synthetic question",
            context="Synthetic constraints",
            **fields,
        ),
    )


def reviewed(svc, job):
    state = capture(svc, job)
    state = svc.execute("local", job, command("draft", state))
    return svc.execute("local", job, command("review", state, decision="approved"))


def test_full_lifecycle_retains_library_review_used_text_and_never_submits(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    original = state["accepted"]
    used = svc.execute("local", jobs[0], command("use", state, text="Actual changed text", attested=True))
    read = svc.repository.read("local", jobs[0])
    assert used["manualUse"]["changed"] is True
    assert used["manualUse"]["reviewId"] == original["reviewId"]
    assert len(read["history"]) == 4 and len(read["library"]) == 1
    assert read["questions"][0]["accepted"]["staleReason"] is None
    assert conn.execute("SELECT COUNT(*) FROM application_outcomes").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplicationSubmitted'").fetchone()[0] == 0


def test_history_joins_receipts_for_replaced_and_rejected_drafts(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = capture(svc, jobs[0])
    generated = svc.execute("local", jobs[0], command("draft", state))
    edited = svc.execute("local", jobs[0], command("edit", generated, text="Replacement draft"))
    rejected = svc.execute("local", jobs[0], command("review", edited, decision="rejected"))
    svc.execute(
        "local",
        jobs[0],
        command(
            "capture", rejected, applicationId=state["applicationId"], question="New question", context="New context"
        ),
    )
    read = svc.repository.read("local", jobs[0])
    assert read["questions"][0]["draft"] is None
    expected = set(generated["draft"]["determinationIds"]) | set(edited["draft"]["determinationIds"])
    actual = {receipt["determination_id"] for receipt in read["determinations"]}
    assert actual == expected
    assert all(
        receipt["entity_id"] == state["questionId"] and receipt["lane"] == "apply" for receipt in read["determinations"]
    )
    assert len(read["history"]) == 5


def test_multiple_attempts_and_cross_job_reuse_need_fresh_review(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    first = reviewed(svc, jobs[0])
    second = capture(svc, jobs[0], applicationId="attempt-two")
    target = capture(svc, jobs[1])
    entry = svc.repository.read("local", jobs[0])["library"][0]
    reused = svc.execute("local", jobs[1], command("reuse", target, libraryId=entry["libraryId"]))
    assert reused["accepted"] is None
    assert reused["draft"]["answerId"] != first["accepted"]["answerId"]
    assert reused["draft"]["binding"]["applicationId"] == target["applicationId"]
    assert second["questionId"] != first["questionId"]
    assert len(svc.repository.read("local", jobs[0])["questions"]) == 2


@pytest.mark.parametrize("context_verdict", ["different", "uncertain"])
def test_opposing_valid_context_verdicts_control_reuse(workspace, context_verdict):
    conn, jobs, _ = workspace
    svc = service(conn)
    reviewed(svc, jobs[0])
    entry = svc.repository.read("local", jobs[0])["library"][0]
    target = capture(svc, jobs[1])
    with pytest.raises(DeterminationFailure, match="screening_context_" + context_verdict):
        service(conn, StructuralModel(context_verdict=context_verdict)).execute(
            "local", jobs[1], command("reuse", target, libraryId=entry["libraryId"])
        )
    assert svc.repository.current("local", target["questionId"]) == target


@pytest.mark.parametrize("failure", ["unavailable", "malformed", "foreign", "claims", "quality", "budget", "provider"])
def test_failed_refresh_preserves_accepted_bytes_source_and_all_histories(workspace, failure):
    conn, jobs, root = workspace
    artifact = root / "source.txt"
    artifact.write_bytes(b"Owned accepted artifact bytes")
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    before = conn.execute("SELECT payload_json FROM job_events ORDER BY event_id").fetchall()
    model = StructuralModel()

    def initial_preflight():
        pass

    preflight = initial_preflight
    if failure == "unavailable":
        model = None
    elif failure == "malformed":
        model.failure = "{"
    elif failure == "foreign":
        model.failure = {
            "verdict": "ready",
            "citations": [
                {"source_id": "foreign", "quote": "x"},
                {"source_id": "question", "quote": "Synthetic question"},
            ],
            "rationale": "Structural invalid input",
        }
    elif failure == "claims":
        model.claim_verdict = "fail"
    elif failure == "quality":
        model.quality_verdict = "fail"
    elif failure == "budget":

        def preflight():
            raise DeterminationFailure("spend_denied")
    else:
        model.failure = RuntimeError("Synthetic provider failure")
    # New authored edit avoids an identical cached draft.
    generator = ScreeningAnswerGenerator(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="synthetic-new",
        model="structural",
        lane="apply",
        preflight=preflight,
    )
    failing = ScreeningAnswerService(svc.repository, generator)
    with pytest.raises(DeterminationFailure):
        failing.execute("local", jobs[0], command("edit", state, text="Changed draft"))
    assert svc.repository.current("local", state["questionId"])["accepted"] == state["accepted"]
    assert (
        conn.execute(
            "SELECT payload_json FROM job_events WHERE entity_kind != 'screening_failure' ORDER BY event_id"
        ).fetchall()
        == before
    )
    assert svc.repository.read("local", jobs[0])["failures"][-1]["action"] == "edit"
    assert artifact.read_bytes() == b"Owned accepted artifact bytes"


@pytest.mark.parametrize("change", ["profile", "posting", "destination", "question", "context"])
def test_source_changes_invalidate_review_and_use_but_preserve_history(workspace, change):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    if change == "profile":
        conn.execute("UPDATE candidate_profiles SET version=2 WHERE tenant_id='local'")
    elif change == "posting":
        conn.execute("UPDATE job_enrichments SET full_description='Changed posting' WHERE tenant_id='local'")
    elif change == "destination":
        conn.execute("UPDATE job_enrichments SET application_url='https://example.test/other' WHERE tenant_id='local'")
    else:
        state = svc.execute(
            "local",
            jobs[0],
            command(
                "capture",
                state,
                applicationId=state["applicationId"],
                question="Changed question" if change == "question" else state["question"],
                context="Changed context" if change == "context" else state["context"],
            ),
        )
    conn.commit()
    with pytest.raises(DeterminationFailure):
        svc.execute("local", jobs[0], command("use", state, text=state["accepted"]["text"], attested=True))
    read = svc.repository.read("local", jobs[0])
    assert read["questions"][0]["accepted"]["staleReason"]
    assert read["questions"][0]["accepted"]["text"] == state["accepted"]["text"]


def test_changed_source_during_model_call_is_fenced(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    model = StructuralModel(
        callback=lambda: conn.execute("UPDATE candidate_profiles SET version=2 WHERE tenant_id='local'")
    )
    with pytest.raises(DeterminationFailure, match="sources_changed"):
        service(conn, model).execute("local", jobs[0], command("edit", state, text="New text"))
    assert svc.repository.current("local", state["questionId"])["accepted"] == state["accepted"]


def test_competing_completion_expected_revision_and_idempotency(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = capture(svc, jobs[0])
    cmd = command("draft", state)
    completed = svc.execute("local", jobs[0], cmd)
    assert svc.execute("local", jobs[0], cmd) == completed
    with pytest.raises(DeterminationFailure, match="revision_conflict"):
        svc.execute("local", jobs[0], command("draft", state))
    with pytest.raises(DeterminationFailure, match="idempotency_conflict"):
        svc.execute("local", jobs[0], cmd.model_copy(update={"text": "foreign request"}))


def test_sensitive_selection_foreign_fact_and_missing_attestation(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = capture(svc, jobs[0])
    facts = svc.repository.read("local", jobs[0])["facts"]
    sensitive = next(fact["id"] for fact in facts if fact["sensitive"])
    with pytest.raises(DeterminationFailure, match="sensitive_consent"):
        svc.execute("local", jobs[0], command("draft", state, selectedFactIds=[sensitive]))
    with pytest.raises(DeterminationFailure, match="foreign_fact"):
        svc.execute("local", jobs[0], command("draft", state, selectedFactIds=["foreign"]))
    drafted = svc.execute(
        "local", jobs[0], command("draft", state, selectedFactIds=[sensitive], sensitiveFactIds=[sensitive])
    )
    assert drafted["draft"]["binding"]["facts"][0]["id"] == sensitive
    accepted = svc.execute("local", jobs[0], command("review", drafted, decision="approved"))
    with pytest.raises(DeterminationFailure, match="attestation_required"):
        svc.execute("local", jobs[0], command("use", accepted, text="Used text"))


def test_tenant_isolation_and_foreign_application_refusal(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    assert svc.repository.read("other", jobs[0])["questions"] == []
    assert svc.repository.read("other", jobs[0])["library"] == []
    with pytest.raises(DeterminationFailure, match="not_found"):
        svc.execute("other", jobs[0], command("draft", state))
    with pytest.raises(DeterminationFailure, match="foreign_context"):
        svc.execute(
            "local",
            jobs[1],
            command("capture", state, applicationId=state["applicationId"], question="Question", context="Context"),
        )


def test_persistence_rollback_preserves_library_and_review(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    state = svc.execute("local", jobs[0], command("edit", state, text="New draft"))
    before = conn.execute("SELECT * FROM job_events").fetchall()
    conn.execute(
        "CREATE TEMP TRIGGER fail_library BEFORE INSERT ON job_events WHEN NEW.entity_kind='screening_library' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
    )
    conn.commit()
    with pytest.raises(DeterminationFailure, match="persistence_failed"):
        svc.execute("local", jobs[0], command("review", state, decision="approved"))
    assert conn.execute("SELECT * FROM job_events WHERE entity_kind != 'screening_failure'").fetchall() == before


def test_identical_inputs_use_persisted_authority_with_zero_extra_calls(workspace):
    conn, jobs, _ = workspace
    model = StructuralModel()
    checks = []

    def preflight():
        assert current_llm_lane() == "apply"
        checks.append(True)

    svc = service(conn, model, preflight)
    state = capture(svc, jobs[0])
    state = svc.execute("local", jobs[0], command("draft", state))
    count = len(model.calls)
    svc.execute("local", jobs[0], command("draft", state))
    assert len(model.calls) == count == len(checks) == 4


def test_missing_current_sources_keep_accepted_history_inspectable(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    conn.execute("UPDATE job_enrichments SET full_description=NULL WHERE tenant_id='local'")
    conn.commit()
    read = svc.repository.read("local", jobs[0])
    assert read["sourceFailure"] == "screening_posting_unavailable"
    assert read["questions"][0]["accepted"]["text"] == state["accepted"]["text"]
    assert read["questions"][0]["accepted"]["staleReason"] == "screening_posting_unavailable"


def test_material_content_changed_without_version_bump_is_stale(workspace):
    conn, jobs, root = workspace
    path = root / "synthetic-artifact.txt"
    path.write_bytes(b"Owned source")
    conn.execute(
        "INSERT INTO job_materials(tenant_id,job_id,generation,status,created_at,updated_at) VALUES('local',?,1,'succeeded','2026-10-08','2026-10-08')",
        (jobs[0],),
    )
    conn.execute(
        "INSERT INTO job_materials_artifacts(tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) VALUES('local',?,1,'resume_text','owned-artifact','approved',?,'text','2026-10-08')",
        (jobs[0], str(path)),
    )
    conn.commit()
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    path.write_bytes(b"Changed source bytes")
    with pytest.raises(DeterminationFailure, match="sources_changed"):
        svc.execute("local", jobs[0], command("review", state, decision="approved"))
    assert svc.repository.read("local", jobs[0])["questions"][0]["accepted"]["text"] == state["accepted"]["text"]


def test_competing_question_write_during_model_call_blocks_completion(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])

    def compete():
        svc.execute(
            "local",
            jobs[0],
            command(
                "capture",
                state,
                applicationId=state["applicationId"],
                question="New authored question",
                context="New context",
            ),
        )

    model = StructuralModel(callback=compete)
    with pytest.raises(DeterminationFailure, match="revision_conflict"):
        service(conn, model).execute("local", jobs[0], command("edit", state, text="Competing edit"))
    latest = svc.repository.current("local", state["questionId"])
    assert latest["accepted"] == state["accepted"]
    assert latest["question"] == "New authored question"
    assert len(model.calls) == 1


def test_idempotency_keys_are_tenant_scoped(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    cmd = ScreeningCommand(
        action="capture",
        applicationId="attempt",
        question="Question",
        context="Context",
        idempotencyKey="same-user-key",
        expectedRevision=0,
    )
    first = svc.execute("local", jobs[0], cmd)
    second = svc.execute("other", jobs[0], cmd)
    assert first["questionId"] != second["questionId"]


def test_same_version_saved_fact_byte_change_is_fenced(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    conn.execute("UPDATE candidate_profile_experience_entries SET title='  Synthetic title  ' WHERE tenant_id='local'")
    conn.commit()
    assert conn.execute("SELECT version FROM candidate_profiles WHERE tenant_id='local'").fetchone()[0] == 1
    with pytest.raises(DeterminationFailure, match="sources_changed"):
        svc.execute("local", jobs[0], command("use", state, text=state["accepted"]["text"], attested=True))


@pytest.mark.parametrize(
    "field,value", [("work_require_sponsorship", "Yes"), ("compensation_salary_expectation", "12345")]
)
def test_authorization_and_compensation_changes_fence_old_review_even_without_version_bump(workspace, field, value):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    # Literal known schema columns, no user-authored SQL or semantic classification.
    conn.execute(f"UPDATE candidate_profiles SET {field}=? WHERE tenant_id='local'", (value,))
    conn.commit()
    read = svc.repository.read("local", jobs[0])
    assert read["questions"][0]["accepted"]["staleReason"] == "screening_sources_changed"
    assert read["questions"][0]["accepted"]["text"] == state["accepted"]["text"]
    with pytest.raises(DeterminationFailure, match="sources_changed"):
        svc.execute("local", jobs[0], command("use", state, text=state["accepted"]["text"], attested=True))
    fresh = svc.execute("local", jobs[0], command("draft", state))
    assert svc.repository.read("local", jobs[0])["questions"][0]["accepted"]["staleReason"]
    svc.execute("local", jobs[0], command("review", fresh, decision="approved"))
    assert svc.repository.read("local", jobs[0])["questions"][0]["accepted"]["staleReason"] is None


def test_password_is_not_selectable_screening_evidence(workspace):
    conn, jobs, _ = workspace
    conn.execute(
        "UPDATE candidate_profiles SET personal_password='Owned synthetic forbidden credential' WHERE tenant_id='local'"
    )
    conn.commit()
    svc = service(conn)
    read = svc.repository.read("local", jobs[0])
    assert not any(fact["id"] == "profile:/personal/password" for fact in read["facts"])
    assert "Owned synthetic forbidden credential" not in json.dumps(read)
    state = capture(svc, jobs[0])
    with pytest.raises(DeterminationFailure, match="foreign_fact"):
        svc.execute(
            "local",
            jobs[0],
            command(
                "draft",
                state,
                selectedFactIds=["profile:/personal/password"],
                sensitiveFactIds=["profile:/personal/password"],
            ),
        )


def test_selected_sources_only_and_material_metadata_never_enters_model_prompt(workspace):
    conn, jobs, root = workspace
    path = root / "owned-source.txt"
    path.write_bytes(b"Secret artifact text outside deliberate facts")
    conn.execute(
        "INSERT INTO job_materials(tenant_id,job_id,generation,status,created_at,updated_at) VALUES('local',?,1,'succeeded','2026-10-08','2026-10-08')",
        (jobs[0],),
    )
    conn.execute(
        "INSERT INTO job_materials_artifacts(tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at,metadata_json) VALUES('local',?,1,'resume_text','artifact','approved',?,'text','2026-10-08',?)",
        (jobs[0], str(path), json.dumps({"private": "Unselected synthetic metadata"})),
    )
    conn.execute(
        "UPDATE candidate_profiles SET personal_full_name='Unselected synthetic person' WHERE tenant_id='local'"
    )
    conn.commit()
    model = StructuralModel()
    svc = service(conn, model)
    state = capture(svc, jobs[0])
    svc.execute("local", jobs[0], command("draft", state))
    prompts = json.dumps(model.calls)
    assert "Unselected synthetic" not in prompts
    assert "Secret artifact text" not in prompts
    assert str(path) not in prompts
    assert all(
        not any(source["source_id"].startswith("profile:") for source in call["sources"]) for call in model.calls
    )


def test_library_keeps_exact_origin_after_source_job_removal(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    # Explicit owned synthetic storage only. Simulate the job-owned event cascade.
    conn.execute("DELETE FROM job_events WHERE tenant_id='local' AND job_id=?", (jobs[0],))
    conn.execute("DELETE FROM job_enrichments WHERE tenant_id='local' AND job_id=?", (jobs[0],))
    conn.execute("DELETE FROM jobs WHERE tenant_id='local' AND job_id=?", (jobs[0],))
    conn.commit()
    read = svc.repository.read("local", jobs[1])
    assert read["library"][0]["originSnapshot"] == state
    assert read["library"][0]["answer"]["text"] == state["accepted"]["text"]


def test_changed_deliberate_selection_requires_fresh_human_review(workspace):
    conn, jobs, _ = workspace
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    fact = next(f["id"] for f in svc.repository.read("local", jobs[0])["facts"] if not f["sensitive"])
    drafted = svc.execute("local", jobs[0], command("draft", state, selectedFactIds=[fact]))
    read = svc.repository.read("local", jobs[0])
    assert read["questions"][0]["accepted"]["staleReason"] == "screening_selection_changed"
    assert drafted["accepted"]["text"] == state["accepted"]["text"]
    with pytest.raises(DeterminationFailure, match="selection_changed"):
        svc.execute("local", jobs[0], command("use", drafted, attested=True, text=state["accepted"]["text"]))
    accepted = svc.execute("local", jobs[0], command("review", drafted, decision="approved"))
    assert svc.repository.read("local", jobs[0])["questions"][0]["accepted"]["staleReason"] is None
    assert accepted["accepted"]["binding"]["facts"][0]["id"] == fact


def test_failed_material_candidate_does_not_invalidate_accepted_answer(workspace):
    conn, jobs, root = workspace
    path = root / "accepted-source.txt"
    path.write_bytes(b"Original accepted source")
    conn.execute(
        "INSERT INTO job_materials(tenant_id,job_id,generation,status,created_at,updated_at) VALUES('local',?,1,'approved','2026-10-08','2026-10-08')",
        (jobs[0],),
    )
    conn.execute(
        "INSERT INTO job_materials_artifacts(tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) VALUES('local',?,1,'resume_text','accepted','approved',?,'text','2026-10-08')",
        (jobs[0], str(path)),
    )
    conn.commit()
    svc = service(conn)
    state = reviewed(svc, jobs[0])
    conn.execute(
        "INSERT INTO job_materials(tenant_id,job_id,generation,status,created_at,updated_at) VALUES('local',?,2,'rejected','2026-10-08','2026-10-08')",
        (jobs[0],),
    )
    conn.execute(
        "INSERT INTO job_materials_artifacts(tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) VALUES('local',?,2,'resume_text','failed','rejected','/owned-absent-candidate','text','2026-10-08')",
        (jobs[0],),
    )
    conn.commit()
    read = svc.repository.read("local", jobs[0])
    assert read["questions"][0]["accepted"]["staleReason"] is None
    assert read["questions"][0]["accepted"]["text"] == state["accepted"]["text"]
    assert path.read_bytes() == b"Original accepted source"
