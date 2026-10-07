"""A model plans board queries and search locations from confirmed targets."""

from typing import Literal

from pydantic import Field, StrictBool, StrictInt, StrictStr

from jobctrl.domain.determinations import Citation, DeterminationFailure, DeterminationModel, determine


class PlannedQuery(DeterminationModel):
    query: StrictStr = Field(min_length=1, max_length=500)
    tier: StrictInt = Field(ge=1, le=3)
    source_scope: list[Literal["jobspy", "ats_api", "workday", "smartextract"]] = Field(min_length=1, max_length=4)
    citations: list[Citation] = Field(min_length=1, max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class PlannedSearchLocation(DeterminationModel):
    label: StrictStr = Field(min_length=1, max_length=160)
    location: StrictStr = Field(min_length=1, max_length=500)
    remote: StrictBool
    country_indeed: StrictStr | None = Field(max_length=160)
    citations: list[Citation] = Field(min_length=1, max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class DiscoveryQueryPlan(DeterminationModel):
    queries: list[PlannedQuery] = Field(min_length=1, max_length=40)
    locations: list[PlannedSearchLocation] = Field(min_length=1, max_length=40)


class ModelDiscoveryQueryPlanner:
    def __init__(self, *, llm, repository, tenant_id, provider, model, preflight):
        self._llm, self._repository, self._tenant_id = llm, repository, tenant_id
        self._provider, self._model, self._preflight = provider, model, preflight

    def plan(self, *, targets, preferences):
        if not targets:
            raise DeterminationFailure("confirmed_preferences_missing")
        return determine(
            kind="discovery_query_plan",
            schema=DiscoveryQueryPlan,
            schema_version="1",
            prompt_version="discovery-query-plan-v1",
            instruction="Plan useful discovery searches from the supplied confirmed target profile. Use the confirmed interpretation of roles, seniority, conditions and locations; do not reinterpret raw preference prose. Produce literal query strings, source-family scopes and priority tiers, and search locations with native board country parameters where applicable. Source families are codes, never aliases. Give verbatim supporting citations and a reason for every query and location. Do not remove enabled sources or invent preferences; queries and locations must serve the user's confirmed targets. Remote is a structured search flag, not a keyword scan.",
            sources=targets,
            context={"preferences": preferences},
            tenant_id=self._tenant_id,
            entity_id="discovery:query-plan",
            provider=self._provider,
            model=self._model,
            lane="discovery",
            llm=self._llm,
            repository=self._repository,
            preflight=self._preflight,
        )
