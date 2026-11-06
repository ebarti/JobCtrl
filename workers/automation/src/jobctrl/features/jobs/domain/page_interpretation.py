"""Rendered-page meaning and description quality belong to model determinations."""

from typing import Literal
from pydantic import Field, StrictStr, model_validator
from jobctrl.semantic import Citation, DeterminationModel
from jobctrl.features.jobs.domain.interpretation import InterpretedField


class PageInterpretation(DeterminationModel):
    availability: InterpretedField[Literal["active", "closed", "expired", "removed", "unknown"]]
    page_kind: InterpretedField[Literal["posting", "listing", "other", "unknown"]]
    access_state: InterpretedField[Literal["clear", "login_required", "challenge", "unknown"]]
    apply_control: InterpretedField[Literal["available", "unavailable", "unknown"]]

    @model_validator(mode="after")
    def inaccessible_pages_have_no_availability_verdict(self):
        if self.access_state.value in {"login_required", "challenge"} and self.availability.value != "unknown":
            raise ValueError("An inaccessible page must report unknown availability")
        return self


class DescriptionQuality(DeterminationModel):
    confidence: Literal["high", "medium", "low"]
    citations: list[Citation] = Field(min_length=1, max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class PostingField(DeterminationModel):
    value: StrictStr = Field(max_length=64000)
    citations: list[Citation] = Field(max_length=20)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class PostingExtraction(DeterminationModel):
    title: PostingField
    employer: PostingField
    description: PostingField
    location: PostingField
    salary: PostingField
    application_url: PostingField


class PostingDescriptionSelection(DeterminationModel):
    source_id: StrictStr = Field(min_length=1, max_length=240)
    first_line_id: StrictStr = Field(min_length=1, max_length=100)
    last_line_id: StrictStr = Field(min_length=1, max_length=100)
    rationale: StrictStr = Field(min_length=1, max_length=1000)
    value: StrictStr | None = Field(
        default=None, max_length=64000, description="Return null; the application copies the validated source span."
    )
    citations: list[Citation] = Field(
        default_factory=list,
        max_length=20,
        description="Return []; the application records the exact copied source citation.",
    )


class PostingSourceOrigin(DeterminationModel):
    source_id: StrictStr = Field(min_length=1, max_length=240)
    url: StrictStr = Field(min_length=1, max_length=64000)


class PostingSelectionExtraction(DeterminationModel):
    title: PostingField
    employer: PostingField
    description: PostingDescriptionSelection
    location: PostingField
    salary: PostingField
    application_url: PostingField
    source_origins: list[PostingSourceOrigin] = Field(
        default_factory=list, max_length=512, description="Return []; the application records captured source origins."
    )
