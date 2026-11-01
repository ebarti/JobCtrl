"""Deterministic company-role reported compensation estimates."""

from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import median
from typing import Literal

from jobctrl.domain.compensation.classification import BenchmarkClassification
from jobctrl.domain.enrichment.interpretation import JobInterpretation
from jobctrl.domain.job_content_identity import normalize_identity_text as canonical_company_key
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.identifiers import JobId, canonical_job_id

ESTIMATOR_VERSION = "company-role-reported-compensation-v5-determinations"

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
MarketSourceProvenance = Literal["public", "licensed", "manual", "employer_posted"]
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
    "benchmark_extrapolated",
    "benchmark_level_fallback",
    "reported_compensation_sample",
    "posted_salary_sample",
    "source_conflict_with_posted_salary",
    "stale_source_snapshot",
    "low_sample_count",
    "company_role_fallback",
    "cost_of_living_only",
    "factor_out_of_bounds",
    "limited_matched_company_evidence",
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
    "benchmark_extrapolated",
    "benchmark_level_fallback",
    "reported_compensation_sample",
    "posted_salary_sample",
    "source_conflict_with_posted_salary",
    "stale_source_snapshot",
    "low_sample_count",
    "company_role_fallback",
    "cost_of_living_only",
    "factor_out_of_bounds",
    "limited_matched_company_evidence",
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
SOURCE_DEFAULT_ATTRIBUTION: dict[tuple[MarketSourceId, MarketSourceProvenance], str] = {
    ("levels_fyi", "public"): "Data source: Levels.fyi (https://www.levels.fyi)",
    ("levels_fyi", "licensed"): "Levels.fyi licensed compensation data",
    ("glassdoor", "licensed"): "Glassdoor reported compensation data",
    ("manual_reported_compensation", "manual"): "Manual reported compensation import",
    ("euro_top_tech", "public"): "Euro Top Tech public crowdsourced compensation data",
    ("posted_salary_text", "employer_posted"): "Employer-posted salary text captured by JobCtrl",
}
LEVELS_FYI_MARKET_AGGREGATE_COMPANY = "Levels.fyi market aggregate"
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


@dataclass(frozen=True)
class MarketConfidenceFactor:
    name: MarketConfidenceFactorName
    score: float
    band: MarketConfidenceBand
    reason: str


@dataclass(frozen=True)
class MarketSourceSnapshot:
    source_id: MarketSourceId
    source_provenance: MarketSourceProvenance
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
    determination_id: str | None = None
    classification_entity_id: str | None = None
    occupation_family_code: str | None = None
    seniority_code: str | None = None
    country_codes: tuple[str, ...] = ()


@dataclass(frozen=True)
class ReportedCompensationObservation:
    source_id: MarketSourceId
    source_provenance: MarketSourceProvenance
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
    sample_count: int | None = None
    attribution: str | None = None
    source_url: str | None = None
    classification: BenchmarkClassification | None = None
    determination_id: str | None = None
    classification_entity_id: str | None = None


@dataclass(frozen=True)
class MarketCompensationEstimate:
    tenant_id: str
    job_id: JobId
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


def accepted_estimate_matches_job(estimate, *, interpretation: JobInterpretation) -> bool:
    if estimate is None or estimate.estimate_state != "estimated_range":
        return False
    countries = {place.country_code for place in interpretation.places if place.country_code}
    return bool(estimate.evidence) and all(
        row.determination_id
        and row.occupation_family_code == interpretation.occupation_family.value
        and row.seniority_code == interpretation.seniority.value
        and set(row.country_codes) & countries
        for row in estimate.evidence
    )


def estimate_market_compensation(
    *,
    job_id,
    title,
    company,
    location,
    observations,
    interpretation: JobInterpretation,
    tenant_id="local",
    component="total_compensation",
    posted_annualized_minimum=None,
    posted_annualized_maximum=None,
    estimated_at=None,
) -> MarketCompensationEstimate:
    job_id = canonical_job_id(str(job_id))
    now = estimated_at or datetime.now(timezone.utc).isoformat()
    family, level = interpretation.occupation_family.value, interpretation.seniority.value
    countries = {place.country_code for place in interpretation.places if place.country_code}
    if any(row.classification is None or not row.determination_id for row in observations):
        raise DeterminationFailure("benchmark_classification_unavailable")
    matched = [
        row
        for row in observations
        if row.source_id != "posted_salary_text"
        and row.component == component
        and row.classification.occupation_family.value == family
        and row.classification.seniority.value == level
        and {place.country_code for place in row.classification.places if place.country_code} & countries
        and family != "unknown"
        and level != "unknown"
        and (row.minimum_amount is not None or row.maximum_amount is not None)
    ]
    exact = [row for row in matched if canonical_company_key(row.company_name) == canonical_company_key(company or "")]
    rows = exact or matched
    scope = "exact_company_role" if exact else "same_location_role_fallback"
    common = dict(
        tenant_id=tenant_id,
        job_id=job_id,
        component=component,
        estimated_at=now,
        company_name=company,
        normalized_company=canonical_company_key(company or "") or None,
        role_title=title,
        normalized_role=family,
        occupation_code=family,
        occupation_label=family,
        seniority_label=level,
        geography_scope=", ".join(sorted(countries)),
        match_scope=scope,
    )
    if rows:
        tiers = {row.classification.company_tier.value for row in rows}
        common["company_tier"] = next(iter(tiers)) if len(tiers) == 1 else "unknown"
    if not rows:
        return _estimate(state="insufficient_evidence", insufficient=["missing_reported_observation"], **common)
    # Amounts must have one explicit currency and period; no inferred conversions.
    if len({(row.currency, row.period) for row in rows}) != 1:
        return _estimate(state="insufficient_evidence", insufficient=["source_dispersion_too_high"], **common)
    minimum, maximum = min(_row_minimum(row) for row in rows), max(_row_maximum(row) for row in rows)
    freshness = min(_freshness_score(row.release_year, now) for row in rows)
    warnings = (
        ["source_conflict_with_posted_salary"]
        if _posted_conflicts(minimum, maximum, posted_annualized_minimum, posted_annualized_maximum)
        else []
    )
    factors = [
        _factor("role", 1, "Equal persisted occupation codes."),
        _factor("level", 1, "Equal persisted seniority codes."),
        _factor("location", 1, "Equal persisted country codes."),
        _factor("freshness", freshness, "Source release dates."),
    ]
    return _estimate(
        state="estimated_range",
        currency=rows[0].currency,
        period=rows[0].period,
        minimum_amount=minimum,
        maximum_amount=maximum,
        confidence_interval_minimum_amount=minimum,
        confidence_interval_maximum_amount=maximum,
        confidence_score=freshness,
        source_count=len({row.source_id for row in rows}),
        sample_count=_combined_sample_count(rows),
        factors=factors,
        warnings=warnings,
        sources=tuple(_snapshot(row) for row in rows),
        evidence=tuple(
            _evidence_row(
                row,
                company_score=1 if row in exact else 0,
                role_score=1,
                level_score=1,
                location_score=1,
                freshness_score=_freshness_score(row.release_year, now),
            )
            for row in rows
        ),
        **common,
    )


def not_requested_market_estimate(
    *,
    tenant_id: str = "local",
    job_id: JobId,
    estimated_at: str | None = None,
) -> MarketCompensationEstimate:
    """Create an explicit not-requested market estimate value without persisting it."""

    job_id = canonical_job_id(str(job_id))
    return _estimate(
        tenant_id=tenant_id,
        job_id=job_id,
        state="not_requested",
        component="total_compensation",
        estimated_at=estimated_at or datetime.now(timezone.utc).isoformat(),
    )


def _insufficient(
    *,
    tenant_id: str,
    job_id: JobId,
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
        job_id=job_id,
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
    job_id: JobId,
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
        job_id=job_id,
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


def _snapshot(row: ReportedCompensationObservation) -> MarketSourceSnapshot:
    return sanitize_market_source_snapshot(
        MarketSourceSnapshot(
            source_id=row.source_id,
            source_provenance=row.source_provenance,
            display_name=_display_name(row.source_id),
            source_type=_source_type(row.source_id),
            release_year=row.release_year,
            snapshot_version=row.snapshot_version,
            geography_scope=", ".join(place.country_code for place in row.classification.places if place.country_code),
            aggregate_bucket=_source_aggregate_bucket(row.source_id),
            attribution=row.attribution or "",
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
        determination_id=row.determination_id,
        classification_entity_id=row.classification_entity_id,
        occupation_family_code=row.classification.occupation_family.value if row.classification else None,
        seniority_code=row.classification.seniority.value if row.classification else None,
        country_codes=tuple(place.country_code for place in row.classification.places) if row.classification else (),
        display_name=_display_name(source_id),
        source_url=_safe_source_url(row.source_url),
        company_name=_safe_text(row.company_name) or "unknown company",
        role_title=_safe_text(row.role_title) or "unknown role",
        location=_safe_text(row.location) or None,
        level_label=_safe_text(row.level_label) or None,
        company_tier=row.classification.company_tier.value if row.classification else "unknown",
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
    if any(
        term in lowered
        for term in (
            "/users/",
            "\\users\\",
            "file://",
            "credential",
            "secret",
            "token",
            "password",
            "api_key",
            "api key",
            "api-key",
            "private",
        )
    ):
        return None
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def sanitize_market_source_snapshot(source: MarketSourceSnapshot) -> MarketSourceSnapshot:
    """Return a safe reported-source snapshot for persistence or API serialization."""

    source_id = source.source_id if source.source_id in MARKET_SOURCE_IDS else "manual_reported_compensation"
    source_provenance = _source_provenance(source_id, source.source_provenance)
    snapshot_version = _safe_text(source.snapshot_version) or _source_snapshot_version(
        source_id,
        source_provenance,
        source.release_year,
    )
    attribution = _safe_text(source.attribution) or SOURCE_DEFAULT_ATTRIBUTION[(source_id, source_provenance)]
    if source_id == "levels_fyi" and source_provenance == "public":
        attribution = SOURCE_DEFAULT_ATTRIBUTION[(source_id, source_provenance)]
    return MarketSourceSnapshot(
        source_id=source_id,
        source_provenance=source_provenance,
        display_name=_display_name(source_id),
        source_type=_source_type(source_id),
        release_year=source.release_year,
        snapshot_version=snapshot_version,
        geography_scope=_safe_text(source.geography_scope) or "reported",
        aggregate_bucket=_source_aggregate_bucket(source_id),
        attribution=attribution,
        sample_count=source.sample_count,
    )


def _display_name(source_id: str) -> str:
    if source_id in SOURCE_DISPLAY_NAMES:
        return SOURCE_DISPLAY_NAMES[source_id]  # type: ignore[index]
    return "Manual reported compensation import"


def _source_type(source_id: str) -> MarketSourceType:
    return "posted_salary" if source_id == "posted_salary_text" else "reported_compensation"


def _source_provenance(source_id: MarketSourceId, value: str) -> MarketSourceProvenance:
    allowed: dict[MarketSourceId, MarketSourceProvenance] = {
        "levels_fyi": "licensed",
        "glassdoor": "licensed",
        "manual_reported_compensation": "manual",
        "euro_top_tech": "public",
        "posted_salary_text": "employer_posted",
    }
    if source_id == "levels_fyi" and value in {"public", "licensed"}:
        return value  # type: ignore[return-value]
    return allowed[source_id]


def _source_snapshot_version(
    source_id: str,
    source_provenance: MarketSourceProvenance,
    release_year: int | None,
) -> str:
    if source_id == "levels_fyi" and source_provenance == "public":
        return f"levels-fyi-public-{release_year}" if release_year is not None else "levels-fyi-public"
    if source_id == "posted_salary_text":
        return "jobctrl-posted-compensation-v1"
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


def _confidence_interval(
    minimum: int,
    maximum: int,
    *,
    match_scope: MarketMatchScope,
    confidence_score: float,
    sample_count: int | None,
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
    if sample_count is None or sample_count < LOW_SAMPLE_THRESHOLD:
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


def _combined_sample_count(rows: list[ReportedCompensationObservation]) -> int | None:
    counts = [row.sample_count for row in rows]
    if any(count is None for count in counts):
        return None
    return sum(count for count in counts if count is not None)


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


def _clean_display(value: str | None) -> str | None:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:240] if text else None


def _dedupe_warnings(values: list[MarketWarningCode]) -> tuple[MarketWarningCode, ...]:
    return tuple(value for value in dict.fromkeys(values) if value in MARKET_WARNING_CODES)


def _dedupe_reasons(values: list[MarketReasonCode]) -> tuple[MarketReasonCode, ...]:
    return tuple(value for value in dict.fromkeys(values) if value in MARKET_REASON_CODES)


def _dedupe_sources(values: tuple[MarketSourceSnapshot, ...]) -> tuple[MarketSourceSnapshot, ...]:
    seen: set[tuple[MarketSourceId, MarketSourceProvenance, str]] = set()
    out: list[MarketSourceSnapshot] = []
    for value in values:
        value = sanitize_market_source_snapshot(value)
        key = (value.source_id, value.source_provenance, value.snapshot_version)
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return tuple(out)
