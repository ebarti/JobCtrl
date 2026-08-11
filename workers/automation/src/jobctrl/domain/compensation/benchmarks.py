"""Canonical compensation benchmark facts and geographic extrapolation.

Employer-posted compensation is intentionally absent from this module. Direct
market evidence and extrapolated market evidence are different authorities and
remain different types all the way to persistence and presentation.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import re
import socket
import urllib.parse
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, timezone
from types import MappingProxyType
from typing import Any, Literal


ROLE_FAMILY_TAXONOMY_VERSION = "jobctrl-role-family-v1"
GEOGRAPHIC_EXTRAPOLATION_FORMULA_VERSION = "geo-shrinkage-v1"
LOWER_FACTOR_BOUND = 0.1
UPPER_FACTOR_BOUND = 10.0

SeniorityLabel = Literal[
    "entry",
    "mid",
    "senior",
    "staff",
    "principal",
    "manager",
    "director",
    "executive",
    "unknown",
]
GeographyScope = Literal["country", "country_subdivision", "locality"]
BenchmarkComponent = Literal["base_salary", "total_compensation"]
BenchmarkMarketScope = Literal["market", "company"]
BenchmarkSourceProvenance = Literal[
    "public",
    "licensed",
    "manual",
    "official",
]
PriceLevelCategory = Literal[
    "actual_individual_consumption",
    "household_final_consumption",
    "general_price_level",
]
PriceLevelSourceId = Literal["eurostat", "world_bank", "oecd", "manual_official"]
FactorBoundState = Literal[
    "within_bounds",
    "below_lower_bound",
    "above_upper_bound",
]
BenchmarkConfidenceBand = Literal["low", "medium"]
DirectInputRole = Literal[
    "anchor",
    "matched_company_source",
    "matched_company_target",
    "occupation_anchor",
]
PriceInputRole = Literal[
    "source_price_level",
    "target_price_level",
    "shrinkage_prior",
]

_FACT_NAMESPACE = uuid.UUID("c34587ca-8990-56a3-8765-645e44cb565d")
_ISO_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
_HASH_RE = re.compile(r"^[a-f0-9]{64}$")
_TOKEN_RE = re.compile(r"[a-z0-9+#]+")
_UNSAFE_PROVENANCE_MARKERS = (
    "/home/",
    "/private/",
    "/users/",
    "/var/folders/",
    "\\users\\",
    "api key",
    "api-key",
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "credential",
    "file://",
    "password",
    "private_key",
    "secret",
    "token",
)
_PRIVATE_HOST_SUFFIXES = (".internal", ".local", ".localhost", ".test")
_LOCAL_PATH_RE = re.compile(
    r"(?:^|[\s\"'=(:])(?:[a-z]:[\\/]|\\\\|/(?!/|\s)|\.\.?[\\/]|~[\\/])",
    re.IGNORECASE,
)
_SENIORITY_LABELS = {
    "entry",
    "mid",
    "senior",
    "staff",
    "principal",
    "manager",
    "director",
    "executive",
    "unknown",
}
_BENCHMARK_COMPONENTS = {"base_salary", "total_compensation"}
_MARKET_SCOPES = {"market", "company"}
_SOURCE_PROVENANCE = {"public", "licensed", "manual", "official"}
_PRICE_LEVEL_CATEGORIES = {
    "actual_individual_consumption",
    "household_final_consumption",
    "general_price_level",
}
_PRICE_LEVEL_SOURCE_IDS = {"eurostat", "world_bank", "oecd", "manual_official"}
_DIRECT_INPUT_ROLES = {
    "anchor",
    "matched_company_source",
    "matched_company_target",
    "occupation_anchor",
}
_PRICE_INPUT_ROLES = {
    "source_price_level",
    "target_price_level",
    "shrinkage_prior",
}

_ROLE_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "security_privacy",
        (
            "application security",
            "cloud security",
            "cybersecurity",
            "information security",
            "privacy engineer",
            "security",
            "trust and safety",
        ),
    ),
    (
        "data_ai",
        (
            "artificial intelligence",
            "data analyst",
            "data engineer",
            "data scientist",
            "machine learning",
            "ml engineer",
            "analytics engineer",
        ),
    ),
    (
        "infrastructure_platform",
        (
            "cloud engineer",
            "devops",
            "infrastructure",
            "platform engineer",
            "reliability engineer",
            "site reliability",
            "sre",
        ),
    ),
    (
        "product_management",
        ("product manager", "product management", "product owner"),
    ),
    (
        "design_research",
        (
            "content designer",
            "product design",
            "product designer",
            "researcher",
            "service designer",
            "ux",
            "user research",
        ),
    ),
    (
        "sales_business_development",
        (
            "account executive",
            "business development",
            "partnerships",
            "sales",
            "solutions consultant",
        ),
    ),
    (
        "marketing_communications",
        (
            "communications",
            "content marketing",
            "demand generation",
            "growth marketing",
            "marketing",
            "public relations",
        ),
    ),
    (
        "customer_success_support",
        (
            "customer experience",
            "customer success",
            "customer support",
            "implementation consultant",
            "support engineer",
        ),
    ),
    (
        "finance_accounting",
        ("accountant", "accounting", "controller", "finance", "financial"),
    ),
    (
        "people_talent",
        (
            "human resources",
            "people operations",
            "recruiter",
            "recruiting",
            "talent acquisition",
        ),
    ),
    (
        "legal_compliance",
        ("compliance", "counsel", "legal", "lawyer", "regulatory"),
    ),
    (
        "business_operations",
        (
            "business operations",
            "chief of staff",
            "operations manager",
            "program manager",
            "project manager",
            "strategy and operations",
        ),
    ),
    (
        "software_engineering",
        (
            "backend",
            "developer",
            "engineer",
            "engineering manager",
            "frontend",
            "full stack",
            "mobile engineer",
            "software",
            "web engineer",
        ),
    ),
    (
        "general_management",
        (
            "chief executive",
            "general manager",
            "managing director",
            "president",
        ),
    ),
)

_COUNTRY_ALIASES: dict[str, str] = {
    "andorra": "AD",
    "australia": "AU",
    "austria": "AT",
    "belgium": "BE",
    "brazil": "BR",
    "bulgaria": "BG",
    "canada": "CA",
    "croatia": "HR",
    "cyprus": "CY",
    "czech republic": "CZ",
    "czechia": "CZ",
    "denmark": "DK",
    "estonia": "EE",
    "finland": "FI",
    "france": "FR",
    "germany": "DE",
    "greece": "GR",
    "hong kong": "HK",
    "hungary": "HU",
    "iceland": "IS",
    "india": "IN",
    "ireland": "IE",
    "italy": "IT",
    "japan": "JP",
    "latvia": "LV",
    "lithuania": "LT",
    "luxembourg": "LU",
    "malta": "MT",
    "mexico": "MX",
    "netherlands": "NL",
    "new zealand": "NZ",
    "norway": "NO",
    "poland": "PL",
    "portugal": "PT",
    "romania": "RO",
    "singapore": "SG",
    "slovakia": "SK",
    "slovenia": "SI",
    "south africa": "ZA",
    "spain": "ES",
    "sweden": "SE",
    "switzerland": "CH",
    "uae": "AE",
    "united arab emirates": "AE",
    "united kingdom": "GB",
    "united states": "US",
    "united states of america": "US",
    "uk": "GB",
    "usa": "US",
}


@dataclass(frozen=True)
class BenchmarkGeography:
    country_code: str
    scope: GeographyScope = "country"
    subdivision_code: str = ""
    locality: str = ""

    def __post_init__(self) -> None:
        country = self.country_code.strip().upper()
        subdivision = self.subdivision_code.strip()
        locality = self.locality.strip()
        if not _ISO_COUNTRY_RE.fullmatch(country):
            raise ValueError("country_code must be an ISO 3166-1 alpha-2 code")
        if self.scope not in {"country", "country_subdivision", "locality"}:
            raise ValueError("unsupported geography scope")
        if self.scope == "country" and (subdivision or locality):
            raise ValueError("country geography cannot include subdivision or locality")
        if self.scope == "country_subdivision" and (not subdivision or locality):
            raise ValueError("country_subdivision geography requires only subdivision_code")
        if self.scope == "locality" and not locality:
            raise ValueError("locality geography requires locality")
        object.__setattr__(self, "country_code", country)
        object.__setattr__(self, "subdivision_code", subdivision)
        object.__setattr__(self, "locality", locality)


@dataclass(frozen=True)
class RoleClassification:
    taxonomy_version: str
    role_family_code: str | None
    seniority_label: SeniorityLabel
    matched_rule: str | None


@dataclass(frozen=True)
class DirectBenchmarkFact:
    tenant_id: str
    fact_id: str
    taxonomy_version: str
    role_family_code: str
    seniority_label: SeniorityLabel
    geography: BenchmarkGeography
    market_scope: BenchmarkMarketScope
    normalized_company: str | None
    component: BenchmarkComponent
    original_currency: str
    original_period: str
    original_minimum_amount: int
    original_maximum_amount: int
    eur_annual_minimum_amount: int
    eur_annual_maximum_amount: int
    confidence_interval_minimum_amount: int
    confidence_interval_maximum_amount: int
    confidence_score: float
    sample_count: int
    source_id: str
    source_provenance: BenchmarkSourceProvenance
    source_snapshot_id: str
    source_url: str | None
    attribution: str
    fx_reference: Mapping[str, Any]
    as_of_date: str
    fetched_at: str
    fresh_until: str
    evidence_hash: str
    created_at: str

    def __post_init__(self) -> None:
        fx_reference = _canonical_json_object(self.fx_reference, "fx_reference")
        object.__setattr__(self, "fx_reference", _freeze_json(fx_reference))
        _validate_uuid(self.fact_id, "fact_id")
        _validate_hash(self.evidence_hash, "evidence_hash")
        _require_text(self.tenant_id, "tenant_id")
        _require_text(self.taxonomy_version, "taxonomy_version")
        _require_text(self.role_family_code, "role_family_code")
        _require_text(self.source_id, "source_id")
        _require_text(self.source_snapshot_id, "source_snapshot_id")
        _require_text(self.attribution, "attribution")
        if self.seniority_label not in _SENIORITY_LABELS:
            raise ValueError("unsupported seniority_label")
        if self.market_scope not in _MARKET_SCOPES:
            raise ValueError("unsupported market_scope")
        if self.component not in _BENCHMARK_COMPONENTS:
            raise ValueError("unsupported compensation component")
        if self.source_provenance not in _SOURCE_PROVENANCE:
            raise ValueError("employer-posted compensation must use the posted compensation authority")
        if self.source_id == "posted_salary_text":
            raise ValueError("employer-posted compensation must use the posted compensation authority")
        _validate_public_url(self.source_url, "source_url", allow_none=True)
        _validate_safe_provenance(
            self.source_id,
            self.source_snapshot_id,
            self.attribution,
            self.source_url or "",
            json.dumps(fx_reference, sort_keys=True),
        )
        if self.market_scope == "market" and self.normalized_company is not None:
            raise ValueError("market facts cannot name a company")
        if self.market_scope == "company" and not self.normalized_company:
            raise ValueError("company facts require normalized_company")
        if not _CURRENCY_RE.fullmatch(self.original_currency):
            raise ValueError("original_currency must be an uppercase ISO currency code")
        if self.original_period not in {"year", "month", "week", "day", "hour"}:
            raise ValueError("unsupported original_period")
        if self.original_minimum_amount <= 0:
            raise ValueError("original minimum must be positive")
        if self.original_maximum_amount < self.original_minimum_amount:
            raise ValueError("original maximum must not be below original minimum")
        if self.eur_annual_minimum_amount <= 0:
            raise ValueError("annual EUR minimum must be positive")
        if self.eur_annual_maximum_amount < self.eur_annual_minimum_amount:
            raise ValueError("annual EUR maximum must not be below annual EUR minimum")
        if self.confidence_interval_minimum_amount > self.eur_annual_minimum_amount:
            raise ValueError("confidence interval minimum must include the estimate")
        if self.confidence_interval_maximum_amount < self.eur_annual_maximum_amount:
            raise ValueError("confidence interval maximum must include the estimate")
        _validate_score(self.confidence_score)
        if self.sample_count <= 0:
            raise ValueError("sample_count must be positive")
        _validate_temporal_window(
            as_of_date=self.as_of_date,
            observed_at=self.fetched_at,
            fresh_until=self.fresh_until,
            observed_field="fetched_at",
        )
        _require_canonical_timestamp(self.created_at, "created_at")
        self.assert_integrity()

    @property
    def midpoint(self) -> float:
        return (self.eur_annual_minimum_amount + self.eur_annual_maximum_amount) / 2

    @property
    def fx_reference_payload(self) -> dict[str, Any]:
        """Return a detached JSON-compatible copy for persistence."""

        payload = _thaw_json(self.fx_reference)
        if not isinstance(payload, dict):  # pragma: no cover - constructor enforces this
            raise ValueError("fx_reference must be a JSON object")
        return payload

    def assert_integrity(self) -> None:
        expected_hash = _content_hash(_direct_fact_payload(self))
        if self.evidence_hash != expected_hash:
            raise ValueError("evidence_hash does not match direct benchmark content")
        if self.fact_id != _fact_id("direct", self.tenant_id, expected_hash):
            raise ValueError("fact_id does not match direct benchmark content")


@dataclass(frozen=True)
class PriceLevelFact:
    tenant_id: str
    fact_id: str
    country_code: str
    category: PriceLevelCategory
    reference_year: int
    base_geography_code: str
    index_value: float
    source_id: PriceLevelSourceId
    source_snapshot_id: str
    source_url: str
    attribution: str
    as_of_date: str
    fetched_at: str
    fresh_until: str
    evidence_hash: str
    created_at: str

    def __post_init__(self) -> None:
        _validate_uuid(self.fact_id, "fact_id")
        _validate_hash(self.evidence_hash, "evidence_hash")
        _require_text(self.tenant_id, "tenant_id")
        if not _ISO_COUNTRY_RE.fullmatch(self.country_code):
            raise ValueError("country_code must be an uppercase ISO code")
        if self.category not in _PRICE_LEVEL_CATEGORIES:
            raise ValueError("unsupported price-level category")
        if self.source_id not in _PRICE_LEVEL_SOURCE_IDS:
            raise ValueError("unsupported price-level source")
        if self.reference_year < 2000:
            raise ValueError("reference_year must be at least 2000")
        if not math.isfinite(self.index_value) or self.index_value <= 0:
            raise ValueError("index_value must be finite and positive")
        for value, field in (
            (self.base_geography_code, "base_geography_code"),
            (self.source_snapshot_id, "source_snapshot_id"),
            (self.source_url, "source_url"),
            (self.attribution, "attribution"),
        ):
            _require_text(value, field)
        _validate_public_url(self.source_url, "source_url")
        _validate_safe_provenance(
            self.source_snapshot_id,
            self.source_url,
            self.attribution,
        )
        _validate_temporal_window(
            as_of_date=self.as_of_date,
            observed_at=self.fetched_at,
            fresh_until=self.fresh_until,
            observed_field="fetched_at",
        )
        _require_canonical_timestamp(self.created_at, "created_at")
        self.assert_integrity()

    def assert_integrity(self) -> None:
        expected_hash = _content_hash(_price_level_fact_payload(self))
        if self.evidence_hash != expected_hash:
            raise ValueError("evidence_hash does not match price-level content")
        if self.fact_id != _fact_id("price", self.tenant_id, expected_hash):
            raise ValueError("fact_id does not match price-level content")


@dataclass(frozen=True)
class CompanyBenchmarkPair:
    source: DirectBenchmarkFact
    target: DirectBenchmarkFact

    def __post_init__(self) -> None:
        if self.source.tenant_id != self.target.tenant_id:
            raise ValueError("company ratio inputs must belong to the same tenant")
        if self.source.market_scope != "company" or self.target.market_scope != "company":
            raise ValueError("company ratio inputs must be company-scoped facts")
        if self.source.normalized_company != self.target.normalized_company:
            raise ValueError("company ratio inputs must name the same company")
        for field in ("taxonomy_version", "role_family_code", "seniority_label", "component"):
            if getattr(self.source, field) != getattr(self.target, field):
                raise ValueError(f"company ratio inputs must match {field}")
        if self.source.geography.country_code == self.target.geography.country_code:
            raise ValueError("company ratio inputs must span countries")

    @property
    def ratio(self) -> float:
        return self.target.midpoint / self.source.midpoint

    @property
    def quality_weight(self) -> float:
        sample_support = math.sqrt(min(self.source.sample_count, self.target.sample_count))
        confidence = math.sqrt(self.source.confidence_score * self.target.confidence_score)
        return max(0.01, sample_support * confidence)


@dataclass(frozen=True)
class ExtrapolationDirectInput:
    direct_fact_id: str
    input_role: DirectInputRole
    weight: float

    def __post_init__(self) -> None:
        _validate_uuid(self.direct_fact_id, "direct_fact_id")
        if self.input_role not in _DIRECT_INPUT_ROLES:
            raise ValueError("unsupported direct input role")
        if not math.isfinite(self.weight) or self.weight < 0:
            raise ValueError("direct input weight must be finite and non-negative")


@dataclass(frozen=True)
class ExtrapolationPriceInput:
    price_level_fact_id: str
    input_role: PriceInputRole
    weight: float

    def __post_init__(self) -> None:
        _validate_uuid(self.price_level_fact_id, "price_level_fact_id")
        if self.input_role not in _PRICE_INPUT_ROLES:
            raise ValueError("unsupported price input role")
        if not math.isfinite(self.weight) or self.weight < 0:
            raise ValueError("price input weight must be finite and non-negative")


@dataclass(frozen=True)
class ExtrapolatedBenchmarkFact:
    tenant_id: str
    fact_id: str
    anchor_direct_fact_id: str
    taxonomy_version: str
    role_family_code: str
    seniority_label: SeniorityLabel
    target_geography: BenchmarkGeography
    component: BenchmarkComponent
    minimum_amount: int
    maximum_amount: int
    confidence_interval_minimum_amount: int
    confidence_interval_maximum_amount: int
    confidence_band: BenchmarkConfidenceBand
    confidence_score: float
    raw_factor: float
    shrinkage_weight: float
    factor_bound_state: FactorBoundState
    matched_company_count: int
    formula_version: str
    inputs_hash: str
    warnings: tuple[str, ...]
    as_of_date: str
    derived_at: str
    fresh_until: str
    direct_inputs: tuple[ExtrapolationDirectInput, ...]
    price_inputs: tuple[ExtrapolationPriceInput, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "warnings", tuple(self.warnings))
        object.__setattr__(self, "direct_inputs", tuple(self.direct_inputs))
        object.__setattr__(self, "price_inputs", tuple(self.price_inputs))
        _validate_uuid(self.fact_id, "fact_id")
        _validate_uuid(self.anchor_direct_fact_id, "anchor_direct_fact_id")
        _validate_hash(self.inputs_hash, "inputs_hash")
        _require_text(self.tenant_id, "tenant_id")
        _require_text(self.taxonomy_version, "taxonomy_version")
        _require_text(self.role_family_code, "role_family_code")
        _require_text(self.formula_version, "formula_version")
        if self.seniority_label not in _SENIORITY_LABELS:
            raise ValueError("unsupported seniority_label")
        if self.component not in _BENCHMARK_COMPONENTS:
            raise ValueError("unsupported compensation component")
        if self.confidence_band not in {"low", "medium"}:
            raise ValueError("unsupported confidence band")
        if self.minimum_amount <= 0 or self.maximum_amount < self.minimum_amount:
            raise ValueError("extrapolated range is invalid")
        if self.confidence_interval_minimum_amount > self.minimum_amount:
            raise ValueError("confidence interval minimum must include the estimate")
        if self.confidence_interval_maximum_amount < self.maximum_amount:
            raise ValueError("confidence interval maximum must include the estimate")
        _validate_score(self.confidence_score)
        if not 0 <= self.shrinkage_weight <= 1:
            raise ValueError("shrinkage_weight must be between zero and one")
        if self.raw_factor <= 0:
            raise ValueError("raw_factor must be positive")
        expected_state = factor_bound_state(self.raw_factor)
        if self.factor_bound_state != expected_state:
            raise ValueError("factor_bound_state does not match raw_factor")
        _validate_temporal_window(
            as_of_date=self.as_of_date,
            observed_at=self.derived_at,
            fresh_until=self.fresh_until,
            observed_field="derived_at",
        )
        anchor_inputs = tuple(item for item in self.direct_inputs if item.input_role == "anchor")
        if len(anchor_inputs) != 1 or anchor_inputs[0].direct_fact_id != self.anchor_direct_fact_id:
            raise ValueError("direct lineage must contain the declared anchor exactly once")
        source_company_count = sum(item.input_role == "matched_company_source" for item in self.direct_inputs)
        target_company_count = sum(item.input_role == "matched_company_target" for item in self.direct_inputs)
        if source_company_count != self.matched_company_count or target_company_count != self.matched_company_count:
            raise ValueError("matched_company_count does not match direct lineage")
        if sum(item.input_role == "source_price_level" for item in self.price_inputs) != 1:
            raise ValueError("price lineage must contain one source price level")
        if sum(item.input_role == "target_price_level" for item in self.price_inputs) != 1:
            raise ValueError("price lineage must contain one target price level")
        self.assert_integrity()

    @property
    def is_actionable(self) -> bool:
        """Out-of-bound facts remain visible for audit but are never effective."""

        return self.factor_bound_state == "within_bounds"

    @property
    def bounded_factor(self) -> float:
        return min(UPPER_FACTOR_BOUND, max(LOWER_FACTOR_BOUND, self.raw_factor))

    def assert_integrity(self) -> None:
        expected_hash = _content_hash(
            _extrapolation_inputs_payload(
                anchor_direct_fact_id=self.anchor_direct_fact_id,
                target_geography=self.target_geography,
                direct_inputs=self.direct_inputs,
                price_inputs=self.price_inputs,
                formula_version=self.formula_version,
            )
        )
        if self.inputs_hash != expected_hash:
            raise ValueError("inputs_hash does not match extrapolation lineage")
        content_hash = _content_hash(_extrapolated_fact_payload(self))
        if self.fact_id != _fact_id("extrapolated", self.tenant_id, content_hash):
            raise ValueError("fact_id does not match extrapolated benchmark content")


def classify_role(title: str) -> RoleClassification:
    normalized = _normalized_phrase(title)
    matched_code: str | None = None
    matched_rule: str | None = None
    for code, rules in _ROLE_RULES:
        for rule in rules:
            if _phrase_present(normalized, rule):
                matched_code = code
                matched_rule = rule
                break
        if matched_code is not None:
            break
    return RoleClassification(
        taxonomy_version=ROLE_FAMILY_TAXONOMY_VERSION,
        role_family_code=matched_code,
        seniority_label=classify_seniority(title),
        matched_rule=matched_rule,
    )


def classify_seniority(title_or_level: str | None) -> SeniorityLabel:
    tokens = set(_TOKEN_RE.findall(str(title_or_level or "").casefold()))
    normalized = _normalized_phrase(title_or_level or "")
    if tokens & {"chief", "ceo", "cfo", "cio", "ciso", "coo", "cpo", "cto", "president", "vp"}:
        return "executive"
    if "vice president" in normalized:
        return "executive"
    if "director" in tokens or "head" in tokens:
        return "director"
    if "manager" in tokens or "management" in tokens:
        return "manager"
    if "principal" in tokens:
        return "principal"
    if "staff" in tokens:
        return "staff"
    if "senior" in tokens or "sr" in tokens:
        return "senior"
    if tokens & {"entry", "graduate", "intern", "internship", "junior", "jr"}:
        return "entry"
    if tokens & {"associate", "intermediate", "mid"} or "mid level" in normalized:
        return "mid"
    return "unknown"


def resolve_country_code(location: str | None) -> str | None:
    normalized = _normalized_phrase(location or "")
    if not normalized:
        return None
    for alias in sorted(_COUNTRY_ALIASES, key=len, reverse=True):
        if _phrase_present(normalized, alias):
            return _COUNTRY_ALIASES[alias]
    parts = [part.strip() for part in re.split(r"[,/|()]", str(location or ""))]
    for part in reversed(parts):
        if _ISO_COUNTRY_RE.fullmatch(part):
            return part
    return None


def normalize_company_name(value: str | None) -> str | None:
    normalized = _normalized_phrase(value or "")
    if not normalized:
        return None
    legal_suffixes = {
        "ag",
        "bv",
        "corp",
        "corporation",
        "gmbh",
        "inc",
        "incorporated",
        "limited",
        "llc",
        "ltd",
        "nv",
        "oy",
        "plc",
        "sa",
        "sas",
        "sarl",
        "sl",
    }
    tokens = [token for token in normalized.split() if token not in legal_suffixes]
    return " ".join(tokens) or None


def build_direct_benchmark_fact(
    *,
    tenant_id: str,
    role_family_code: str,
    seniority_label: SeniorityLabel,
    geography: BenchmarkGeography,
    market_scope: BenchmarkMarketScope,
    normalized_company: str | None,
    component: BenchmarkComponent,
    original_currency: str,
    original_period: str,
    original_minimum_amount: int,
    original_maximum_amount: int,
    eur_annual_minimum_amount: int,
    eur_annual_maximum_amount: int,
    confidence_interval_minimum_amount: int,
    confidence_interval_maximum_amount: int,
    confidence_score: float,
    sample_count: int,
    source_id: str,
    source_provenance: BenchmarkSourceProvenance,
    source_snapshot_id: str,
    source_url: str | None,
    attribution: str,
    fx_reference: Mapping[str, Any],
    as_of_date: str,
    fetched_at: str,
    fresh_until: str,
    created_at: str | None = None,
    taxonomy_version: str = ROLE_FAMILY_TAXONOMY_VERSION,
) -> DirectBenchmarkFact:
    as_of_date = _canonical_benchmark_date(as_of_date, "as_of_date")
    fetched_at = canonical_benchmark_timestamp(fetched_at, "fetched_at")
    fresh_until = canonical_benchmark_timestamp(fresh_until, "fresh_until")
    created = canonical_benchmark_timestamp(created_at or fetched_at, "created_at")
    original_currency = original_currency.strip().upper()
    normalized_company = normalize_company_name(normalized_company)
    fx_payload = _canonical_json_object(fx_reference, "fx_reference")
    payload = {
        "tenant_id": tenant_id,
        "taxonomy_version": taxonomy_version,
        "role_family_code": role_family_code,
        "seniority_label": seniority_label,
        "geography": _geography_payload(geography),
        "market_scope": market_scope,
        "normalized_company": normalized_company,
        "component": component,
        "original_currency": original_currency,
        "original_period": original_period,
        "original_minimum_amount": original_minimum_amount,
        "original_maximum_amount": original_maximum_amount,
        "eur_annual_minimum_amount": eur_annual_minimum_amount,
        "eur_annual_maximum_amount": eur_annual_maximum_amount,
        "confidence_interval_minimum_amount": confidence_interval_minimum_amount,
        "confidence_interval_maximum_amount": confidence_interval_maximum_amount,
        "confidence_score": round(confidence_score, 6),
        "sample_count": sample_count,
        "source_id": source_id,
        "source_provenance": source_provenance,
        "source_snapshot_id": source_snapshot_id,
        "source_url": source_url,
        "attribution": attribution,
        "fx_reference": fx_payload,
        "as_of_date": as_of_date,
        "fetched_at": fetched_at,
        "fresh_until": fresh_until,
    }
    evidence_hash = _content_hash(payload)
    return DirectBenchmarkFact(
        tenant_id=tenant_id,
        fact_id=_fact_id("direct", tenant_id, evidence_hash),
        taxonomy_version=taxonomy_version,
        role_family_code=role_family_code,
        seniority_label=seniority_label,
        geography=geography,
        market_scope=market_scope,
        normalized_company=normalized_company,
        component=component,
        original_currency=original_currency,
        original_period=original_period,
        original_minimum_amount=original_minimum_amount,
        original_maximum_amount=original_maximum_amount,
        eur_annual_minimum_amount=eur_annual_minimum_amount,
        eur_annual_maximum_amount=eur_annual_maximum_amount,
        confidence_interval_minimum_amount=confidence_interval_minimum_amount,
        confidence_interval_maximum_amount=confidence_interval_maximum_amount,
        confidence_score=round(confidence_score, 6),
        sample_count=sample_count,
        source_id=source_id,
        source_provenance=source_provenance,
        source_snapshot_id=source_snapshot_id,
        source_url=source_url,
        attribution=attribution,
        fx_reference=fx_payload,
        as_of_date=as_of_date,
        fetched_at=fetched_at,
        fresh_until=fresh_until,
        evidence_hash=evidence_hash,
        created_at=created,
    )


def build_price_level_fact(
    *,
    tenant_id: str,
    country_code: str,
    category: PriceLevelCategory,
    reference_year: int,
    base_geography_code: str,
    index_value: float,
    source_id: PriceLevelSourceId,
    source_snapshot_id: str,
    source_url: str,
    attribution: str,
    as_of_date: str,
    fetched_at: str,
    fresh_until: str,
    created_at: str | None = None,
) -> PriceLevelFact:
    country = country_code.strip().upper()
    as_of_date = _canonical_benchmark_date(as_of_date, "as_of_date")
    fetched_at = canonical_benchmark_timestamp(fetched_at, "fetched_at")
    fresh_until = canonical_benchmark_timestamp(fresh_until, "fresh_until")
    created = canonical_benchmark_timestamp(created_at or fetched_at, "created_at")
    numeric_index = float(index_value)
    if not math.isfinite(numeric_index) or numeric_index <= 0:
        raise ValueError("index_value must be finite and positive")
    normalized_index = round(numeric_index, 8)
    payload = {
        "tenant_id": tenant_id,
        "country_code": country,
        "category": category,
        "reference_year": reference_year,
        "base_geography_code": base_geography_code,
        "index_value": normalized_index,
        "source_id": source_id,
        "source_snapshot_id": source_snapshot_id,
        "source_url": source_url,
        "attribution": attribution,
        "as_of_date": as_of_date,
        "fetched_at": fetched_at,
        "fresh_until": fresh_until,
    }
    evidence_hash = _content_hash(payload)
    return PriceLevelFact(
        tenant_id=tenant_id,
        fact_id=_fact_id("price", tenant_id, evidence_hash),
        country_code=country,
        category=category,
        reference_year=reference_year,
        base_geography_code=base_geography_code,
        index_value=normalized_index,
        source_id=source_id,
        source_snapshot_id=source_snapshot_id,
        source_url=source_url,
        attribution=attribution,
        as_of_date=as_of_date,
        fetched_at=fetched_at,
        fresh_until=fresh_until,
        evidence_hash=evidence_hash,
        created_at=created,
    )


def extrapolate_benchmark(
    *,
    anchor: DirectBenchmarkFact,
    target_geography: BenchmarkGeography,
    source_price_level: PriceLevelFact,
    target_price_level: PriceLevelFact,
    company_pairs: tuple[CompanyBenchmarkPair, ...] = (),
    derived_at: str,
) -> ExtrapolatedBenchmarkFact:
    derived_at = canonical_benchmark_timestamp(derived_at, "derived_at")
    if anchor.tenant_id != source_price_level.tenant_id or anchor.tenant_id != target_price_level.tenant_id:
        raise ValueError("all extrapolation inputs must belong to the same tenant")
    if anchor.geography.country_code != source_price_level.country_code:
        raise ValueError("source price level must match the anchor country")
    if target_geography.country_code != target_price_level.country_code:
        raise ValueError("target price level must match the target country")
    if source_price_level.category != target_price_level.category:
        raise ValueError("price-level categories must match")
    if source_price_level.reference_year != target_price_level.reference_year:
        raise ValueError("price-level reference years must match")
    if source_price_level.base_geography_code != target_price_level.base_geography_code:
        raise ValueError("price-level base geographies must match")

    accepted: list[CompanyBenchmarkPair] = []
    seen_companies: set[str] = set()
    for pair in company_pairs:
        if not (
            pair.source.tenant_id == anchor.tenant_id
            and pair.target.tenant_id == anchor.tenant_id
            and pair.source.taxonomy_version == anchor.taxonomy_version
            and pair.target.taxonomy_version == anchor.taxonomy_version
            and pair.source.role_family_code == anchor.role_family_code
            and pair.target.role_family_code == anchor.role_family_code
            and pair.source.seniority_label == anchor.seniority_label
            and pair.target.seniority_label == anchor.seniority_label
            and pair.source.component == anchor.component
            and pair.target.component == anchor.component
            and pair.source.geography == anchor.geography
            and pair.target.geography == target_geography
        ):
            raise ValueError("company ratio inputs do not match the extrapolation slice")
        company_key = str(pair.source.normalized_company)
        if company_key not in seen_companies:
            accepted.append(pair)
            seen_companies.add(company_key)
    accepted_pairs = tuple(accepted)

    price_factor = target_price_level.index_value / source_price_level.index_value
    pair_weights = tuple(pair.quality_weight for pair in accepted_pairs)
    total_pair_weight = sum(pair_weights)
    if accepted_pairs:
        company_log_factor = (
            sum(weight * math.log(pair.ratio) for pair, weight in zip(accepted_pairs, pair_weights, strict=True))
            / total_pair_weight
        )
        company_factor = math.exp(company_log_factor)
        shrinkage_weight = total_pair_weight / (total_pair_weight + 3.0)
        raw_factor = math.exp(
            shrinkage_weight * math.log(company_factor) + (1 - shrinkage_weight) * math.log(price_factor)
        )
    else:
        shrinkage_weight = 0.0
        raw_factor = price_factor

    raw_factor = round(raw_factor, 8)
    bound_state = factor_bound_state(raw_factor)
    warnings: list[str] = []
    if not accepted_pairs:
        warnings.append("cost_of_living_only")
    elif len(accepted_pairs) < 3:
        warnings.append("limited_matched_company_evidence")
    if bound_state == "below_lower_bound":
        warnings.append("factor_below_lower_bound")
    elif bound_state == "above_upper_bound":
        warnings.append("factor_above_upper_bound")

    minimum = max(1, round(anchor.eur_annual_minimum_amount * raw_factor))
    maximum = max(minimum, round(anchor.eur_annual_maximum_amount * raw_factor))
    interval_minimum = max(
        1,
        round(anchor.confidence_interval_minimum_amount * raw_factor),
    )
    interval_maximum = max(
        maximum,
        round(anchor.confidence_interval_maximum_amount * raw_factor),
    )
    if accepted_pairs:
        confidence_score = min(
            0.74,
            0.35 + min(0.18, len(accepted_pairs) * 0.06) + shrinkage_weight * 0.24,
        )
        confidence_band: BenchmarkConfidenceBand = (
            "medium" if len(accepted_pairs) >= 2 and confidence_score >= 0.55 else "low"
        )
    else:
        confidence_score = 0.3
        confidence_band = "low"
    if bound_state != "within_bounds":
        confidence_score = min(confidence_score, 0.2)
        confidence_band = "low"

    direct_inputs: list[ExtrapolationDirectInput] = [
        ExtrapolationDirectInput(
            direct_fact_id=anchor.fact_id,
            input_role="anchor",
            weight=1.0,
        )
    ]
    for pair, pair_weight in zip(accepted_pairs, pair_weights, strict=True):
        normalized_weight = shrinkage_weight * pair_weight / total_pair_weight if total_pair_weight else 0.0
        direct_inputs.extend(
            (
                ExtrapolationDirectInput(
                    direct_fact_id=pair.source.fact_id,
                    input_role="matched_company_source",
                    weight=round(normalized_weight, 8),
                ),
                ExtrapolationDirectInput(
                    direct_fact_id=pair.target.fact_id,
                    input_role="matched_company_target",
                    weight=round(normalized_weight, 8),
                ),
            )
        )
    price_weight = round(1 - shrinkage_weight, 8)
    price_inputs = (
        ExtrapolationPriceInput(
            price_level_fact_id=source_price_level.fact_id,
            input_role="source_price_level",
            weight=price_weight,
        ),
        ExtrapolationPriceInput(
            price_level_fact_id=target_price_level.fact_id,
            input_role="target_price_level",
            weight=price_weight,
        ),
    )
    input_payload = _extrapolation_inputs_payload(
        anchor_direct_fact_id=anchor.fact_id,
        target_geography=target_geography,
        direct_inputs=tuple(direct_inputs),
        price_inputs=price_inputs,
        formula_version=GEOGRAPHIC_EXTRAPOLATION_FORMULA_VERSION,
    )
    inputs_hash = _content_hash(input_payload)
    as_of_date = min(
        anchor.as_of_date,
        source_price_level.as_of_date,
        target_price_level.as_of_date,
        *(fact.as_of_date for pair in accepted_pairs for fact in (pair.source, pair.target)),
    )
    fresh_until = min(
        anchor.fresh_until,
        source_price_level.fresh_until,
        target_price_level.fresh_until,
        *(fact.fresh_until for pair in accepted_pairs for fact in (pair.source, pair.target)),
    )
    fact_fields: dict[str, Any] = {
        "tenant_id": anchor.tenant_id,
        "anchor_direct_fact_id": anchor.fact_id,
        "taxonomy_version": anchor.taxonomy_version,
        "role_family_code": anchor.role_family_code,
        "seniority_label": anchor.seniority_label,
        "target_geography": target_geography,
        "component": anchor.component,
        "minimum_amount": minimum,
        "maximum_amount": maximum,
        "confidence_interval_minimum_amount": min(interval_minimum, minimum),
        "confidence_interval_maximum_amount": interval_maximum,
        "confidence_band": confidence_band,
        "confidence_score": round(confidence_score, 6),
        "raw_factor": raw_factor,
        "shrinkage_weight": round(shrinkage_weight, 8),
        "factor_bound_state": bound_state,
        "matched_company_count": len(accepted_pairs),
        "formula_version": GEOGRAPHIC_EXTRAPOLATION_FORMULA_VERSION,
        "inputs_hash": inputs_hash,
        "warnings": tuple(warnings),
        "as_of_date": as_of_date,
        "derived_at": derived_at,
        "fresh_until": fresh_until,
        "direct_inputs": tuple(direct_inputs),
        "price_inputs": price_inputs,
    }
    content_hash = _content_hash(_extrapolated_fact_payload(fact_fields))
    return ExtrapolatedBenchmarkFact(
        fact_id=_fact_id("extrapolated", anchor.tenant_id, content_hash),
        **fact_fields,
    )


def factor_bound_state(raw_factor: float) -> FactorBoundState:
    if raw_factor < LOWER_FACTOR_BOUND:
        return "below_lower_bound"
    if raw_factor > UPPER_FACTOR_BOUND:
        return "above_upper_bound"
    return "within_bounds"


def annualize_and_convert_to_eur(
    amount: int,
    *,
    period: str,
    rate_to_eur: float,
) -> int:
    if amount <= 0 or rate_to_eur <= 0:
        raise ValueError("amount and rate_to_eur must be positive")
    multipliers = {
        "year": 1,
        "month": 12,
        "week": 52,
        "day": 260,
        "hour": 2080,
    }
    try:
        multiplier = multipliers[period]
    except KeyError as exc:
        raise ValueError("unsupported compensation period") from exc
    return max(1, round(amount * multiplier * rate_to_eur))


def canonical_benchmark_timestamp(value: str, field: str = "timestamp") -> str:
    """Normalize an aware ISO timestamp to fixed-width UTC for SQL ordering."""

    raw = str(value or "").strip()
    candidate = f"{raw[:-1]}+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO 8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field} must include a UTC offset")
    return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _normalized_phrase(value: str) -> str:
    return " ".join(_TOKEN_RE.findall(value.casefold()))


def _phrase_present(normalized: str, phrase: str) -> bool:
    return f" {phrase} " in f" {normalized} "


def _geography_payload(geography: BenchmarkGeography) -> dict[str, str]:
    return {
        "country_code": geography.country_code,
        "scope": geography.scope,
        "subdivision_code": geography.subdivision_code,
        "locality": geography.locality,
    }


def _direct_fact_payload(fact: DirectBenchmarkFact) -> dict[str, Any]:
    return {
        "tenant_id": fact.tenant_id,
        "taxonomy_version": fact.taxonomy_version,
        "role_family_code": fact.role_family_code,
        "seniority_label": fact.seniority_label,
        "geography": _geography_payload(fact.geography),
        "market_scope": fact.market_scope,
        "normalized_company": fact.normalized_company,
        "component": fact.component,
        "original_currency": fact.original_currency,
        "original_period": fact.original_period,
        "original_minimum_amount": fact.original_minimum_amount,
        "original_maximum_amount": fact.original_maximum_amount,
        "eur_annual_minimum_amount": fact.eur_annual_minimum_amount,
        "eur_annual_maximum_amount": fact.eur_annual_maximum_amount,
        "confidence_interval_minimum_amount": fact.confidence_interval_minimum_amount,
        "confidence_interval_maximum_amount": fact.confidence_interval_maximum_amount,
        "confidence_score": round(fact.confidence_score, 6),
        "sample_count": fact.sample_count,
        "source_id": fact.source_id,
        "source_provenance": fact.source_provenance,
        "source_snapshot_id": fact.source_snapshot_id,
        "source_url": fact.source_url,
        "attribution": fact.attribution,
        "fx_reference": fact.fx_reference_payload,
        "as_of_date": fact.as_of_date,
        "fetched_at": fact.fetched_at,
        "fresh_until": fact.fresh_until,
    }


def _price_level_fact_payload(fact: PriceLevelFact) -> dict[str, Any]:
    return {
        "tenant_id": fact.tenant_id,
        "country_code": fact.country_code,
        "category": fact.category,
        "reference_year": fact.reference_year,
        "base_geography_code": fact.base_geography_code,
        "index_value": round(float(fact.index_value), 8),
        "source_id": fact.source_id,
        "source_snapshot_id": fact.source_snapshot_id,
        "source_url": fact.source_url,
        "attribution": fact.attribution,
        "as_of_date": fact.as_of_date,
        "fetched_at": fact.fetched_at,
        "fresh_until": fact.fresh_until,
    }


def _extrapolation_inputs_payload(
    *,
    anchor_direct_fact_id: str,
    target_geography: BenchmarkGeography,
    direct_inputs: tuple[ExtrapolationDirectInput, ...],
    price_inputs: tuple[ExtrapolationPriceInput, ...],
    formula_version: str,
) -> dict[str, Any]:
    return {
        "anchor": anchor_direct_fact_id,
        "target_geography": _geography_payload(target_geography),
        "direct_inputs": sorted(
            (
                item.direct_fact_id,
                item.input_role,
                round(item.weight, 8),
            )
            for item in direct_inputs
        ),
        "price_inputs": sorted(
            (
                item.price_level_fact_id,
                item.input_role,
                round(item.weight, 8),
            )
            for item in price_inputs
        ),
        "formula_version": formula_version,
    }


def _extrapolated_fact_payload(
    fact: ExtrapolatedBenchmarkFact | Mapping[str, Any],
) -> dict[str, Any]:
    def field(name: str) -> Any:
        if isinstance(fact, Mapping):
            return fact[name]
        return getattr(fact, name)

    geography = field("target_geography")
    if not isinstance(geography, BenchmarkGeography):
        raise ValueError("target_geography must be a BenchmarkGeography")
    return {
        "tenant_id": field("tenant_id"),
        "anchor_direct_fact_id": field("anchor_direct_fact_id"),
        "taxonomy_version": field("taxonomy_version"),
        "role_family_code": field("role_family_code"),
        "seniority_label": field("seniority_label"),
        "target_geography": _geography_payload(geography),
        "component": field("component"),
        "minimum_amount": field("minimum_amount"),
        "maximum_amount": field("maximum_amount"),
        "confidence_interval_minimum_amount": field("confidence_interval_minimum_amount"),
        "confidence_interval_maximum_amount": field("confidence_interval_maximum_amount"),
        "confidence_band": field("confidence_band"),
        "confidence_score": round(float(field("confidence_score")), 6),
        "raw_factor": round(float(field("raw_factor")), 8),
        "shrinkage_weight": round(float(field("shrinkage_weight")), 8),
        "factor_bound_state": field("factor_bound_state"),
        "matched_company_count": field("matched_company_count"),
        "formula_version": field("formula_version"),
        "inputs_hash": field("inputs_hash"),
        "warnings": tuple(field("warnings")),
        "as_of_date": field("as_of_date"),
        "fresh_until": field("fresh_until"),
    }


def _canonical_json_object(value: Mapping[str, Any], field: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{field} must be a JSON object")
    payload = _thaw_json(value)
    if not isinstance(payload, dict):  # pragma: no cover - Mapping guarantees this
        raise ValueError(f"{field} must be a JSON object")
    try:
        json.dumps(payload, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must contain JSON-safe values") from exc
    return payload


def _thaw_json(value: Any) -> Any:
    if isinstance(value, Mapping):
        payload: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("benchmark JSON object keys must be strings")
            payload[key] = _thaw_json(item)
        return payload
    if isinstance(value, (list, tuple)):
        return [_thaw_json(item) for item in value]
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("benchmark JSON numbers must be finite")
        return value
    raise ValueError("benchmark metadata must contain only JSON-safe values")


def _freeze_json(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze_json(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze_json(item) for item in value)
    return value


def _content_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _fact_id(kind: str, tenant_id: str, content_hash: str) -> str:
    return str(uuid.uuid5(_FACT_NAMESPACE, f"{kind}:{tenant_id}:{content_hash}"))


def _validate_uuid(value: str, field: str) -> None:
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be a UUID") from exc
    if str(parsed) != value:
        raise ValueError(f"{field} must use canonical lowercase UUID form")


def _validate_hash(value: str, field: str) -> None:
    if not _HASH_RE.fullmatch(value):
        raise ValueError(f"{field} must be a lowercase SHA-256 digest")


def _validate_score(value: float) -> None:
    if not 0 <= value <= 1:
        raise ValueError("confidence score must be between zero and one")


def _canonical_benchmark_date(value: str, field: str) -> str:
    raw = str(value or "").strip()
    try:
        parsed = date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO 8601 date") from exc
    if parsed.isoformat() != raw:
        raise ValueError(f"{field} must use canonical YYYY-MM-DD form")
    return raw


def _require_canonical_timestamp(value: str, field: str) -> datetime:
    canonical = canonical_benchmark_timestamp(value, field)
    if value != canonical:
        raise ValueError(f"{field} must use canonical UTC form")
    return datetime.fromisoformat(canonical.replace("Z", "+00:00"))


def _validate_temporal_window(
    *,
    as_of_date: str,
    observed_at: str,
    fresh_until: str,
    observed_field: str,
) -> None:
    canonical_date = _canonical_benchmark_date(as_of_date, "as_of_date")
    observed = _require_canonical_timestamp(observed_at, observed_field)
    fresh = _require_canonical_timestamp(fresh_until, "fresh_until")
    if date.fromisoformat(canonical_date) > observed.date():
        raise ValueError(f"as_of_date must not be after {observed_field}")
    if observed > fresh:
        raise ValueError(f"fresh_until must not be before {observed_field}")


def _require_text(value: str, field: str) -> None:
    if not value.strip():
        raise ValueError(f"{field} must not be empty")


def _validate_public_url(
    value: str | None,
    field: str,
    *,
    allow_none: bool = False,
) -> None:
    if value is None and allow_none:
        return
    parts = urllib.parse.urlsplit(str(value or ""))
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError(f"{field} must be an HTTP(S) URL")
    if parts.username is not None or parts.password is not None:
        raise ValueError(f"{field} must not contain URL credentials")
    try:
        hostname = str(parts.hostname or "").casefold().rstrip(".")
        parts.port
    except ValueError as exc:
        raise ValueError(f"{field} must be a valid public URL") from exc
    if not hostname or hostname == "localhost" or hostname.endswith(_PRIVATE_HOST_SUFFIXES):
        raise ValueError(f"{field} must reference a public host")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        try:
            socket.inet_aton(hostname)
        except OSError:
            if "." not in hostname or "%" in hostname:
                raise ValueError(f"{field} must reference a public host") from None
        else:
            raise ValueError(f"{field} must use a canonical public host") from None
    else:
        if not address.is_global:
            raise ValueError(f"{field} must reference a public host")


def _validate_safe_provenance(*values: str) -> None:
    decoded_values = tuple(urllib.parse.unquote(value) for value in values)
    if any(_LOCAL_PATH_RE.search(value) for value in decoded_values):
        raise ValueError("benchmark provenance contains a local filesystem path")
    lowered = " ".join(decoded_values).casefold()
    if any(marker in lowered for marker in _UNSAFE_PROVENANCE_MARKERS):
        raise ValueError("benchmark provenance contains unsafe private material")


__all__ = [
    "GEOGRAPHIC_EXTRAPOLATION_FORMULA_VERSION",
    "LOWER_FACTOR_BOUND",
    "ROLE_FAMILY_TAXONOMY_VERSION",
    "UPPER_FACTOR_BOUND",
    "BenchmarkGeography",
    "CompanyBenchmarkPair",
    "DirectBenchmarkFact",
    "ExtrapolatedBenchmarkFact",
    "ExtrapolationDirectInput",
    "ExtrapolationPriceInput",
    "PriceLevelFact",
    "RoleClassification",
    "annualize_and_convert_to_eur",
    "build_direct_benchmark_fact",
    "build_price_level_fact",
    "canonical_benchmark_timestamp",
    "classify_role",
    "classify_seniority",
    "extrapolate_benchmark",
    "factor_bound_state",
    "normalize_company_name",
    "resolve_country_code",
]
