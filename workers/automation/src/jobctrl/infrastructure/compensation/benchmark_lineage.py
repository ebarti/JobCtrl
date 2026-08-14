"""Read-model-safe lineage for canonical compensation benchmarks."""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from jobctrl.domain.compensation.benchmarks import (
    LOWER_FACTOR_BOUND,
    UPPER_FACTOR_BOUND,
    BenchmarkGeography,
    DirectBenchmarkFact,
    ExtrapolationDirectInput,
    ExtrapolationPriceInput,
    PriceLevelFact,
)
from jobctrl.infrastructure.compensation.sqlite_benchmark_repository import (
    SqliteCompensationBenchmarkRepository,
)


_CANONICAL_ESTIMATOR = re.compile(
    r"^company-role-reported-compensation-canonical-benchmark-v\d+"
    r":(direct|extrapolated):([a-f0-9-]{36})$"
)
_DIRECT_SOURCE_PROVENANCE = {"public", "licensed", "manual", "official"}


def load_market_benchmark_lineage(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    estimator_version: str,
) -> dict[str, Any] | None:
    """Resolve a per-job estimate reference to its immutable benchmark graph."""

    match = _CANONICAL_ESTIMATOR.fullmatch(estimator_version)
    if match is None:
        return None
    kind, fact_id = match.groups()
    repository = SqliteCompensationBenchmarkRepository(conn)
    try:
        if kind == "direct":
            direct = repository.get_direct(tenant_id, fact_id)
            if direct is None:
                return None
            return {
                **_lineage_base(
                    fact_id=direct.fact_id,
                    taxonomy_version=direct.taxonomy_version,
                    role_family_code=direct.role_family_code,
                    seniority_label=direct.seniority_label,
                    target_geography=direct.geography,
                    component=direct.component,
                    as_of_date=direct.as_of_date,
                    observed_at=direct.fetched_at,
                    fresh_until=direct.fresh_until,
                    direct_inputs=[_direct_input(direct, input_role="anchor", weight=1.0)],
                    price_inputs=[],
                ),
                "kind": "direct",
            }

        extrapolated = repository.get_extrapolated(tenant_id, fact_id)
        if extrapolated is None:
            return None
        direct_inputs = _direct_inputs(repository, tenant_id, extrapolated.direct_inputs)
        price_inputs = _price_inputs(repository, tenant_id, extrapolated.price_inputs)
        if direct_inputs is None or price_inputs is None:
            return None
        anchor = next(
            (
                item
                for item in direct_inputs
                if item["inputRole"] == "anchor" and item["factId"] == extrapolated.anchor_direct_fact_id
            ),
            None,
        )
        if anchor is None:
            return None
        return {
            **_lineage_base(
                fact_id=extrapolated.fact_id,
                taxonomy_version=extrapolated.taxonomy_version,
                role_family_code=extrapolated.role_family_code,
                seniority_label=extrapolated.seniority_label,
                target_geography=extrapolated.target_geography,
                component=extrapolated.component,
                as_of_date=extrapolated.as_of_date,
                observed_at=extrapolated.derived_at,
                fresh_until=extrapolated.fresh_until,
                direct_inputs=direct_inputs,
                price_inputs=price_inputs,
            ),
            "kind": "extrapolated",
            "anchorDirectFactId": extrapolated.anchor_direct_fact_id,
            "anchorGeography": anchor["geography"],
            "extrapolationMethod": "evidence_weighted_shrinkage",
            "rawFactor": extrapolated.raw_factor,
            "shrinkageWeight": extrapolated.shrinkage_weight,
            "lowerFactorBound": LOWER_FACTOR_BOUND,
            "upperFactorBound": UPPER_FACTOR_BOUND,
            "factorBoundState": extrapolated.factor_bound_state,
            "matchedCompanyCount": extrapolated.matched_company_count,
            "formulaVersion": extrapolated.formula_version,
        }
    except (sqlite3.OperationalError, ValueError):
        return None


def _lineage_base(
    *,
    fact_id: str,
    taxonomy_version: str,
    role_family_code: str,
    seniority_label: str,
    target_geography: BenchmarkGeography,
    component: str,
    as_of_date: str,
    observed_at: str,
    fresh_until: str,
    direct_inputs: list[dict[str, Any]],
    price_inputs: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "factId": fact_id,
        "taxonomyVersion": taxonomy_version,
        "roleFamilyCode": role_family_code,
        "seniorityLabel": seniority_label,
        "targetGeography": _geography(target_geography),
        "component": component,
        "asOfDate": as_of_date,
        "observedAt": observed_at,
        "freshUntil": fresh_until,
        "directInputs": direct_inputs,
        "priceLevelInputs": price_inputs,
    }


def _direct_inputs(
    repository: SqliteCompensationBenchmarkRepository,
    tenant_id: str,
    inputs: tuple[ExtrapolationDirectInput, ...],
) -> list[dict[str, Any]] | None:
    resolved: list[dict[str, Any]] = []
    for item in sorted(inputs, key=lambda value: (value.input_role, value.direct_fact_id)):
        fact = repository.get_direct(tenant_id, item.direct_fact_id)
        if fact is None:
            return None
        resolved.append(
            _direct_input(
                fact,
                input_role=item.input_role,
                weight=item.weight,
            )
        )
    return resolved


def _direct_input(
    fact: DirectBenchmarkFact,
    *,
    input_role: str,
    weight: float,
) -> dict[str, Any]:
    provenance = fact.source_provenance
    if provenance not in _DIRECT_SOURCE_PROVENANCE:
        raise ValueError("unsupported direct benchmark provenance")
    return {
        "factId": fact.fact_id,
        "inputRole": input_role,
        "weight": weight,
        "geography": _geography(fact.geography),
        "marketScope": fact.market_scope,
        "normalizedCompany": fact.normalized_company,
        "minimumAmountEur": fact.eur_annual_minimum_amount,
        "maximumAmountEur": fact.eur_annual_maximum_amount,
        "confidenceScore": fact.confidence_score,
        "sampleCount": fact.sample_count,
        "sourceId": fact.source_id,
        "sourceProvenance": provenance,
        "sourceSnapshotId": fact.source_snapshot_id,
        "asOfDate": fact.as_of_date,
        "fetchedAt": fact.fetched_at,
        "freshUntil": fact.fresh_until,
    }


def _price_inputs(
    repository: SqliteCompensationBenchmarkRepository,
    tenant_id: str,
    inputs: tuple[ExtrapolationPriceInput, ...],
) -> list[dict[str, Any]] | None:
    resolved: list[dict[str, Any]] = []
    for item in sorted(inputs, key=lambda value: (value.input_role, value.price_level_fact_id)):
        fact = repository.get_price_level(tenant_id, item.price_level_fact_id)
        if fact is None:
            return None
        resolved.append(_price_input(fact, input_role=item.input_role, weight=item.weight))
    return resolved


def _price_input(
    fact: PriceLevelFact,
    *,
    input_role: str,
    weight: float,
) -> dict[str, Any]:
    return {
        "factId": fact.fact_id,
        "inputRole": input_role,
        "weight": weight,
        "countryCode": fact.country_code,
        "category": fact.category,
        "referenceYear": fact.reference_year,
        "baseGeographyCode": fact.base_geography_code,
        "indexValue": fact.index_value,
        "sourceId": fact.source_id,
        "sourceSnapshotId": fact.source_snapshot_id,
        "asOfDate": fact.as_of_date,
        "fetchedAt": fact.fetched_at,
        "freshUntil": fact.fresh_until,
    }


def _geography(value: BenchmarkGeography) -> dict[str, str | None]:
    return {
        "countryCode": value.country_code,
        "subdivisionCode": value.subdivision_code or None,
        "locality": value.locality or None,
        "scope": value.scope,
    }
