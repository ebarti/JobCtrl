"""Deterministic company-role reported compensation estimates."""

from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import median
from typing import Literal

ESTIMATOR_VERSION = "company-role-reported-compensation-v2"

MarketEstimateState = Literal[
    "not_requested",
    "unsupported",
    "source_unavailable",
    "insufficient_evidence",
    "estimated_range",
]
MarketSourceId = Literal[
    "levels_fyi",
    "glassdoor",
    "manual_reported_compensation",
    "euro_top_tech",
    "posted_salary_text",
]
MarketSourceType = Literal["reported_compensation", "posted_salary"]
MarketConfidenceBand = Literal["none", "low", "medium", "high"]
MarketComponent = Literal["base_salary", "total_compensation"]
MarketPeriod = Literal["year", "month"]
CompanyCompensationTier = Literal["tier_1_local", "tier_2_ambitious", "tier_3_top_of_market", "unknown"]
MarketMatchScope = Literal[
    "exact_company_role",
    "same_location_role_fallback",
    "company_adjacent_role",
    "tier_role_fallback",
    "market_baseline_fallback",
    "none",
]
MarketConfidenceFactorName = Literal[
    "company",
    "role",
    "level",
    "location",
    "component",
    "freshness",
    "sample",
    "agreement",
    "trimodal_tier",
]
MarketWarningCode = Literal[
    "reported_compensation_sample",
    "posted_salary_sample",
    "source_conflict_with_posted_salary",
    "stale_source_snapshot",
    "low_sample_count",
    "company_role_fallback",
    "trimodal_tier_inferred",
    "location_mismatch",
]
MarketReasonCode = Literal[
    "unsupported_source",
    "unsupported_component",
    "missing_company",
    "missing_role",
    "missing_reported_observation",
    "stale_source_snapshot",
    "weak_company_match",
    "weak_role_match",
    "weak_level_match",
    "weak_location_match",
    "low_sample_count",
    "source_dispersion_too_high",
]

MARKET_ESTIMATE_STATES: tuple[MarketEstimateState, ...] = (
    "not_requested",
    "unsupported",
    "source_unavailable",
    "insufficient_evidence",
    "estimated_range",
)
MARKET_SOURCE_IDS: tuple[MarketSourceId, ...] = (
    "levels_fyi",
    "glassdoor",
    "manual_reported_compensation",
    "euro_top_tech",
    "posted_salary_text",
)
COMPANY_TIERS: tuple[CompanyCompensationTier, ...] = (
    "tier_1_local",
    "tier_2_ambitious",
    "tier_3_top_of_market",
    "unknown",
)
MARKET_CONFIDENCE_BANDS: tuple[MarketConfidenceBand, ...] = ("none", "low", "medium", "high")
MARKET_WARNING_CODES: tuple[MarketWarningCode, ...] = (
    "reported_compensation_sample",
    "posted_salary_sample",
    "source_conflict_with_posted_salary",
    "stale_source_snapshot",
    "low_sample_count",
    "company_role_fallback",
    "trimodal_tier_inferred",
    "location_mismatch",
)
MARKET_REASON_CODES: tuple[MarketReasonCode, ...] = (
    "unsupported_source",
    "unsupported_component",
    "missing_company",
    "missing_role",
    "missing_reported_observation",
    "stale_source_snapshot",
    "weak_company_match",
    "weak_role_match",
    "weak_level_match",
    "weak_location_match",
    "low_sample_count",
    "source_dispersion_too_high",
)

SUPPORTED_COMPONENTS = frozenset({"base_salary", "total_compensation"})
STALE_THRESHOLD_MONTHS = 36
LOW_SAMPLE_THRESHOLD = 3
MIN_ESTIMATE_SCORE = 0.62
MIN_CRITICAL_FACTOR_SCORE = 0.55
MAX_DISPERSION_RATIO = 0.45
POSTED_CONFLICT_RATIO = 0.30
SOURCE_DISPLAY_NAMES: dict[MarketSourceId, str] = {
    "levels_fyi": "Levels.fyi",
    "glassdoor": "Glassdoor",
    "manual_reported_compensation": "Manual reported compensation import",
    "euro_top_tech": "Euro Top Tech",
    "posted_salary_text": "Job posting salary text",
}
SOURCE_DEFAULT_SNAPSHOT_VERSION = "reported-compensation-import-v1"
SOURCE_DEFAULT_ATTRIBUTION: dict[MarketSourceId, str] = {
    "levels_fyi": "Levels.fyi reported compensation data",
    "glassdoor": "Glassdoor reported compensation data",
    "manual_reported_compensation": "Manual reported compensation import",
    "euro_top_tech": "Euro Top Tech public crowdsourced compensation data",
    "posted_salary_text": "Employer-posted salary text captured by JobHunter",
}
UNSAFE_SOURCE_TEXT_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"rawproviderpayload",
        r"credential",
        r"secret",
        r"\bprivate\b",
        r"api[_ -]?key",
        r"token",
        r"password",
        r"file://",
        r"/users/",
        r"\\users\\",
    )
)
LEGAL_SUFFIX_RE = re.compile(
    r"\b(?:inc|incorporated|ltd|limited|llc|gmbh|ag|sa|sas|sarl|sl|plc|bv|nv|ab|oy|srl|spa)\b\.?",
    re.IGNORECASE,
)
SENIORITY_WORDS = frozenset(
    {
        "ceo",
        "chief",
        "cio",
        "ciso",
        "coo",
        "cpo",
        "cto",
        "junior",
        "jr",
        "mid",
        "senior",
        "sr",
        "staff",
        "principal",
        "lead",
        "manager",
        "director",
        "head",
        "president",
        "vice",
        "vp",
    }
)
ROLE_STOP_WORDS = frozenset({"remote", "full", "time", "the"})
ROLE_FAMILY_MARKERS: dict[str, frozenset[str]] = {
    "engineering": frozenset(
        {
            "architect",
            "backend",
            "developer",
            "devops",
            "engineer",
            "engineering",
            "frontend",
            "golang",
            "java",
            "kotlin",
            "mobile",
            "node",
            "platform",
            "python",
            "software",
            "tech",
            "technical",
            "technology",
        }
    ),
    "security": frozenset({"security", "privacy", "trust", "infrastructure", "operations"}),
    "data": frozenset({"ai", "analytics", "data", "ml", "machine", "omnichannel"}),
    "leadership": frozenset({"chief", "cto", "director", "head", "manager", "principal", "staff", "vp"}),
}
EUROPE_MARKERS = frozenset(
    {
        "europe",
        "eu",
        "emea",
        "spain",
        "madrid",
        "barcelona",
        "france",
        "germany",
        "netherlands",
        "ireland",
        "united kingdom",
        "uk",
        "switzerland",
        "poland",
        "portugal",
        "italy",
        "sweden",
        "denmark",
        "norway",
        "andorra",
        "austria",
        "belgium",
        "czechia",
        "czech",
        "finland",
        "greece",
        "hungary",
        "luxembourg",
        "slovakia",
        "slovenia",
    }
)


@dataclass(frozen=True)
class MarketConfidenceFactor:
    name: MarketConfidenceFactorName
    score: float
    band: MarketConfidenceBand
    reason: str


@dataclass(frozen=True)
class MarketSourceSnapshot:
    source_id: MarketSourceId
    display_name: str
    source_type: MarketSourceType
    release_year: int | None
    snapshot_version: str
    geography_scope: str
    aggregate_bucket: str
    attribution: str
    sample_count: int | None


@dataclass(frozen=True)
class MarketEvidenceRow:
    source_id: MarketSourceId
    display_name: str
    source_url: str | None
    company_name: str
    role_title: str
    location: str | None
    level_label: str | None
    company_tier: CompanyCompensationTier
    component: MarketComponent
    currency: str
    period: MarketPeriod
    minimum_amount: int
    maximum_amount: int
    sample_count: int | None
    release_year: int | None
    company_score: float
    role_score: float
    level_score: float
    location_score: float
    freshness_score: float


@dataclass(frozen=True)
class ReportedCompensationObservation:
    source_id: MarketSourceId
    company_name: str
    role_title: str
    minimum_amount: int | None
    maximum_amount: int | None
    currency: str = "EUR"
    period: MarketPeriod = "year"
    component: MarketComponent = "total_compensation"
    location: str | None = None
    level_label: str | None = None
    company_tier: CompanyCompensationTier = "unknown"
    release_year: int | None = 2026
    snapshot_version: str = SOURCE_DEFAULT_SNAPSHOT_VERSION
    sample_count: int | None = 1
    attribution: str | None = None
    source_url: str | None = None


@dataclass(frozen=True)
class MarketCompensationEstimate:
    tenant_id: str
    job_url: str
    estimate_state: MarketEstimateState
    currency: str | None
    period: MarketPeriod
    component: MarketComponent
    minimum_amount: int | None
    maximum_amount: int | None
    confidence_interval_minimum_amount: int | None
    confidence_interval_maximum_amount: int | None
    confidence_band: MarketConfidenceBand
    confidence_score: float
    source_count: int
    sample_count: int | None
    aggregate_bucket: str | None
    geography_scope: str | None
    occupation_code: str | None
    occupation_label: str | None
    seniority_label: str | None
    sources: tuple[MarketSourceSnapshot, ...]
    factors: tuple[MarketConfidenceFactor, ...]
    evidence: tuple[MarketEvidenceRow, ...]
    insufficient_reasons: tuple[MarketReasonCode, ...]
    unsupported_reasons: tuple[MarketReasonCode, ...]
    source_unavailable_reasons: tuple[MarketReasonCode, ...]
    warnings: tuple[MarketWarningCode, ...]
    estimator_version: str
    estimated_at: str
    company_name: str | None = None
    normalized_company: str | None = None
    role_title: str | None = None
    normalized_role: str | None = None
    company_tier: CompanyCompensationTier = "unknown"
    match_scope: MarketMatchScope = "none"


def estimate_market_compensation(
    *,
    job_url: str,
    title: str,
    company: str | None,
    location: str | None,
    observations: tuple[ReportedCompensationObservation, ...],
    tenant_id: str = "local",
    component: str = "total_compensation",
    seniority_label: str | None = None,
    posted_annualized_minimum: int | None = None,
    posted_annualized_maximum: int | None = None,
    estimated_at: str | None = None,
) -> MarketCompensationEstimate:
    """Estimate compensation from reported company-role salary observations."""

    now = estimated_at or datetime.now(timezone.utc).isoformat()
    warnings: list[MarketWarningCode] = []
    unsupported_reasons: list[MarketReasonCode] = []
    source_unavailable_reasons: list[MarketReasonCode] = []
    insufficient_reasons: list[MarketReasonCode] = []
    factors: list[MarketConfidenceFactor] = []
    component_value = _market_component(component)

    normalized_company = _normalize_company(company)
    normalized_role = _normalize_role(title)
    inferred_level = seniority_label or _level_from_title(title)

    if component_value is None:
        unsupported_reasons.append("unsupported_component")
        factors.append(_factor("component", 0.0, "Unsupported compensation component."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="unsupported",
            component="total_compensation",
            factors=factors,
            unsupported=unsupported_reasons,
            warnings=warnings,
            estimated_at=now,
            company_name=_clean_display(company),
            normalized_company=normalized_company or None,
            role_title=_clean_display(title),
            normalized_role=normalized_role or None,
        )
    if not normalized_company:
        insufficient_reasons.append("missing_company")
        factors.append(_factor("company", 0.0, "The job has no company name to match reported compensation."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="insufficient_evidence",
            component=component_value,
            factors=factors,
            insufficient=insufficient_reasons,
            warnings=warnings,
            estimated_at=now,
            role_title=_clean_display(title),
            normalized_role=normalized_role or None,
        )
    if not normalized_role:
        insufficient_reasons.append("missing_role")
        factors.append(_factor("role", 0.0, "The job title has no role terms to match reported compensation."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="insufficient_evidence",
            component=component_value,
            factors=factors,
            insufficient=insufficient_reasons,
            warnings=warnings,
            estimated_at=now,
            company_name=_clean_display(company),
            normalized_company=normalized_company,
        )

    unsupported_sources = sorted(str(row.source_id) for row in observations if row.source_id not in MARKET_SOURCE_IDS)
    if unsupported_sources:
        unsupported_reasons.append("unsupported_source")
        factors.append(_factor("company", 0.0, "Unsupported reported-compensation source evidence was rejected."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="unsupported",
            component=component_value,
            factors=factors,
            unsupported=unsupported_reasons,
            warnings=warnings,
            estimated_at=now,
            company_name=_clean_display(company),
            normalized_company=normalized_company,
            role_title=_clean_display(title),
            normalized_role=normalized_role,
        )

    component_rows = tuple(row for row in observations if row.source_id in MARKET_SOURCE_IDS and row.component == component_value)
    if not component_rows:
        insufficient_reasons.append("missing_reported_observation")
        factors.append(_factor("component", 0.0, f"No reported compensation observations use {component_value}."))
        return _insufficient(
            tenant_id=tenant_id,
            job_url=job_url,
            component=component_value,
            company=company,
            normalized_company=normalized_company,
            role=title,
            normalized_role=normalized_role,
            factors=factors,
            insufficient=insufficient_reasons,
            warnings=warnings,
            estimated_at=now,
        )
    warnings.extend(_source_sample_warnings(component_rows))

    usable_rows: list[ReportedCompensationObservation] = []
    for row in component_rows:
        if row.release_year is not None and _age_months(row.release_year, now) > STALE_THRESHOLD_MONTHS:
            source_unavailable_reasons.append("stale_source_snapshot")
            warnings.append("stale_source_snapshot")
            continue
        if row.minimum_amount is None and row.maximum_amount is None:
            insufficient_reasons.append("missing_reported_observation")
            continue
        if (row.sample_count or 1) <= 0:
            insufficient_reasons.append("low_sample_count")
            warnings.append("low_sample_count")
            continue
        usable_rows.append(row)

    if source_unavailable_reasons and not usable_rows:
        factors.append(_factor("freshness", 0.0, "Reported compensation source snapshots are stale."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="source_unavailable",
            component=component_value,
            factors=factors,
            source_unavailable=source_unavailable_reasons,
            warnings=warnings,
            estimated_at=now,
            company_name=_clean_display(company),
            normalized_company=normalized_company,
            role_title=_clean_display(title),
            normalized_role=normalized_role,
        )
    if not usable_rows:
        factors.append(_factor("sample", 0.0, "No reported compensation row had usable amount evidence."))
        return _insufficient(
            tenant_id=tenant_id,
            job_url=job_url,
            component=component_value,
            company=company,
            normalized_company=normalized_company,
            role=title,
            normalized_role=normalized_role,
            factors=factors,
            insufficient=insufficient_reasons or ["missing_reported_observation"],
            warnings=warnings,
            estimated_at=now,
        )

    selected_rows, match_scope, scope_warning = _select_rows(
        usable_rows,
        normalized_company=normalized_company,
        normalized_role=normalized_role,
        location=location,
        inferred_level=inferred_level,
    )
    if scope_warning:
        warnings.append(scope_warning)
    if not selected_rows:
        factors.extend(
            [
                _factor("company", 0.0, f"No reported compensation rows matched company {company}."),
                _factor("role", 0.0, f"No reported compensation rows matched role {title}."),
            ]
        )
        return _insufficient(
            tenant_id=tenant_id,
            job_url=job_url,
            component=component_value,
            company=company,
            normalized_company=normalized_company,
            role=title,
            normalized_role=normalized_role,
            factors=factors,
            insufficient=["missing_reported_observation"],
            warnings=warnings,
            estimated_at=now,
        )

    company_scores = tuple(_company_score(normalized_company, row.company_name) for row in selected_rows)
    role_scores = tuple(_role_score(normalized_role, row.role_title) for row in selected_rows)
    level_scores = tuple(_level_score(inferred_level, row.level_label) for row in selected_rows)
    location_scores = tuple(_location_score(location, row.location) for row in selected_rows)
    freshness_scores = tuple(_freshness_score(row.release_year, now) for row in selected_rows)
    source_count = len({row.source_id for row in selected_rows})
    sample_count = sum(row.sample_count or 1 for row in selected_rows)
    sample_score = _sample_score(sample_count)
    agreement_score, dispersion_warning, dispersion_insufficient = _agreement_score(selected_rows)
    company_tier, tier_inferred = _company_tier(selected_rows)
    tier_score = _tier_score(company_tier, match_scope)

    if tier_inferred:
        warnings.append("trimodal_tier_inferred")
    if sample_count < LOW_SAMPLE_THRESHOLD:
        warnings.append("low_sample_count")
        insufficient_reasons.append("low_sample_count")
    if min(location_scores) < MIN_CRITICAL_FACTOR_SCORE:
        warnings.append("location_mismatch")
        insufficient_reasons.append("weak_location_match")
    if dispersion_warning:
        warnings.append("company_role_fallback")
    if dispersion_insufficient:
        insufficient_reasons.append("source_dispersion_too_high")

    minimum = min(_row_minimum(row) for row in selected_rows)
    maximum = max(_row_maximum(row) for row in selected_rows)
    if _posted_conflicts(minimum, maximum, posted_annualized_minimum, posted_annualized_maximum):
        warnings.append("source_conflict_with_posted_salary")

    company_score = min(company_scores)
    if match_scope == "tier_role_fallback":
        company_score = max(company_score, 0.62)
    if match_scope == "same_location_role_fallback":
        company_score = max(company_score, 0.45)
    if match_scope == "market_baseline_fallback":
        company_score = max(company_score, 0.32)
    role_score = min(role_scores)
    if match_scope == "company_adjacent_role":
        role_score = max(role_score, 0.62)
    if match_scope == "market_baseline_fallback":
        role_score = max(role_score, 0.35)
    level_score = min(level_scores)
    location_score = min(location_scores)
    freshness_score = min(freshness_scores)
    factors.extend(
        [
            _factor("company", company_score, f"Reported rows matched company {company}."),
            _factor("role", role_score, f"Reported rows matched role {title}."),
            _factor("level", level_score, f"Level support: {inferred_level}."),
            _factor("location", location_score, "Location compatibility was evaluated but company-role evidence is primary."),
            _factor("component", 1.0, f"Component {component_value} matches the reported compensation rows."),
            _factor("freshness", freshness_score, "Reported source snapshots are inside the freshness window."),
            _factor("sample", sample_score, f"Reported compensation sample count: {sample_count}."),
            _factor("agreement", agreement_score, "Selected reported compensation rows are within dispersion tolerance."),
            _factor("trimodal_tier", tier_score, f"Company tier context: {company_tier}."),
        ]
    )

    if company_score < MIN_CRITICAL_FACTOR_SCORE:
        insufficient_reasons.append("weak_company_match")
    if role_score < MIN_CRITICAL_FACTOR_SCORE:
        insufficient_reasons.append("weak_role_match")
    if level_score < MIN_CRITICAL_FACTOR_SCORE:
        insufficient_reasons.append("weak_level_match")

    confidence_score = round(
        min(company_score, role_score, level_score, location_score, freshness_score, sample_score, agreement_score, tier_score),
        2,
    )
    confidence_interval_minimum, confidence_interval_maximum = _confidence_interval(
        minimum,
        maximum,
        match_scope=match_scope,
        confidence_score=confidence_score,
        sample_count=sample_count,
        warnings=warnings,
        rows=selected_rows,
        dispersion_insufficient=dispersion_insufficient,
    )
    evidence = tuple(
        _evidence_row(
            row,
            company_score=company_scores[index],
            role_score=role_scores[index],
            level_score=level_scores[index],
            location_score=location_scores[index],
            freshness_score=freshness_scores[index],
        )
        for index, row in enumerate(selected_rows)
    )

    minimum_score = _minimum_estimate_score(selected_rows, match_scope)
    if confidence_score < minimum_score:
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="insufficient_evidence",
            component=component_value,
            factors=factors,
            insufficient=insufficient_reasons or ["missing_reported_observation"],
            warnings=warnings,
            sources=tuple(_snapshot(row) for row in selected_rows),
            evidence=evidence,
            source_count=source_count,
            sample_count=sample_count,
            aggregate_bucket=_estimate_aggregate_bucket(company, title, match_scope, selected_rows),
            geography_scope=_geography_scope(location, selected_rows),
            occupation_code=normalized_company,
            occupation_label=normalized_role,
            seniority_label=inferred_level,
            confidence_score=confidence_score,
            estimated_at=now,
            company_name=_clean_display(company),
            normalized_company=normalized_company,
            role_title=_clean_display(title),
            normalized_role=normalized_role,
            company_tier=company_tier,
            match_scope=match_scope,
        )

    return _estimate(
        tenant_id=tenant_id,
        job_url=job_url,
        state="estimated_range",
        currency=selected_rows[0].currency,
        period=selected_rows[0].period,
        component=component_value,
        minimum_amount=minimum,
        maximum_amount=maximum,
        confidence_interval_minimum_amount=confidence_interval_minimum,
        confidence_interval_maximum_amount=confidence_interval_maximum,
        factors=factors,
        warnings=warnings,
        sources=tuple(_snapshot(row) for row in selected_rows),
        evidence=evidence,
        source_count=source_count,
        sample_count=sample_count,
        aggregate_bucket=_estimate_aggregate_bucket(company, title, match_scope, selected_rows),
        geography_scope=_geography_scope(location, selected_rows),
        occupation_code=normalized_company,
        occupation_label=normalized_role,
        seniority_label=inferred_level,
        confidence_score=confidence_score,
        estimated_at=now,
        company_name=_clean_display(company),
        normalized_company=normalized_company,
        role_title=_clean_display(title),
        normalized_role=normalized_role,
        company_tier=company_tier,
        match_scope=match_scope,
    )


def not_requested_market_estimate(
    *,
    tenant_id: str = "local",
    job_url: str,
    estimated_at: str | None = None,
) -> MarketCompensationEstimate:
    """Create an explicit not-requested market estimate value without persisting it."""

    return _estimate(
        tenant_id=tenant_id,
        job_url=job_url,
        state="not_requested",
        component="total_compensation",
        estimated_at=estimated_at or datetime.now(timezone.utc).isoformat(),
    )


def _insufficient(
    *,
    tenant_id: str,
    job_url: str,
    component: MarketComponent,
    company: str | None,
    normalized_company: str | None,
    role: str | None,
    normalized_role: str | None,
    factors: list[MarketConfidenceFactor],
    insufficient: list[MarketReasonCode],
    warnings: list[MarketWarningCode],
    estimated_at: str,
) -> MarketCompensationEstimate:
    return _estimate(
        tenant_id=tenant_id,
        job_url=job_url,
        state="insufficient_evidence",
        component=component,
        factors=factors,
        insufficient=insufficient,
        warnings=warnings,
        estimated_at=estimated_at,
        company_name=_clean_display(company),
        normalized_company=normalized_company,
        role_title=_clean_display(role),
        normalized_role=normalized_role,
    )


def _estimate(
    *,
    tenant_id: str,
    job_url: str,
    state: MarketEstimateState,
    component: MarketComponent,
    estimated_at: str,
    currency: str | None = None,
    period: MarketPeriod = "year",
    minimum_amount: int | None = None,
    maximum_amount: int | None = None,
    confidence_interval_minimum_amount: int | None = None,
    confidence_interval_maximum_amount: int | None = None,
    factors: list[MarketConfidenceFactor] | None = None,
    insufficient: list[MarketReasonCode] | None = None,
    unsupported: list[MarketReasonCode] | None = None,
    source_unavailable: list[MarketReasonCode] | None = None,
    warnings: list[MarketWarningCode] | None = None,
    sources: tuple[MarketSourceSnapshot, ...] = (),
    evidence: tuple[MarketEvidenceRow, ...] = (),
    source_count: int = 0,
    sample_count: int | None = None,
    aggregate_bucket: str | None = None,
    geography_scope: str | None = None,
    occupation_code: str | None = None,
    occupation_label: str | None = None,
    seniority_label: str | None = None,
    confidence_score: float = 0.0,
    company_name: str | None = None,
    normalized_company: str | None = None,
    role_title: str | None = None,
    normalized_role: str | None = None,
    company_tier: CompanyCompensationTier = "unknown",
    match_scope: MarketMatchScope = "none",
) -> MarketCompensationEstimate:
    if state != "estimated_range":
        currency = None
        minimum_amount = None
        maximum_amount = None
        confidence_interval_minimum_amount = None
        confidence_interval_maximum_amount = None
    return MarketCompensationEstimate(
        tenant_id=tenant_id,
        job_url=job_url,
        estimate_state=state,
        currency=currency,
        period=period,
        component=component,
        minimum_amount=minimum_amount,
        maximum_amount=maximum_amount,
        confidence_interval_minimum_amount=confidence_interval_minimum_amount,
        confidence_interval_maximum_amount=confidence_interval_maximum_amount,
        confidence_band=_confidence_band(confidence_score, state, warnings or []),
        confidence_score=round(confidence_score, 2),
        source_count=source_count,
        sample_count=sample_count,
        aggregate_bucket=aggregate_bucket,
        geography_scope=geography_scope,
        occupation_code=occupation_code,
        occupation_label=occupation_label,
        seniority_label=seniority_label,
        sources=_dedupe_sources(sources),
        factors=tuple(factors or ()),
        evidence=evidence,
        insufficient_reasons=_dedupe_reasons(insufficient or []),
        unsupported_reasons=_dedupe_reasons(unsupported or []),
        source_unavailable_reasons=_dedupe_reasons(source_unavailable or []),
        warnings=_dedupe_warnings(warnings or []),
        estimator_version=ESTIMATOR_VERSION,
        estimated_at=estimated_at,
        company_name=company_name,
        normalized_company=normalized_company,
        role_title=role_title,
        normalized_role=normalized_role,
        company_tier=company_tier,
        match_scope=match_scope,
    )


def _select_rows(
    rows: list[ReportedCompensationObservation],
    *,
    normalized_company: str,
    normalized_role: str,
    location: str | None,
    inferred_level: str | None,
) -> tuple[list[ReportedCompensationObservation], MarketMatchScope, MarketWarningCode | None]:
    exact = [
        row
        for row in rows
        if _company_score(normalized_company, row.company_name) >= 0.95 and _role_score(normalized_role, row.role_title) >= 0.72
    ]
    if exact:
        return exact, "exact_company_role", None

    adjacent = [
        row
        for row in rows
        if _company_score(normalized_company, row.company_name) >= 0.95 and _role_score(normalized_role, row.role_title) >= 0.30
    ]
    if adjacent:
        return adjacent, "company_adjacent_role", "company_role_fallback"

    company_rows = [row for row in rows if _company_score(normalized_company, row.company_name) >= 0.95]
    company_tier, _ = _company_tier(company_rows)
    target_level = _normalize_level(inferred_level)
    if company_tier != "unknown":
        tier_rows = [
            row
            for row in rows
            if row.company_tier == company_tier and _role_score(normalized_role, row.role_title) >= 0.72
            and _fallback_level_score(target_level, row) >= 0.78
        ]
        if tier_rows:
            return tier_rows, "tier_role_fallback", "company_role_fallback"

    same_location_role_threshold = 0.72 if target_level == "executive" else 0.55
    same_location_role = [
        row
        for row in rows
        if _role_score(normalized_role, row.role_title) >= same_location_role_threshold
        and _fallback_level_score(target_level, row) >= 0.78
        and _location_score(location, row.location) >= 0.78
    ]
    if same_location_role:
        return same_location_role, "same_location_role_fallback", "company_role_fallback"

    baseline = [
        row
        for row in rows
        if _fallback_level_score(target_level, row) >= 0.78 and _location_score(location, row.location) >= 0.5
    ]
    if baseline:
        return baseline, "market_baseline_fallback", "company_role_fallback"

    return [], "none", None


def _snapshot(row: ReportedCompensationObservation) -> MarketSourceSnapshot:
    return sanitize_market_source_snapshot(
        MarketSourceSnapshot(
            source_id=row.source_id,
            display_name=_display_name(row.source_id),
            source_type=_source_type(row.source_id),
            release_year=row.release_year,
            snapshot_version=row.snapshot_version,
            geography_scope=_safe_text(_reported_geography(row.location)),
            aggregate_bucket=_source_aggregate_bucket(row.source_id),
            attribution=row.attribution or SOURCE_DEFAULT_ATTRIBUTION[row.source_id],
            sample_count=row.sample_count,
        )
    )


def _evidence_row(
    row: ReportedCompensationObservation,
    *,
    company_score: float,
    role_score: float,
    level_score: float,
    location_score: float,
    freshness_score: float,
) -> MarketEvidenceRow:
    source_id = row.source_id if row.source_id in MARKET_SOURCE_IDS else "manual_reported_compensation"
    return MarketEvidenceRow(
        source_id=source_id,
        display_name=_display_name(source_id),
        source_url=_safe_source_url(row.source_url),
        company_name=_safe_text(row.company_name) or "unknown company",
        role_title=_safe_text(row.role_title) or "unknown role",
        location=_safe_text(row.location) or None,
        level_label=_safe_text(row.level_label) or None,
        company_tier=row.company_tier if row.company_tier in COMPANY_TIERS else "unknown",
        component=row.component if row.component in SUPPORTED_COMPONENTS else "total_compensation",
        currency=_safe_text(row.currency)[:3].upper() or "EUR",
        period=row.period if row.period in {"year", "month"} else "year",
        minimum_amount=_row_minimum(row),
        maximum_amount=_row_maximum(row),
        sample_count=row.sample_count,
        release_year=row.release_year,
        company_score=round(max(0.0, min(1.0, company_score)), 2),
        role_score=round(max(0.0, min(1.0, role_score)), 2),
        level_score=round(max(0.0, min(1.0, level_score)), 2),
        location_score=round(max(0.0, min(1.0, location_score)), 2),
        freshness_score=round(max(0.0, min(1.0, freshness_score)), 2),
    )


def _safe_source_url(value: str | None) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        return None
    lowered = text.casefold()
    if any(term in lowered for term in ("/users/", "\\users\\", "file://", "credential", "secret", "token", "password", "api_key", "api key", "api-key", "private")):
        return None
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def sanitize_market_source_snapshot(source: MarketSourceSnapshot) -> MarketSourceSnapshot:
    """Return a safe reported-source snapshot for persistence or API serialization."""

    source_id = source.source_id if source.source_id in MARKET_SOURCE_IDS else "manual_reported_compensation"
    return MarketSourceSnapshot(
        source_id=source_id,
        display_name=_display_name(source_id),
        source_type=_source_type(source_id),
        release_year=source.release_year,
        snapshot_version=_source_snapshot_version(source_id),
        geography_scope=_safe_text(source.geography_scope) or "reported",
        aggregate_bucket=_source_aggregate_bucket(source_id),
        attribution=SOURCE_DEFAULT_ATTRIBUTION[source_id],
        sample_count=source.sample_count,
    )


def _display_name(source_id: str) -> str:
    if source_id in SOURCE_DISPLAY_NAMES:
        return SOURCE_DISPLAY_NAMES[source_id]  # type: ignore[index]
    return "Manual reported compensation import"


def _source_type(source_id: str) -> MarketSourceType:
    return "posted_salary" if source_id == "posted_salary_text" else "reported_compensation"


def _source_snapshot_version(source_id: str) -> str:
    if source_id == "posted_salary_text":
        return "jobhunter-posted-compensation-v1"
    if source_id == "euro_top_tech":
        return "eurotoptech-data-public"
    return SOURCE_DEFAULT_SNAPSHOT_VERSION


def _source_aggregate_bucket(source_id: str) -> str:
    if source_id == "posted_salary_text":
        return "employer-posted company-role compensation"
    return "reported company-role compensation"


def _source_sample_warnings(rows: tuple[ReportedCompensationObservation, ...]) -> list[MarketWarningCode]:
    source_ids = {row.source_id for row in rows}
    warnings: list[MarketWarningCode] = []
    if source_ids & {"levels_fyi", "glassdoor", "manual_reported_compensation", "euro_top_tech"}:
        warnings.append("reported_compensation_sample")
    if "posted_salary_text" in source_ids:
        warnings.append("posted_salary_sample")
    return warnings


def _safe_text(value: str | None) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text or _contains_unsafe_source_text(text):
        return ""
    return text[:160]


def _contains_unsafe_source_text(value: str) -> bool:
    text = value.casefold()
    return any(pattern.search(text) for pattern in UNSAFE_SOURCE_TEXT_PATTERNS)


def _market_component(component: str) -> MarketComponent | None:
    return component if component in SUPPORTED_COMPONENTS else None  # type: ignore[return-value]


def _factor(name: MarketConfidenceFactorName, score: float, reason: str) -> MarketConfidenceFactor:
    bounded = max(0.0, min(1.0, score))
    return MarketConfidenceFactor(name=name, score=round(bounded, 2), band=_score_band(bounded), reason=reason)


def _score_band(score: float) -> MarketConfidenceBand:
    if score >= 0.85:
        return "high"
    if score >= 0.62:
        return "medium"
    if score > 0:
        return "low"
    return "none"


def _confidence_band(
    score: float,
    state: MarketEstimateState,
    warnings: list[MarketWarningCode],
) -> MarketConfidenceBand:
    if state == "estimated_range" and score >= 0.85 and "low_sample_count" not in warnings:
        return "high"
    if state == "estimated_range" and score >= MIN_ESTIMATE_SCORE:
        return "medium"
    if state == "estimated_range" and score > 0:
        return "low"
    if state in {"insufficient_evidence", "source_unavailable"} and score > 0:
        return "low"
    return "none"


def _normalize_company(value: str | None) -> str:
    text = str(value or "").casefold()
    text = LEGAL_SUFFIX_RE.sub(" ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _normalize_role(value: str | None) -> str:
    tokens = _role_tokens(value)
    return " ".join(token for token in tokens if token not in SENIORITY_WORDS)


def _role_tokens(value: str | None) -> tuple[str, ...]:
    text = str(value or "").casefold()
    tokens = tuple(re.findall(r"[a-z0-9]+", text))
    return tuple(_singularize(token) for token in tokens if token not in ROLE_STOP_WORDS)


def _singularize(token: str) -> str:
    if len(token) > 4 and token.endswith("ies"):
        return f"{token[:-3]}y"
    if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


def _company_score(normalized_company: str, reported_company: str | None) -> float:
    reported = _normalize_company(reported_company)
    if not normalized_company or not reported:
        return 0.0
    if normalized_company == reported:
        return 1.0
    if normalized_company in reported or reported in normalized_company:
        return 0.82
    return 0.0


def _role_score(normalized_role: str, reported_title: str | None) -> float:
    reported = _normalize_role(reported_title)
    if not normalized_role or not reported:
        return 0.0
    if normalized_role == reported:
        return 1.0
    wanted = set(normalized_role.split())
    seen = set(reported.split())
    if not wanted or not seen:
        return 0.0
    overlap = len(wanted & seen) / len(wanted | seen)
    wanted_families = _role_families(wanted)
    seen_families = _role_families(seen)
    if wanted_families & seen_families:
        overlap = max(overlap, 0.55)
    if "engineering" in wanted_families and "engineering" in seen_families:
        overlap = max(overlap, 0.65)
    return round(overlap, 2)


def _role_families(tokens: set[str]) -> set[str]:
    return {family for family, markers in ROLE_FAMILY_MARKERS.items() if tokens & markers}


def _level_from_title(title: str | None) -> str:
    tokens = set(_role_tokens(title))
    if {"ceo", "chief", "cio", "ciso", "coo", "cpo", "cto", "president", "vice", "vp"} & tokens:
        return "executive"
    if {"staff", "principal", "lead", "director", "head"} & tokens:
        return "staff_plus"
    if {"senior", "sr"} & tokens:
        return "senior"
    if {"junior", "jr"} & tokens:
        return "junior"
    if "manager" in tokens:
        return "manager"
    return "mid"


def _level_score(expected: str | None, observed: str | None) -> float:
    expected_level = _normalize_level(expected)
    observed_level = _normalize_level(observed)
    if observed_level == "unknown":
        return 0.5 if expected_level == "executive" else 0.75
    if expected_level == observed_level:
        return 0.95
    if expected_level == "executive" and observed_level in {"staff_plus", "manager"}:
        return 0.45
    if observed_level == "executive" and expected_level in {"staff_plus", "manager"}:
        return 0.45
    if expected_level == "senior" and observed_level == "staff_plus":
        return 0.82
    if expected_level == "staff_plus" and observed_level == "senior":
        return 0.78
    if expected_level == "mid" and observed_level in {"senior", "junior"}:
        return 0.65
    return 0.5


def _normalize_level(value: str | None) -> str:
    text = str(value or "").casefold()
    tokens = set(re.findall(r"[a-z0-9]+", text))
    if {"ceo", "chief", "cio", "ciso", "coo", "cpo", "cto", "executive", "president", "vice", "vp"} & tokens:
        return "executive"
    if {"staff", "principal", "lead", "director", "head", "l6", "l7", "l8"} & tokens:
        return "staff_plus"
    if {"senior", "sr", "l5"} & tokens:
        return "senior"
    if {"junior", "jr", "graduate", "l3"} & tokens:
        return "junior"
    if {"manager"} & tokens:
        return "manager"
    if tokens:
        return "mid"
    return "unknown"


def _fallback_level_score(target_level: str, row: ReportedCompensationObservation) -> float:
    observed_level = _normalize_level(row.level_label)
    if observed_level == "unknown":
        observed_level = _level_from_title(row.role_title)
    return _level_score(target_level, observed_level)


def _location_score(job_location: str | None, observed_location: str | None) -> float:
    job = _normalize_location(job_location)
    observed = _normalize_location(observed_location)
    if not job or not observed:
        return 0.78
    if job == observed or job in observed or observed in job:
        return 0.95
    if _is_europe(job) and _is_europe(observed):
        return 0.78
    return 0.5


def _normalize_location(value: str | None) -> str:
    text = str(value or "").casefold()
    text = re.sub(r"\bu\.k\.", " uk ", text)
    text = re.sub(r"\be\.u\.", " eu ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _is_europe(value: str) -> bool:
    tokens = set(value.split())
    if tokens & EUROPE_MARKERS:
        return True
    return any(marker in value for marker in EUROPE_MARKERS if " " in marker)


def _reported_geography(value: str | None) -> str:
    normalized = _normalize_location(value)
    if not normalized:
        return "reported"
    if _is_europe(normalized):
        return "Europe"
    return "reported"


def _company_tier(
    rows: list[ReportedCompensationObservation],
) -> tuple[CompanyCompensationTier, bool]:
    tiers = [row.company_tier for row in rows if row.company_tier != "unknown"]
    if tiers:
        return max(set(tiers), key=tiers.count), False
    if not rows:
        return "unknown", False
    midpoint = median((_row_minimum(row) + _row_maximum(row)) / 2 for row in rows)
    if midpoint >= 160_000:
        return "tier_3_top_of_market", True
    if midpoint >= 90_000:
        return "tier_2_ambitious", True
    return "tier_1_local", True


def _tier_score(company_tier: CompanyCompensationTier, match_scope: MarketMatchScope) -> float:
    if company_tier == "unknown":
        return 0.62 if match_scope == "exact_company_role" else 0.45
    if match_scope == "tier_role_fallback":
        return 0.62
    if match_scope == "market_baseline_fallback":
        return 0.5
    return 0.82


def _minimum_estimate_score(rows: list[ReportedCompensationObservation], match_scope: MarketMatchScope) -> float:
    if match_scope == "market_baseline_fallback":
        return 0.3
    if match_scope in {"same_location_role_fallback", "company_adjacent_role"}:
        return 0.42
    if match_scope == "tier_role_fallback":
        return 0.38
    if rows and all(row.source_id == "posted_salary_text" for row in rows):
        return 0.5
    return 0.3


def _confidence_interval(
    minimum: int,
    maximum: int,
    *,
    match_scope: MarketMatchScope,
    confidence_score: float,
    sample_count: int,
    warnings: list[MarketWarningCode],
    rows: list[ReportedCompensationObservation],
    dispersion_insufficient: bool,
) -> tuple[int, int]:
    margin_by_scope = {
        "exact_company_role": 0.12,
        "same_location_role_fallback": 0.24,
        "company_adjacent_role": 0.28,
        "tier_role_fallback": 0.34,
        "market_baseline_fallback": 0.48,
        "none": 0.6,
    }
    margin = margin_by_scope[match_scope]
    if sample_count < LOW_SAMPLE_THRESHOLD:
        margin += 0.12
    if "location_mismatch" in warnings:
        margin += 0.08
    if "company_role_fallback" in warnings:
        margin += 0.05
    if dispersion_insufficient:
        margin += 0.12
    if rows and all(row.source_id == "posted_salary_text" for row in rows):
        margin += 0.08
    if confidence_score < MIN_ESTIMATE_SCORE:
        margin += 0.08
    margin = min(margin, 0.75)
    return max(0, round(minimum * (1 - margin))), round(maximum * (1 + margin))


def _row_minimum(row: ReportedCompensationObservation) -> int:
    if row.minimum_amount is not None:
        return int(row.minimum_amount)
    return int(row.maximum_amount or 0)


def _row_maximum(row: ReportedCompensationObservation) -> int:
    if row.maximum_amount is not None:
        return int(row.maximum_amount)
    return int(row.minimum_amount or 0)


def _age_months(release_year: int, estimated_at: str) -> int:
    year = _year(estimated_at)
    return max(0, (year - release_year) * 12)


def _freshness_score(release_year: int | None, estimated_at: str) -> float:
    if release_year is None:
        return 0.72
    months = _age_months(release_year, estimated_at)
    if months <= 12:
        return 0.95
    if months <= STALE_THRESHOLD_MONTHS:
        return 0.78
    return 0.0


def _year(value: str) -> int:
    try:
        return int(value[:4])
    except (TypeError, ValueError):
        return datetime.now(timezone.utc).year


def _sample_score(sample_count: int | None) -> float:
    if sample_count is None:
        return 0.62
    if sample_count >= 8:
        return 0.9
    if sample_count >= LOW_SAMPLE_THRESHOLD:
        return 0.78
    if sample_count >= 1:
        return 0.5
    return 0.0


def _agreement_score(rows: list[ReportedCompensationObservation]) -> tuple[float, bool, bool]:
    if len(rows) < 2:
        return 0.72, False, False
    midpoints = [(_row_minimum(row) + _row_maximum(row)) / 2 for row in rows]
    center = median(midpoints)
    if center <= 0:
        return 0.0, True, True
    dispersion = (max(midpoints) - min(midpoints)) / center
    if dispersion > MAX_DISPERSION_RATIO:
        return 0.4, True, True
    if dispersion > 0.25:
        return 0.62, True, False
    return 0.85, False, False


def _posted_conflicts(
    minimum: int,
    maximum: int,
    posted_minimum: int | None,
    posted_maximum: int | None,
) -> bool:
    if posted_minimum is None or posted_maximum is None:
        return False
    market_mid = (minimum + maximum) / 2
    posted_mid = (posted_minimum + posted_maximum) / 2
    if market_mid <= 0 or posted_mid <= 0:
        return False
    return abs(market_mid - posted_mid) / market_mid > POSTED_CONFLICT_RATIO


def _aggregate_bucket(company: str | None, title: str | None, match_scope: MarketMatchScope) -> str:
    if match_scope == "exact_company_role":
        return "reported company-role compensation"
    if match_scope == "company_adjacent_role":
        return "reported company adjacent-role compensation"
    if match_scope == "same_location_role_fallback":
        return "same-location role compensation fallback"
    if match_scope == "tier_role_fallback":
        return "trimodal tier role fallback"
    if match_scope == "market_baseline_fallback":
        return "trimodal market baseline fallback"
    return f"reported compensation for {_clean_display(company) or 'unknown company'} {_clean_display(title) or 'unknown role'}"


def _estimate_aggregate_bucket(
    company: str | None,
    title: str | None,
    match_scope: MarketMatchScope,
    rows: list[ReportedCompensationObservation],
) -> str:
    if rows and all(row.source_id == "posted_salary_text" for row in rows):
        if match_scope == "same_location_role_fallback":
            return "employer-posted same-location role compensation"
        if match_scope == "tier_role_fallback":
            return "employer-posted trimodal tier compensation"
        if match_scope == "market_baseline_fallback":
            return "employer-posted trimodal market baseline"
        return "employer-posted company-role compensation"
    return _aggregate_bucket(company, title, match_scope)


def _geography_scope(location: str | None, rows: list[ReportedCompensationObservation]) -> str:
    if _is_europe(_normalize_location(location)):
        return "Europe"
    for row in rows:
        geography = _reported_geography(row.location)
        if geography:
            return geography
    return "reported"


def _clean_display(value: str | None) -> str | None:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:240] if text else None


def _dedupe_warnings(values: list[MarketWarningCode]) -> tuple[MarketWarningCode, ...]:
    return tuple(value for value in dict.fromkeys(values) if value in MARKET_WARNING_CODES)


def _dedupe_reasons(values: list[MarketReasonCode]) -> tuple[MarketReasonCode, ...]:
    return tuple(value for value in dict.fromkeys(values) if value in MARKET_REASON_CODES)


def _dedupe_sources(values: tuple[MarketSourceSnapshot, ...]) -> tuple[MarketSourceSnapshot, ...]:
    seen: set[tuple[MarketSourceId, str]] = set()
    out: list[MarketSourceSnapshot] = []
    for value in values:
        value = sanitize_market_source_snapshot(value)
        key = (value.source_id, value.snapshot_version)
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return tuple(out)
