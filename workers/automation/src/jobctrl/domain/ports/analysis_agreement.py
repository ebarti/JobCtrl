"""Semantic agreement between analysis drafts is a cited model judgment."""

from typing import Literal, Protocol
from pydantic import Field, StrictStr
from jobctrl.domain.determinations import Citation, DeterminationModel


class AgreementFinding(DeterminationModel):
    kind: Literal["requirement", "keyword"]
    source_ids: list[StrictStr] = Field(min_length=1, max_length=24)
    citations: list[Citation] = Field(min_length=1, max_length=24)
    rationale: StrictStr = Field(min_length=1, max_length=1500)


class DraftAgreement(DeterminationModel):
    score: float = Field(ge=0, le=1)
    findings: list[AgreementFinding] = Field(max_length=200)
    citations: list[Citation] = Field(min_length=1, max_length=24)
    rationale: StrictStr = Field(min_length=1, max_length=1500)


class AnalysisAgreementJudge(Protocol):
    def judge(self, *, entity_id, drafts): ...
