"""Employer-side role context; qualified requirement identities belong elsewhere."""

from typing import Literal

from pydantic import Field, StrictStr

from jobctrl.semantic import Citation, DeterminationModel
from jobctrl.semantic.taxonomy_codes import SeniorityCode


class RoleStatement(DeterminationModel):
    text: StrictStr = Field(min_length=1, max_length=12000)
    citations: list[Citation] = Field(min_length=1, max_length=20)
    uncertainty: StrictStr = Field(min_length=1, max_length=2000)


class RoleSeniority(DeterminationModel):
    value: SeniorityCode
    citations: list[Citation] = Field(min_length=1, max_length=20)
    rationale: StrictStr = Field(min_length=1, max_length=2000)


class RoleKeyword(DeterminationModel):
    keyword: StrictStr = Field(min_length=1, max_length=200)
    evidence_span: StrictStr = Field(min_length=1, max_length=4000)
    requirement_ref: StrictStr | None = Field(max_length=240)
    rationale: StrictStr = Field(min_length=1, max_length=2000)
    citations: list[Citation] = Field(min_length=1, max_length=8)


class RoleAnalysis(DeterminationModel):
    role_framing: RoleStatement
    inferred_seniority: RoleSeniority
    ideal_candidate_narrative: RoleStatement
    keywords: list[RoleKeyword] = Field(max_length=100)


class RefreshIdentity(DeterminationModel):
    verdict: Literal["same_posting", "different_posting", "unknown"]
    citations: list[Citation] = Field(min_length=2, max_length=20)
    rationale: StrictStr = Field(min_length=1, max_length=4000)
