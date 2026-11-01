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

    def interpret(self, *, entity_id, text, metadata, additional_sources=()):
        return determine(
            kind="page_interpretation",
            schema=PageInterpretation,
            schema_version="1",
            prompt_version="page-interpretation-v1",
            entity_id=entity_id,
            sources=[
                Source(source_id="rendered_page", text=text),
                Source(source_id="page_metadata", text=json.dumps(metadata, ensure_ascii=False)),
                *additional_sources,
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


class PostingDescriptionSelection(DeterminationModel):
    source_id: StrictStr = Field(min_length=1, max_length=240)
    first_line_id: StrictStr = Field(min_length=1, max_length=100)
    last_line_id: StrictStr = Field(min_length=1, max_length=100)
    rationale: StrictStr = Field(min_length=1, max_length=1000)
    value: StrictStr | None = Field(default=None, max_length=64000, description="Return null; the application copies the validated source span.")
    citations: list[Citation] = Field(default_factory=list, max_length=20, description="Return []; the application records the exact copied source citation.")


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
    source_origins: list[PostingSourceOrigin] = Field(default_factory=list, max_length=512, description="Return []; the application records captured source origins.")


class ModelPagePostingExtractor:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def extract(self, *, entity_id, sources, source_urls=None):
        from jobctrl.domain.determinations import DeterminationFailure, validate_citations

        source_text = {source.source_id: source.text for source in sources}
        if source_urls is not None and set(source_urls) != set(source_text):
            raise DeterminationFailure("source_binding_invalid")
        origins = {source.source_id: (source_urls or {}).get(source.source_id, entity_id) for source in sources}
        recorded_origins = [PostingSourceOrigin(source_id=ident, url=url) for ident, url in origins.items()]
        if len(origins) > 512:
            raise DeterminationFailure("source_schema_violation")
        line_ranges = {}
        inventory = []
        for source_index, source in enumerate(sources):
            offset = 0
            lines = []
            ranges = {}
            for line_index, text in enumerate(source.text.splitlines(keepends=True)):
                line_id = f"line:{source_index}:{line_index}"
                ranges[line_id] = (offset, offset + len(text))
                lines.append({"line_id": line_id, "text": text})
                offset += len(text)
            line_ranges[source.source_id] = ranges
            inventory.append({"source_id": source.source_id, "lines": lines})

        def materialize(selected):
            description = selected.description
            ranges = line_ranges.get(description.source_id, {})
            first = ranges.get(description.first_line_id)
            last = ranges.get(description.last_line_id)
            if first is None or last is None or first[0] > last[0]:
                raise DeterminationFailure("field_binding_invalid", repair_context={
                    "field": "description", "selection": description.model_dump(),
                })
            value = source_text[description.source_id][first[0]:last[1]].strip()
            if not value:
                raise DeterminationFailure("incomplete_posting_extraction")
            citations = [Citation(source_id=description.source_id, quote=value[:4000], exact_values=[])]
            if (
                description.value is not None and description.value != value
                or description.citations and description.citations != citations
            ):
                raise DeterminationFailure("field_binding_invalid", repair_context={"field": "description"})
            description.value = value
            description.citations = citations
            fields = selected.model_dump(exclude={"description", "source_origins"})
            return PostingExtraction(**fields, description=PostingField(
                value=value,
                citations=citations,
                rationale=description.rationale,
            ))

        def validate(selected):
            if selected.source_origins and selected.source_origins != recorded_origins:
                raise DeterminationFailure("field_binding_invalid", repair_context={"field": "source_urls"})
            selected.source_origins = recorded_origins
            result = materialize(selected)
            validate_citations(result, sources)
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

        selected, envelope = determine(
            kind="posting_extraction",
            schema=PostingSelectionExtraction,
            schema_version="4",
            prompt_version="posting-extraction-v4-source-selection",
            instruction="Extract the one current job posting from these canonical rendered-page and structured-data sources. Determine the role title, employer, complete job description, location, posted salary and usable application URL. Captured embedded pages retain their own source URLs; select the requested posting, not unrelated frames. For description, select its source_id and the first_line_id and last_line_id of one contiguous range from line_inventory; return value=null and citations=[]. Return source_origins=[] because code records captured origins. Select the complete substantive posting, including responsibilities, requirements and benefits where present, excluding unrelated navigation and legal panels. Prefer a dedicated structured description source when it supplies the complete posting. Code copies and records that exact source span and its citation; never retype or normalize the description. All other nonempty field values must be copied verbatim from one supplied source with citations. If the captured application control is on this posting, cite its supplied page URL; otherwise cite its explicit link URL. Leave application_url empty when no usable control is captured. Leave absent employer, location or salary empty. Never guess an employer from a title separator, heading template or URL. Never use neighboring job listings. The page interpretation already established that this is an individual posting.",
            sources=sources,
            context={"line_inventory": inventory, "source_urls": origins},
            entity_id=entity_id,
            validate=validate,
            **self._dependencies,
        )
        return materialize(selected), envelope
