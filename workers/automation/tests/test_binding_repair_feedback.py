"""Complete mechanical feedback; semantic decisions remain with the model."""

import json
from typing import Literal

import pytest

from jobctrl.domain.determinations import Citation, DeterminationFailure, DeterminationModel, Source, determine, validate_citations
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.ports.llm import LlmMessage
from jobctrl.domain.scoring.determination import ScoringDecision
from jobctrl.domain.scoring.eligibility import eligibility_blocks_downstream
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.scoring.sqlite_repository import SqliteScoreRepository
from tests.test_scoring_determinations import JOB, JOB_ID, PROFILE, Model, case, connection
from tests.test_semantic_determinations import Decision, Repository


def repair_packet(messages):
    return json.loads(messages[-1].content.split("\n", 1)[1])["binding_failure"]


class RepairScoring(Model):
    def __init__(self, *, blocked=False, stubborn=False, provider_failure=False):
        super().__init__(blocked=blocked)
        self.fixed = set()
        self.stubborn, self.provider_failure = stubborn, provider_failure
        self.packets = []

    def chat_json(self, messages, **kwargs):
        if len(messages) > 2:
            packet = repair_packet(messages)
            self.packets.append(packet)
            if self.provider_failure:
                raise RuntimeError("private provider detail")
            if not self.stubborn:
                self.fixed.update(
                    r["citation"]["source_id"]
                    for r in packet.get("binding_failures", [packet]) if r.get("citation")
                )
        result = super().chat_json(messages, **kwargs)
        data = json.loads(messages[1].content)
        result["citations"] = [
            {"source_id": s["source_id"], "quote": s["text"] if s["source_id"] in self.fixed else "Invalid owned quote", "exact_values": []}
            for s in data["sources"][:4]
        ]
        return result


@pytest.mark.parametrize("blocked", [False, True])
def test_score_repairs_all_literal_errors_together_without_changing_eligibility(blocked):
    conn, model = connection(), RepairScoring(blocked=blocked)
    outcome = case(conn, model).score(job=JOB, profile_snapshot=ProfileSnapshot(LOCAL_TENANT, "default", 1, PROFILE))
    assert outcome.ok
    assert eligibility_blocks_downstream(outcome.score.breakdown.eligibility) is blocked
    assert len(model.calls) == 2 and len(model.packets) == 1
    report = model.packets[0]
    assert len(report["binding_failures"]) == 4
    assert {tuple(r["path"]) for r in report["binding_failures"]} == {("citations", i) for i in range(4)}
    expected = json.loads(model.calls[0][1].content)["sources"][:4]
    assert report["canonical_sources"] == expected


class SpanRepairs(Model):
    def __init__(self):
        super().__init__()
        self.fixed = set()
        self.packets = []

    def chat_json(self, messages, **kwargs):
        if len(messages) > 2:
            packet = repair_packet(messages)
            self.packets.append(packet)
            self.fixed.update(
                r["requirement_id"] for r in packet.get("binding_failures", [])
                if r.get("field") == "job_evidence_span"
            )
        result = super().chat_json(messages, **kwargs)
        sources = json.loads(messages[1].content)["sources"]
        result["requirement_assessments"] = [
            {
                "requirement_id": s["source_id"], "requirement_text": "Owned requirement",
                "tier": "must_have", "weight": .5,
                "job_evidence_span": s["text"] if s["source_id"] in self.fixed else "Wrong owned span",
                "fit": {"kind": "not_assessed", "evidence_ids": [], "strength": None, "gap": None, "bridge": None, "reason": "Explicit model judgment", "blocker": None},
                "target_keywords": [], "citations": [{"source_id": s["source_id"], "quote": s["text"], "exact_values": []}],
            }
            for s in sources if s["source_id"].startswith("r:")
        ]
        return result


def test_requirement_span_feedback_identifies_every_field_and_exact_canonical_target():
    requirements = {f"r:{i}": f"Owned\u00a0literal\nrequirement {i}" for i in range(4)}
    model, repo = SpanRepairs(), Repository()
    result, _ = determine(
        kind="scoring", schema=ScoringDecision, schema_version="owned", prompt_version="owned",
        instruction="Make an explicit synthetic scoring decision from the supplied sources.",
        sources=[Source(source_id="posting", text="Posting source"), *[Source(source_id=i, text=t) for i, t in requirements.items()]],
        context={}, tenant_id="owned", entity_id="owned", provider="fake", model="fake", lane="scoring",
        llm=model, repository=repo, preflight=lambda: None,
        validate=lambda row: row.validate_inventory(requirements=requirements, evidence_ids=set()),
    )
    assert len(model.calls) == 2
    failures = model.packets[0]["binding_failures"]
    assert {r["requirement_id"] for r in failures} == set(requirements)
    assert all(r["field"] == "job_evidence_span" and r["canonical_value"] == requirements[r["requirement_id"]] for r in failures)
    assert {r.requirement_id: r.job_evidence_span for r in result.requirement_assessments} == requirements


@pytest.mark.parametrize("fault", ["invalid", "provider", "budget"])
def test_failed_binding_refresh_retains_last_score_and_safe_failure_state(fault):
    conn = connection()
    good = case(conn, Model()).score(job=JOB, profile_snapshot=ProfileSnapshot(LOCAL_TENANT, "default", 1, PROFILE))
    model = RepairScoring(stubborn=fault == "invalid", provider_failure=fault == "provider")

    def preflight():
        if fault == "budget" and model.calls:
            raise RuntimeError("private budget detail")

    failed = case(conn, model, preflight).score(job=JOB, profile_snapshot=ProfileSnapshot(LOCAL_TENANT, "default", 2, PROFILE))
    code = {"invalid": "non_verbatim_quote", "provider": "provider_error", "budget": "budget_denied"}[fault]
    assert not failed.ok and failed.error == "semantic_determination:" + code
    assert SqliteScoreRepository(conn).load(LOCAL_TENANT, JOB_ID).version == good.score.version
    state = dict(conn.execute("SELECT * FROM semantic_stage_states WHERE state='blocked'").fetchone())
    assert state["failure_code"] == code and "private" not in json.dumps(state) and "Invalid owned" not in json.dumps(state)
    if fault == "invalid":
        assert len(model.calls) == 3
    if fault == "budget":
        assert len(model.calls) == 1


class MappedDecision(DeterminationModel):
    verdict: Literal["accept", "reject"]
    citations: dict[str, Citation]


@pytest.mark.parametrize("verdict", ["accept", "reject"])
def test_typed_mapping_citations_receive_the_same_strict_binding_repair(verdict):
    class MappingRepair:
        def __init__(self):
            self.calls = 0
            self.fixed = set()

        def chat_json(self, messages, **kwargs):
            self.calls += 1
            if len(messages) > 2:
                self.fixed.update(r["citation"]["source_id"] for r in repair_packet(messages)["binding_failures"])
            return {"verdict": verdict, "citations": {
                f"key:{i}": {"source_id": s["source_id"], "quote": s["text"] if s["source_id"] in self.fixed else "Wrong owned quote", "exact_values": []}
                for i, s in enumerate(json.loads(messages[1].content)["sources"])
            }}

    model, repo = MappingRepair(), Repository()
    result, _ = determine(
        kind="owned", schema=MappedDecision, schema_version="owned", prompt_version="owned",
        instruction="Choose the synthetic decision independently.",
        sources=[Source(source_id=f"s:{i}", text=f"Owned exact {i}") for i in range(4)],
        context={}, tenant_id="owned", entity_id="owned", provider="fake", model="fake", lane="scoring",
        llm=model, repository=repo, preflight=lambda: None,
    )
    assert model.calls == 2 and result.verdict == verdict


def test_inventory_feedback_reports_all_structural_failures_without_private_exception_text():
    output = SpanRepairs().chat_json([
        LlmMessage(role="system", content="Owned instruction"),
        LlmMessage(role="user", content=json.dumps({"sources": [{"source_id": "r:0", "text": "Owned exact span"}]})),
    ])
    row = output["requirement_assessments"][0]
    row["fit"].update(kind="matched", evidence_ids=["foreign"])
    output["eligibility"]["status"] = "blocked"
    decision = ScoringDecision.model_validate(output)
    with pytest.raises(DeterminationFailure) as caught:
        decision.validate_inventory(requirements={"r:0": "Owned exact span"}, evidence_ids={"allowed"})
    report = caught.value.repair_context
    assert {r["code"] for r in report["binding_failures"]} == {"non_verbatim_quote", "foreign_source_id", "inconsistent_verdict"}
    assert "Owned" not in str(caught.value)


def test_unknown_requirement_does_not_hide_independent_evidence_errors():
    output = Model().chat_json([])
    output["requirement_assessments"] = [{
        "requirement_id": "outside", "requirement_text": "Owned requirement", "tier": "must_have", "weight": .5,
        "job_evidence_span": "Owned span",
        "fit": {"kind": "matched", "evidence_ids": ["foreign"], "strength": "direct", "gap": None, "bridge": None, "reason": "Model decision", "blocker": None},
        "target_keywords": [], "citations": [{"source_id": "posting", "quote": "Posting source"}],
    }]
    with pytest.raises(DeterminationFailure) as caught:
        ScoringDecision.model_validate(output).validate_inventory(requirements={"r:0": "Owned span"}, evidence_ids={"allowed"})
    assert {r["code"] for r in caught.value.repair_context["binding_failures"]} == {"foreign_or_missing_requirement_id", "foreign_source_id"}


@pytest.mark.parametrize("span", ["", " ", "\n"])
def test_empty_requirement_span_never_receives_verbatim_credit(span):
    output = Model().chat_json([])
    output["requirement_assessments"] = [{
        "requirement_id": "r:0", "requirement_text": "Owned requirement", "tier": "must_have", "weight": .5,
        "job_evidence_span": span,
        "fit": {"kind": "not_assessed", "evidence_ids": [], "strength": None, "gap": None, "bridge": None, "reason": "Model decision", "blocker": None},
        "target_keywords": [], "citations": [{"source_id": "posting", "quote": "Posting source"}],
    }]
    with pytest.raises(DeterminationFailure, match="non_verbatim_quote"):
        ScoringDecision.model_validate(output).validate_inventory(requirements={"r:0": "Owned \nspan"}, evidence_ids=set())


def test_complete_citation_report_keeps_first_code_and_never_repairs_values_in_code():
    decision = Decision(verdict="reject", citations=[
        Citation(source_id="known", quote="Wrong quote", exact_values=["absent"]),
        Citation(source_id="outside", quote="Another quote"),
    ])
    with pytest.raises(DeterminationFailure, match="non_verbatim_quote") as caught:
        validate_citations(decision, [Source(source_id="known", text="Owned private canonical source")])
    report = caught.value.repair_context
    assert [r["code"] for r in report["binding_failures"]] == ["non_verbatim_quote", "mismatched_value", "foreign_source_id"]
    assert report["citation"]["quote"] == decision.citations[0].quote == "Wrong quote"
    assert report["canonical_sources"] == [{"source_id": "known", "text": "Owned private canonical source"}]
    assert "private" not in str(caught.value)
