"""Project canonical compensation benchmarks onto active job read models."""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any, cast

from jobctrl.domain.compensation import (
    BenchmarkGeography,
    DirectBenchmarkFact,
    MarketCompensationEstimate,
    ReportedCompensationObservation,
    estimate_market_compensation,
    MarketConfidenceFactor,
    MarketEvidenceRow,
    MarketSourceSnapshot,
    canonical_benchmark_timestamp,
    classify_role,
    normalize_company_name,
    resolve_country_code,
    sanitize_market_source_snapshot,
)
from jobctrl.domain.compensation.market import (
    MARKET_SOURCE_IDS,
    MARKET_WARNING_CODES,
    MarketComponent,
    MarketConfidenceBand,
    MarketConfidenceFactorName,
    MarketSourceId,
    MarketWarningCode,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.compensation.refresh_state import (
    CompensationBenchmarkSlice,
    CompensationRefreshState,
    SqliteCompensationRefreshStateRepository,
)
from jobctrl.infrastructure.compensation.sqlite_benchmark_repository import (
    SqliteCompensationBenchmarkRepository,
)
from jobctrl.infrastructure.compensation.sqlite_market_repository import (
    SqliteMarketCompensationRepository,
)
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder


CANONICAL_BENCHMARK_ESTIMATOR_VERSION = "company-role-reported-compensation-canonical-benchmark-v1"

_SOURCE_DISPLAY_NAMES: dict[str, str] = {
    "levels_fyi": "Levels.fyi",
    "glassdoor": "Glassdoor",
    "manual_reported_compensation": "Manual reported compensation import",
    "euro_top_tech": "Euro Top Tech",
    "posted_salary_text": "Job posting salary text",
}


@dataclass(frozen=True)
class CompensationBenchmarkMaterializationResult:
    jobs_considered: int
    jobs_with_benchmark: int
    estimates_written: int
    estimates_unchanged: int
    estimates_cleared: int
    jobs_without_benchmark: int
    jobs_without_role_family: int
    jobs_without_country: int
    projections_refreshed: int
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class _BenchmarkProjectionInput:
    result_kind: str
    reference_fact_id: str
    role_family_code: str
    seniority_label: str
    geography: BenchmarkGeography
    component: str
    minimum_amount: int
    maximum_amount: int
    confidence_interval_minimum_amount: int
    confidence_interval_maximum_amount: int
    confidence_band: str
    confidence_score: float
    source_facts: tuple[DirectBenchmarkFact, ...]
    warnings: tuple[str, ...]
    observed_at: str
    fresh_until: str
    source_lookup_failed: bool = False


def materialize_automatic_compensation_estimates(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    materialized_at: str,
) -> CompensationBenchmarkMaterializationResult:
    """Attach the latest canonical slice result to every matching active job."""

    canonical_now = canonical_benchmark_timestamp(materialized_at, "materialized_at")
    state_repository = SqliteCompensationRefreshStateRepository(conn)
    benchmark_repository = SqliteCompensationBenchmarkRepository(conn)
    market_repository = SqliteMarketCompensationRepository(conn)
    rows = _active_job_rows(conn, tenant_id)
    written = 0
    unchanged = 0
    cleared = 0
    with_benchmark = 0
    without_benchmark = 0
    without_role = 0
    without_country = 0
    warnings: set[str] = set()

    for row in rows:
        job_id = canonical_job_id(str(row["job_id"]))
        title = str(row["title"] or "").strip()
        location = str(row["location"] or "").strip()
        classification = classify_role(title)
        if classification.role_family_code is None:
            without_role += 1
            cleared += int(
                market_repository.delete_estimate_if_owned_by(
                    tenant_id,
                    job_id,
                    estimator_version_prefix=CANONICAL_BENCHMARK_ESTIMATOR_VERSION,
                    deleted_at=canonical_now,
                )
            )
            continue
        country_code = resolve_country_code(location)
        if country_code is None:
            without_country += 1
            cleared += int(
                market_repository.delete_estimate_if_owned_by(
                    tenant_id,
                    job_id,
                    estimator_version_prefix=CANONICAL_BENCHMARK_ESTIMATOR_VERSION,
                    deleted_at=canonical_now,
                )
            )
            continue
        benchmark_slice = CompensationBenchmarkSlice(
            tenant_id=tenant_id,
            taxonomy_version=classification.taxonomy_version,
            role_family_code=classification.role_family_code,
            seniority_label=classification.seniority_label,
            geography=BenchmarkGeography(country_code),
        )
        state = state_repository.get(benchmark_slice)
        projection_input = _projection_input(
            benchmark_repository,
            state,
        )
        company = _nullable_text(row["company"]) or _nullable_text(row["site"])
        if projection_input is None or projection_input.seniority_label != classification.seniority_label:
            peers = benchmark_repository.fresh_company_peers(
                tenant_id=tenant_id, taxonomy_version=classification.taxonomy_version,
                role_family_code=classification.role_family_code, seniority_label=classification.seniority_label,
                country_code=country_code, component=benchmark_slice.component, fresh_at=canonical_now,
            )
            peer_estimate = _peer_estimate(peers, benchmark_slice, job_id, title, company, location, canonical_now)
            current = market_repository.get_estimate(tenant_id, job_id)
            if peer_estimate is not None:
                with_benchmark += 1
                if current == peer_estimate:
                    unchanged += 1
                else:
                    market_repository.save_estimate(peer_estimate)
                    written += 1
                continue
            if market_repository.can_retain_estimate(current, title=title, location=location):
                # An unavailable/weak refresh cannot replace accepted role-level
                # evidence. Stale source dates remain visible on the retained result.
                with_benchmark += 1
                unchanged += 1
                continue
        if projection_input is None and state is not None and state.refresh_status == "failed":
            # Date the placeholder from the failed refresh itself so an unchanged
            # failed state materializes to the same row and produces no write.
            unavailable = estimate_market_compensation(job_id=job_id, tenant_id=tenant_id,
                company=company, title=title, location=location, observations=(),
                estimated_at=state.last_checked_at or canonical_now)
            unavailable = replace(unavailable, estimate_state="source_unavailable", insufficient_reasons=(),
                source_unavailable_reasons=("missing_reported_observation",),
                estimator_version=f"{CANONICAL_BENCHMARK_ESTIMATOR_VERSION}:unavailable")
            current = market_repository.get_estimate(tenant_id, job_id)
            if current == unavailable:
                unchanged += 1
            else:
                market_repository.save_estimate(unavailable)
                written += 1
            without_benchmark += 1
            continue
        if projection_input is None:
            without_benchmark += 1
            cleared += int(
                market_repository.delete_estimate_if_owned_by(
                    tenant_id,
                    job_id,
                    estimator_version_prefix=CANONICAL_BENCHMARK_ESTIMATOR_VERSION,
                    deleted_at=canonical_now,
                )
            )
            continue
        with_benchmark += 1
        try:
            estimate = _estimate_from_benchmark(
                job_id=job_id,
                tenant_id=tenant_id,
                title=title,
                company=company,
                job_seniority=classification.seniority_label,
                benchmark=projection_input,
                materialized_at=canonical_now,
            )
        except ValueError:
            warnings.add("invalid_benchmark_projection")
            without_benchmark += 1
            with_benchmark -= 1
            cleared += int(
                market_repository.delete_estimate_if_owned_by(
                    tenant_id,
                    job_id,
                    estimator_version_prefix=CANONICAL_BENCHMARK_ESTIMATOR_VERSION,
                    deleted_at=canonical_now,
                )
            )
            continue
        current = market_repository.get_estimate(tenant_id, job_id)
        if current == estimate:
            unchanged += 1
            continue
        market_repository.save_estimate(estimate)
        written += 1

    projections_refreshed = 0
    if written or cleared:
        projections_refreshed = ProjectionBuilder(
            conn_factory=lambda: conn,
            tenant_id=TenantId(tenant_id),
        ).refresh()

    return CompensationBenchmarkMaterializationResult(
        jobs_considered=len(rows),
        jobs_with_benchmark=with_benchmark,
        estimates_written=written,
        estimates_unchanged=unchanged,
        estimates_cleared=cleared,
        jobs_without_benchmark=without_benchmark,
        jobs_without_role_family=without_role,
        jobs_without_country=without_country,
        projections_refreshed=projections_refreshed,
        warnings=tuple(sorted(warnings)),
    )


def _peer_estimate(
    peers: tuple[DirectBenchmarkFact, ...], benchmark_slice: CompensationBenchmarkSlice,
    job_id: JobId, title: str, company: str | None, location: str, materialized_at: str,
) -> MarketCompensationEstimate | None:
    if not peers or benchmark_slice.seniority_label == "unknown":
        return None
    observations = tuple(ReportedCompensationObservation(
        source_id=cast(Any, fact.source_id), source_provenance=cast(Any, fact.source_provenance),
        company_name=fact.normalized_company or "unknown company",
        role_title=fact.role_family_code.replace("_", " "), level_label=fact.seniority_label,
        location=_peer_location_label(fact.geography, location), currency="EUR", period="year",
        component=cast(Any, fact.component), minimum_amount=fact.eur_annual_minimum_amount,
        maximum_amount=fact.eur_annual_maximum_amount, sample_count=fact.sample_count,
        release_year=int(fact.as_of_date[:4]), snapshot_version=fact.source_snapshot_id,
        source_url=fact.source_url, attribution=fact.attribution,
    ) for fact in peers if fact.source_id in MARKET_SOURCE_IDS)
    estimate = estimate_market_compensation(
        job_id=job_id, tenant_id=benchmark_slice.tenant_id, company=company, title=title,
        location=location, seniority_label=benchmark_slice.seniority_label,
        observations=observations, estimated_at=max(fact.fetched_at for fact in peers),
    )
    if estimate.estimate_state != "estimated_range":
        return None
    return replace(estimate, normalized_role=benchmark_slice.role_family_code,
                   estimator_version=f"{CANONICAL_BENCHMARK_ESTIMATOR_VERSION}:company-peers",
                   aggregate_bucket="reported regional company peer cohort",
                   confidence_band="low", confidence_score=min(0.45, estimate.confidence_score))


def _projection_input(
    repository: SqliteCompensationBenchmarkRepository,
    state: CompensationRefreshState | None,
) -> _BenchmarkProjectionInput | None:
    if state is None:
        return None
    if state.last_result_kind == "direct" and state.last_direct_fact_id:
        direct = repository.get_direct(
            state.benchmark_slice.tenant_id,
            state.last_direct_fact_id,
        )
        if direct is None:
            return None
        return _BenchmarkProjectionInput(
            result_kind="direct",
            reference_fact_id=direct.fact_id,
            role_family_code=direct.role_family_code,
            seniority_label=direct.seniority_label,
            geography=direct.geography,
            component=direct.component,
            minimum_amount=direct.eur_annual_minimum_amount,
            maximum_amount=direct.eur_annual_maximum_amount,
            confidence_interval_minimum_amount=(direct.confidence_interval_minimum_amount),
            confidence_interval_maximum_amount=(direct.confidence_interval_maximum_amount),
            confidence_band=_confidence_band(direct.confidence_score),
            confidence_score=direct.confidence_score,
            source_facts=(direct,),
            warnings=(),
            observed_at=direct.fetched_at,
            fresh_until=direct.fresh_until,
            source_lookup_failed=state.refresh_status == "failed",
        )
    if state.last_result_kind == "extrapolated" and state.last_extrapolated_fact_id:
        extrapolated = repository.get_extrapolated(
            state.benchmark_slice.tenant_id,
            state.last_extrapolated_fact_id,
        )
        if extrapolated is None:
            return None
        source_facts = tuple(
            direct
            for item in sorted(
                extrapolated.direct_inputs,
                key=lambda value: (value.input_role, value.direct_fact_id),
            )
            if (
                direct := repository.get_direct(
                    extrapolated.tenant_id,
                    item.direct_fact_id,
                )
            )
            is not None
        )
        if not source_facts:
            return None
        warnings = list(extrapolated.warnings)
        warnings.append("benchmark_extrapolated")
        if extrapolated.factor_bound_state != "within_bounds":
            warnings.append("factor_out_of_bounds")
        return _BenchmarkProjectionInput(
            result_kind="extrapolated",
            reference_fact_id=extrapolated.fact_id,
            role_family_code=extrapolated.role_family_code,
            seniority_label=extrapolated.seniority_label,
            geography=extrapolated.target_geography,
            component=extrapolated.component,
            minimum_amount=extrapolated.minimum_amount,
            maximum_amount=extrapolated.maximum_amount,
            confidence_interval_minimum_amount=(extrapolated.confidence_interval_minimum_amount),
            confidence_interval_maximum_amount=(extrapolated.confidence_interval_maximum_amount),
            confidence_band=extrapolated.confidence_band,
            confidence_score=extrapolated.confidence_score,
            source_facts=source_facts,
            warnings=tuple(warnings),
            observed_at=extrapolated.derived_at,
            fresh_until=extrapolated.fresh_until,
            source_lookup_failed=state.refresh_status == "failed",
        )
    return None


def _estimate_from_benchmark(
    *,
    job_id: JobId,
    tenant_id: str,
    title: str,
    company: str | None,
    job_seniority: str,
    benchmark: _BenchmarkProjectionInput,
    materialized_at: str,
) -> MarketCompensationEstimate:
    role_label = benchmark.role_family_code.replace("_", " ").title()
    sources = _source_snapshots(benchmark.source_facts)
    if not sources:
        raise ValueError("canonical benchmark has no supported reported source")
    evidence = tuple(
        _evidence_row(
            fact,
            role_label=role_label,
            target_geography=benchmark.geography,
            target_seniority=job_seniority,
            extrapolated=benchmark.result_kind == "extrapolated",
            materialized_at=materialized_at,
        )
        for fact in benchmark.source_facts
    )
    sample_count = sum(fact.sample_count for fact in benchmark.source_facts)
    anonymous_reports = any(fact.source_id == "euro_top_tech" and fact.market_scope == "market"
                            for fact in benchmark.source_facts)
    warning_values = list(benchmark.warnings)
    if benchmark.seniority_label != job_seniority:
        warning_values.append("benchmark_level_fallback")
    if benchmark.fresh_until <= materialized_at:
        warning_values.append("stale_source_snapshot")
    if sample_count < 3:
        warning_values.append("low_sample_count")
    warnings = _warning_codes(warning_values)
    freshness_score = 0.25 if "stale_source_snapshot" in warnings else 1.0
    level_matches = benchmark.seniority_label == job_seniority
    level_score = 1.0 if level_matches else 0.0
    factors = (
        _factor(
            "role",
            1.0,
            f"Matched canonical role family {benchmark.role_family_code}.",
        ),
        _factor(
            "level",
            level_score,
            (
                f"Matched canonical seniority {benchmark.seniority_label}."
                if level_score == 1.0
                else ("The requested role and level lookup could not retrieve supporting source pages. "
                      if benchmark.source_lookup_failed else "")
                + f"The {benchmark.seniority_label} population does not establish pay for {job_seniority}."
            ),
        ),
        _factor(
            "location",
            1.0 if benchmark.result_kind == "direct" else benchmark.confidence_score,
            (
                f"Used direct country evidence for {benchmark.geography.country_code}."
                if benchmark.result_kind == "direct"
                else f"Derived {benchmark.geography.country_code} from an auditable geographic bridge."
            ),
        ),
        _factor(
            "sample",
            min(1.0, sample_count / 20),
            f"Canonical lineage contains {sample_count} reported observations.",
        ),
        _factor(
            "freshness",
            freshness_score,
            f"Benchmark evidence is fresh through {benchmark.fresh_until}.",
        ),
    )
    return MarketCompensationEstimate(
        tenant_id=tenant_id,
        job_id=job_id,
        estimate_state="estimated_range" if level_matches else "insufficient_evidence",
        currency="EUR",
        period="year",
        component=cast(MarketComponent, benchmark.component),
        minimum_amount=benchmark.minimum_amount if level_matches else None,
        maximum_amount=benchmark.maximum_amount if level_matches else None,
        confidence_interval_minimum_amount=(benchmark.confidence_interval_minimum_amount if level_matches else None),
        confidence_interval_maximum_amount=(benchmark.confidence_interval_maximum_amount if level_matches else None),
        confidence_band=("low" if anonymous_reports else cast(MarketConfidenceBand, benchmark.confidence_band)) if level_matches else "none",
        confidence_score=round(min(0.45, benchmark.confidence_score) if anonymous_reports else benchmark.confidence_score, 2) if level_matches else 0.0,
        source_count=len(sources),
        sample_count=sample_count,
        aggregate_bucket="reported regional source sample" if anonymous_reports else "reported company-role compensation",
        geography_scope=benchmark.geography.scope,
        occupation_code=benchmark.role_family_code,
        occupation_label=role_label,
        seniority_label=benchmark.seniority_label,
        sources=sources,
        factors=factors,
        evidence=evidence,
        insufficient_reasons=() if level_matches else ("weak_level_match",),
        unsupported_reasons=(),
        source_unavailable_reasons=(),
        warnings=warnings,
        estimator_version=(
            f"{CANONICAL_BENCHMARK_ESTIMATOR_VERSION}:{benchmark.result_kind}:{benchmark.reference_fact_id}"
        ),
        estimated_at=benchmark.observed_at,
        company_name=company,
        normalized_company=normalize_company_name(company),
        role_title=title,
        normalized_role=benchmark.role_family_code,
        company_tier="unknown",
        match_scope="market_baseline_fallback",
    )


def _source_snapshots(
    facts: tuple[DirectBenchmarkFact, ...],
) -> tuple[MarketSourceSnapshot, ...]:
    snapshots: dict[tuple[str, str, str], MarketSourceSnapshot] = {}
    for fact in facts:
        if fact.source_id not in MARKET_SOURCE_IDS:
            continue
        source_id = cast(MarketSourceId, fact.source_id)
        snapshot = sanitize_market_source_snapshot(
            MarketSourceSnapshot(
                source_id=source_id,
                source_provenance=cast(Any, fact.source_provenance),
                display_name=_SOURCE_DISPLAY_NAMES[source_id],
                source_type="reported_compensation",
                release_year=int(fact.as_of_date[:4]),
                snapshot_version=fact.source_snapshot_id,
                geography_scope=fact.geography.scope,
                aggregate_bucket="reported company-role compensation",
                attribution=fact.attribution,
                sample_count=fact.sample_count,
            )
        )
        key = (
            snapshot.source_id,
            snapshot.source_provenance,
            snapshot.snapshot_version,
        )
        snapshots.setdefault(key, snapshot)
    return tuple(snapshots[key] for key in sorted(snapshots))


def _evidence_row(
    fact: DirectBenchmarkFact,
    *,
    role_label: str,
    target_geography: BenchmarkGeography,
    target_seniority: str,
    extrapolated: bool,
    materialized_at: str,
) -> MarketEvidenceRow:
    if fact.source_id not in MARKET_SOURCE_IDS:
        raise ValueError("unsupported benchmark source")
    source_id = cast(MarketSourceId, fact.source_id)
    return MarketEvidenceRow(
        source_id=source_id,
        display_name=_SOURCE_DISPLAY_NAMES[source_id],
        source_url=fact.source_url,
        company_name=(
            fact.normalized_company
            if fact.market_scope == "company" and fact.normalized_company
            else "Euro Top Tech community" if source_id == "euro_top_tech"
            else f"{_SOURCE_DISPLAY_NAMES[source_id]} market aggregate"
        ),
        role_title=role_label,
        location=_geography_label(fact.geography),
        level_label=fact.seniority_label,
        company_tier="unknown",
        component=fact.component,
        currency="EUR",
        period="year",
        minimum_amount=fact.eur_annual_minimum_amount,
        maximum_amount=fact.eur_annual_maximum_amount,
        sample_count=fact.sample_count,
        release_year=int(fact.as_of_date[:4]),
        company_score=1.0 if fact.market_scope == "company" else 0.0,
        role_score=1.0,
        level_score=1.0 if fact.seniority_label == target_seniority else 0.0,
        location_score=(1.0 if not extrapolated and fact.geography == target_geography else 0.5),
        freshness_score=0.25 if fact.fresh_until <= materialized_at else 1.0,
    )


def _factor(
    name: MarketConfidenceFactorName,
    score: float,
    reason: str,
) -> MarketConfidenceFactor:
    rounded = round(max(0.0, min(1.0, score)), 2)
    return MarketConfidenceFactor(
        name=name,
        score=rounded,
        band=_confidence_band(rounded),
        reason=reason,
    )


def _confidence_band(score: float) -> MarketConfidenceBand:
    if score >= 0.85:
        return "high"
    if score >= 0.62:
        return "medium"
    if score > 0:
        return "low"
    return "none"


def _warning_codes(values: list[str]) -> tuple[MarketWarningCode, ...]:
    mapped = (
        "factor_out_of_bounds" if value in {"factor_below_lower_bound", "factor_above_upper_bound"} else value
        for value in values
    )
    return tuple(cast(MarketWarningCode, value) for value in dict.fromkeys(mapped) if value in MARKET_WARNING_CODES)


def _geography_label(geography: BenchmarkGeography) -> str:
    if geography.scope == "locality":
        return f"{geography.locality}, {geography.country_code}"
    if geography.scope == "country_subdivision":
        return f"{geography.subdivision_code}, {geography.country_code}"
    return geography.country_code


def _peer_location_label(geography: BenchmarkGeography, job_location: str) -> str:
    """Label same-country peer evidence with the job's own spelling of that country.

    Peer facts are selected by the job's country code, but the market estimator
    scores locations textually and reads a bare ISO code such as ``ES`` as a
    mismatch against ``Madrid, Spain``. Reusing the job's country wording keeps
    the evidence truthful (it is the same country) and lets the estimator score
    the cohort as same-location. Unmatched wording falls back to the ISO code.
    """

    country_label = next(
        (part.strip() for part in re.split(r"[,/|()]|\s[-\u2013\u2014]\s", job_location)
         if part.strip() and resolve_country_code(part) == geography.country_code),
        geography.country_code,
    )
    if geography.scope == "locality":
        return f"{geography.locality}, {country_label}"
    if geography.scope == "country_subdivision":
        return f"{geography.subdivision_code}, {country_label}"
    return country_label


def _active_job_rows(
    conn: sqlite3.Connection,
    tenant_id: str,
) -> tuple[Mapping[str, Any], ...]:
    cursor = conn.execute(
        """
        SELECT jobs.job_id, jobs.title, jobs.company, jobs.site, jobs.location
        FROM jobs
        LEFT JOIN jobctrl_deleted_jobs AS deleted
          ON deleted.tenant_id = jobs.tenant_id
         AND deleted.job_id = jobs.job_id
         AND (
               deleted.restored_at IS NULL
               OR julianday(deleted.restored_at) <= julianday(deleted.deleted_at)
         )
        WHERE jobs.tenant_id = ?
          AND deleted.job_id IS NULL
        ORDER BY jobs.discovered_at, jobs.job_id
        """,
        (tenant_id,),
    )
    columns = tuple(column[0] for column in cursor.description)
    return tuple(
        dict(row) if isinstance(row, sqlite3.Row) else dict(zip(columns, row, strict=True)) for row in cursor.fetchall()
    )


def _nullable_text(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


__all__ = [
    "CANONICAL_BENCHMARK_ESTIMATOR_VERSION",
    "CompensationBenchmarkMaterializationResult",
    "materialize_automatic_compensation_estimates",
]
