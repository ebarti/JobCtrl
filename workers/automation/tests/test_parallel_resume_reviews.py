"""Real review pool and source-bound résumé gates in owned synthetic databases."""
from __future__ import annotations

import copy
import json
import threading
from pathlib import Path

import pytest

from jobctrl import database
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.materials.letter_reviews import ParallelLetterReviews
from tests.test_materials_use_cases import (
    ResumeModel, canonical_scored_target, connection, request, resume_case,
)


@pytest.fixture(autouse=True)
def owned_review_pool(monkeypatch):
    from jobctrl.infrastructure.materials import letter_reviews
    monkeypatch.setattr(letter_reviews, "_pool", None)
    yield
    letter_reviews.close_letter_reviews()


def file_case(tmp_path, monkeypatch, model):
    filename = tmp_path / "owned.db"
    monkeypatch.setattr(database, "DB_PATH", filename)
    conn = database.get_connection(filename)
    source = connection()
    source.backup(conn)
    source.close()
    case = resume_case(conn, model)
    deps = dict(
        llm=model, repository=SqliteDeterminationRepository(conn), tenant_id="local",
        provider="fake", model="synthetic", lane="tailoring", preflight=lambda: None,
    )
    case._parallel_reviews = ParallelLetterReviews(filename.resolve(), deps)
    return conn, case, deps


def candidate(outcome):
    return outcome.report["attempt_history"][0]["candidates"][0]


def test_production_pool_overlaps_independent_resume_reviews_without_extra_quality_call(tmp_path, monkeypatch):
    both = threading.Barrier(2, timeout=3)
    threads = {}
    class Model(ResumeModel):
        reasoning_effort = "max"
        def chat_json(self, messages, *, response_schema, **kwargs):
            kind = response_schema["title"]
            if kind in {"ClaimVerification", "ArtifactQuality"}:
                threads[kind] = threading.get_ident()
                both.wait()
            return super().chat_json(messages, response_schema=response_schema, **kwargs)
    model = Model()
    conn, case, _deps = file_case(tmp_path, monkeypatch, model)
    parent = threading.get_ident()
    guards = []
    outcome = case.execute(**request(tmp_path), commit_guard=lambda: guards.append(threading.get_ident()))
    assert outcome.status == "approved"
    assert len(set(threads.values())) == 2 and parent not in threads.values()
    assert set(guards) == {parent}
    audit = candidate(outcome)
    assert audit["parallel_reviews"]["quality_usage"] == "used"
    assert audit["judge"]["determination_id"] == audit["parallel_reviews"]["quality_determination_id"]
    assert audit["claim_verification_id"] == audit["parallel_reviews"]["claim_verification_id"]
    assert sum(title == "ArtifactQuality" for title, _lane, _messages in model.calls) == 1
    for identity in (audit["claim_verification_id"], audit["judge"]["determination_id"]):
        receipt = json.loads(conn.execute(
            "SELECT envelope_json FROM semantic_determinations WHERE determination_id=?", (identity,),
        ).fetchone()[0])
        assert receipt["reasoning_effort"] == "max"
    conn.close()


@pytest.mark.parametrize("claims,quality", [("fail", "pass"), ("pass", "fail"), ("fail", "fail")])
def test_either_model_rejection_preserves_prior_materials_and_records_both_receipts(tmp_path, monkeypatch, claims, quality):
    conn, initial, deps = file_case(tmp_path, monkeypatch, ResumeModel(text="Original owned draft"))
    accepted = initial.execute(**request(tmp_path))
    prior = accepted.materials.tailored_resume
    prior_bytes = Path(prior.path).read_bytes()
    model = ResumeModel(verdict=claims, quality=quality, text="Changed owned draft")
    current = resume_case(conn, model)
    current._parallel_reviews = ParallelLetterReviews(
        (tmp_path / "owned.db").resolve(), {**deps, "llm": model},
    )
    outcome = current.execute(**request(tmp_path, retailor=True))
    assert outcome.status != "approved"
    current_approved = conn.execute(
        "SELECT artifact_id FROM job_materials_artifacts WHERE artifact_type='tailored_resume' AND status='approved' ORDER BY generation DESC LIMIT 1",
    ).fetchone()
    assert current_approved[0] == prior.artifact_id
    assert Path(prior.path).read_bytes() == prior_bytes
    audit = candidate(outcome)
    pair = audit["parallel_reviews"]
    assert all(conn.execute(
        "SELECT 1 FROM semantic_determinations WHERE determination_id=?", (pair[key],),
    ).fetchone() for key in ("claim_verification_id", "quality_determination_id"))
    assert pair["quality_usage"] == ("used" if claims == "pass" else "not_used_candidate_rejected")
    conn.close()


def test_changed_complete_quality_context_requires_a_fresh_model_verdict(tmp_path, monkeypatch):
    class Model(ResumeModel):
        def chat_json(self, messages, *, response_schema, **kwargs):
            if response_schema["title"] == "ArtifactQuality":
                context = json.loads(messages[1].content)["context"]["rubric"]
                self.quality = "fail" if "owned_context_version" in context else "pass"
            return super().chat_json(messages, response_schema=response_schema, **kwargs)
    model = Model()
    conn, case, _deps = file_case(tmp_path, monkeypatch, model)
    original, calls = case._resume_quality_request, []
    def changed(**kwargs):
        value = original(**kwargs)
        calls.append(None)
        if len(calls) > 1:
            value["rubric"] = {**value["rubric"], "owned_context_version": "changed"}
        return value
    case._resume_quality_request = changed
    outcome = case.execute(**request(tmp_path))
    audit = candidate(outcome)
    assert not outcome.materials.is_resume_approved
    assert audit["parallel_reviews"]["quality_usage"] == "not_used_request_changed"
    assert audit["judge"]["determination_id"] != audit["parallel_reviews"]["quality_determination_id"]
    assert audit["judge"]["result"]["verdict"] == "fail"
    assert sum(title == "ArtifactQuality" for title, _lane, _messages in model.calls) == 2
    conn.close()


def test_high_fit_still_requires_the_six_persona_receipt_after_both_reviews(tmp_path, monkeypatch):
    model = ResumeModel()
    conn, case, _deps = file_case(tmp_path, monkeypatch, model)
    arguments = request(tmp_path)
    arguments["job"] = canonical_scored_target(conn, 8)
    outcome = case.execute(**arguments)
    assert outcome.status == "approved"
    audit = candidate(outcome)
    assert audit["parallel_reviews"]["quality_usage"] == "used"
    receipt = conn.execute(
        "SELECT envelope_json FROM semantic_determinations WHERE kind='resume_adversarial'",
    ).fetchone()
    assert len(json.loads(receipt[0])["result"]["personas"]) == 6
    order = [title for title, _lane, _messages in model.calls]
    assert order.index("ResumeAdversarialReview") > order.index("ClaimVerification")
    assert order.index("ResumeAdversarialReview") > order.index("ArtifactQuality")
    conn.close()


def test_each_quality_input_participates_in_the_reuse_fingerprint():
    from jobctrl.domain.determinations import Source
    from jobctrl.domain.materials.use_cases import _quality_request_fingerprint
    from jobctrl.domain.ports.claim_verification import ArtifactLine
    request = dict(
        artifact_kind="resume", entity_id="owned",
        lines=[ArtifactLine(line_id="owned", text="Owned line", allowed_evidence_ids=["owned-source"], allowed_requirement_ids=[])],
        sources=[Source(source_id="owned-source", text="Owned source")], rubric={"version": "one"},
    )
    initial = _quality_request_fingerprint(request)
    for key in request:
        changed = copy.deepcopy(request)
        if key in {"artifact_kind", "entity_id"}:
            changed[key] = "different"
        elif key == "lines":
            changed[key][0] = changed[key][0].model_copy(update={"allowed_evidence_ids": []})
        elif key == "sources":
            changed[key][0] = changed[key][0].model_copy(update={"text": "Changed source"})
        else:
            changed[key]["version"] = "two"
        assert _quality_request_fingerprint(changed) != initial
    assert _quality_request_fingerprint(request) == initial



def test_parent_cancellation_drains_both_admitted_reviews_and_preserves_accepted_bytes(tmp_path, monkeypatch):
    from jobctrl.domain.determinations import DeterminationFailure

    conn, initial, deps = file_case(tmp_path, monkeypatch, ResumeModel(text="Original owned draft"))
    accepted = initial.execute(**request(tmp_path))
    prior = accepted.materials.tailored_resume
    before = Path(prior.path).read_bytes()
    both, release, entered = threading.Barrier(2, timeout=3), threading.Event(), threading.Event()
    active, lock = [], threading.Lock()
    class CanceledModel(ResumeModel):
        def chat_json(self, messages, *, response_schema, **kwargs):
            if response_schema["title"] in {"ClaimVerification", "ArtifactQuality"}:
                with lock:
                    active.append(response_schema["title"])
                try:
                    both.wait()
                    entered.set()
                    assert release.wait(timeout=3)
                    return super().chat_json(messages, response_schema=response_schema, **kwargs)
                finally:
                    with lock:
                        active.remove(response_schema["title"])
            return super().chat_json(messages, response_schema=response_schema, **kwargs)
    model = CanceledModel(text="Changed owned draft")
    case = resume_case(conn, model)
    case._parallel_reviews = ParallelLetterReviews(
        (tmp_path / "owned.db").resolve(), {**deps, "llm": model},
    )
    def guard():
        if entered.is_set():
            release.set()
            raise DeterminationFailure("owner_canceled")
    with pytest.raises(DeterminationFailure, match="owner_canceled"):
        case.execute(**request(tmp_path, retailor=True), commit_guard=guard)
    assert release.is_set() and active == []
    assert Path(prior.path).read_bytes() == before
    assert conn.execute("SELECT status FROM job_materials_artifacts WHERE artifact_id=?", (prior.artifact_id,)).fetchone()[0] == "approved"
    conn.close()


def test_resume_factory_enrolls_only_default_file_backed_review_ports(tmp_path, monkeypatch):
    from jobctrl.infrastructure import determinations
    from jobctrl.scoring import tailor
    from jobctrl.domain.materials.use_cases import TailoringLlmPolicy

    model = ResumeModel()
    conn, _case, deps = file_case(tmp_path, monkeypatch, model)
    monkeypatch.setattr(tailor, "get_connection", lambda: conn)
    monkeypatch.setattr(determinations, "determination_dependencies", lambda *_args, **_kwargs: deps)
    monkeypatch.setattr(tailor.config, "get_resume_voice_polish_enabled", lambda: False)
    arguments = dict(llm_port=model, analyze_use_case=object(), evidence_selector=object(),
                     llm_policy=TailoringLlmPolicy(candidate_models=("default",), judge_model="default"))
    normal = tailor._build_use_case(**arguments)
    assert isinstance(normal._parallel_reviews, ParallelLetterReviews)
    assert normal._parallel_reviews._dependencies["model"] == deps["model"]
    custom = tailor._build_use_case(**arguments, quality_judge=object())
    assert custom._parallel_reviews is None
    memory = connection()
    monkeypatch.setattr(tailor, "get_connection", lambda: memory)
    assert tailor._build_use_case(**arguments)._parallel_reviews is None
    memory.close()
    conn.close()
