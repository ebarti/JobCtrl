"""Qualify a complete arbitrary-site posting, never a feed card."""

import json
from typing import Literal

from jobctrl.domain.determinations import DeterminationFailure, DeterminationModel, Source, determine
from jobctrl.domain.enrichment.interpretation import InterpretedField
from jobctrl.domain.enrichment.page_interpretation import DescriptionQuality


class PostingQualification(DeterminationModel):
    role_title: InterpretedField[Literal["specific_role", "not_specific", "unknown"]]
    description_quality: DescriptionQuality
    location_match: InterpretedField[Literal["match", "mismatch", "unknown"]]


class ModelPostingQualifier:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def qualify(self, *, entity_id, extraction, extraction_id, locations, captured_sources=(), source_urls=None):
        sources = [
            Source(source_id=f"posting:{name}", text=getattr(extraction, name).value)
            for name in ("title", "employer", "location", "description")
        ]
        sources.append(Source(source_id="saved_locations", text=json.dumps(locations, ensure_ascii=False)))
        sources.extend(captured_sources)
        posting_ids = {source.source_id for source in captured_sources} | {"posting:location", "posting:description"}

        def validate(result):
            if not any(c.source_id == "posting:title" for c in result.role_title.citations):
                raise DeterminationFailure("field_binding_invalid")
            if not any(c.source_id == "posting:description" for c in result.description_quality.citations):
                raise DeterminationFailure("field_binding_invalid")
            cited = {c.source_id for c in result.location_match.citations}
            if "saved_locations" not in cited or not cited.intersection(posting_ids):
                raise DeterminationFailure("field_binding_invalid")

        return determine(
            kind="discovery_posting_qualification",
            schema=PostingQualification,
            schema_version="1",
            prompt_version="discovery-posting-qualification-v1",
            entity_id=entity_id,
            sources=sources,
            context={"posting_extraction_id": extraction_id, "captured_source_urls": source_urls or {}},
            instruction=(
                "Qualify this complete captured individual job posting for automatic Discovery. "
                "Judge whether posting:title is the actual specific role, rather than a company hiring announcement, "
                "feed headline, multiple roles or generic careers heading. Cite posting:title. "
                "Judge description completeness for this one role; cite posting:description. Do not grade by length. "
                "Compare the posting's stated work location, remote eligibility, residence restrictions and work model "
                "using all captured sources, including structured applicantLocationRequirements and header details "
                "outside the selected description. The extracted location field alone may omit these restrictions. "
                "against the saved location rows exactly as authored. An object with locations and work_models "
                "contains parallel user-authored rows; pair them by index, with comma-separated work-model choices. "
                "Legacy rows instead carry location and a boolean remote parameter (false means non-remote). "
                "Each row permits only its selected work models; "
                "any matching row suffices. A remote role restricted to a different country does not match merely "
                "because it says remote. Do not infer relocation consent, work authorization or geography from history. "
                "No saved rows means no location restriction. Use unknown when the posting does not establish whether "
                "the saved rules can be met; do not invent missing places or turn uncertainty into a match or mismatch. "
                "Cite both saved_locations and the captured posting spans establishing location_match. "
                "Judge only these posting and location facts; full downstream scoring owns role fit and seniority."
            ),
            validate=validate,
            **self._dependencies,
        )
