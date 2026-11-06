"""Neutral inputs and boundary ports for source-bound compensation analysis.

Source references and determination IDs are opaque caller identities; the core
never interprets them as JobCtrl IDs. Implementations are supplied by the host.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class Source:
    reference: str
    text: str
    as_of: str | None = None
    url: str | None = None
    attribution: str | None = None


@dataclass(frozen=True)
class Citation:
    reference: str
    quote: str


@dataclass(frozen=True)
class Determination:
    reference: str
    provider: str
    model: str
    lane: str
    prompt_version: str
    input_fingerprint: str
    source_reference: str
    source_hash: str
    citations: tuple[Citation, ...]
    rationale: str
    decided_at: str


@dataclass(frozen=True)
class PayJudgment:
    parse_state: Literal["missing", "unparseable", "ambiguous", "parsed_range"]
    currency: str | None
    period: Literal["hour", "month", "year", "unknown"]
    component: Literal["base_salary", "ote", "bonus", "commission", "equity", "unknown"]
    minimum: int | None
    maximum: int | None
    confidence: Literal["none", "low", "medium", "high"]
    warnings: tuple[str, ...]
    determination: Determination


@dataclass(frozen=True)
class Classification:
    occupation: str
    seniority: str
    countries: tuple[str, ...]
    market_scope: Literal["company", "market", "unknown"]
    company_tier: Literal["tier_1_local", "tier_2_ambitious", "tier_3_top_of_market", "unknown"]
    determination: Determination
    field_citations: tuple[tuple[str, tuple[Citation, ...]], ...] = ()
    geography_scope: Literal["country", "locality", "multiple", "unknown"] = "unknown"
    locality: str | None = None


@dataclass(frozen=True)
class Observation:
    source: Source
    provider: str
    provenance: Literal["public", "licensed", "manual", "official"]
    company: str | None
    company_reference: str | None
    role: str
    location: str | None
    level: str | None
    component: Literal["base_salary", "total_compensation"]
    currency: str
    period: Literal["year", "month", "week", "day", "hour"]
    minimum: int | None
    maximum: int | None
    sample_count: int | None
    release_year: int | None
    attribution: str
    classification: Classification | None = None
    original_period: str | None = None
    original_currency: str | None = None
    original_minimum: int | float | None = None
    original_maximum: int | float | None = None
    conversion_rate: float | None = None
    conversion_reference: str | None = None


@dataclass(frozen=True)
class Rate:
    source: Source
    from_currency: str
    to_currency: str
    rate: float
    as_of: str


@dataclass(frozen=True)
class PriceLevel:
    source: Source
    country: str
    category: str
    base_geography: str
    year: int
    index: float


@dataclass(frozen=True)
class CompanyPair:
    company_reference: str
    source_value: float
    target_value: float
    quality_weight: float
    source: Source
    target: Source


class Model(Protocol):
    async def posted_pay(self, source: Source) -> PayJudgment: ...
    async def classify(self, source: Source) -> Classification: ...


class Provider(Protocol):
    def observations(self, target: Classification, policy: dict) -> tuple[Observation, ...]: ...


class Rates(Protocol):
    def rate(self, source_currency: str, target_currency: str, as_of: str) -> Rate | None: ...
