"""Posting semantics determined once for the canonical job snapshot."""

from __future__ import annotations

from typing import Generic, Literal, TypeVar
from pydantic import Field, StrictStr, PrivateAttr

from jobctrl.domain.determinations import Citation, DeterminationModel
from jobctrl.domain.taxonomy_codes import OccupationFamilyCode, RegionCode, SeniorityCode, TrackCode, WorkModelCode

T = TypeVar("T")


class InterpretedField(DeterminationModel, Generic[T]):
    value: T
    citations: list[Citation] = Field(min_length=1, max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class InterpretedPlace(DeterminationModel):
    country_code: StrictStr | None = Field(pattern=r"^[A-Z]{2}$")
    region: RegionCode
    locality: StrictStr | None = Field(max_length=160)
    citations: list[Citation] = Field(min_length=1, max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class InterpretedConstraint(DeterminationModel):
    category: Literal[
        "work_authorization", "clearance", "citizenship", "language", "qualification", "explicit_exclusion"
    ]
    required: bool
    value: StrictStr = Field(min_length=1, max_length=500)
    citations: list[Citation] = Field(min_length=1, max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class InterpretedCompensation(DeterminationModel):
    state: Literal["stated", "uncertain", "not_stated"]
    lower: StrictStr | None = Field(pattern=r"^\d+(?:\.\d+)?$")
    upper: StrictStr | None = Field(pattern=r"^\d+(?:\.\d+)?$")
    currency: StrictStr | None = Field(pattern=r"^[A-Z]{3}$")
    period: Literal["hour", "day", "week", "month", "year", "unknown"]
    component: Literal["base_salary", "ote", "bonus", "commission", "equity", "unknown"]
    citations: list[Citation] = Field(max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class RequirementInterpretation(DeterminationModel):
    requirement_id: StrictStr = Field(min_length=1, max_length=240)
    scope: Literal["resume", "eligibility", "logistics", "employer_condition"]
    protected_class: bool
    citations: list[Citation] = Field(min_length=1, max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class JobInterpretation(DeterminationModel):
    _determination_id: str = PrivateAttr(default="")
    track: InterpretedField[TrackCode]
    seniority: InterpretedField[SeniorityCode]
    occupation_family: InterpretedField[OccupationFamilyCode]
    work_model: InterpretedField[WorkModelCode]
    places: list[InterpretedPlace] = Field(max_length=24)
    constraints: list[InterpretedConstraint] = Field(max_length=40)
    compensation: list[InterpretedCompensation] = Field(max_length=20)
    requirements: list[RequirementInterpretation] = Field(max_length=200)


class ModelJobInterpreter:
    def __init__(self, *, llm, repository, tenant_id, provider, model, preflight, lane="enrichment"):
        self._llm, self._repository, self._tenant_id = llm, repository, tenant_id
        self._provider, self._model, self._preflight, self._lane = provider, model, preflight, lane

    def interpret(self, *, entity_id, posting, fields, requirements):
        from decimal import Decimal
        from jobctrl.domain.determinations import DeterminationFailure, determine
        from jobctrl.domain.exact_values import numeric_literals

        sources = [posting, *fields, *requirements]
        expected = {source.source_id for source in requirements}

        def validate(result):
            ids = [row.requirement_id for row in result.requirements]
            if set(ids) != expected or len(set(ids)) != len(ids):
                raise DeterminationFailure("foreign_or_missing_requirement_id")
            for row in result.compensation:
                if row.state == "stated":
                    if not row.citations or (row.lower is None and row.upper is None) or row.currency is None:
                        raise DeterminationFailure("missing_compensation_citation")
                    numbers = {number for cite in row.citations for _, number in numeric_literals(cite.quote)}
                    if any(Decimal(value) not in numbers for value in (row.lower, row.upper) if value is not None):
                        raise DeterminationFailure("mismatched_value")
                    if row.lower is not None and row.upper is not None and Decimal(row.lower) > Decimal(row.upper):
                        raise DeterminationFailure("invalid_numeric_range")
                elif row.lower is not None or row.upper is not None:
                    raise DeterminationFailure("inconsistent_verdict")

        return determine(
            kind="job_interpretation",
            schema=JobInterpretation,
            schema_version="1",
            prompt_version="job-interpretation-v1",
            instruction="Interpret this canonical posting once. Map track, seniority, occupation, work model and geographic places to the supplied taxonomy codes. Identify every actual eligibility constraint without inventing requirements. Extract posted compensation with its stated component, period, currency and exact amounts; never infer pay from unrelated numbers. Every requirement ID must receive exactly one scope and protected-class determination. Treat requirements as resume, eligibility, logistics or employer condition according to their meaning; no phrase table. Cite verbatim source spans for every judgment, explaining uncertainty using unknown codes. Candidate requirements must not include unlawful protected-class criteria; flag them rather than silently discarding evidence. Return numeric compensation as exact decimal strings, converting only explicit numeric multipliers such as 100k. No external research.",
            sources=sources,
            context={"requirement_ids": sorted(expected)},
            tenant_id=self._tenant_id,
            entity_id=entity_id,
            provider=self._provider,
            model=self._model,
            lane=self._lane,
            llm=self._llm,
            repository=self._repository,
            preflight=self._preflight,
            validate=validate,
        )
