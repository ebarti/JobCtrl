"""Cited persona judgments remain separate from the resume quality judge."""

from typing import ClassVar, Literal
from pydantic import Field, StrictStr
from jobctrl.domain.determinations import Citation, DeterminationModel
from jobctrl.domain.ports.artifact_quality import QualityFinding

RESUME_ADVERSARIAL_SCHEMA_VERSION = "1"
RESUME_ADVERSARIAL_PROMPT_VERSION = "resume-adversarial-v2"


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
    compatible_prompt_versions: ClassVar[tuple[str, ...]] = ("resume-adversarial-v1", "resume-adversarial-v2")
    verdict: Literal["pass", "fail"]
    score: float = Field(ge=0, le=1)
    rationale: StrictStr = Field(min_length=1, max_length=1500)
    personas: list[PersonaJudgment] = Field(min_length=6, max_length=6)
