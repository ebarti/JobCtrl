"""Interpret authored search intent once, before the user confirms its meaning."""

from typing import Literal
from pydantic import Field, StrictStr
from jobctrl.domain.determinations import Citation, DeterminationModel, Source, determine
from jobctrl.domain.enrichment.interpretation import InterpretedField, InterpretedPlace
from jobctrl.domain.taxonomy_codes import TrackCode, SeniorityCode, OccupationFamilyCode, WorkModelCode


class PreferredRole(DeterminationModel):
    title: StrictStr = Field(min_length=1, max_length=240)
    track: TrackCode
    seniority_floor: SeniorityCode
    occupation_family: OccupationFamilyCode
    citations: list[Citation] = Field(min_length=1, max_length=12)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class SearchCondition(DeterminationModel):
    category: Literal[
        "role",
        "seniority",
        "location",
        "work_model",
        "work_authorization",
        "language",
        "qualification",
        "employer_condition",
        "other",
    ]
    force: Literal["required", "excluded", "preferred", "uncertain"]
    description: StrictStr = Field(min_length=1, max_length=1000)
    citations: list[Citation] = Field(min_length=1, max_length=12)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class SearchPreferences(DeterminationModel):
    roles: list[PreferredRole] = Field(max_length=40)
    places: list[InterpretedPlace] = Field(max_length=40)
    work_models: list[InterpretedField[WorkModelCode]] = Field(max_length=8)
    conditions: list[SearchCondition] = Field(max_length=40)
    rationale: StrictStr = Field(min_length=1, max_length=2000)


TARGET_FIELDS = (
    "roles",
    "tracks",
    "seniority",
    "functions",
    "specializations",
    "locations",
    "work_models",
    "exclusions",
    "criteria",
)


def authored_search_sources(search_cfg):
    target = search_cfg.get("confirmed_targets") or {}
    return [
        Source(source_id=f"target:{key}:{index}", text=str(value))
        for key in TARGET_FIELDS
        for index, value in enumerate(target.get(key) or [])
        if str(value).strip()
    ]


class ModelSearchPreferenceInterpreter:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def interpret(self, *, search_cfg):
        from jobctrl.domain.determinations import DeterminationFailure

        sources = authored_search_sources(search_cfg)
        if not sources:
            raise DeterminationFailure("authored_preferences_missing")
        return determine(
            kind="search_preferences",
            schema=SearchPreferences,
            schema_version="1",
            prompt_version="search-preferences-v1",
            entity_id="discovery:preferences",
            sources=sources,
            context={"profile_version": (search_cfg.get("confirmed_targets") or {}).get("profile_version")},
            instruction="Interpret only the user's authored search intent into a proposal they must confirm. Map roles, tracks, seniority floors, occupations, places and work models to the supplied codes. Interpret criteria and exclusions into explicit typed conditions with their meaning and force. A preference is not a hard requirement; ambiguous intent stays uncertain. Never use the person's home address or historical employment as consent. Every role, place, work model and condition must cite the authored preference that supports it. Do not invent an exclusion, geography, compensation requirement or role. This result supplies the meaning of preferences to downstream determinations; it does not authorize any search or profile edit.",
            **self._dependencies,
        )
