"""Semantic claim-verification port, shared without importing Materials internals."""

from __future__ import annotations

from typing import ClassVar, Literal, Protocol

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
    text: Citation = Field(
        description="Cite the final text being verified: source_id must be exactly line:<the containing LineVerification.line_id>, and quote must be a verbatim span of that line. This slot never cites evidence or a requirement.",
    )
    evidence: list[Citation] = Field(
        max_length=32,
        description="Supporting source citations. For candidate_fact, use only this line's allowed_evidence_ids; other claim kinds may also use its allowed_requirement_ids. Never cite a final line as supporting evidence.",
    )
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class ServedRequirement(DeterminationModel):
    requirement_id: StrictStr = Field(min_length=1, max_length=240)
    citation: Citation = Field(description="Cite the requirement source whose source_id exactly equals this entry's requirement_id.")
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class LineVerification(DeterminationModel):
    line_id: StrictStr = Field(min_length=1, max_length=240)
    verdict: Literal["pass", "fail"]
    served_requirements: list[ServedRequirement] = Field(
        max_length=400,
        description="At most one entry per requirement_id on this line. Combine its support into one citation and rationale; do not repeat an ID for each claim. Use an empty list when no requirement is demonstrated.",
    )

    @property
    def served_requirement_ids(self) -> list[str]:
        return [row.requirement_id for row in self.served_requirements]

    source_evidence: list[Citation] = Field(
        max_length=400,
        description="Only candidate evidence IDs in this line's allowed_evidence_ids. Include every source used to support a candidate_fact in claims.evidence. When allowed_evidence_ids is empty, return []. Requirements/posting citations belong in claims.evidence or served_requirements, never in this list.",
    )
    claims: list[VerifiedClaim] = Field(max_length=40)
    findings: list["VerificationFinding"] = Field(max_length=20)


class VerificationFinding(DeterminationModel):
    kind: Literal[
        "unsupported_claim", "prohibited_claim", "voice", "self_talk", "negotiation_guidance", "process_narration"
    ]
    rationale: StrictStr = Field(min_length=1, max_length=1000)
    citation: Citation = Field(description="Cite the affected final line: source_id is line:<the containing LineVerification.line_id>, with a verbatim span from that line.")


class ClaimVerification(DeterminationModel):
    # The compact response format retains this full canonical result contract.
    compatible_prompt_versions: ClassVar[tuple[str, ...]] = (
        "claim-verification-v2", "claim-verification-v3", "claim-verification-v4-grounded-span-references",
    )
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
        supporting_spans: list[Source] | None = None,
    ) -> tuple[ClaimVerification, DeterminationEnvelope]: ...
