"""Deterministic Europe public market compensation estimates."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import median
from typing import Literal

ESTIMATOR_VERSION = "market-compensation-v1"

MarketEstimateState = Literal[
    "not_requested",
    "unsupported",
    "source_unavailable",
    "insufficient_evidence",
    "estimated_range",
]
MarketSourceId = Literal[
    "eurostat_structure_of_earnings",
    "esco_occupation_taxonomy",
    "spain_ine_salary_structure",
]
MarketConfidenceBand = Literal["none", "low", "medium", "high"]
MarketComponent = Literal["base_salary", "gross_annual_salary", "gross_monthly_salary"]
MarketPeriod = Literal["year", "month"]
MarketConfidenceFactorName = Literal[
    "occupation",
    "geography",
    "seniority",
    "component",
    "freshness",
    "sample",
    "agreement",
]
MarketWarningCode = Literal[
    "aggregate_baseline",
    "broad_aggregate_band",
    "source_conflict_with_posted_salary",
    "stale_source_snapshot",
    "low_sample_count",
    "remote_europe_assumption",
    "spain_local_assumption",
    "eu_wide_assumption",
    "non_eu_europe_assumption",
    "unknown_location_assumption",
]
MarketReasonCode = Literal[
    "unsupported_source",
    "unsupported_geography",
    "unsupported_component",
    "missing_occupation_mapping",
    "stale_source_snapshot",
    "weak_occupation_match",
    "weak_geography_match",
    "weak_seniority_match",
    "weak_component_match",
    "low_sample_count",
    "source_dispersion_too_high",
    "missing_salary_observation",
]

MARKET_ESTIMATE_STATES: tuple[MarketEstimateState, ...] = (
    "not_requested",
    "unsupported",
    "source_unavailable",
    "insufficient_evidence",
    "estimated_range",
)
MARKET_SOURCE_IDS: tuple[MarketSourceId, ...] = (
    "eurostat_structure_of_earnings",
    "esco_occupation_taxonomy",
    "spain_ine_salary_structure",
)
MARKET_CONFIDENCE_BANDS: tuple[MarketConfidenceBand, ...] = ("none", "low", "medium", "high")
MARKET_WARNING_CODES: tuple[MarketWarningCode, ...] = (
    "aggregate_baseline",
    "broad_aggregate_band",
    "source_conflict_with_posted_salary",
    "stale_source_snapshot",
    "low_sample_count",
    "remote_europe_assumption",
    "spain_local_assumption",
    "eu_wide_assumption",
    "non_eu_europe_assumption",
    "unknown_location_assumption",
)
MARKET_REASON_CODES: tuple[MarketReasonCode, ...] = (
    "unsupported_source",
    "unsupported_geography",
    "unsupported_component",
    "missing_occupation_mapping",
    "stale_source_snapshot",
    "weak_occupation_match",
    "weak_geography_match",
    "weak_seniority_match",
    "weak_component_match",
    "low_sample_count",
    "source_dispersion_too_high",
    "missing_salary_observation",
)

EU_COUNTRIES = frozenset(
    {
        "austria",
        "belgium",
        "bulgaria",
        "croatia",
        "cyprus",
        "czechia",
        "czech republic",
        "denmark",
        "estonia",
        "finland",
        "france",
        "germany",
        "greece",
        "hungary",
        "ireland",
        "italy",
        "latvia",
        "lithuania",
        "luxembourg",
        "malta",
        "netherlands",
        "poland",
        "portugal",
        "romania",
        "slovakia",
        "slovenia",
        "spain",
        "sweden",
    }
)
NON_EU_EUROPE_COUNTRIES = frozenset({"norway", "switzerland", "iceland", "liechtenstein", "united kingdom", "uk"})
NON_EUROPE_COUNTRIES = frozenset({"united states", "usa", "us", "canada", "australia", "india", "brazil"})
SUPPORTED_COMPONENTS = frozenset({"base_salary", "gross_annual_salary", "gross_monthly_salary"})
SALARY_SOURCE_IDS = frozenset({"eurostat_structure_of_earnings", "spain_ine_salary_structure"})
STALE_THRESHOLD_MONTHS = 60
LOW_SAMPLE_THRESHOLD = 500
MIN_SAMPLE_THRESHOLD = 100
MIN_ESTIMATE_SCORE = 0.72
MIN_CRITICAL_FACTOR_SCORE = 0.60
MAX_DISPERSION_RATIO = 0.25
POSTED_CONFLICT_RATIO = 0.30


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
    source_type: Literal["public_wage_baseline", "occupation_taxonomy"]
    release_year: int | None
    snapshot_version: str
    geography_scope: str
    aggregate_bucket: str
    attribution: str
    sample_count: int | None


@dataclass(frozen=True)
class PublicMarketBaseline:
    source_id: MarketSourceId
    occupation_code: str
    occupation_label: str
    geography_scope: str
    aggregate_bucket: str
    minimum_amount: int | None
    maximum_amount: int | None
    currency: str = "EUR"
    period: MarketPeriod = "year"
    component: MarketComponent = "base_salary"
    release_year: int | None = 2024
    snapshot_version: str = "synthetic-public-fixture"
    sample_count: int | None = None
    attribution: str = "Synthetic public aggregate fixture"
    seniority_label: str = "aggregate"
    occupation_match_score: float = 1.0
    geography_match_score: float = 1.0
    seniority_match_score: float = 0.75


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
    insufficient_reasons: tuple[MarketReasonCode, ...]
    unsupported_reasons: tuple[MarketReasonCode, ...]
    source_unavailable_reasons: tuple[MarketReasonCode, ...]
    warnings: tuple[MarketWarningCode, ...]
    estimator_version: str
    estimated_at: str


def estimate_market_compensation(
    *,
    job_url: str,
    title: str,
    location: str | None,
    baselines: tuple[PublicMarketBaseline, ...],
    tenant_id: str = "local",
    component: str = "base_salary",
    seniority_label: str | None = None,
    posted_annualized_minimum: int | None = None,
    posted_annualized_maximum: int | None = None,
    estimated_at: str | None = None,
) -> MarketCompensationEstimate:
    """Estimate a Europe public market range from deterministic local baseline rows."""

    now = estimated_at or datetime.now(timezone.utc).isoformat()
    warnings: list[MarketWarningCode] = ["aggregate_baseline"]
    unsupported_reasons: list[MarketReasonCode] = []
    source_unavailable_reasons: list[MarketReasonCode] = []
    insufficient_reasons: list[MarketReasonCode] = []
    factors: list[MarketConfidenceFactor] = []

    if component not in SUPPORTED_COMPONENTS:
        unsupported_reasons.append("unsupported_component")
        factors.append(_factor("component", 0.0, "Unsupported compensation component."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="unsupported",
            component="base_salary",
            factors=factors,
            unsupported=unsupported_reasons,
            warnings=warnings,
            estimated_at=now,
        )

    source_ids = {baseline.source_id for baseline in baselines}
    unsupported_sources = sorted(str(source_id) for source_id in source_ids if source_id not in MARKET_SOURCE_IDS)
    if unsupported_sources:
        unsupported_reasons.append("unsupported_source")
        factors.append(_factor("occupation", 0.0, "Unsupported compensation source evidence was rejected."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="unsupported",
            component=_market_component(component),
            factors=factors,
            unsupported=unsupported_reasons,
            warnings=warnings,
            estimated_at=now,
        )

    geography_score, geography_scope, geography_reason, geography_warnings, geography_unsupported = _geography(
        location
    )
    warnings.extend(geography_warnings)
    factors.append(_factor("geography", geography_score, geography_reason))
    if geography_unsupported:
        unsupported_reasons.append("unsupported_geography")
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="unsupported",
            component=_market_component(component),
            factors=factors,
            unsupported=unsupported_reasons,
            warnings=warnings,
            geography_scope=geography_scope,
            estimated_at=now,
        )

    if "esco_occupation_taxonomy" not in source_ids:
        unsupported_reasons.append("missing_occupation_mapping")
        factors.append(_factor("occupation", 0.0, "No ESCO occupation mapping evidence was provided."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="unsupported",
            component=_market_component(component),
            factors=factors,
            unsupported=unsupported_reasons,
            warnings=warnings,
            geography_scope=geography_scope,
            estimated_at=now,
        )

    salary_rows = tuple(baseline for baseline in baselines if baseline.source_id in SALARY_SOURCE_IDS)
    if not salary_rows:
        insufficient_reasons.append("missing_salary_observation")
        factors.append(_factor("occupation", 0.75, f"ESCO mapping supports {title}, but no wage baseline row exists."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="insufficient_evidence",
            component=_market_component(component),
            factors=factors,
            insufficient=insufficient_reasons,
            warnings=warnings,
            geography_scope=geography_scope,
            estimated_at=now,
        )

    usable_rows: list[PublicMarketBaseline] = []
    for row in salary_rows:
        if row.release_year is not None and _age_months(row.release_year, now) > STALE_THRESHOLD_MONTHS:
            source_unavailable_reasons.append("stale_source_snapshot")
            warnings.append("stale_source_snapshot")
            continue
        if row.minimum_amount is None or row.maximum_amount is None:
            insufficient_reasons.append("missing_salary_observation")
            continue
        if row.sample_count is not None and row.sample_count < MIN_SAMPLE_THRESHOLD:
            insufficient_reasons.append("low_sample_count")
            warnings.append("low_sample_count")
            continue
        usable_rows.append(row)

    if source_unavailable_reasons and not usable_rows:
        factors.append(_factor("freshness", 0.0, "Required wage baseline source snapshots are stale."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="source_unavailable",
            component=_market_component(component),
            factors=factors,
            source_unavailable=source_unavailable_reasons,
            warnings=warnings,
            geography_scope=geography_scope,
            estimated_at=now,
        )
    if not usable_rows:
        factors.append(_factor("sample", 0.0, "No wage baseline row had enough sample support."))
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="insufficient_evidence",
            component=_market_component(component),
            factors=factors,
            insufficient=insufficient_reasons or ["missing_salary_observation"],
            warnings=warnings,
            geography_scope=geography_scope,
            estimated_at=now,
        )

    selected_rows = _prefer_rows(usable_rows, geography_scope)
    snapshots = tuple(_snapshot(row) for row in selected_rows) + tuple(
        _snapshot(row) for row in baselines if row.source_id == "esco_occupation_taxonomy"
    )
    minimum = min(row.minimum_amount for row in selected_rows if row.minimum_amount is not None)
    maximum = max(row.maximum_amount for row in selected_rows if row.maximum_amount is not None)
    sample_count = sum(row.sample_count or 0 for row in selected_rows) or None
    source_count = len({row.source_id for row in selected_rows})
    aggregate_bucket = _join_unique(row.aggregate_bucket for row in selected_rows)
    occupation_code = selected_rows[0].occupation_code
    occupation_label = selected_rows[0].occupation_label
    component_value = _market_component(component)

    occupation_score = min(row.occupation_match_score for row in selected_rows)
    seniority_score = min(row.seniority_match_score for row in selected_rows)
    sample_score = _sample_score(sample_count)
    freshness_score = min(_freshness_score(row.release_year, now) for row in selected_rows)
    component_score = 1.0 if component_value in SUPPORTED_COMPONENTS else 0.0
    agreement_score, dispersion_warning, dispersion_insufficient = _agreement_score(selected_rows)
    if dispersion_warning:
        warnings.append("broad_aggregate_band")
    if dispersion_insufficient:
        insufficient_reasons.append("source_dispersion_too_high")
    if sample_count is not None and sample_count < LOW_SAMPLE_THRESHOLD:
        warnings.append("low_sample_count")
        insufficient_reasons.append("low_sample_count")
    if _is_broad_band(minimum, maximum):
        warnings.append("broad_aggregate_band")
    if _posted_conflicts(minimum, maximum, posted_annualized_minimum, posted_annualized_maximum):
        warnings.append("source_conflict_with_posted_salary")

    factors.extend(
        [
            _factor("occupation", occupation_score, f"Occupation mapped to {occupation_label}."),
            _factor("seniority", seniority_score, f"Seniority support: {seniority_label or selected_rows[0].seniority_label}."),
            _factor("component", component_score, f"Component {component_value} is compatible with public wage baselines."),
            _factor("freshness", freshness_score, "Source snapshots are inside the freshness policy window."),
            _factor("sample", sample_score, f"Combined public sample count: {sample_count or 'not published'}."),
            _factor("agreement", agreement_score, "Public baseline rows are within dispersion tolerance."),
        ]
    )

    critical_scores = [
        occupation_score,
        geography_score,
        seniority_score,
        component_score,
        freshness_score,
        sample_score,
        agreement_score,
    ]
    confidence_score = round(min(critical_scores), 2)
    if occupation_score < MIN_CRITICAL_FACTOR_SCORE:
        insufficient_reasons.append("weak_occupation_match")
    if geography_score < MIN_CRITICAL_FACTOR_SCORE:
        insufficient_reasons.append("weak_geography_match")
    if seniority_score < MIN_CRITICAL_FACTOR_SCORE:
        insufficient_reasons.append("weak_seniority_match")
    if component_score < MIN_CRITICAL_FACTOR_SCORE:
        insufficient_reasons.append("weak_component_match")

    if confidence_score < MIN_ESTIMATE_SCORE or insufficient_reasons:
        return _estimate(
            tenant_id=tenant_id,
            job_url=job_url,
            state="insufficient_evidence",
            component=component_value,
            factors=factors,
            insufficient=insufficient_reasons or ["weak_geography_match"],
            warnings=warnings,
            sources=snapshots,
            source_count=source_count,
            sample_count=sample_count,
            aggregate_bucket=aggregate_bucket,
            geography_scope=geography_scope,
            occupation_code=occupation_code,
            occupation_label=occupation_label,
            seniority_label=seniority_label or selected_rows[0].seniority_label,
            confidence_score=confidence_score,
            estimated_at=now,
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
        factors=factors,
        warnings=warnings,
        sources=snapshots,
        source_count=source_count,
        sample_count=sample_count,
        aggregate_bucket=aggregate_bucket,
        geography_scope=geography_scope,
        occupation_code=occupation_code,
        occupation_label=occupation_label,
        seniority_label=seniority_label or selected_rows[0].seniority_label,
        confidence_score=confidence_score,
        estimated_at=now,
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
        component="base_salary",
        estimated_at=estimated_at or datetime.now(timezone.utc).isoformat(),
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
    factors: list[MarketConfidenceFactor] | None = None,
    insufficient: list[MarketReasonCode] | None = None,
    unsupported: list[MarketReasonCode] | None = None,
    source_unavailable: list[MarketReasonCode] | None = None,
    warnings: list[MarketWarningCode] | None = None,
    sources: tuple[MarketSourceSnapshot, ...] = (),
    source_count: int = 0,
    sample_count: int | None = None,
    aggregate_bucket: str | None = None,
    geography_scope: str | None = None,
    occupation_code: str | None = None,
    occupation_label: str | None = None,
    seniority_label: str | None = None,
    confidence_score: float = 0.0,
) -> MarketCompensationEstimate:
    if state != "estimated_range":
        currency = None
        minimum_amount = None
        maximum_amount = None
    return MarketCompensationEstimate(
        tenant_id=tenant_id,
        job_url=job_url,
        estimate_state=state,
        currency=currency,
        period=period,
        component=component,
        minimum_amount=minimum_amount,
        maximum_amount=maximum_amount,
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
        insufficient_reasons=_dedupe_reasons(insufficient or []),
        unsupported_reasons=_dedupe_reasons(unsupported or []),
        source_unavailable_reasons=_dedupe_reasons(source_unavailable or []),
        warnings=_dedupe_warnings(warnings or []),
        estimator_version=ESTIMATOR_VERSION,
        estimated_at=estimated_at,
    )


def _geography(location: str | None) -> tuple[float, str, str, list[MarketWarningCode], bool]:
    normalized = str(location or "").casefold()
    if not normalized.strip():
        return 0.5, "unknown", "Location is unknown; no European market can be selected precisely.", [
            "unknown_location_assumption"
        ], False
    if "remote" in normalized and "europe" in normalized:
        return 0.78, "remote_europe", "Remote Europe role mapped to Europe aggregate baselines.", [
            "remote_europe_assumption"
        ], False
    if "spain" in normalized or "barcelona" in normalized or "madrid" in normalized:
        return 0.95, "spain", "Spain-local role can use Spain INE where available.", ["spain_local_assumption"], False
    if any(country in normalized for country in NON_EUROPE_COUNTRIES):
        return 0.0, "non_europe", "Known non-European location is outside Phase 19 scope.", [], True
    if any(country in normalized for country in NON_EU_EUROPE_COUNTRIES):
        return 0.72, "non_eu_europe", "Non-EU Europe role uses broad Europe aggregate assumptions.", [
            "non_eu_europe_assumption"
        ], False
    if "europe" in normalized or "eu" in normalized or any(country in normalized for country in EU_COUNTRIES):
        return 0.82, "eu_wide", "EU/Europe role mapped to Europe aggregate baselines.", ["eu_wide_assumption"], False
    return 0.5, "unknown", "Location is not specific enough to choose a European market.", [
        "unknown_location_assumption"
    ], False


def _prefer_rows(rows: list[PublicMarketBaseline], geography_scope: str) -> tuple[PublicMarketBaseline, ...]:
    if geography_scope == "spain":
        spain_rows = tuple(row for row in rows if row.source_id == "spain_ine_salary_structure")
        if spain_rows:
            return spain_rows
    return tuple(rows)


def _snapshot(row: PublicMarketBaseline) -> MarketSourceSnapshot:
    source_type: Literal["public_wage_baseline", "occupation_taxonomy"] = (
        "occupation_taxonomy" if row.source_id == "esco_occupation_taxonomy" else "public_wage_baseline"
    )
    return MarketSourceSnapshot(
        source_id=row.source_id,
        display_name=_display_name(row.source_id),
        source_type=source_type,
        release_year=row.release_year,
        snapshot_version=row.snapshot_version,
        geography_scope=row.geography_scope,
        aggregate_bucket=row.aggregate_bucket,
        attribution=row.attribution,
        sample_count=row.sample_count,
    )


def _display_name(source_id: str) -> str:
    if source_id == "eurostat_structure_of_earnings":
        return "Eurostat Structure of Earnings Survey"
    if source_id == "esco_occupation_taxonomy":
        return "ESCO occupation taxonomy"
    if source_id == "spain_ine_salary_structure":
        return "Spain INE Wage Structure Survey"
    return source_id


def _factor(name: MarketConfidenceFactorName, score: float, reason: str) -> MarketConfidenceFactor:
    bounded = max(0.0, min(1.0, score))
    return MarketConfidenceFactor(name=name, score=round(bounded, 2), band=_score_band(bounded), reason=reason)


def _score_band(score: float) -> MarketConfidenceBand:
    if score >= 0.85:
        return "high"
    if score >= 0.72:
        return "medium"
    if score > 0:
        return "low"
    return "none"


def _confidence_band(
    score: float,
    state: MarketEstimateState,
    warnings: list[MarketWarningCode],
) -> MarketConfidenceBand:
    if state == "estimated_range" and score >= 0.85 and not {"low_sample_count", "broad_aggregate_band"} & set(warnings):
        return "high"
    if state == "estimated_range" and score >= MIN_ESTIMATE_SCORE:
        return "medium"
    if state in {"insufficient_evidence", "source_unavailable"} and score > 0:
        return "low"
    return "none"


def _market_component(component: str) -> MarketComponent:
    return component if component in SUPPORTED_COMPONENTS else "base_salary"  # type: ignore[return-value]


def _age_months(release_year: int, estimated_at: str) -> int:
    year = _year(estimated_at)
    return max(0, (year - release_year) * 12)


def _freshness_score(release_year: int | None, estimated_at: str) -> float:
    if release_year is None:
        return 0.72
    months = _age_months(release_year, estimated_at)
    if months <= 24:
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
        return 0.72
    if sample_count >= LOW_SAMPLE_THRESHOLD:
        return 0.9
    if sample_count >= MIN_SAMPLE_THRESHOLD:
        return 0.55
    return 0.0


def _agreement_score(rows: tuple[PublicMarketBaseline, ...]) -> tuple[float, bool, bool]:
    if len(rows) < 2:
        return 0.78, False, False
    midpoints = [((row.minimum_amount or 0) + (row.maximum_amount or 0)) / 2 for row in rows]
    center = median(midpoints)
    if center <= 0:
        return 0.0, True, True
    dispersion = (max(midpoints) - min(midpoints)) / center
    if dispersion > MAX_DISPERSION_RATIO:
        return 0.4, True, True
    if dispersion > 0.15:
        return 0.72, True, False
    return 0.9, False, False


def _is_broad_band(minimum: int, maximum: int) -> bool:
    if minimum <= 0:
        return True
    return (maximum - minimum) / minimum > 0.35


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


def _join_unique(values: object) -> str:
    return ", ".join(dict.fromkeys(str(value) for value in values if value is not None))


def _dedupe_warnings(values: list[MarketWarningCode]) -> tuple[MarketWarningCode, ...]:
    return tuple(value for value in dict.fromkeys(values) if value in MARKET_WARNING_CODES)


def _dedupe_reasons(values: list[MarketReasonCode]) -> tuple[MarketReasonCode, ...]:
    return tuple(value for value in dict.fromkeys(values) if value in MARKET_REASON_CODES)


def _dedupe_sources(values: tuple[MarketSourceSnapshot, ...]) -> tuple[MarketSourceSnapshot, ...]:
    seen: set[tuple[MarketSourceId, str, str]] = set()
    out: list[MarketSourceSnapshot] = []
    for value in values:
        key = (value.source_id, value.snapshot_version, value.aggregate_bucket)
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return tuple(out)
