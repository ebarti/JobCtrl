"""Single-provider canonicalization preserves source-bound model authority."""
from __future__ import annotations

import pytest

from tests.test_analysis_determinations import JOB, Draft, Model, connection, use_case
from tests.test_employer_analysis_ensemble import (
    JD, _StubDraftAdapter, _StubSynthesizer, _grounded_dict, run_ensemble,
)
from jobctrl.domain.materials.analysis import EnsembleError, JobAnalysis
from jobctrl.infrastructure.materials.employer_analysis_repository import SqliteEmployerAnalysisRepository


class NeverSynthesize:
    async def reconcile(self, *args, **kwargs):
        raise AssertionError("A sole verified admitted draft must not be rewritten")


@pytest.mark.asyncio
async def test_single_admitted_verified_draft_becomes_independent_strict_canonical():
    outcome = await run_ensemble("system", JD,
        adapters=(_StubDraftAdapter("gpt-6.1-sol", returns=_grounded_dict()),),
        synthesizer=NeverSynthesize(), synthesizer_system_prompt="unused")
    assert type(outcome.canonical) is JobAnalysis
    assert outcome.canonical.model_dump() == outcome.drafts[0].model_dump(exclude={"model_id"})
    assert outcome.legs_attempted == 1 and not outcome.failures
    assert outcome.agreement_determination_id is None
    original = outcome.drafts[0].requirements[0].text
    outcome.canonical.requirements[0].text = "Independent mutable test copy"
    assert outcome.drafts[0].requirements[0].text == original


def test_single_canonical_reuses_exact_verification_and_persists_both_bindings():
    conn, model, draft = connection(), Model(), Draft()
    case = use_case(conn, model, draft)
    case._synthesizer = NeverSynthesize()
    record = case.execute(job=JOB).analysis
    assert record.determination_ids["canonical"] == record.determination_ids[draft.model_id]
    assert model.calls == ["ClaimVerification", "JobInterpretation"]
    assert len(draft.calls) == 1
    loaded = SqliteEmployerAnalysisRepository(conn).load(record.tenant_id, record.job_id)
    assert loaded.determination_ids == record.determination_ids
    assert len(loaded.line_anchors) == len(record.line_anchors)
    assert {row["line_id"]: row for row in loaded.line_anchors} == {
        row["line_id"]: row for row in record.line_anchors
    }
    assert loaded.canonical == record.canonical
    assert case.execute(job=JOB).cached
    assert model.calls == ["ClaimVerification", "JobInterpretation"]
    assert len(draft.calls) == 1


def test_single_provider_model_rejection_preserves_last_accepted_analysis():
    conn = connection()
    accepted_case = use_case(conn, Model())
    accepted_case._synthesizer = NeverSynthesize()
    accepted = accepted_case.execute(job=JOB).analysis
    rejected_case = use_case(conn, Model(verdict="fail"))
    rejected_case._synthesizer = NeverSynthesize()
    with pytest.raises(EnsembleError) as error:
        rejected_case.execute(job={**JOB, "full_description": "Canonical posting\nChanged source"}, force=True)
    assert {row.error for row in error.value.failures} == {"claim_verification_failed"}
    retained = SqliteEmployerAnalysisRepository(conn).load(accepted.tenant_id, accepted.job_id)
    assert retained.generation == accepted.generation
    assert retained.canonical == accepted.canonical
    assert retained.determination_ids == accepted.determination_ids


@pytest.mark.asyncio
async def test_one_survivor_of_two_admitted_legs_still_uses_synthesis():
    synth = _StubSynthesizer()
    outcome = await run_ensemble("system", JD,
        adapters=(
            _StubDraftAdapter("synthetic-good", returns=_grounded_dict()),
            _StubDraftAdapter("synthetic-failed", raises=RuntimeError("owned failure")),
        ), synthesizer=synth, synthesizer_system_prompt="reconcile", max_leg_retries=0)
    assert outcome.legs_attempted == 2 and len(outcome.drafts) == 1
    assert len(outcome.failures) == 1
    assert synth.prompts == ["reconcile"]
    assert len(synth.received_drafts) == 1


@pytest.mark.asyncio
async def test_sole_ungrounded_draft_cannot_be_promoted():
    unsupported = _grounded_dict()
    unsupported["requirements"][0]["evidence_span"] = "Absent source quote"
    with pytest.raises(EnsembleError) as error:
        await run_ensemble("system", JD,
            adapters=(_StubDraftAdapter("synthetic", returns=unsupported),),
            synthesizer=NeverSynthesize(), synthesizer_system_prompt="unused", max_leg_retries=0)
    assert [row.error for row in error.value.failures] == ["GroundingError"]
