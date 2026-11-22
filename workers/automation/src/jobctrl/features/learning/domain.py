"""Source-bound selected-posting demand; proposals never establish capability."""

from typing import Literal

from pydantic import Field, StrictStr

from jobctrl.semantic.determinations import Citation, DeterminationFailure, DeterminationModel


class CareerDemand(DeterminationModel):
    demand_id: StrictStr = Field(min_length=1, max_length=80)
    skill: StrictStr = Field(min_length=1, max_length=200)
    mentions: list[Citation] = Field(min_length=1, max_length=60)
    capability: Literal["demonstrated", "partial", "not_evidenced", "uncertain"]
    evidence: list[Citation] = Field(max_length=24)
    rationale: StrictStr = Field(min_length=1, max_length=2000)
    uncertainty: StrictStr = Field(min_length=1, max_length=2000)


class CareerMilestoneProposal(DeterminationModel):
    proposal_id: StrictStr = Field(min_length=1, max_length=80)
    demand_id: StrictStr = Field(min_length=1, max_length=80)
    kind: Literal["learning", "evidence_building"]
    title: StrictStr = Field(min_length=1, max_length=240)
    action: StrictStr = Field(min_length=1, max_length=2000)
    completion_criterion: StrictStr = Field(min_length=1, max_length=2000)
    rationale: StrictStr = Field(min_length=1, max_length=2000)


class CareerDemandComparison(DeterminationModel):
    demands: list[CareerDemand] = Field(max_length=60)
    proposals: list[CareerMilestoneProposal] = Field(max_length=30)
    uncertainty: StrictStr = Field(min_length=1, max_length=2000)


def validate_career_comparison(result, posting_ids, evidence_ids):
    demand_ids = [row.demand_id for row in result.demands]
    proposal_ids = [row.proposal_id for row in result.proposals]
    if len(set(demand_ids)) != len(demand_ids) or len(set(proposal_ids)) != len(proposal_ids):
        raise DeterminationFailure("duplicate_result_id")
    for row in result.demands:
        if any(cite.source_id not in posting_ids for cite in row.mentions):
            raise DeterminationFailure("foreign_posting_id")
        if any(cite.source_id not in evidence_ids for cite in row.evidence):
            raise DeterminationFailure("unconfirmed_evidence_id")
        if row.capability in {"demonstrated", "partial"} and not row.evidence:
            raise DeterminationFailure("missing_capability_evidence")
        if row.capability == "not_evidenced" and row.evidence:
            raise DeterminationFailure("inconsistent_verdict")
    if any(row.demand_id not in demand_ids for row in result.proposals):
        raise DeterminationFailure("foreign_demand_id")
