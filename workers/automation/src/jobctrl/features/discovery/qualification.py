"""Strict source-bound admission of complete arbitrary-site postings."""

from typing import Literal

from pydantic import Field, StrictStr

from jobctrl.app.errors import AppError
from jobctrl.semantic import Citation, DeterminationFailure, DeterminationModel, Source, validate_citations


class PostingAdmission(DeterminationModel):
    specific_role: Literal["yes", "no", "unknown"]
    role_citations: list[Citation] = Field(min_length=1, max_length=12)
    location_match: Literal["match", "mismatch", "unknown"]
    location_citations: list[Citation] = Field(min_length=1, max_length=12)
    rationale: StrictStr = Field(min_length=1, max_length=4000)


async def qualify_posting(model, posting, locations):
    import json

    sources = [
        Source(source_id="posting:" + key, text=posting.get(key) or "")
        for key in ("title", "company", "location", "description")
    ]
    sources.append(Source(source_id="saved_locations", text=json.dumps(locations, ensure_ascii=False)))
    sources.extend(
        Source.model_validate(source)
        for source in posting.get("provenance", {}).get("sources", [])
        if source.get("source_id") not in {s.source_id for s in sources}
    )
    response = await model.determine(
        operation="discovery.posting_qualification",
        instructions=(
            "Qualify this complete captured individual posting. Determine whether its title is a specific role rather than "
            "a hiring announcement, feed headline, multiple roles or generic careers heading. Cite posting:title. "
            "Compare all captured location, remote eligibility, residence restrictions and work-model evidence against the "
            "saved location rows exactly as authored. Each row has location and a literal remote flag; any matching row suffices. "
            "A role restricted to another country cannot match just because it is remote. No saved rows means no location restriction. "
            "Use unknown when current evidence cannot establish a match or mismatch. Cite saved_locations and captured posting "
            "location evidence. Judge neither applicant qualifications nor role fit. Never infer relocation or work authorization."
        ),
        sources=[s.model_dump() for s in sources],
        response_schema=PostingAdmission.model_json_schema(),
        lane="enrichment",
        prompt_version="1",
    )
    result = PostingAdmission.model_validate(response.value)
    try:
        validate_citations(result, sources)
    except DeterminationFailure as error:
        raise AppError(error.code, "The posting qualification is not bound to its sources.", 409) from None
    if not any(c.source_id == "posting:title" for c in result.role_citations):
        raise AppError(
            "posting_qualification_binding_invalid", "The posting admission omitted its title authority.", 409
        )
    cited = {c.source_id for c in result.location_citations}
    if "saved_locations" not in cited or not cited.intersection(
        {s.source_id for s in sources if s.source_id != "saved_locations"}
    ):
        raise AppError(
            "posting_qualification_binding_invalid",
            "The posting admission omitted saved location or posting authority.",
            409,
        )
    return result, response.provenance
