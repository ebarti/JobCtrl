"""Semantic claim-verification port, shared without importing Materials internals."""

from __future__ import annotations

from typing import Literal, Protocol

from pydantic import Field, StrictStr

from jobctrl.domain.determinations import Citation, DeterminationEnvelope, DeterminationModel, Source


ArtifactKind = Literal["resume", "cover_letter", "outreach", "interview", "employer_analysis", "user_edit"]


class ArtifactLine(DeterminationModel):
    line_id: StrictStr = Field(min_length=1, max_length=240)
    text: StrictStr = Field(min_length=1, max_length=16000)
    allowed_evidence_ids: list[StrictStr] = Field(max_length=400)
    allowed_requirement_ids: list[StrictStr] = Field(max_length=400)


class VerifiedClaim(DeterminationModel):
    kind: Literal["candidate_fact", "hypothetical", "target_role", "employer_statement", "advice"]
    support: Literal["supported", "unsupported", "not_factual", "uncertain"]
    text: Citation
    evidence: list[Citation] = Field(max_length=32)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class ServedRequirement(DeterminationModel):
    requirement_id: StrictStr = Field(min_length=1, max_length=240)
    citation: Citation
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class LineVerification(DeterminationModel):
    line_id: StrictStr = Field(min_length=1, max_length=240)
    verdict: Literal["pass", "fail"]
    served_requirements: list[ServedRequirement] = Field(max_length=400)

    @property
    def served_requirement_ids(self) -> list[str]:
        return [row.requirement_id for row in self.served_requirements]

    source_evidence: list[Citation] = Field(max_length=400)
    claims: list[VerifiedClaim] = Field(max_length=40)
    findings: list["VerificationFinding"] = Field(max_length=20)


class VerificationFinding(DeterminationModel):
    kind: Literal[
        "unsupported_claim", "prohibited_claim", "voice", "self_talk", "negotiation_guidance", "process_narration"
    ]
    rationale: StrictStr = Field(min_length=1, max_length=1000)
    citation: Citation


class ClaimVerification(DeterminationModel):
    verdict: Literal["pass", "fail"]
    lines: list[LineVerification] = Field(min_length=1, max_length=1000)
    rationale: StrictStr = Field(min_length=1, max_length=1500)


class ClaimVerifier(Protocol):
    def verify(
        self,
        *,
        artifact_kind: ArtifactKind,
        entity_id: str,
        lines: list[ArtifactLine],
        evidence: list[Source],
        requirements: list[Source],
        rubric: dict[str, str],
    ) -> tuple[ClaimVerification, DeterminationEnvelope]: ...
