"""Finite provider responses, model authority and historical receipt readability."""
from __future__ import annotations

from copy import deepcopy
import json
import sqlite3

import pytest
from pydantic import ValidationError

from jobctrl.domain.determinations import DeterminationFailure, DeterminationEnvelope, Source, validate_citations
from jobctrl.domain.materials.artifact_quality import ModelArtifactQualityJudge
from jobctrl.domain.materials.adversarial import ADVERSARIAL_REVIEW_PERSONAS
from jobctrl.domain.ports.claim_verification import ArtifactLine
from jobctrl.domain.ports.resume_adversarial import ResumeAdversarialResponse, ResumeAdversarialReview
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from tests.determination_fakes import persona_decision


@pytest.fixture
def dependencies(tmp_path):
    connection = sqlite3.connect(tmp_path / "owned-review.sqlite")
    connection.row_factory = sqlite3.Row
    create_exact_v14_schema(connection)
    yield connection, SqliteDeterminationRepository(connection)
    connection.close()


def request():
    return dict(entity_id="owned-job", lines=[ArtifactLine(
        line_id="owned-line", text="Owned source text", allowed_evidence_ids=[], allowed_requirement_ids=[],
    )], sources=[Source(source_id="owned-source", text="Owned source text")], rubric={})


class ResponseModel:
    provider_id, model, reasoning_effort = "fake", "synthetic", "max"

    def __init__(self, verdict="pass", mutate=lambda result: None):
        self.verdict, self.mutate, self.calls = verdict, mutate, []

    def chat_json(self, messages, *, response_schema):
        self.calls.append((response_schema, messages))
        result = persona_decision(json.loads(messages[1].content), self.verdict)
        result["score"] = 0.01 if self.verdict == "pass" else 0.99
        self.mutate(result)
        return result


def judge(repository, model):
    return ModelArtifactQualityJudge(
        llm=model, repository=repository, tenant_id="local", provider="fake",
        model="synthetic", lane="tailoring", preflight=lambda: None,
    )


def assert_finite_shape(node):
    if node.get("type") == "array":
        assert node["maxItems"] > 0
    if node.get("type") == "string" and "enum" not in node and "const" not in node:
        assert node["maxLength"] > 0
    for value in node.values():
        if isinstance(value, dict):
            assert_finite_shape(value)
        elif isinstance(value, list):
            for child in value:
                if isinstance(child, dict):
                    assert_finite_shape(child)


@pytest.mark.parametrize("verdict", ["pass", "fail"])
def test_bounded_response_preserves_all_persona_verdicts_and_source_binding(dependencies, verdict):
    _, repository = dependencies
    model = ResponseModel(verdict)
    result, envelope = judge(repository, model).review_adversarial(**request())
    assert result.verdict == verdict
    assert len(result.personas) == 6
    assert all(row.verdict == verdict for row in result.personas)
    assert len(model.calls) == 1
    schema = model.calls[0][0]
    assert schema["properties"]["personas"]["minItems"] == schema["properties"]["personas"]["maxItems"] == 6
    assert_finite_shape(schema)
    assert envelope.prompt_version == "resume-adversarial-v3"
    assert envelope.reasoning_effort == "max"
    stored = repository.find("local", envelope.determination_id)
    assert stored.result == result.model_dump()
    assert ResumeAdversarialReview.model_validate(stored.result).model_dump() == stored.result
    validate_citations(result, [Source(source_id="line:owned-line", text="Owned source text")])


def oversized_response(result, field):
    persona = result["personas"][0]
    if field == "rationale":
        persona["rationale"] = "X" * 513
    elif field == "citations":
        persona["citations"] *= 4
    elif field == "quote":
        persona["citations"][0]["quote"] = "X" * 241
    elif field == "exact_value":
        persona["citations"][0]["exact_values"] = ["X" * 65]
    elif field == "exact_value_count":
        persona["citations"][0]["exact_values"] = ["X"] * 5
    elif field == "findings":
        result["verdict"] = persona["verdict"] = "fail"
        persona["findings"] = [{
            "line_id": "owned-line", "category": "clarity", "citation": deepcopy(persona["citations"][0]),
            "rationale": "Owned model rejection", "repair_instruction": "Owned repair instruction",
        }] * 7


@pytest.mark.parametrize("field", ["rationale", "citations", "quote", "exact_value", "exact_value_count", "findings"])
def test_oversized_refresh_is_rejected_without_replacing_accepted_receipt(dependencies, field):
    connection, repository = dependencies
    accepted_model = ResponseModel()
    _, accepted = judge(repository, accepted_model).review_adversarial(**request())
    saved = connection.execute("SELECT envelope_json FROM semantic_determinations WHERE determination_id=?",
                               (accepted.determination_id,)).fetchone()[0]
    refresh = ResponseModel(mutate=lambda result: oversized_response(result, field))
    changed_request = request()
    changed_request["rubric"] = {"revision": "owned changed request"}
    with pytest.raises(DeterminationFailure, match="schema_violation"):
        judge(repository, refresh).review_adversarial(**changed_request)
    assert len(refresh.calls) == 3
    assert connection.execute("SELECT envelope_json FROM semantic_determinations WHERE determination_id=?",
                              (accepted.determination_id,)).fetchone()[0] == saved
    assert repository.find("local", accepted.determination_id).result == accepted.result


def test_historical_accepted_review_keeps_its_original_diagnostics(dependencies):
    _, repository = dependencies
    source_text = "X" * 65 + " " + "Y" * 434
    data = {"sources": [{"source_id": "line:owned-line", "text": source_text}],
            "context": {"personas": ADVERSARIAL_REVIEW_PERSONAS}}
    result = persona_decision(data)
    for persona in result["personas"]:
        persona["rationale"] = "R" * 600
        persona["citations"] = [{"source_id": "line:owned-line", "quote": source_text[:300],
                                  "exact_values": ["X" * 65]}] * 4
    legacy = DeterminationEnvelope(
        determination_id="a" * 64, input_fingerprint="a" * 64, tenant_id="local", entity_id="owned-job",
        kind="resume_adversarial", schema_version="1", prompt_version="resume-adversarial-v2",
        provider="fake", model="synthetic", lane="tailoring", created_at="2026-10-01T00:00:00+00:00",
        result=result,
    )
    repository.save(legacy)
    stored = repository.find("local", legacy.determination_id)
    accepted = ResumeAdversarialReview.model_validate(stored.result)
    validate_citations(accepted, [Source(source_id="line:owned-line", text=source_text)])
    assert accepted.model_dump() == result
    with pytest.raises(ValidationError):
        ResumeAdversarialResponse.model_validate(stored.result)
