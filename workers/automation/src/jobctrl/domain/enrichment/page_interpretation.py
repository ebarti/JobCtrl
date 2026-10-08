"""Rendered-page meaning and description quality belong to model determinations."""

import hashlib
import json
from typing import Literal
from pydantic import Field, StrictStr, model_validator
from jobctrl.domain.determinations import Citation, DeterminationModel, Source, determine
from jobctrl.domain.enrichment.interpretation import InterpretedField


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


class ModelPageInterpreter:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def interpret(self, *, entity_id, text, metadata):
        return determine(
            kind="page_interpretation",
            schema=PageInterpretation,
            schema_version="1",
            prompt_version="page-interpretation-v1",
            entity_id=entity_id,
            sources=[
                Source(source_id="rendered_page", text=text),
                Source(source_id="page_metadata", text=json.dumps(metadata, ensure_ascii=False)),
            ],
            context={},
            instruction="Determine what this captured page currently says. Distinguish a job's current closed/expired status from historical description prose, references to other jobs and hidden controls. Classify an individual posting versus a listing, a login or access challenge, and whether its actual application control is usable. Cite verbatim spans for every judgment; use unknown where current evidence is absent or inconsistent. HTTP status, URL identity and visibility metadata are supplied facts. Never use a phrase table or assume body presence means active.",
            **self._dependencies,
        )

    def description_quality(self, *, text, metadata):
        return determine(
            kind="description_quality",
            schema=DescriptionQuality,
            schema_version="1",
            prompt_version="description-quality-v1",
            entity_id=hashlib.sha256(text.encode()).hexdigest(),
            sources=[Source(source_id="description", text=text)],
            context=metadata,
            instruction="Judge whether this extracted text is a sufficiently complete description of one specific job, rather than navigation, a list of openings, a login page or fragments. Return a confidence code with exact source citations and a rationale. Extraction tier and application URL presence are metadata, not substitutes for understanding the content. Do not grade by length thresholds.",
            **self._dependencies,
        )


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


class ModelPagePostingExtractor:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def extract(self, *, entity_id, sources):
        from jobctrl.domain.determinations import DeterminationFailure

        source_text = {source.source_id: source.text for source in sources}

        def validate(result):
            for name in type(result).model_fields:
                field = getattr(result, name)
                if field.value and (
                    not field.citations
                    or not any(field.value in source_text[citation.source_id] for citation in field.citations)
                    or not all(
                        citation.quote in field.value or field.value in citation.quote for citation in field.citations
                    )
                ):
                    raise DeterminationFailure("field_binding_invalid")
            if not result.title.value or not result.description.value:
                raise DeterminationFailure("incomplete_posting_extraction")

        return determine(
            kind="posting_extraction",
            schema=PostingExtraction,
            schema_version="3",
            prompt_version="posting-extraction-v3",
            instruction="Extract the one current job posting from these canonical rendered-page and structured-data sources. Determine the role title, employer, complete job description, location, posted salary and the usable application URL. If the captured application control is on this posting, cite its supplied page URL; otherwise cite its explicit link URL. Leave application_url empty when no usable control is captured. Each nonempty field must be copied verbatim from one supplied source with citations. Leave absent employer, location or salary empty. Never guess an employer from a title separator, heading template or URL. Never use neighboring job listings. The page interpretation already established that this is an individual posting.",
            sources=sources,
            context={},
            entity_id=entity_id,
            validate=validate,
            **self._dependencies,
        )
