"""Classify authored edit intent once; learning consumes the recorded verdict."""

from typing import Literal
from pydantic import Field, StrictStr
from jobctrl.domain.determinations import Citation, DeterminationFailure, DeterminationModel, determine


class EditIntent(DeterminationModel):
    edit_id: StrictStr
    kind: Literal["factual_correction", "claim_policy_correction", "style_preference", "provenance_dispute"]
    citations: list[Citation] = Field(min_length=1, max_length=10)
    rationale: StrictStr = Field(min_length=1, max_length=500)


class EditIntents(DeterminationModel):
    edits: list[EditIntent] = Field(min_length=1, max_length=1000)


class ModelEditIntent:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def interpret(self, *, entity_id, sources):
        ids = {source.source_id for source in sources}

        def validate(result):
            if len(result.edits) != len(ids) or {row.edit_id for row in result.edits} != ids:
                raise DeterminationFailure("foreign_or_missing_edit_id")
            for row in result.edits:
                if any(citation.source_id != row.edit_id for citation in row.citations):
                    raise DeterminationFailure("edit_binding_invalid")

        return determine(
            kind="edit_intent",
            schema=EditIntents,
            schema_version="1",
            prompt_version="edit-intent-v1",
            instruction="Read each user edit's before and after text and determine its intent for tailoring feedback. Return factual_correction, claim_policy_correction, style_preference or provenance_dispute with verbatim citations and a rationale. Do not infer intent from keywords, numerical differences or edit operation alone. The user will confirm a learning recommendation before it changes policy.",
            sources=sources,
            context={},
            entity_id=entity_id,
            validate=validate,
            **self._dependencies,
        )
