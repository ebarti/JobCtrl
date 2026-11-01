"""Strict per-line generation contract used by prose artifact producers."""

from typing import Literal
from pydantic import Field, StrictStr
from jobctrl.domain.determinations import DeterminationModel

Transform = Literal["verbatim", "rephrase", "reframe", "synthesize_from_related", "quantify_from_evidence", "voice"]


class GeneratedProseLine(DeterminationModel):
    line_id: StrictStr = Field(min_length=1, max_length=240)
    text: StrictStr = Field(min_length=1, max_length=10000)
    evidence_ids: list[StrictStr]
    requirement_ids: list[StrictStr]
    transform_type: Transform
    reason: StrictStr = Field(min_length=1, max_length=2000)


class GeneratedProseDraft(DeterminationModel):
    lines: list[GeneratedProseLine] = Field(min_length=1, max_length=30)
