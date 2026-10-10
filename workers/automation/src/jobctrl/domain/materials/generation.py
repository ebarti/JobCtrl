"""Strict generation shapes with explicit line IDs and model-authored anchors."""

from typing import Literal
from pydantic import Field, StrictStr
from jobctrl.domain.determinations import DeterminationModel

Transform = Literal["verbatim", "rephrase", "reframe", "synthesize_from_related", "quantify_from_evidence", "voice"]


class GeneratedClaim(DeterminationModel):
    claim_id: StrictStr = Field(min_length=1)
    line_id: StrictStr = Field(min_length=1)
    location: StrictStr = Field(min_length=1)
    text: StrictStr = Field(min_length=1)
    reason: StrictStr = Field(min_length=1, max_length=2000)
    transform_type: Transform
    claim_label: Literal[
        "verified",
        "evidence_reframed",
        "adjacent_translation",
        "draft_requires_confirmation",
        "pinned",
        "positioning",
        "structure",
    ]
    coverage_edge_ids: list[StrictStr]
    requirement_ids: list[StrictStr]
    evidence_ids: list[StrictStr]
    non_requirement_reason: Literal["", "pinned", "positioning", "structure"]
    review_required: bool


class ExperienceUpdate(DeterminationModel):
    id: StrictStr
    title: StrictStr
    bullets: list[StrictStr]


class SkillUpdate(DeterminationModel):
    id: StrictStr
    items: list[StrictStr]


class GeneratedResumeDraft(DeterminationModel):
    executive_profile: StrictStr
    executive_profile_sentences: list[StrictStr] = Field(min_length=1, max_length=4)
    experience_updates: list[ExperienceUpdate] = Field(min_length=1)
    skill_category_updates: list[SkillUpdate] = Field(min_length=1)
    generated_claim_mappings: list[GeneratedClaim] = Field(min_length=1)
