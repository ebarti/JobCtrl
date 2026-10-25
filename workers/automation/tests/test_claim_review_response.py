"""Compact transport retains source-bound model authority and canonical receipts."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import sqlite3
from threading import Barrier

import pytest

from jobctrl.domain.determinations import DeterminationFailure, Source, validate_citations
from jobctrl.domain.materials.claim_review_response import claim_review_response_model
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.domain.ports.claim_verification import ArtifactLine, ClaimVerification
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository, read_artifact_anchors
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.llm_lanes import current_llm_lane
from tests.determination_fakes import claim_verification_input, claim_verification_response


@pytest.fixture
def repository(tmp_path):
    connection = sqlite3.connect(tmp_path / "owned.sqlite")
    connection.row_factory = sqlite3.Row
    create_exact_v14_schema(connection)
    yield SqliteDeterminationRepository(connection)
    connection.close()


def request():
    return dict(
        artifact_kind="resume", entity_id="owned-job", rubric={},
        lines=[ArtifactLine(line_id=f"line-{index}", text="Delivered 3 units",
                            allowed_evidence_ids=[f"fact-{index}"],
                            allowed_requirement_ids=[f"requirement-{index}"])
               for index in (1, 2)],
        evidence=[Source(source_id=f"fact-{index}", text="Authored 3 units") for index in (1, 2)],
        requirements=[Source(source_id=f"requirement-{index}", text="Deliver 3 units") for index in (1, 2)],
    )


def decision(data, verdict="pass"):
    data = claim_verification_input(data)
    sources = {row["source_id"]: row["text"] for row in data["sources"]}
    def citation(ident):
        return dict(source_id=ident, quote=sources[ident], exact_values=[])
    rows = []
    for line in data["context"]["lines"]:
        evidence = [citation(ident) for ident in line["allowed_evidence_ids"]]
        final = citation("line:" + line["line_id"])
        rows.append(dict(
            line_id=line["line_id"], verdict=verdict, source_evidence=evidence,
            served_requirements=[dict(requirement_id=ident, citation=citation(ident),
                                      rationale="Explicit synthetic requirement judgment")
                                 for ident in line["allowed_requirement_ids"]],
            claims=[dict(kind="candidate_fact", support="supported" if verdict == "pass" else "uncertain",
                         text=final, evidence=evidence, rationale="Explicit synthetic support judgment")],
            findings=[] if verdict == "pass" else [dict(kind="unsupported_claim", citation=final,
                                                        rationale="Explicit synthetic rejection")],
        ))
    return dict(verdict=verdict, lines=rows, rationale="Explicit synthetic verdict")


class Model:
    reasoning_effort = "max"

    def __init__(self, verdict="pass", *, whole=True, mutate=None, after_call=None):
        self.verdict, self.whole = verdict, whole
        self.mutate, self.after_call, self.calls = mutate, after_call, []

    def chat_json(self, messages, *, response_schema):
        assert current_llm_lane() == "tailoring"
        data = json.loads(messages[1].content)
        expected = decision(data, self.verdict)
        result = claim_verification_response(data, expected, whole_sources=self.whole)
        if self.mutate:
            self.mutate(result, data)
        self.calls.append((data, deepcopy(result), response_schema))
        if self.after_call:
            self.after_call()
        return result


def verifier(repository, model, admissions=None):
    def preflight():
        assert current_llm_lane() == "tailoring"
        if admissions is not None:
            admissions.append(True)
    return ModelClaimVerifier(llm=model, repository=repository, tenant_id="local", provider="fake",
                              model="synthetic", lane="tailoring", preflight=preflight)


@pytest.mark.parametrize("whole", [False, True])
@pytest.mark.parametrize("verdict", ["pass", "fail"])
def test_both_formats_keep_every_model_decision_and_full_canonical_receipt(repository, whole, verdict):
    model, admissions = Model(verdict, whole=whole), []
    result, envelope = verifier(repository, model, admissions).verify(**request())
    data, wire, schema = model.calls[0]
    assert envelope.result == result.model_dump() == decision(data, verdict)
    assert ClaimVerification.model_validate(envelope.result).model_dump() == envelope.result
    assert repository.find("local", envelope.determination_id).result == envelope.result
    assert envelope.prompt_version == "claim-verification-v4-grounded-span-references"
    assert envelope.schema_version == "2" and envelope.reasoning_effort == "max"
    assert admissions == [True]
    assert isinstance(wire["lines"][0]["source_evidence"][0], str) == whole
    assert len(json.dumps(wire)) < len(json.dumps(envelope.result))
    assert schema["$defs"]["ClaimCitationSpan"]["properties"]["source_id"]["enum"] == list(data["context"]["citation_refs"])
    assert "Citation" not in schema["$defs"]
    for original, supplied in zip(request()["lines"], data["context"]["lines"], strict=True):
        refs = data["context"]["citation_refs"]
        assert [refs[ident]["source_id"] for ident in supplied["allowed_evidence_ids"]] == original.allowed_evidence_ids
        assert [refs[ident]["source_id"] for ident in supplied["allowed_requirement_ids"]] == original.allowed_requirement_ids
        assert refs[supplied["line_source_id"]]["source_id"] == "line:" + original.line_id
    validate_citations(result, [Source(**source) for source in data["sources"]])
    cached, receipt = verifier(repository, model, admissions).verify(**request())
    assert cached == result and receipt == envelope
    assert len(model.calls) == len(admissions) == 1


def test_explicit_spans_preserve_literal_value_assertions(repository):
    def add_values(result, data):
        row = result["lines"][0]
        row["claims"][0]["text"]["exact_values"] = ["3"]
        row["claims"][0]["evidence"][0]["exact_values"] = ["3"]
    result, receipt = verifier(repository, Model(whole=False, mutate=add_values)).verify(**request())
    assert result.lines[0].claims[0].text.exact_values == ["3"]
    assert result.lines[0].claims[0].evidence[0].exact_values == ["3"]
    assert receipt.result["lines"][0]["claims"][0]["evidence"][0]["exact_values"] == ["3"]


def corrupt(result, data, fault):
    refs = {entry["source_id"]: key for key, entry in data["context"]["citation_refs"].items()}
    row = result["lines"][0]
    if fault == "unknown":
        row["source_evidence"] = ["@unknown"]
    elif fault == "foreign_evidence":
        row["source_evidence"] = [refs["fact-2"]]
    elif fault == "wrong_line":
        row["claims"][0]["text"]["source_id"] = refs["line:line-2"]
    elif fault == "legacy_id":
        row["claims"][0]["text"]["source_id"] = "line:line-1"
    elif fault == "wrong_requirement":
        row["served_requirements"][0]["citation"] = refs["fact-1"]
    elif fault == "non_verbatim":
        row["claims"][0]["text"]["quote"] = "Absent span"
    elif fault == "exact_value":
        row["claims"][0]["text"]["exact_values"] = ["4"]
    elif fault in {"oversized", "empty"}:
        row["source_evidence"] = [refs["fact-1"]]
    elif fault == "claim_reference":
        row["claims"][0]["text"] = refs["line:line-1"]
    elif fault == "finding_reference":
        result["verdict"] = row["verdict"] = "fail"
        row["findings"] = [dict(kind="voice", rationale="Explicit model finding",
                                citation=refs["line:line-1"])]
    elif fault == "extra_field":
        row["claims"][0]["text"]["unrequested"] = True
    elif fault != "numeric":
        raise AssertionError(fault)


@pytest.mark.parametrize("fault,code", [
    ("unknown", "foreign_source_id"), ("foreign_evidence", "foreign_source_id"),
    ("wrong_line", "claim_line_binding_invalid"), ("legacy_id", "foreign_source_id"),
    ("wrong_requirement", "requirement_binding_invalid"), ("non_verbatim", "non_verbatim_quote"),
    ("exact_value", "mismatched_value"), ("numeric", "mismatched_value"),
    ("oversized", "schema_violation"), ("empty", "schema_violation"),
    ("claim_reference", "schema_violation"), ("finding_reference", "schema_violation"),
    ("extra_field", "schema_violation"),
])
def test_invalid_refresh_consumes_only_existing_budget_and_preserves_receipt(repository, fault, code):
    _, accepted = verifier(repository, Model()).verify(**request())
    original = repository._connection.execute("SELECT envelope_json FROM semantic_determinations WHERE determination_id=?",
                                             (accepted.determination_id,)).fetchone()[0]
    changed = request()
    changed["rubric"] = {"revision": "Explicit refresh"}
    if fault in {"numeric", "oversized", "empty"}:
        changed["evidence"][0].text = {"numeric": "Authored 4 units", "oversized": "X" * 4001, "empty": ""}[fault]
    model = Model(mutate=lambda result, data: corrupt(result, data, fault))
    admissions = []
    with pytest.raises(DeterminationFailure, match=code):
        verifier(repository, model, admissions).verify(**changed)
    assert len(model.calls) == len(admissions) == 3
    assert repository._connection.execute("SELECT envelope_json FROM semantic_determinations WHERE determination_id=?",
                                         (accepted.determination_id,)).fetchone()[0] == original
    assert repository._connection.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 1


def test_structural_repair_keeps_reference_format_and_repeats_preflight(repository):
    model = Model()
    def first_fault(result, data):
        if not model.calls:
            result["lines"][0]["source_evidence"] = ["@unknown"]
    model.mutate = first_fault
    admissions = []
    result, receipt = verifier(repository, model, admissions).verify(**request())
    assert result.verdict == "pass"
    assert len(model.calls) == len(admissions) == 2
    assert receipt.result == decision(model.calls[-1][0])


def test_changed_sources_never_reuse_an_old_receipt_and_caller_mutation_cannot_rebind(repository):
    arguments = request()
    def mutate_caller():
        arguments["evidence"][0].text = "Unrelated changed evidence"
        arguments["lines"][0].allowed_evidence_ids.clear()
    model = Model(after_call=mutate_caller)
    first, receipt = verifier(repository, model).verify(**arguments)
    assert first.lines[0].source_evidence[0].quote == "Authored 3 units"
    assert receipt.result == decision(model.calls[0][0])
    changed = request()
    changed["evidence"][0].text = "Another authored 3 units"
    second_model = Model()
    second, second_receipt = verifier(repository, second_model).verify(**changed)
    assert second_receipt.determination_id != receipt.determination_id
    assert second.lines[0].source_evidence[0].quote == "Another authored 3 units"
    assert len(second_model.calls) == 1


def test_request_local_reference_maps_cannot_cross_during_parallel_decoding():
    barrier = Barrier(2)
    def decode(text):
        sources = [Source(source_id="fact", text=text)]
        response, refs = claim_review_response_model(sources)
        sources[0].text = "Changed caller value"
        ref = next(iter(refs))
        barrier.wait(timeout=5)
        result = response.model_validate(dict(verdict="pass", rationale="Explicit model verdict", lines=[dict(
            line_id="owned", verdict="pass", source_evidence=[ref], served_requirements=[], claims=[], findings=[],
        )]))
        return result.lines[0].source_evidence[0].quote
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(decode, ["First immutable source", "Second immutable source"])) == [
            "First immutable source", "Second immutable source",
        ]


def test_aliases_are_unambiguous_even_when_source_ids_resemble_references():
    sources = [Source(source_id="@0/0", text="First"), Source(source_id="@1/0", text="Second")]
    _, refs = claim_review_response_model(sources)
    assert set(refs).isdisjoint(source.source_id for source in sources)
    assert {entry["source_id"] for entry in refs.values()} == {source.source_id for source in sources}


@pytest.mark.parametrize("version", ["claim-verification-v2", "claim-verification-v3"])
def test_accepted_artifact_readers_keep_historical_and_current_receipts(tmp_path, version):
    from tests.test_artifact_determinations import JOB_ID, Model as ArtifactModel, connection, cover_case, cover_request, seed_resume
    conn = connection()
    seed_resume(conn, tmp_path)
    outcome = cover_case(conn, ArtifactModel()).execute(**cover_request(tmp_path))
    artifact = outcome.materials.cover_letter
    repository = SqliteDeterminationRepository(conn)
    receipt = repository.find("local", artifact.metadata["claim_verification_id"])
    ident = "a" * 64 if version.endswith("v2") else "b" * 64
    historical = receipt.model_copy(update=dict(prompt_version=version, determination_id=ident, input_fingerprint=ident))
    repository.save(historical)
    conn.execute("UPDATE artifact_line_anchors SET determination_id=? WHERE artifact_id=?", (ident, artifact.artifact_id))
    assert read_artifact_anchors(conn, tenant_id="local", artifact_id=artifact.artifact_id,
                                 generation=conn.execute("SELECT generation FROM job_materials_artifacts WHERE artifact_id=?", (artifact.artifact_id,)).fetchone()[0], expected_job_id=str(JOB_ID)) == {
        "body:1": {"evidence_ids": ["fact"], "requirement_ids": []},
    }
    conn.close()


def span_request(quote="Authored 3\u00a0units"):
    arguments = request()
    arguments["evidence"][0].text = "Unrelated context. " * 250 + "Authored 3\u00a0units. More context."
    arguments["supporting_spans"] = [Source(source_id="fact-1", text=quote)]
    return arguments


def select_span(result, data):
    reference = next(ref for ref, entry in data["context"]["citation_refs"].items()
                     if "span_reference_quote" in entry)
    row = result["lines"][0]
    row["source_evidence"] = [reference]
    row["claims"][0]["evidence"] = [reference]
    return reference


@pytest.mark.parametrize("verdict", ["pass", "fail"])
def test_selected_supporting_span_retains_exact_unicode_source_and_model_verdict(repository, verdict):
    arguments, admissions = span_request(), []
    model = Model(verdict, mutate=select_span)
    result, receipt = verifier(repository, model, admissions).verify(**arguments)
    data, wire, schema = model.calls[0]
    refs = data["context"]["citation_refs"]
    selected = wire["lines"][0]["source_evidence"][0]
    assert refs[selected]["source_id"] == "fact-1"
    assert refs[selected]["span_reference_quote"] == "Authored 3\u00a0units"
    assert not refs[selected]["whole_source_reference_allowed"]
    assert result.verdict == receipt.result["verdict"] == verdict
    assert result.lines[0].claims[0].support == ("supported" if verdict == "pass" else "uncertain")
    assert result.lines[0].source_evidence[0].model_dump() == {
        "source_id": "fact-1", "quote": "Authored 3\u00a0units", "exact_values": [],
    }
    assert result.lines[0].claims[0].evidence == result.lines[0].source_evidence
    assert receipt.result == ClaimVerification.model_validate(receipt.result).model_dump()
    assert admissions == [True] and len(model.calls) == 1
    # Aliases retain the original allowlist and cannot become explicit line IDs.
    assert refs[data["context"]["lines"][0]["allowed_evidence_ids"][0]]["source_id"] == "fact-1"
    assert selected not in schema["$defs"]["ClaimCitationSpan"]["properties"]["source_id"]["enum"]
    validate_citations(result, [Source(**source) for source in data["sources"]])
    cached, cached_receipt = verifier(repository, model, admissions).verify(**arguments)
    assert cached == result and cached_receipt == receipt
    assert len(model.calls) == len(admissions) == 1


@pytest.mark.parametrize("source_id,quote,code", [
    ("foreign", "Authored 3\u00a0units", "foreign_source_id"),
    ("fact-1", "Authored 4 units", "non_verbatim_quote"),
    ("fact-1", "", "non_verbatim_quote"),
])
def test_invalid_supporting_span_never_reaches_provider(repository, source_id, quote, code):
    arguments = span_request()
    arguments["supporting_spans"] = [Source(source_id=source_id, text=quote)]
    model, admissions = Model(), []
    with pytest.raises(DeterminationFailure, match=code):
        verifier(repository, model, admissions).verify(**arguments)
    assert model.calls == admissions == []


def test_changed_span_fences_cache_and_caller_mutation_cannot_rebind_it(repository):
    arguments = span_request()
    model = Model(mutate=select_span, after_call=lambda: setattr(arguments["supporting_spans"][0], "text", "3\u00a0units"))
    first, first_receipt = verifier(repository, model).verify(**arguments)
    second_model = Model(mutate=select_span)
    second, second_receipt = verifier(repository, second_model).verify(**arguments)
    assert first.lines[0].source_evidence[0].quote == "Authored 3\u00a0units"
    assert second.lines[0].source_evidence[0].quote == "3\u00a0units"
    assert first_receipt.determination_id != second_receipt.determination_id
    assert len(model.calls) == len(second_model.calls) == 1


@pytest.mark.parametrize("fault,code", [
    ("foreign_line", "foreign_source_id"),
    ("changed_number", "mismatched_value"),
    ("claim_reference", "schema_violation"),
    ("span_as_explicit_source", "foreign_source_id"),
])
def test_span_references_keep_permissions_values_and_failed_refresh_preservation(repository, fault, code):
    _, accepted = verifier(repository, Model()).verify(**request())
    accepted_json = repository._connection.execute(
        "SELECT envelope_json FROM semantic_determinations WHERE determination_id=?", (accepted.determination_id,),
    ).fetchone()[0]
    arguments = span_request()
    if fault == "changed_number":
        arguments["lines"][0].text = "Delivered 4 units"

    def corrupt_span(result, data):
        reference = select_span(result, data)
        row = result["lines"][0]
        if fault == "foreign_line":
            result["lines"][1]["source_evidence"] = [reference]
        elif fault == "claim_reference":
            row["claims"][0]["text"] = reference
        elif fault == "span_as_explicit_source":
            row["claims"][0]["evidence"] = [{
                "source_id": reference, "quote": "Authored 3\u00a0units", "exact_values": [],
            }]

    model, admissions = Model(mutate=corrupt_span), []
    with pytest.raises(DeterminationFailure, match=code):
        verifier(repository, model, admissions).verify(**arguments)
    assert len(model.calls) == len(admissions) == 3
    assert repository._connection.execute(
        "SELECT envelope_json FROM semantic_determinations WHERE determination_id=?", (accepted.determination_id,),
    ).fetchone()[0] == accepted_json
    assert repository._connection.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 1


def test_supporting_span_maps_remain_request_local_during_concurrent_decoding():
    barrier = Barrier(2)

    def decode(quote):
        sources = [Source(source_id="owned", text="Prefix " + quote + " suffix")]
        selected = Source(source_id="owned", text=quote)
        response, refs = claim_review_response_model(sources, supporting_spans=[selected])
        ref = next(ref for ref, entry in refs.items() if "span_reference_quote" in entry)
        sources[0].text = selected.text = "Changed caller text"
        barrier.wait(timeout=5)
        result = response.model_validate(dict(verdict="pass", rationale="Explicit model verdict", lines=[dict(
            line_id="owned", verdict="pass", source_evidence=[ref], served_requirements=[], claims=[], findings=[],
        )]))
        return result.lines[0].source_evidence[0].quote

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(decode, ["First 3\u00a0units", "Second 4\u00a0units"])) == [
            "First 3\u00a0units", "Second 4\u00a0units",
        ]


def test_duplicate_full_oversized_and_colliding_span_references_stay_unambiguous():
    sources = [Source(source_id="@0/span/0", text="Prefix selected suffix"),
               Source(source_id="long", text="X" * 4500)]
    _, refs = claim_review_response_model(sources, supporting_spans=[
        Source(source_id="@0/span/0", text="selected"),
        Source(source_id="@0/span/0", text="selected"),
        Source(source_id="@0/span/0", text="Prefix selected suffix"),
        Source(source_id="long", text="X" * 4001),
    ])
    assert set(refs).isdisjoint(source.source_id for source in sources)
    assert [entry["span_reference_quote"] for entry in refs.values() if "span_reference_quote" in entry] == ["selected"]
