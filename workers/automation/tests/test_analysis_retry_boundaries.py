"""Verifier protocol repairs must not multiply analysis or stage retry budgets."""

from __future__ import annotations

import json

import pytest

from tests.determination_fakes import claim_verification_input, claim_verification_response

from jobctrl.domain.determinations import DeterminationFailure, Source
from jobctrl.domain.materials.analysis import EnsembleError
from jobctrl.domain.ports.claim_verification import ArtifactLine
from jobctrl.infrastructure.analysis.ensemble import _draft_with_retry, _synthesize_with_retry
from tests.test_analysis_determinations import Draft, JOB, Model, Synth, connection, use_case
from tests.test_artifact_determinations import ports


@pytest.mark.asyncio
@pytest.mark.parametrize("code", [
    "malformed_json", "schema_violation", "foreign_source_id", "non_verbatim_quote",
    "mismatched_value", "provider_error", "provider_unavailable", "budget_denied",
])
async def test_exhausted_verifier_protocol_does_not_receive_a_fresh_analysis_budget(code):
    draft = Draft()

    def reject(_analysis):
        raise DeterminationFailure(code)

    with pytest.raises(DeterminationFailure, match=code):
        await _draft_with_retry(draft, system_prompt="Synthetic", jd_snapshot="Canonical posting",
                                max_retries=2, verify_prose=reject)
    assert len(draft.calls) == 1

    class CountingSynth(Synth):
        calls = 0

        async def reconcile(self, *args, **kwargs):
            self.calls += 1
            return await super().reconcile(*args, **kwargs)

    synth = CountingSynth()
    candidate = await Draft().draft("Synthetic", "Canonical posting")
    with pytest.raises(DeterminationFailure, match=code):
        await _synthesize_with_retry(synth, system_prompt="Synthetic", drafts=(candidate,),
                                     jd_snapshot="Canonical posting", max_retries=2, verify_prose=reject)
    assert synth.calls == 1


class InvalidVerifier(Model):
    def __init__(self, fault):
        super().__init__(verdict="fail")
        self.fault_kind = fault

    def chat_json(self, messages, *, response_schema, **kwargs):
        result = super().chat_json(messages, response_schema=response_schema, **kwargs)
        if response_schema["title"] != "ClaimVerification":
            return result
        citation = result["lines"][0]["findings"][0]["citation"]
        if self.fault_kind == "malformed_json":
            raise json.JSONDecodeError("Synthetic invalid JSON", "", 0)
        if self.fault_kind == "schema_violation":
            result["unexpected"] = True
        elif self.fault_kind == "foreign_source_id":
            citation["source_id"] = "foreign"
        elif self.fault_kind == "non_verbatim_quote":
            citation["quote"] = "Synthetic unbound quote"
        elif self.fault_kind == "mismatched_value":
            citation["exact_values"] = ["999"]
        return claim_verification_response(json.loads(messages[1].content), result)


@pytest.mark.parametrize("code", [
    "malformed_json", "schema_violation", "foreign_source_id", "non_verbatim_quote", "mismatched_value",
])
def test_actual_verifier_keeps_one_three_call_budget_and_safe_typed_failure(code):
    conn, model, draft = connection(), InvalidVerifier(code), Draft()
    with pytest.raises(EnsembleError) as error:
        use_case(conn, model, draft).execute(job=JOB)
    assert len(draft.calls) == 1
    assert model.calls == ["ClaimVerification"] * 3
    assert error.value.determination_failure.code == code
    assert str(error.value.determination_failure) == "semantic_determination:" + code
    assert {row.error for row in error.value.failures} == {code}
    assert all(row.raw_output is None for row in error.value.failures)
    assert conn.execute("SELECT COUNT(*) FROM job_employer_analysis").fetchone()[0] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("second,expected", [
    ("schema_violation", "mismatched_value"), ("provider_unavailable", "mismatched_value"),
    ("provider_error", "provider_error"), (None, None),
])
async def test_all_failed_legs_keep_terminal_and_transient_classification(second, expected):
    from jobctrl.infrastructure.analysis.ensemble import run_ensemble

    class FailedDraft(Draft):
        def __init__(self, failure):
            super().__init__()
            self.failure = failure

        async def draft(self, *args):
            raise self.failure

    errors = (DeterminationFailure("mismatched_value"),
              DeterminationFailure(second) if second else RuntimeError("PRIVATE TRANSPORT DETAIL"))
    with pytest.raises(EnsembleError) as error:
        await run_ensemble("Synthetic", "Canonical posting", adapters=tuple(FailedDraft(e) for e in errors),
                           synthesizer=Synth(), synthesizer_system_prompt="Synthetic", verify_prose=lambda _: None,
                           agreement_judge=None, entity_id="owned", max_leg_retries=0)
    failure = error.value.determination_failure
    assert (failure.code if failure else None) == expected
    assert len(error.value.failures) == 2
    assert all(row.raw_output is None and "PRIVATE" not in row.error for row in error.value.failures)


def test_failed_protocol_leg_does_not_cancel_a_healthy_peer():
    class FailedDraft(Draft):
        async def draft(self, *args):
            self.calls.append(args[0])
            raise DeterminationFailure("mismatched_value")

    conn, draft = connection(), FailedDraft()
    record = use_case(conn, Model(), draft, multiple=True).execute(job=JOB).analysis
    assert len(draft.calls) == 1
    assert record.legs_attempted == 2
    assert record.legs_succeeded == 1
    assert record.failures[0].error == "mismatched_value"
    assert record.failures[0].raw_output is None


def test_protocol_failure_preserves_the_accepted_analysis():
    from jobctrl.infrastructure.materials.employer_analysis_repository import SqliteEmployerAnalysisRepository

    conn = connection()
    accepted = use_case(conn, Model()).execute(job=JOB).analysis
    repository = SqliteEmployerAnalysisRepository(conn)
    before = repository.load(accepted.tenant_id, accepted.job_id)
    with pytest.raises(EnsembleError):
        use_case(conn, InvalidVerifier("mismatched_value")).execute(
            job={**JOB, "full_description": "Canonical posting\nChanged owned snapshot"}, force=True,
        )
    assert repository.load(accepted.tenant_id, accepted.job_id) == before


@pytest.mark.asyncio
async def test_valid_prose_rejection_still_repairs_with_recorded_findings():
    draft = Draft()
    calls = 0

    def verify(_analysis):
        nonlocal calls
        calls += 1
        if calls == 1:
            error = DeterminationFailure("claim_verification_failed")
            error.repair_feedback = json.dumps({"verdict": "fail", "rationale": "Synthetic cited finding"})
            raise error

    await _draft_with_retry(draft, system_prompt="Synthetic", jd_snapshot="Canonical posting",
                            max_retries=2, verify_prose=verify)
    assert len(draft.calls) == 2
    assert "Synthetic cited finding" in draft.calls[1]
    assert "untrusted candidate" in draft.calls[1]


class NumericRepairModel:
    """An owned model port corrects only the exact claim paths reported to it."""

    def __init__(self, verdict):
        self.verdict = verdict
        self.feedback = []
        self.corrected = set()
        self.calls = 0

    def chat_json(self, messages, **kwargs):
        self.calls += 1
        data = claim_verification_input(json.loads(messages[1].content))
        sources = {row["source_id"]: row["text"] for row in data["sources"]}
        if len(messages) > 2:
            feedback = json.loads(messages[-1].content.split("\n", 1)[1])["binding_failure"]
            self.feedback.append(feedback)
            for failure in (feedback or {}).get("binding_failures", []):
                self.corrected.add(failure["path"][1])

        def cite(ident):
            return {"source_id": ident, "quote": sources[ident], "exact_values": []}

        rows = []
        for index, line in enumerate(data["context"]["lines"]):
            corrected = index in self.corrected
            sid = ("correct:" if corrected else "wrong:") + str(index)
            verdict = self.verdict if corrected else "pass"
            rows.append({
                "line_id": line["line_id"], "verdict": verdict, "source_evidence": [cite(sid)],
                "served_requirements": [], "findings": [],
                "claims": [{
                    "kind": "candidate_fact", "support": "supported" if verdict == "pass" else "unsupported",
                    "text": cite("line:" + line["line_id"]), "evidence": [cite(sid)],
                    "rationale": "Synthetic model judgment",
                }],
            })
        result = {"verdict": self.verdict if len(self.corrected) == len(rows) else "pass",
                "rationale": "Synthetic model judgment", "lines": rows}

        return claim_verification_response(data, result)


@pytest.mark.parametrize("verdict", ["pass", "fail"])
def test_numeric_binding_feedback_identifies_every_claim_and_preserves_model_verdict(verdict):
    conn, model = connection(), NumericRepairModel(verdict)
    verifier, _ = ports(conn, model)
    evidence = [Source(source_id=prefix + str(i), text=f"{i + offset} units")
                for i in range(4) for prefix, offset in (("wrong:", 1), ("correct:", 5))]
    lines = [ArtifactLine(line_id=str(i), text=f"{i + 5} units",
                          allowed_evidence_ids=[f"wrong:{i}", f"correct:{i}"], allowed_requirement_ids=[])
             for i in range(4)]
    result, envelope = verifier.verify(artifact_kind="resume", entity_id="owned-numeric-repair",
                                       lines=lines, evidence=evidence, requirements=[], rubric={})
    assert result.verdict == verdict
    assert envelope.result["verdict"] == verdict
    assert model.calls == 2
    failures = model.feedback[0]["binding_failures"]
    assert [row["path"] for row in failures] == [["lines", i, "claims", 0] for i in range(4)]
    assert all(row["unsupported_numeric_literals"] == [str(i + 5)] for i, row in enumerate(failures))
    assert {row["source_id"] for row in model.feedback[0]["canonical_sources"]} == {
        source.source_id for source in evidence
    }
