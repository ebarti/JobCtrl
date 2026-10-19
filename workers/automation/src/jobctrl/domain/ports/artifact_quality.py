"""Quality judgment remains separate from factual claim verification."""

from typing import Literal, Protocol

from pydantic import Field, StrictStr

from jobctrl.domain.determinations import Citation, DeterminationEnvelope, DeterminationModel, Source
from jobctrl.domain.ports.claim_verification import ArtifactKind, ArtifactLine


class QualityFinding(DeterminationModel):
    line_id: StrictStr = Field(
        min_length=1, max_length=240,
        description="An exact unprefixed rendered line ID from context.line_ids, never a candidate evidence or requirement ID.",
    )
    category: Literal["relevance", "clarity", "completeness", "structure", "voice", "interview_defensibility"]
    citation: Citation = Field(
        description="Cite this rendered line: source_id must equal 'line:' + line_id and quote must be verbatim text from that line. Saved candidate evidence belongs in evidence_corrections instead.",
    )
    rationale: StrictStr = Field(min_length=1, max_length=1500)
    repair_instruction: StrictStr = Field(min_length=1, max_length=1500)


class ArtifactQuality(DeterminationModel):
    verdict: Literal["pass", "fail"]
    score: float = Field(ge=0, le=1)
    findings: list[QualityFinding] = Field(max_length=100)
    evidence_corrections: list[Citation] = Field(
        max_length=32,
        description="Only saved candidate evidence IDs that support a proposed repair, never rendered line IDs or posting/requirement IDs. Findings cite rendered lines separately.",
    )
    rationale: StrictStr = Field(min_length=1, max_length=1500)


class ArtifactQualityJudge(Protocol):
    def review_adversarial(self, *, entity_id, lines, sources, rubric): ...

    def judge(
        self,
        *,
        artifact_kind: ArtifactKind,
        entity_id: str,
        lines: list[ArtifactLine],
        sources: list[Source],
        rubric: dict[str, str],
    ) -> tuple[ArtifactQuality, DeterminationEnvelope]: ...
