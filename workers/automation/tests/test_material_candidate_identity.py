"""A candidate attempt has an identity independent of prompt prose or outcome."""

from concurrent.futures import ThreadPoolExecutor
import json

import pytest

from jobctrl.domain.ports.llm import LlmMessage
from tests.test_artifact_determinations import connection, JOB_ID
from tests.test_material_review_history import ResumeReviews
from tests.test_materials_use_cases import request, resume_case
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository


def failing_case(monkeypatch, *, parse=False):
    conn = connection()
    use_case = resume_case(conn, ResumeReviews())
    monkeypatch.setattr("jobctrl.domain.materials.use_cases._tailored_resume_response_schema", lambda _: {})
    def fail(*args, **kwargs):
        if parse:
            raise json.JSONDecodeError("synthetic malformed reply", "", 0)
        raise RuntimeError("synthetic provider failure")
    monkeypatch.setattr(use_case, "_chat_json_payload", fail)
    def run(suffix="one", attempt=1):
        return use_case._run_candidate(
            messages=[LlmMessage(role="user", content="x" * 80 + suffix)],
            model="codex:synthetic", profile_snapshot=None, tailoring_plan=None,
            validation_mode="normal", job={}, attempt=attempt, employer_analysis=None,
            profile_evidence=None, audit_execution_id="owned-execution", durable_attempt=1,
        ).record
    return conn, run


@pytest.mark.parametrize("parse", [False, True])
@pytest.mark.parametrize("same_prompt", [False, True])
def test_distinct_attempts_keep_distinct_ids_with_identical_or_common_prefix_inputs(monkeypatch, parse, same_prompt):
    conn, run = failing_case(monkeypatch, parse=parse)
    try:
        first = run("one", 1)
        second = run("one" if same_prompt else "two", 2)
        assert first["candidate_id"] != second["candidate_id"]
        assert first["status"] == second["status"] == ("parse_error" if parse else "provider_error")
        assert (first["prompt_fingerprint"] == second["prompt_fingerprint"]) is same_prompt
        if not parse:
            assert first["provider_error"]["candidate_id"] == first["candidate_id"]
            assert second["provider_error"]["candidate_id"] == second["candidate_id"]
    finally:
        conn.close()


def test_parallel_candidate_admission_preserves_individual_ids(monkeypatch):
    conn, run = failing_case(monkeypatch)
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            records = list(pool.map(run, ["same"] * 16))
        assert len({r["candidate_id"] for r in records}) == 16
        assert len({r["prompt_fingerprint"] for r in records}) == 1
    finally:
        conn.close()


@pytest.mark.parametrize("same_body", [False, True])
def test_actual_retries_and_new_generations_persist_unambiguous_selected_candidate(tmp_path, same_body):
    conn = connection()
    try:
        model = ResumeReviews(final="pass", failures=2, constant=same_body)
        outcome = resume_case(conn, model, retries=2).execute(**request(tmp_path))
        assert outcome.materials.is_resume_approved
        audit = outcome.materials.metadata["tailoring_attempt_audit"]
        candidates = [c for a in audit["attempt_history"] for c in a["candidates"]]
        ids = [c["candidate_id"] for c in candidates]
        assert len(ids) == len(set(ids)) == 3
        selected = [c for c in candidates if c["candidate_id"] == audit["selected_candidate"]]
        assert len(selected) == 1 and selected[0]["status"] == "approved"
        durable = SqliteMaterialsRepository(conn).load(outcome.materials.tenant_id, JOB_ID)
        assert durable.metadata["tailoring_attempt_audit"]["selected_candidate"] == selected[0]["candidate_id"]
        second_model = ResumeReviews(final="pass", failures=2, constant=same_body)
        second = resume_case(conn, second_model, retries=2).execute(**request(tmp_path, retailor=True))
        assert second.materials.is_resume_approved
        second_id = second.materials.metadata["tailoring_attempt_audit"]["selected_candidate"]
        assert second_id not in ids
        first = SqliteMaterialsRepository(conn).load(outcome.materials.tenant_id, JOB_ID, generation=outcome.materials.generation)
        assert first.metadata["tailoring_attempt_audit"]["selected_candidate"] == selected[0]["candidate_id"]
    finally:
        conn.close()
