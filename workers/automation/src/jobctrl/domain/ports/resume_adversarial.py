"""Cited persona judgments remain separate from the resume quality judge."""

from typing import Annotated, ClassVar, Literal
from pydantic import ConfigDict, Field, StrictStr
from jobctrl.domain.determinations import Citation, DeterminationModel
from jobctrl.domain.ports.artifact_quality import QualityFinding

RESUME_ADVERSARIAL_SCHEMA_VERSION = "1"
RESUME_ADVERSARIAL_PROMPT_VERSION = "resume-adversarial-v3"


Persona = Literal[
    "ats_parser",
    "skeptical_recruiter",
    "hiring_manager_domain_expert",
    "evidence_auditor",
    "anti_ai_voice_critic",
    "interview_defensibility_critic",
]


class PersonaJudgment(DeterminationModel):
    persona: Persona
    verdict: Literal["pass", "fail"]
    score: float = Field(ge=0, le=1)
    rationale: StrictStr = Field(min_length=1, max_length=1500)
    citations: list[Citation] = Field(min_length=1, max_length=20)
    findings: list[QualityFinding] = Field(max_length=100)


class ResumeAdversarialReview(DeterminationModel):
    compatible_prompt_versions: ClassVar[tuple[str, ...]] = (
        "resume-adversarial-v1", "resume-adversarial-v2", "resume-adversarial-v3",
    )
    verdict: Literal["pass", "fail"]
    score: float = Field(ge=0, le=1)
    rationale: StrictStr = Field(min_length=1, max_length=1500)
    personas: list[PersonaJudgment] = Field(min_length=6, max_length=6)


# Bound newly generated diagnostics at the provider boundary, including nested
# quotes and literal-value strings. Historical accepted receipts retain the
# wider canonical reader above; no saved review is truncated or reclassified.
class _ReviewCitation(Citation):
    quote: StrictStr = Field(min_length=1, max_length=240)
    exact_values: list[Annotated[StrictStr, Field(max_length=64)]] = Field(
        default_factory=list, max_length=4,
    )


class _ReviewFinding(QualityFinding):
    citation: _ReviewCitation
    rationale: StrictStr = Field(min_length=1, max_length=512)
    repair_instruction: StrictStr = Field(min_length=1, max_length=512)


class _PersonaResponse(PersonaJudgment):
    rationale: StrictStr = Field(min_length=1, max_length=512)
    citations: list[_ReviewCitation] = Field(min_length=1, max_length=3)
    findings: list[_ReviewFinding] = Field(max_length=6)


class ResumeAdversarialResponse(ResumeAdversarialReview):
    """Concise response format; every persona keeps its explicit model verdict."""

    stored_result_schema: ClassVar[type[ResumeAdversarialReview]] = ResumeAdversarialReview
    model_config = ConfigDict(title="ResumeAdversarialReview")
    rationale: StrictStr = Field(min_length=1, max_length=512)
    personas: list[_PersonaResponse] = Field(min_length=6, max_length=6)
