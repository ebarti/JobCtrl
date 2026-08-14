"""Map reported-compensation observations into canonical direct facts."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

from jobctrl.domain.compensation import (
    LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
    DirectBenchmarkFact,
    ReportedCompensationObservation,
    annualize_and_convert_to_eur,
    build_direct_benchmark_fact,
    classify_role,
    classify_seniority,
    normalize_company_name,
    resolve_benchmark_geography,
)


BenchmarkObservationRejectionReason = Literal[
    "employer_posted_is_not_market_evidence",
    "invalid_observation",
    "missing_amount",
    "missing_country",
    "missing_fx_rate",
    "missing_role_family",
]


@dataclass(frozen=True)
class FxRateToEur:
    currency: str
    rate: float
    source_id: str
    reference_id: str
    as_of_date: str

    def __post_init__(self) -> None:
        if len(self.currency) != 3 or self.currency != self.currency.upper():
            raise ValueError("currency must be an uppercase ISO currency code")
        if not math.isfinite(self.rate) or self.rate <= 0:
            raise ValueError("FX rate must be finite and positive")
        if not self.source_id.strip() or not self.reference_id.strip():
            raise ValueError("FX source and reference identifiers are required")


@dataclass(frozen=True)
class BenchmarkObservationRejection:
    observation_index: int
    source_id: str
    reason: BenchmarkObservationRejectionReason


@dataclass(frozen=True)
class BenchmarkObservationBatch:
    facts: tuple[DirectBenchmarkFact, ...]
    rejected: tuple[BenchmarkObservationRejection, ...]


def canonicalize_reported_observations(
    observations: tuple[ReportedCompensationObservation, ...],
    *,
    tenant_id: str,
    fetched_at: str,
    fresh_until: str,
    fx_rates_to_eur: tuple[FxRateToEur, ...] = (),
) -> BenchmarkObservationBatch:
    """Build direct facts while preserving explicit rejection provenance."""

    rates = {rate.currency: rate for rate in fx_rates_to_eur}
    rates.setdefault(
        "EUR",
        FxRateToEur(
            currency="EUR",
            rate=1.0,
            source_id="identity",
            reference_id="eur-identity",
            as_of_date=fetched_at[:10],
        ),
    )
    facts: list[DirectBenchmarkFact] = []
    rejected: list[BenchmarkObservationRejection] = []
    for index, observation in enumerate(observations):
        try:
            rejection = _canonicalize_one(
                observation,
                observation_index=index,
                tenant_id=tenant_id,
                fetched_at=fetched_at,
                fresh_until=fresh_until,
                rates=rates,
            )
        except (OverflowError, TypeError, ValueError):
            rejection = _rejection(
                observation,
                index,
                "invalid_observation",
            )
        if isinstance(rejection, BenchmarkObservationRejection):
            rejected.append(rejection)
        else:
            facts.append(rejection)
    return BenchmarkObservationBatch(facts=tuple(facts), rejected=tuple(rejected))


def _canonicalize_one(
    observation: ReportedCompensationObservation,
    *,
    observation_index: int,
    tenant_id: str,
    fetched_at: str,
    fresh_until: str,
    rates: dict[str, FxRateToEur],
) -> DirectBenchmarkFact | BenchmarkObservationRejection:
    if observation.source_provenance == "employer_posted" or observation.source_id == "posted_salary_text":
        return _rejection(
            observation,
            observation_index,
            "employer_posted_is_not_market_evidence",
        )
    minimum = observation.minimum_amount
    maximum = observation.maximum_amount
    if minimum is None and maximum is None:
        return _rejection(observation, observation_index, "missing_amount")
    minimum = minimum if minimum is not None else maximum
    maximum = maximum if maximum is not None else minimum
    assert minimum is not None and maximum is not None
    if maximum < minimum:
        minimum, maximum = maximum, minimum

    classification = classify_role(observation.role_title)
    if classification.role_family_code is None:
        return _rejection(observation, observation_index, "missing_role_family")
    geography = resolve_benchmark_geography(observation.location)
    if geography is None:
        return _rejection(observation, observation_index, "missing_country")
    currency = observation.currency.strip().upper()
    rate = rates.get(currency)
    if rate is None:
        return _rejection(observation, observation_index, "missing_fx_rate")

    annual_minimum = annualize_and_convert_to_eur(
        minimum,
        period=observation.period,
        rate_to_eur=rate.rate,
    )
    annual_maximum = annualize_and_convert_to_eur(
        maximum,
        period=observation.period,
        rate_to_eur=rate.rate,
    )
    sample_count = max(1, int(observation.sample_count or 1))
    confidence_score = _direct_confidence(
        observation.source_provenance,
        sample_count,
    )
    uncertainty_margin = max(0.08, (1 - confidence_score) * 0.4)
    interval_minimum = max(1, round(annual_minimum * (1 - uncertainty_margin)))
    interval_maximum = max(
        annual_maximum,
        round(annual_maximum * (1 + uncertainty_margin)),
    )
    market_scope = _market_scope(observation.company_name)
    normalized_company = normalize_company_name(observation.company_name) if market_scope == "company" else None
    seniority = classify_seniority(observation.level_label or observation.role_title)
    as_of_date = f"{observation.release_year:04d}-01-01" if observation.release_year is not None else fetched_at[:10]
    attribution = str(observation.attribution or "").strip() or f"Reported compensation source: {observation.source_id}"
    return build_direct_benchmark_fact(
        tenant_id=tenant_id,
        role_family_code=classification.role_family_code,
        seniority_label=seniority,
        geography=geography,
        market_scope=market_scope,
        normalized_company=normalized_company,
        component=observation.component,
        original_currency=currency,
        original_period=observation.period,
        original_minimum_amount=minimum,
        original_maximum_amount=maximum,
        eur_annual_minimum_amount=annual_minimum,
        eur_annual_maximum_amount=annual_maximum,
        confidence_interval_minimum_amount=interval_minimum,
        confidence_interval_maximum_amount=interval_maximum,
        confidence_score=confidence_score,
        sample_count=sample_count,
        source_id=observation.source_id,
        source_provenance=observation.source_provenance,
        source_snapshot_id=observation.snapshot_version,
        source_url=observation.source_url,
        attribution=attribution,
        fx_reference={
            "currency": currency,
            "rate_to_eur": rate.rate,
            "source_id": rate.source_id,
            "reference_id": rate.reference_id,
            "as_of_date": rate.as_of_date,
        },
        as_of_date=as_of_date,
        fetched_at=fetched_at,
        fresh_until=fresh_until,
    )


def _rejection(
    observation: ReportedCompensationObservation,
    observation_index: int,
    reason: BenchmarkObservationRejectionReason,
) -> BenchmarkObservationRejection:
    return BenchmarkObservationRejection(
        observation_index=observation_index,
        source_id=observation.source_id,
        reason=reason,
    )


def _market_scope(company_name: str) -> Literal["market", "company"]:
    normalized = company_name.strip().casefold()
    if company_name == LEVELS_FYI_MARKET_AGGREGATE_COMPANY:
        return "market"
    if "market aggregate" in normalized or normalized.endswith(" community"):
        return "market"
    return "company"


def _direct_confidence(provenance: str, sample_count: int) -> float:
    base = {
        "licensed": 0.76,
        "official": 0.82,
        "public": 0.64,
        "manual": 0.56,
    }.get(provenance, 0.5)
    sample_bonus = min(0.12, max(0, sample_count - 1) * 0.015)
    return round(min(0.9, base + sample_bonus), 6)


__all__ = [
    "BenchmarkObservationBatch",
    "BenchmarkObservationRejection",
    "FxRateToEur",
    "canonicalize_reported_observations",
]
