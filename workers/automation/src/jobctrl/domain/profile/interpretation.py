"""Evidence-backed candidate suggestions; confirmation is an owner action."""

from typing import Literal
from pydantic import Field, StrictStr
from jobctrl.domain.determinations import Citation, DeterminationModel, determine
from jobctrl.domain.enrichment.interpretation import InterpretedField, InterpretedPlace
from jobctrl.domain.profile.canonical_sources import profile_sources
from jobctrl.domain.taxonomy_codes import TrackCode, SeniorityCode, OccupationFamilyCode, WorkModelCode


class TargetRole(DeterminationModel):
    title: StrictStr = Field(min_length=1, max_length=100)
    classification: Literal["direct", "adjacent"]
    track: TrackCode
    seniority: SeniorityCode
    citations: list[Citation] = Field(min_length=1, max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=240)


class TargetPreference(DeterminationModel):
    location: StrictStr = Field(max_length=100)
    work_model: WorkModelCode
    citations: list[Citation] = Field(min_length=1, max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=240)


class CandidateInterpretation(DeterminationModel):
    track: InterpretedField[TrackCode]
    seniority: InterpretedField[SeniorityCode]
    functions: list[InterpretedField[OccupationFamilyCode]] = Field(max_length=16)
    target_roles: list[TargetRole] = Field(max_length=5)
    target_preferences: list[TargetPreference] = Field(max_length=5)
    experience_places: list[InterpretedPlace] = Field(max_length=24)


class ModelCandidateInterpreter:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def interpret(self, *, profile, profile_version, entity_id="candidate"):
        sources = profile_sources(profile)
        return determine(
            kind="candidate_interpretation",
            schema=CandidateInterpretation,
            schema_version="1",
            prompt_version="candidate-interpretation-v1",
            sources=sources,
            entity_id=entity_id,
            context={"profile_version": profile_version},
            instruction="Interpret the supplied authored profile facts once. Map career track, seniority and functions to the supplied taxonomy. Propose up to five evidence-backed target roles and historical location/work-model preferences with verbatim citations and rationales. A historical location or role is a suggestion, never consent for a new search. Do not turn an unconfirmed evidence card into a fact. Do not write inferred strength, metrics or seniority into authored evidence. Use unknown codes when meaning is uncertain. Only supplied facts can support a suggestion; no external research.",
            **self._dependencies,
        )
