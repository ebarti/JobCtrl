"""Automatic, lease-fenced discovery of reusable compensation benchmarks."""

from __future__ import annotations

import logging
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from jobctrl.database import get_connection
from jobctrl.domain.compensation import (
    DirectBenchmarkFact,
    ExtrapolatedBenchmarkFact,
    PriceLevelFact,
    canonical_benchmark_timestamp,
    extrapolate_benchmark,
)
from jobctrl.infrastructure.compensation.benchmark_ingestion import (
    FxRateToEur,
    canonicalize_reported_observations,
)
from jobctrl.infrastructure.compensation.levels_fyi_public import LevelsFyiPublicTarget
from jobctrl.infrastructure.compensation.official_data import (
    load_ecb_daily_exchange_rates,
    load_eurostat_actual_individual_consumption_price_levels,
)
from jobctrl.infrastructure.compensation.refresh_state import (
    CompensationBenchmarkSlice,
    SqliteCompensationRefreshStateRepository,
)
from jobctrl.infrastructure.compensation.sqlite_benchmark_repository import (
    SqliteCompensationBenchmarkRepository,
)
from jobctrl.infrastructure.compensation.sqlite_market_repository import (
    ReportedCompensationSourceLoad,
    compensation_feed_client,
    load_default_reported_compensation_observations,
)
from jobctrl.infrastructure.network import PolitenessGateway


log = logging.getLogger(__name__)

AUTOMATIC_REFRESH_INTERVAL = timedelta(days=7)
AUTOMATIC_REFRESH_RETRY_INTERVAL = timedelta(days=1)
AUTOMATIC_REFRESH_LEASE_DURATION = timedelta(hours=1)
PRICE_LEVEL_CATEGORY = "actual_individual_consumption"

AutomaticRefreshStatus = Literal["skipped", "succeeded", "completed_with_warnings"]
ObservationLoader = Callable[[tuple[LevelsFyiPublicTarget, ...]], ReportedCompensationSourceLoad]
FxLoader = Callable[[], tuple[FxRateToEur, ...]]
PriceLevelLoader = Callable[[], tuple[PriceLevelFact, ...]]
CompletionClock = Callable[[], str]


@dataclass(frozen=True)
class AutomaticCompensationRefreshResult:
    status: AutomaticRefreshStatus
    jobs_considered: int
    slices_discovered: int
    slices_claimed: int
    direct_results: int
    extrapolated_results: int
    level_fallback_results: int
    insufficient_results: int
    failed_results: int
    observations_loaded: int
    observations_rejected: int
    direct_facts_saved: int
    price_level_facts_saved: int
    warnings: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "jobsConsidered": self.jobs_considered,
            "slicesDiscovered": self.slices_discovered,
            "slicesClaimed": self.slices_claimed,
            "directResults": self.direct_results,
            "extrapolatedResults": self.extrapolated_results,
            "levelFallbackResults": self.level_fallback_results,
            "insufficientResults": self.insufficient_results,
            "failedResults": self.failed_results,
            "observationsLoaded": self.observations_loaded,
            "observationsRejected": self.observations_rejected,
            "directFactsSaved": self.direct_facts_saved,
            "priceLevelFactsSaved": self.price_level_facts_saved,
            "warnings": list(self.warnings),
        }


def refresh_automatic_compensation_benchmarks(
    *,
    tenant_id: str,
    owner: str,
    now: str | None = None,
    conn: sqlite3.Connection | None = None,
    opener: Any | None = None,
) -> AutomaticCompensationRefreshResult:
    """Run the production automatic refresh through policy-routed public clients."""

    active_conn = conn if conn is not None else get_connection()
    canonical_now = canonical_benchmark_timestamp(
        now or datetime.now(timezone.utc).isoformat(),
        "now",
    )
    fresh_until = _shift_timestamp(canonical_now, AUTOMATIC_REFRESH_INTERVAL)
    gateway = PolitenessGateway()
    run_id = owner

    def load_observations(
        targets: tuple[LevelsFyiPublicTarget, ...],
    ) -> ReportedCompensationSourceLoad:
        return load_default_reported_compensation_observations(
            levels_fyi_targets=targets,
            include_eurotoptech=True,
            gateway=gateway,
            recorder_conn=active_conn,
            run_id=run_id,
            opener=opener,
            preserve_levels_fyi_source_currency=True,
        )

    ecb_client = compensation_feed_client(
        gateway,
        "ecb",
        active_conn,
        run_id,
        opener=opener,
    )
    eurostat_client = compensation_feed_client(
        gateway,
        "eurostat",
        active_conn,
        run_id,
        opener=opener,
    )

    def load_price_levels() -> tuple[PriceLevelFact, ...]:
        reference_year = _timestamp_datetime(canonical_now).year - 1
        last_error: Exception | None = None
        for candidate_year in (reference_year, reference_year - 1):
            try:
                return load_eurostat_actual_individual_consumption_price_levels(
                    tenant_id=tenant_id,
                    reference_year=candidate_year,
                    fetched_at=canonical_now,
                    fresh_until=fresh_until,
                    fetch_json=eurostat_client.fetch_json,
                )
            except Exception as exc:  # noqa: BLE001 - annual release can lag by one year
                last_error = exc
        assert last_error is not None
        raise last_error

    return run_automatic_compensation_refresh(
        active_conn,
        tenant_id=tenant_id,
        owner=owner,
        now=canonical_now,
        load_observations=load_observations,
        load_fx_rates=lambda: load_ecb_daily_exchange_rates(
            fetch_text=ecb_client.fetch_text,
        ),
        load_price_levels=load_price_levels,
    )


def run_automatic_compensation_refresh(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    owner: str,
    now: str,
    load_observations: ObservationLoader,
    load_fx_rates: FxLoader,
    load_price_levels: PriceLevelLoader,
    completion_clock: CompletionClock | None = None,
) -> AutomaticCompensationRefreshResult:
    """Refresh every missing or due country/role slice exactly once per run."""

    canonical_now = canonical_benchmark_timestamp(now, "now")
    fresh_until = _shift_timestamp(canonical_now, AUTOMATIC_REFRESH_INTERVAL)
    retry_at = _shift_timestamp(canonical_now, AUTOMATIC_REFRESH_RETRY_INTERVAL)
    lease_expires_at = _shift_timestamp(canonical_now, AUTOMATIC_REFRESH_LEASE_DURATION)
    strict_fresh_at = _shift_timestamp(canonical_now, timedelta(microseconds=1))
    state_repository = SqliteCompensationRefreshStateRepository(conn)
    benchmark_repository = SqliteCompensationBenchmarkRepository(conn)

    discovery = state_repository.discover_active_job_slices(tenant_id)
    state_repository.ensure_slices(discovery.slices, now=canonical_now)
    claimed = state_repository.claim_due(
        discovery.slices,
        owner=owner,
        now=canonical_now,
        lease_expires_at=lease_expires_at,
    )
    if not claimed:
        return AutomaticCompensationRefreshResult(
            status="skipped",
            jobs_considered=discovery.jobs_considered,
            slices_discovered=len(discovery.slices),
            slices_claimed=0,
            direct_results=0,
            extrapolated_results=0,
            level_fallback_results=0,
            insufficient_results=0,
            failed_results=0,
            observations_loaded=0,
            observations_rejected=0,
            direct_facts_saved=0,
            price_level_facts_saved=0,
        )

    warnings: set[str] = set()
    load_errors: list[str] = []
    targets = _levels_fyi_targets(tuple(lease.benchmark_slice for lease in claimed))
    try:
        source_load = load_observations(targets)
    except Exception:  # noqa: BLE001 - one source family must not fail discovery
        log.warning("Automatic compensation source loading failed")
        source_load = ReportedCompensationSourceLoad(observations=())
        load_errors.append("reported_sources_unavailable")
    load_errors.extend(source_load.source_errors)
    warnings.update(source_load.source_errors)

    needed_fx = {
        observation.currency.strip().upper()
        for observation in source_load.observations
        if observation.currency.strip().upper() != "EUR"
    }
    fx_rates: tuple[FxRateToEur, ...] = ()
    if needed_fx:
        try:
            fx_rates = load_fx_rates()
        except Exception:  # noqa: BLE001 - EUR evidence can still be retained
            log.warning("Automatic compensation FX loading failed")
            load_errors.append("ecb_fx_unavailable")
            warnings.add("ecb_fx_unavailable")

    batch = canonicalize_reported_observations(
        source_load.observations,
        tenant_id=tenant_id,
        fetched_at=canonical_now,
        fresh_until=fresh_until,
        fx_rates_to_eur=fx_rates,
    )
    rejection_reasons = {rejection.reason for rejection in batch.rejected}
    warnings.update(f"observation_{reason}" for reason in rejection_reasons)
    if "missing_fx_rate" in rejection_reasons:
        load_errors.append("ecb_fx_incomplete")

    direct_ids: set[str] = set()
    for fact in batch.facts:
        if (
            benchmark_repository.get_direct_by_evidence_hash(
                fact.tenant_id,
                fact.evidence_hash,
            )
            is None
        ):
            direct_ids.add(fact.fact_id)
        benchmark_repository.save_direct(fact)
    conn.commit()

    direct_matches = {
        benchmark_slice.key: _latest_direct_for_slice(
            benchmark_repository,
            benchmark_slice,
            fresh_at=strict_fresh_at,
        )
        for benchmark_slice in (lease.benchmark_slice for lease in claimed)
    }
    needs_price_levels = any(fact is None for fact in direct_matches.values())
    price_ids: set[str] = set()
    if needs_price_levels:
        try:
            for fact in load_price_levels():
                if fact.tenant_id != tenant_id:
                    raise ValueError("price-level facts must belong to the refresh tenant")
                if (
                    benchmark_repository.get_price_level_by_evidence_hash(
                        fact.tenant_id,
                        fact.evidence_hash,
                    )
                    is None
                ):
                    price_ids.add(fact.fact_id)
                benchmark_repository.save_price_level(fact)
            conn.commit()
        except Exception:  # noqa: BLE001 - direct facts remain independently usable
            conn.rollback()
            price_ids.clear()
            log.warning("Automatic compensation price-level loading failed")
            load_errors.append("eurostat_price_levels_unavailable")
            warnings.add("eurostat_price_levels_unavailable")

    direct_results = 0
    extrapolated_results = 0
    level_fallback_results = 0
    insufficient_results = 0
    failed_results = 0
    for lease in claimed:
        benchmark_slice = lease.benchmark_slice
        direct = direct_matches[benchmark_slice.key]
        if direct is not None:
            state_repository.mark_result(
                lease,
                completed_at=_completion_timestamp(completion_clock),
                next_refresh_at=min(fresh_until, direct.fresh_until),
                result_kind="direct",
                fact_id=direct.fact_id,
            )
            direct_results += 1
            level_fallback_results += int(direct.seniority_label != benchmark_slice.seniority_label)
            continue

        try:
            extrapolated, missing_reason = _derive_extrapolated_for_slice(
                benchmark_repository,
                benchmark_slice,
                derived_at=canonical_now,
                fresh_at=strict_fresh_at,
            )
            if extrapolated is not None:
                saved = benchmark_repository.save_extrapolated(extrapolated)
                state_repository.mark_result(
                    lease,
                    completed_at=_completion_timestamp(completion_clock),
                    next_refresh_at=min(fresh_until, saved.fresh_until),
                    result_kind="extrapolated",
                    fact_id=saved.fact_id,
                    actionable=saved.is_actionable,
                )
                extrapolated_results += 1
                level_fallback_results += int(saved.seniority_label != benchmark_slice.seniority_label)
                if not saved.is_actionable:
                    insufficient_results += 1
                    warnings.add("factor_out_of_bounds")
                continue
        except Exception:  # noqa: BLE001 - isolate independent benchmark slices
            conn.rollback()
            log.warning("Automatic compensation derivation failed for one benchmark slice")
            missing_reason = "benchmark_derivation_failed"
            load_errors.append(missing_reason)

        if load_errors:
            state_repository.mark_failed(
                lease,
                completed_at=_completion_timestamp(completion_clock),
                retry_at=retry_at,
                error_code=load_errors[0],
            )
            failed_results += 1
        else:
            state_repository.mark_insufficient(
                lease,
                completed_at=_completion_timestamp(completion_clock),
                next_refresh_at=fresh_until,
                error_code=missing_reason,
            )
            insufficient_results += 1

    if load_errors:
        warnings.update(load_errors)
    status: AutomaticRefreshStatus = (
        "completed_with_warnings" if warnings or insufficient_results or failed_results else "succeeded"
    )
    return AutomaticCompensationRefreshResult(
        status=status,
        jobs_considered=discovery.jobs_considered,
        slices_discovered=len(discovery.slices),
        slices_claimed=len(claimed),
        direct_results=direct_results,
        extrapolated_results=extrapolated_results,
        level_fallback_results=level_fallback_results,
        insufficient_results=insufficient_results,
        failed_results=failed_results,
        observations_loaded=len(source_load.observations),
        observations_rejected=len(batch.rejected),
        direct_facts_saved=len(direct_ids),
        price_level_facts_saved=len(price_ids),
        warnings=tuple(sorted(warnings)),
    )


def _latest_direct_for_slice(
    repository: SqliteCompensationBenchmarkRepository,
    benchmark_slice: CompensationBenchmarkSlice,
    *,
    fresh_at: str,
) -> DirectBenchmarkFact | None:
    seniorities = (
        (benchmark_slice.seniority_label,)
        if benchmark_slice.seniority_label == "unknown"
        else (benchmark_slice.seniority_label, "unknown")
    )
    for seniority in seniorities:
        fact = repository.latest_direct(
            tenant_id=benchmark_slice.tenant_id,
            taxonomy_version=benchmark_slice.taxonomy_version,
            role_family_code=benchmark_slice.role_family_code,
            seniority_label=seniority,
            geography=benchmark_slice.geography,
            component=benchmark_slice.component,
            fresh_at=fresh_at,
        )
        if fact is not None:
            return fact
    return None


def _derive_extrapolated_for_slice(
    repository: SqliteCompensationBenchmarkRepository,
    benchmark_slice: CompensationBenchmarkSlice,
    *,
    derived_at: str,
    fresh_at: str,
) -> tuple[ExtrapolatedBenchmarkFact | None, str]:
    anchors = repository.fresh_market_anchors(
        tenant_id=benchmark_slice.tenant_id,
        taxonomy_version=benchmark_slice.taxonomy_version,
        role_family_code=benchmark_slice.role_family_code,
        seniority_label=benchmark_slice.seniority_label,
        component=benchmark_slice.component,
        exclude_country_code=benchmark_slice.geography.country_code,
        fresh_at=fresh_at,
    )
    if not anchors:
        return None, "no_direct_anchor"

    candidates: list[tuple[ExtrapolatedBenchmarkFact, DirectBenchmarkFact]] = []
    for anchor in anchors:
        price_levels = repository.latest_compatible_price_levels(
            tenant_id=benchmark_slice.tenant_id,
            source_country_code=anchor.geography.country_code,
            target_country_code=benchmark_slice.geography.country_code,
            category=PRICE_LEVEL_CATEGORY,
            fresh_at=fresh_at,
        )
        if price_levels is None:
            continue
        source_price_level, target_price_level = price_levels
        company_pairs = repository.matched_company_pairs(
            tenant_id=benchmark_slice.tenant_id,
            taxonomy_version=anchor.taxonomy_version,
            role_family_code=anchor.role_family_code,
            seniority_label=anchor.seniority_label,
            component=anchor.component,
            source_country_code=anchor.geography.country_code,
            target_country_code=benchmark_slice.geography.country_code,
            fresh_at=fresh_at,
        )
        candidates.append(
            (
                extrapolate_benchmark(
                    anchor=anchor,
                    target_geography=benchmark_slice.geography,
                    source_price_level=source_price_level,
                    target_price_level=target_price_level,
                    company_pairs=company_pairs,
                    derived_at=derived_at,
                ),
                anchor,
            )
        )
    if not candidates:
        return None, "missing_compatible_price_levels"
    candidates.sort(
        key=lambda item: (
            item[0].is_actionable,
            item[0].seniority_label == benchmark_slice.seniority_label,
            item[0].confidence_score,
            item[0].matched_company_count,
            item[1].confidence_score,
            item[1].sample_count,
        ),
        reverse=True,
    )
    return candidates[0][0], ""


def _levels_fyi_targets(
    slices: tuple[CompensationBenchmarkSlice, ...],
) -> tuple[LevelsFyiPublicTarget, ...]:
    targets: dict[tuple[str, str], LevelsFyiPublicTarget] = {}
    for benchmark_slice in slices:
        key = (benchmark_slice.title_hint, benchmark_slice.geography.country_code)
        targets.setdefault(
            key,
            LevelsFyiPublicTarget(
                role_title=benchmark_slice.title_hint,
                location=benchmark_slice.geography.country_code,
            ),
        )
    return tuple(targets[key] for key in sorted(targets))


def _timestamp_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _shift_timestamp(value: str, delta: timedelta) -> str:
    shifted = _timestamp_datetime(value) + delta
    return canonical_benchmark_timestamp(shifted.isoformat(), "timestamp")


def _completion_timestamp(clock: CompletionClock | None) -> str:
    value = clock() if clock is not None else datetime.now(timezone.utc).isoformat()
    return canonical_benchmark_timestamp(value, "completed_at")


__all__ = [
    "AUTOMATIC_REFRESH_INTERVAL",
    "AutomaticCompensationRefreshResult",
    "refresh_automatic_compensation_benchmarks",
    "run_automatic_compensation_refresh",
]
