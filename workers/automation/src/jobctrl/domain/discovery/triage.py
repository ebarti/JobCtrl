"""Intake admission is a cited model determination over a listing batch."""

from collections.abc import Callable
from typing import Literal

from pydantic import Field, StrictBool, StrictInt, StrictStr

from jobctrl.domain.determinations import (
    Citation,
    DeterminationFailure,
    DeterminationModel,
    DeterminationRepository,
    Source,
    determine,
)
from jobctrl.domain.ports.llm import LlmPort

TRIAGE_SCHEMA_VERSION = "2"
TRIAGE_PROMPT_VERSION = "posting-triage-v3-saved-targets"
DEFAULT_TRIAGE_BATCH_SIZE = 20
MAX_TRIAGE_BATCH_SIZE = 100


class Listing(DeterminationModel):
    listing_id: StrictStr = Field(min_length=1, max_length=240)
    source_id: StrictStr = Field(min_length=1, max_length=240)
    url: StrictStr = Field(min_length=1, max_length=4000)
    title: StrictStr = Field(max_length=2000)
    company: StrictStr = Field(max_length=2000)
    location: StrictStr = Field(max_length=4000)
    remote: StrictBool | None


class IntakeSnapshot(DeterminationModel):
    listing: Listing
    target_sources: list[Source]
    profile_version: StrictInt | None = Field(ge=1)


class ListingDecision(DeterminationModel):
    listing_id: StrictStr = Field(min_length=1, max_length=240)
    verdict: Literal["admit", "reject", "uncertain"]
    reason_code: Literal[
        "compatible",
        "role_mismatch",
        "seniority_mismatch",
        "location_mismatch",
        "work_model_mismatch",
        "exclusion",
        "insufficient_information",
    ]
    rationale: StrictStr = Field(min_length=1, max_length=1500)
    citations: list[Citation] = Field(min_length=1, max_length=20)


class PostingTriage(DeterminationModel):
    listings: list[ListingDecision] = Field(min_length=1, max_length=MAX_TRIAGE_BATCH_SIZE)


class ModelPostingTriage:
    def __init__(
        self,
        *,
        llm: LlmPort | None,
        repository: DeterminationRepository,
        tenant_id: str,
        provider: str,
        model: str,
        preflight: Callable[[], object],
    ):
        self._llm, self._repository, self._tenant_id = llm, repository, tenant_id
        self._provider, self._model, self._preflight = provider, model, preflight

    def triage(self, *, listings: list[Listing], targets: list[Source], preferences: dict):
        by_id = {listing.listing_id: listing for listing in listings}
        if len(by_id) != len(listings):
            raise DeterminationFailure("duplicate_listing_id")
        sources = [
            *(
                Source(source_id=f"listing:{listing.listing_id}:{field}", text=str(getattr(listing, field)))
                for listing in listings
                for field in ("url", "title", "company", "location", "remote")
            ),
            *targets,
        ]
        target_ids = {source.source_id for source in targets}

        def validate(result: PostingTriage):
            ids = [row.listing_id for row in result.listings]
            if len(set(ids)) != len(ids) or set(ids) != set(by_id):
                raise DeterminationFailure("foreign_or_missing_listing_id")
            for row in result.listings:
                allowed = target_ids | {
                    f"listing:{row.listing_id}:{field}" for field in ("url", "title", "company", "location", "remote")
                }
                if any(citation.source_id not in allowed for citation in row.citations):
                    raise DeterminationFailure("foreign_source_id")

        return determine(
            kind="posting_triage",
            schema=PostingTriage,
            schema_version=TRIAGE_SCHEMA_VERSION,
            prompt_version=TRIAGE_PROMPT_VERSION,
            instruction="Determine admission for each supplied listing against the user's saved targets and preferences. Those selected settings are authoritative: do not change them, propose replacements or demand another confirmation. Understand the listing's role, seniority, location and work model against those settings; do not treat a token as proof of a restriction or invent a hard constraint from a preference. Use listing title, company, location and structured remote flag only, without pretending a description was fetched. Return admit, reject or uncertain for every listing ID. Uncertainty is visible and waits for a decision. Cite exact spans from that listing and/or the saved targets. The user's literal exact exclusions retain their literal meaning. Never invent listing facts.",
            sources=sources,
            context={"listings": [listing.model_dump() for listing in listings], "preferences": preferences},
            tenant_id=self._tenant_id,
            entity_id="discovery:intake",
            provider=self._provider,
            model=self._model,
            lane="discovery",
            llm=self._llm,
            repository=self._repository,
            preflight=self._preflight,
            validate=validate,
        )
