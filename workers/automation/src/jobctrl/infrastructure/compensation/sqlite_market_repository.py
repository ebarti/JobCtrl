"""SQLite repository for company-role reported compensation estimates."""

from __future__ import annotations

import csv
import json
import logging
import os
import re
import sqlite3
import urllib.parse
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable

from jobctrl.config import get_config_path
from jobctrl.domain.discovery.source_registry import (
    RobotsPolicy,
    SourcePolicy,
    SourcePolicyMethod,
)
from jobctrl.infrastructure.network import (
    GatewayHttpClient,
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
)
from jobctrl.infrastructure.compensation.levels_fyi_public import (
    DEFAULT_LEVELS_FYI_PUBLIC_MAX_PAGES,
    LevelsFyiPublicLoadOutcome,
    LevelsFyiPublicTarget,
    load_levels_fyi_public_observations,
)
from jobctrl.domain.compensation import (
    MarketCompensationEstimate,
    MarketConfidenceFactor,
    MarketEvidenceRow,
    MarketSourceProvenance,
    MarketSourceSnapshot,
    ReportedCompensationObservation,
    estimate_market_compensation,
    sanitize_market_source_snapshot,
)
from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.ports.events import EventHandler, Subscription
from jobctrl.domain.tenant import TenantId

SAFE_FACTOR_NAMES = frozenset(
    {"agreement", "company", "component", "freshness", "level", "location", "role", "sample", "trimodal_tier"}
)
SAFE_CONFIDENCE_BANDS = frozenset({"none", "low", "medium", "high"})
SAFE_SOURCE_IDS = frozenset(
    {"levels_fyi", "glassdoor", "manual_reported_compensation", "euro_top_tech", "posted_salary_text"}
)
SAFE_SOURCE_DISPLAY_NAMES = {
    "levels_fyi": "Levels.fyi",
    "glassdoor": "Glassdoor",
    "manual_reported_compensation": "Manual reported compensation import",
    "euro_top_tech": "Euro Top Tech",
    "posted_salary_text": "Job posting salary text",
}
SAFE_COMPONENTS = frozenset({"base_salary", "total_compensation"})
SAFE_COMPANY_TIERS = frozenset({"tier_1_local", "tier_2_ambitious", "tier_3_top_of_market", "unknown"})
SAFE_MATCH_SCOPES = frozenset(
    {
        "exact_company_role",
        "same_location_role_fallback",
        "company_adjacent_role",
        "tier_role_fallback",
        "market_baseline_fallback",
        "none",
    }
)
DEFAULT_FACTOR_REASON = "Reported compensation estimate factor recorded by the deterministic company-role estimator."
MAX_FACTOR_REASON_LENGTH = 240
UNSAFE_FACTOR_REASON_TERMS = (
    "/users/",
    "\\users\\",
    "file://",
    "rawproviderpayload",
    "credential",
    "secret",
    "token",
    "password",
    "api_key",
    "api key",
    "api-key",
    "private",
)
EURO_TOP_TECH_DATA_ENTRIES_URL = "https://www.eurotoptech.com/api/data-entries?sort=submitted&dir=desc"
EURO_TOP_TECH_ATTRIBUTION = "Euro Top Tech public crowdsourced compensation data (https://www.eurotoptech.com/data)"

# Compensation inputs are documented public pages/APIs or operator-configured
# licensed feeds, so robots is exempt (D2); the gateway still applies the
# honest UA, per-host pacing/concurrency, and a per-run request budget (R10).
COMPENSATION_FEED_POLICY = SourcePolicy(
    policy_id="compensation_feed",
    allowed_methods=(SourcePolicyMethod.FEED, SourcePolicyMethod.STATIC_PAGE),
    robots_policy=RobotsPolicy.EXEMPT_DOCUMENTED_API,
    max_requests_per_run=100,
)

JsonFeedFetcher = Callable[[str], Any]
TextFeedFetcher = Callable[[str, str | None], str | None]


def compensation_feed_client(
    gateway: PolitenessGateway,
    source_id: str,
    conn: sqlite3.Connection | None,
    run_id: str | None,
    opener: Any | None = None,
) -> GatewayHttpClient:
    session = PolitenessSession(
        gateway,
        policy=COMPENSATION_FEED_POLICY,
        budget=gateway.new_run_budget(COMPENSATION_FEED_POLICY.max_requests_per_run),
        context=PolitenessSourceContext(
            stage="compensation",
            source_id=source_id,
            source_role="compensation_feed",
            adapter="compensation_feed",
            run_id=run_id,
        ),
        recorder_conn=conn,
    )
    return GatewayHttpClient(session, opener=opener)


def _text_feed_fetcher(
    gateway: PolitenessGateway,
    source_id: str,
    conn: sqlite3.Connection | None,
    run_id: str | None,
    opener: Any | None = None,
) -> TextFeedFetcher:
    client = compensation_feed_client(gateway, source_id, conn, run_id, opener=opener)

    def fetch(url: str, auth_token: str | None) -> str | None:
        headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else None
        return client.fetch_text(url, extra_headers=headers)

    return fetch


def _levels_fyi_public_fetcher(
    gateway: PolitenessGateway,
    conn: sqlite3.Connection | None,
    run_id: str | None,
    opener: Any | None = None,
) -> Callable[[str], str | None]:
    client = compensation_feed_client(gateway, "levels_fyi", conn, run_id, opener=opener)

    def fetch(url: str) -> str | None:
        return client.fetch_text(url, extra_headers={"Accept-Encoding": "gzip"})

    return fetch


EURO_TOP_TECH_EUROPE_COUNTRIES = frozenset(
    {
        "albania",
        "andorra",
        "austria",
        "belarus",
        "belgium",
        "bosnia and herzegovina",
        "bulgaria",
        "croatia",
        "cyprus",
        "czech republic",
        "czechia",
        "denmark",
        "estonia",
        "finland",
        "france",
        "germany",
        "greece",
        "hungary",
        "iceland",
        "ireland",
        "italy",
        "latvia",
        "liechtenstein",
        "lithuania",
        "luxembourg",
        "malta",
        "moldova",
        "monaco",
        "montenegro",
        "netherlands",
        "north macedonia",
        "norway",
        "poland",
        "portugal",
        "romania",
        "serbia",
        "slovakia",
        "slovenia",
        "spain",
        "sweden",
        "switzerland",
        "ukraine",
        "united kingdom",
    }
)
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ReportedCompensationSourceLoad:
    observations: tuple[ReportedCompensationObservation, ...]
    local_count: int = 0
    levels_fyi_count: int = 0
    levels_fyi_public_count: int = 0
    glassdoor_count: int = 0
    euro_top_tech_count: int = 0
    source_errors: tuple[str, ...] = ()

    @property
    def licensed_count(self) -> int:
        return max(0, self.levels_fyi_count - self.levels_fyi_public_count) + self.glassdoor_count


@dataclass(frozen=True)
class EuroTopTechLoadOutcome:
    requested_pages: int
    parsed_pages: int

    @property
    def unavailable(self) -> bool:
        return self.requested_pages > 0 and self.parsed_pages == 0


class _BufferedEventPublisher:
    """Hold notifications until the canonical write has committed."""

    def __init__(self) -> None:
        self.events: list[DomainEvent] = []

    def publish(self, event: DomainEvent) -> None:
        self.events.append(event)

    def subscribe(
        self,
        _event_type: str | None,
        _handler: EventHandler,
    ) -> Subscription:
        raise RuntimeError("buffered event publisher does not accept subscriptions")


class SqliteMarketCompensationRepository:
    """SQLite-backed repository for canonical reported compensation estimates."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save_estimate(self, estimate: MarketCompensationEstimate) -> None:
        if estimate.estimate_state == "not_requested":
            raise ValueError("not_requested market estimates are read-side markers and must not be persisted")
        estimate = replace(estimate, job_id=canonical_job_id(str(estimate.job_id)))
        with self._atomic_event_write() as publisher:
            self._save_estimate_row(estimate)
            self._record_updated_event(estimate, publisher=publisher)

    def _save_estimate_row(self, estimate: MarketCompensationEstimate) -> None:
        self._conn.execute(
            """
            INSERT INTO job_market_compensation_estimates (
                tenant_id, job_id, estimate_state, currency, period, component,
                minimum_amount, maximum_amount, confidence_interval_minimum_amount,
                confidence_interval_maximum_amount, confidence_band, confidence_score,
                source_count, sample_count, aggregate_bucket, geography_scope,
                occupation_code, occupation_label, seniority_label, source_snapshot_json,
                factor_reasons_json, selected_evidence_json, insufficient_reasons_json, unsupported_reasons_json,
                source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
                company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_id) DO UPDATE SET
                estimate_state                    = excluded.estimate_state,
                currency                          = excluded.currency,
                period                            = excluded.period,
                component                         = excluded.component,
                minimum_amount                    = excluded.minimum_amount,
                maximum_amount                    = excluded.maximum_amount,
                confidence_interval_minimum_amount = excluded.confidence_interval_minimum_amount,
                confidence_interval_maximum_amount = excluded.confidence_interval_maximum_amount,
                confidence_band                   = excluded.confidence_band,
                confidence_score                  = excluded.confidence_score,
                source_count                      = excluded.source_count,
                sample_count                      = excluded.sample_count,
                aggregate_bucket                  = excluded.aggregate_bucket,
                geography_scope                   = excluded.geography_scope,
                occupation_code                   = excluded.occupation_code,
                occupation_label                  = excluded.occupation_label,
                seniority_label                   = excluded.seniority_label,
                source_snapshot_json              = excluded.source_snapshot_json,
                factor_reasons_json               = excluded.factor_reasons_json,
                selected_evidence_json            = excluded.selected_evidence_json,
                insufficient_reasons_json         = excluded.insufficient_reasons_json,
                unsupported_reasons_json          = excluded.unsupported_reasons_json,
                source_unavailable_reasons_json   = excluded.source_unavailable_reasons_json,
                warnings_json                     = excluded.warnings_json,
                estimator_version                 = excluded.estimator_version,
                estimated_at                      = excluded.estimated_at,
                company_name                      = excluded.company_name,
                normalized_company                = excluded.normalized_company,
                role_title                        = excluded.role_title,
                normalized_role                   = excluded.normalized_role,
                company_tier                      = excluded.company_tier,
                match_scope                       = excluded.match_scope
            """,
            (
                estimate.tenant_id,
                estimate.job_id,
                estimate.estimate_state,
                estimate.currency,
                estimate.period,
                estimate.component,
                estimate.minimum_amount,
                estimate.maximum_amount,
                estimate.confidence_interval_minimum_amount,
                estimate.confidence_interval_maximum_amount,
                estimate.confidence_band,
                estimate.confidence_score,
                estimate.source_count,
                estimate.sample_count,
                estimate.aggregate_bucket,
                estimate.geography_scope,
                estimate.occupation_code,
                estimate.occupation_label,
                estimate.seniority_label,
                json.dumps([_source_to_dict(source) for source in estimate.sources], sort_keys=True),
                json.dumps([_factor_to_dict(factor) for factor in estimate.factors], sort_keys=True),
                json.dumps([_evidence_to_dict(row) for row in estimate.evidence], sort_keys=True),
                json.dumps(list(estimate.insufficient_reasons), sort_keys=True),
                json.dumps(list(estimate.unsupported_reasons), sort_keys=True),
                json.dumps(list(estimate.source_unavailable_reasons), sort_keys=True),
                json.dumps(list(estimate.warnings), sort_keys=True),
                estimate.estimator_version,
                estimate.estimated_at,
                estimate.company_name,
                estimate.normalized_company,
                estimate.role_title,
                estimate.normalized_role,
                estimate.company_tier,
                estimate.match_scope,
            ),
        )

    def get_estimate(self, tenant_id: str, job_id: JobId) -> MarketCompensationEstimate | None:
        job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT tenant_id, job_id, estimate_state, currency, period, component,
                   minimum_amount, maximum_amount, confidence_interval_minimum_amount,
                   confidence_interval_maximum_amount, confidence_band, confidence_score,
                   source_count, sample_count, aggregate_bucket, geography_scope,
                   occupation_code, occupation_label, seniority_label, source_snapshot_json,
                   factor_reasons_json, selected_evidence_json, insufficient_reasons_json, unsupported_reasons_json,
                   source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
                   company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
            FROM job_market_compensation_estimates
            WHERE tenant_id = ? AND job_id = ?
            """,
            (tenant_id, job_id),
        ).fetchone()
        return _row_to_estimate(row) if row is not None else None

    def delete_estimate_if_owned_by(
        self,
        tenant_id: str,
        job_id: JobId,
        *,
        estimator_version_prefix: str,
        deleted_at: str,
    ) -> bool:
        """Clear a stale projection only when it belongs to the named estimator."""

        job_id = canonical_job_id(str(job_id))
        with self._atomic_event_write() as publisher:
            cursor = self._conn.execute(
                """
                DELETE FROM job_market_compensation_estimates
                WHERE tenant_id = ?
                  AND job_id = ?
                  AND estimator_version LIKE ?
                """,
                (tenant_id, job_id, f"{estimator_version_prefix}%"),
            )
            if cursor.rowcount != 1:
                return False
            self._record_cleared_event(
                tenant_id=tenant_id,
                job_id=job_id,
                cleared_at=deleted_at,
                publisher=publisher,
            )
            return True

    @contextmanager
    def _atomic_event_write(self) -> Iterator[_BufferedEventPublisher]:
        """Commit the canonical mutation and dirty event before notifying."""

        savepoint = "market_compensation_event_write"
        publisher = _BufferedEventPublisher()
        self._conn.execute(f"SAVEPOINT {savepoint}")
        try:
            yield publisher
        except BaseException:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise
        else:
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            self._conn.commit()
            from jobctrl.infrastructure.events import get_default_publisher

            destination = get_default_publisher()
            for event in publisher.events:
                destination.publish(event)

    def estimate_and_save_job(
        self,
        *,
        job_id: JobId,
        title: str,
        company: str | None,
        location: str | None,
        observations: tuple[ReportedCompensationObservation, ...],
        tenant_id: str = "local",
        component: str = "total_compensation",
        seniority_label: str | None = None,
        estimated_at: str | None = None,
    ) -> MarketCompensationEstimate:
        job_id = canonical_job_id(str(job_id))
        estimate = self._estimate_job(
            tenant_id=tenant_id,
            job_id=job_id,
            title=title,
            company=company,
            location=location,
            observations=observations,
            component=component,
            seniority_label=seniority_label,
            estimated_at=estimated_at,
        )
        self.save_estimate(estimate)
        return estimate

    def _estimate_job(
        self,
        *,
        job_id: JobId,
        title: str,
        company: str | None,
        location: str | None,
        observations: tuple[ReportedCompensationObservation, ...],
        tenant_id: str,
        component: str,
        seniority_label: str | None = None,
        estimated_at: str | None = None,
    ) -> MarketCompensationEstimate:
        job_id = canonical_job_id(str(job_id))
        posted_minimum, posted_maximum = self._posted_annualized_range(tenant_id, job_id)
        return estimate_market_compensation(
            tenant_id=tenant_id,
            job_id=job_id,
            title=title,
            company=company,
            location=location,
            component=component,
            seniority_label=seniority_label,
            observations=observations,
            posted_annualized_minimum=posted_minimum,
            posted_annualized_maximum=posted_maximum,
            estimated_at=estimated_at,
        )

    def backfill_from_jobs(
        self,
        observations: tuple[ReportedCompensationObservation, ...],
        *,
        tenant_id: str = "local",
        estimated_at: str | None = None,
        limit: int = 0,
        job_id: JobId | None = None,
    ) -> int:
        if job_id is not None:
            job_id = canonical_job_id(str(job_id))
        sql = "SELECT job_id, url, title, site, company, location FROM jobs WHERE tenant_id = ?"
        params: list[Any] = [tenant_id]
        if job_id:
            sql += " AND job_id = ?"
            params.append(job_id)
        sql += " ORDER BY url"
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        for row in rows:
            current_job_id = canonical_job_id(str(_row_value(row, "job_id")))
            title = str(_row_value(row, "title") or "")
            company = _nullable_str(_row_value(row, "company")) or _nullable_str(_row_value(row, "site"))
            location = _nullable_str(_row_value(row, "location"))
            estimate = self._estimate_job(
                tenant_id=tenant_id,
                job_id=current_job_id,
                title=title,
                company=company,
                location=location,
                observations=observations,
                component="total_compensation",
                estimated_at=estimated_at,
            )
            self.save_estimate(estimate)
        self._conn.commit()
        return len(rows)

    def _posted_annualized_range(self, tenant_id: str, job_id: JobId) -> tuple[int | None, int | None]:
        row = self._conn.execute(
            """
            SELECT annualized_minimum_amount, annualized_maximum_amount
            FROM job_posted_compensation_facts
            WHERE tenant_id = ? AND job_id = ?
            """,
            (tenant_id, job_id),
        ).fetchone()
        if row is None:
            return None, None
        return _nullable_int(_row_value(row, "annualized_minimum_amount")), _nullable_int(
            _row_value(row, "annualized_maximum_amount")
        )

    def _record_updated_event(
        self,
        estimate: MarketCompensationEstimate,
        *,
        publisher: _BufferedEventPublisher,
    ) -> None:
        from jobctrl.state import record_job_event

        record_job_event(
            self._conn,
            estimate.job_id,
            "enrich",
            "CompensationFactsUpdated",
            tenant_id=TenantId(estimate.tenant_id),
            message="Market compensation estimate updated",
            occurred_at=estimate.estimated_at,
            publisher=publisher,
            payload={
                "jobId": str(estimate.job_id),
                "changedSections": ["market"],
                "postedRecordStatus": None,
                "postedParseState": None,
                "marketRecordStatus": "recorded",
                "marketEstimateState": estimate.estimate_state,
                "updatedAt": estimate.estimated_at,
            },
        )

    def _record_cleared_event(
        self,
        *,
        tenant_id: str,
        job_id: JobId,
        cleared_at: str,
        publisher: _BufferedEventPublisher,
    ) -> None:
        from jobctrl.state import record_job_event

        record_job_event(
            self._conn,
            job_id,
            "enrich",
            "CompensationFactsUpdated",
            tenant_id=TenantId(tenant_id),
            message="Market compensation estimate cleared",
            occurred_at=cleared_at,
            publisher=publisher,
            payload={
                "jobId": str(job_id),
                "changedSections": ["market"],
                "postedRecordStatus": None,
                "postedParseState": None,
                "marketRecordStatus": "not_requested",
                "marketEstimateState": "not_requested",
                "updatedAt": cleared_at,
            },
        )


def load_reported_compensation_observations(
    path: Path | str,
    *,
    default_source_id: str | None = None,
) -> tuple[ReportedCompensationObservation, ...]:
    """Load Levels.fyi, Glassdoor, or manual reported compensation observations from JSON."""

    return _load_reported_compensation_payload(
        Path(path).read_text(encoding="utf-8"),
        default_source_id=default_source_id,
    )


def load_default_reported_compensation_observations(
    *,
    local_observations_path: Path | str | None = None,
    levels_fyi_targets: Iterable[LevelsFyiPublicTarget] = (),
    levels_fyi_public_max_pages: int = DEFAULT_LEVELS_FYI_PUBLIC_MAX_PAGES,
    include_eurotoptech: bool = True,
    eurotoptech_max_pages: int = 10,
    env: dict[str, str] | None = None,
    settings_path: Path | str | None = None,
    gateway: PolitenessGateway | None = None,
    recorder_conn: sqlite3.Connection | None = None,
    run_id: str | None = None,
    opener: Any | None = None,
    preserve_levels_fyi_source_currency: bool = False,
) -> ReportedCompensationSourceLoad:
    """Load every configured reported-compensation source for refresh paths.

    Every URL-backed feed fetches through the R10 politeness gateway (honest UA,
    per-host pacing, per-run budget). Robots is exempt for these documented /
    licensed feeds (D2); blocked/rate-limited outcomes are recorded when a
    ``recorder_conn`` is supplied.
    """

    source_env = _compensation_source_environment(
        env if env is not None else os.environ,
        settings_path=settings_path,
    )
    active_gateway = gateway if gateway is not None else PolitenessGateway()
    observations: list[ReportedCompensationObservation] = []
    source_errors: list[str] = []
    local = _load_optional_observation_ref(
        local_observations_path,
        default_source_id=None,
        text_fetch=_text_feed_fetcher(active_gateway, "local", recorder_conn, run_id, opener=opener),
    )
    levels_fyi_licensed = _load_configured_provider_observations(
        source_env,
        provider="levels_fyi",
        text_fetch=_text_feed_fetcher(active_gateway, "levels_fyi", recorder_conn, run_id, opener=opener),
        default_source_id="levels_fyi",
        access_var="JOBCTRL_LEVELS_FYI_ACCESS_MODE",
        permitted_access_modes={"licensed_api", "licensed_data_feed", "enterprise_mcp"},
        required_true_vars=("JOBCTRL_LEVELS_FYI_EUROPE_COVERAGE",),
        ref_vars=(
            "JOBCTRL_LEVELS_FYI_OBSERVATIONS_PATH",
            "JOBCTRL_LEVELS_FYI_OBSERVATIONS_JSON",
            "JOBCTRL_LEVELS_FYI_DATA_FEED_PATH",
            "JOBCTRL_LEVELS_FYI_OBSERVATIONS_URL",
            "JOBCTRL_LEVELS_FYI_DATA_FEED_URL",
        ),
        auth_token_vars=(
            "JOBCTRL_LEVELS_FYI_API_TOKEN",
            "JOBCTRL_LEVELS_FYI_API_KEY",
            "JOBCTRL_LEVELS_FYI_TOKEN",
        ),
        default_paths=(
            Path.home() / ".jobctrl" / "compensation" / "levels_fyi.json",
            Path.home() / ".jobctrl" / "compensation" / "levels_fyi.csv",
            Path.home() / ".jobctrl" / "compensation" / "levels-fyi.json",
            Path.home() / ".jobctrl" / "compensation" / "levels-fyi.csv",
        ),
    )
    levels_fyi_public_fetch = _levels_fyi_public_fetcher(
        active_gateway,
        recorder_conn,
        run_id,
        opener=opener,
    )
    levels_fyi_outcomes: list[LevelsFyiPublicLoadOutcome] = []
    levels_fyi_public = (
        load_levels_fyi_public_observations(
            levels_fyi_targets,
            fetch_text=levels_fyi_public_fetch,
            max_pages=levels_fyi_public_max_pages,
            preserve_source_currency=preserve_levels_fyi_source_currency,
            on_load_outcome=levels_fyi_outcomes.append,
        )
        if str(source_env.get("JOBCTRL_LEVELS_FYI_ACCESS_MODE") or "").strip().casefold() == "public_markdown"
        else ()
    )
    if any(outcome.unavailable for outcome in levels_fyi_outcomes):
        source_errors.append("levels_fyi_public_unavailable")
    levels_fyi = (*levels_fyi_public, *levels_fyi_licensed)
    glassdoor = _load_configured_provider_observations(
        source_env,
        provider="glassdoor",
        text_fetch=_text_feed_fetcher(active_gateway, "glassdoor", recorder_conn, run_id, opener=opener),
        default_source_id="glassdoor",
        access_var="JOBCTRL_GLASSDOOR_ACCESS_MODE",
        permitted_access_modes={"partner_api", "written_permission"},
        required_true_vars=(),
        ref_vars=(
            "JOBCTRL_GLASSDOOR_OBSERVATIONS_PATH",
            "JOBCTRL_GLASSDOOR_OBSERVATIONS_JSON",
            "JOBCTRL_GLASSDOOR_DATA_FEED_PATH",
            "JOBCTRL_GLASSDOOR_OBSERVATIONS_URL",
            "JOBCTRL_GLASSDOOR_DATA_FEED_URL",
        ),
        auth_token_vars=(
            "JOBCTRL_GLASSDOOR_API_TOKEN",
            "JOBCTRL_GLASSDOOR_API_KEY",
            "JOBCTRL_GLASSDOOR_TOKEN",
        ),
        default_paths=(
            Path.home() / ".jobctrl" / "compensation" / "glassdoor.json",
            Path.home() / ".jobctrl" / "compensation" / "glassdoor.csv",
        ),
    )
    if include_eurotoptech:
        eurotoptech_outcomes: list[EuroTopTechLoadOutcome] = []
        try:
            eurotoptech = load_euro_top_tech_observations(
                max_pages=eurotoptech_max_pages,
                http=compensation_feed_client(
                    active_gateway,
                    "euro_top_tech",
                    recorder_conn,
                    run_id,
                    opener=opener,
                ).fetch_json,
                on_load_outcome=eurotoptech_outcomes.append,
            )
        except Exception as exc:  # noqa: BLE001 - preserve other independent evidence
            log.warning("Euro Top Tech compensation feed could not be loaded: %s", exc)
            eurotoptech = ()
            source_errors.append("euro_top_tech_unavailable")
        if any(outcome.unavailable for outcome in eurotoptech_outcomes):
            source_errors.append("euro_top_tech_unavailable")
    else:
        eurotoptech = ()
    observations.extend(local)
    observations.extend(levels_fyi)
    observations.extend(glassdoor)
    observations.extend(eurotoptech)
    return ReportedCompensationSourceLoad(
        observations=tuple(observations),
        local_count=len(local),
        levels_fyi_count=len(levels_fyi),
        levels_fyi_public_count=len(levels_fyi_public),
        glassdoor_count=len(glassdoor),
        euro_top_tech_count=len(eurotoptech),
        source_errors=tuple(source_errors),
    )


def _compensation_source_environment(
    env: Mapping[str, str],
    *,
    settings_path: Path | str | None,
) -> dict[str, str]:
    """Translate config.json source preferences into loader runtime inputs."""

    effective = dict(env)
    for key in (
        "JOBCTRL_LEVELS_FYI_ACCESS_MODE",
        "JOBCTRL_LEVELS_FYI_EUROPE_COVERAGE",
        "JOBCTRL_GLASSDOOR_ACCESS_MODE",
    ):
        effective.pop(key, None)
    resolved_settings_path = Path(settings_path) if settings_path else get_config_path()
    preferences = _read_compensation_source_preferences(resolved_settings_path)
    _apply_compensation_source_preference(
        effective,
        preferences.get("levels_fyi"),
        access_var="JOBCTRL_LEVELS_FYI_ACCESS_MODE",
        coverage_var="JOBCTRL_LEVELS_FYI_EUROPE_COVERAGE",
    )
    _apply_compensation_source_preference(
        effective,
        preferences.get("glassdoor"),
        access_var="JOBCTRL_GLASSDOOR_ACCESS_MODE",
    )
    return effective


def _read_compensation_source_preferences(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    raw_sources = parsed.get("compensation_sources")
    if not isinstance(raw_sources, dict):
        return {}
    return {str(source_id): value for source_id, value in raw_sources.items() if isinstance(value, dict)}


def _apply_compensation_source_preference(
    env: dict[str, str],
    preference: dict[str, Any] | None,
    *,
    access_var: str,
    coverage_var: str | None = None,
) -> None:
    if preference is None or not isinstance(preference.get("enabled"), bool):
        return
    if not preference["enabled"]:
        env[access_var] = ""
        if coverage_var is not None:
            env[coverage_var] = "false"
        return

    access_mode = preference.get("access_mode")
    env[access_var] = str(access_mode or "").strip()
    if coverage_var is not None:
        coverage = preference.get("europe_coverage_confirmed", False)
        env[coverage_var] = "true" if coverage is True else "false"


def _load_reported_compensation_payload(
    text: str,
    *,
    default_source_id: str | None,
    source_provenance: MarketSourceProvenance | None = None,
) -> tuple[ReportedCompensationObservation, ...]:
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return _load_reported_compensation_csv(
            text,
            default_source_id=default_source_id,
            source_provenance=source_provenance,
        )
    items = raw.get("observations", raw) if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        raise ValueError("reported compensation JSON must be a list or an object with an observations list")
    observations = []
    for item in items:
        if not isinstance(item, dict):
            continue
        observation = _observation_from_dict(
            item,
            default_source_id=default_source_id,
            source_provenance=source_provenance,
        )
        if observation is not None:
            observations.append(observation)
    return tuple(observations)


def _load_reported_compensation_csv(
    text: str,
    *,
    default_source_id: str | None,
    source_provenance: MarketSourceProvenance | None = None,
) -> tuple[ReportedCompensationObservation, ...]:
    observations: list[ReportedCompensationObservation] = []
    for item in csv.DictReader(text.splitlines()):
        observation = _observation_from_dict(
            item,
            default_source_id=default_source_id,
            source_provenance=source_provenance,
        )
        if observation is not None:
            observations.append(observation)
    return tuple(observations)


def _load_optional_observation_ref(
    ref: Path | str | None,
    *,
    default_source_id: str | None,
    text_fetch: TextFeedFetcher,
) -> tuple[ReportedCompensationObservation, ...]:
    if ref is None or str(ref).strip() == "":
        return ()
    return _load_observation_ref(
        str(ref),
        default_source_id=default_source_id,
        source_provenance=None,
        auth_token=None,
        text_fetch=text_fetch,
    )


def _load_configured_provider_observations(
    env: dict[str, str],
    *,
    provider: str,
    text_fetch: TextFeedFetcher,
    default_source_id: str,
    access_var: str,
    permitted_access_modes: set[str],
    required_true_vars: tuple[str, ...],
    ref_vars: tuple[str, ...],
    auth_token_vars: tuple[str, ...],
    default_paths: tuple[Path, ...],
) -> tuple[ReportedCompensationObservation, ...]:
    access_mode = str(env.get(access_var) or "").strip().casefold()
    if access_mode not in permitted_access_modes:
        return ()
    if any(not _truthy(env.get(var)) for var in required_true_vars):
        return ()

    refs: list[str] = []
    for var in ref_vars:
        value = str(env.get(var) or "").strip()
        if value:
            refs.extend(item.strip() for item in re.split(r"[,;]", value) if item.strip())
    refs.extend(str(path) for path in default_paths if path.exists())
    if not refs:
        return ()

    auth_token = next(
        (str(env.get(var) or "").strip() for var in auth_token_vars if str(env.get(var) or "").strip()), None
    )
    observations: list[ReportedCompensationObservation] = []
    for ref in refs:
        try:
            observations.extend(
                _load_observation_ref(
                    ref,
                    default_source_id=default_source_id,
                    source_provenance="licensed",
                    auth_token=auth_token,
                    text_fetch=text_fetch,
                )
            )
        except Exception as exc:  # noqa: BLE001 - one unavailable licensed feed should not block refresh
            log.warning("%s reported compensation feed could not be loaded from %s: %s", provider, ref, exc)
    return tuple(row for row in observations if row.source_id == provider)


def _load_observation_ref(
    ref: str,
    *,
    default_source_id: str | None,
    source_provenance: MarketSourceProvenance | None,
    auth_token: str | None,
    text_fetch: TextFeedFetcher,
) -> tuple[ReportedCompensationObservation, ...]:
    if _is_url(ref):
        body = text_fetch(ref, auth_token)
        if body is None:
            # Gateway blocked / rate-limited the feed; recorded as an outcome.
            return ()
        return _load_reported_compensation_payload(
            body,
            default_source_id=default_source_id,
            source_provenance=source_provenance,
        )

    path = Path(ref).expanduser()
    if path.is_dir():
        observations: list[ReportedCompensationObservation] = []
        for child in sorted(path.iterdir()):
            if child.suffix.casefold() not in {".csv", ".json"}:
                continue
            observations.extend(
                _load_reported_compensation_payload(
                    child.read_text(encoding="utf-8"),
                    default_source_id=default_source_id,
                    source_provenance=source_provenance,
                )
            )
        return tuple(observations)
    return _load_reported_compensation_payload(
        path.read_text(encoding="utf-8"),
        default_source_id=default_source_id,
        source_provenance=source_provenance,
    )


def _is_url(value: str) -> bool:
    return urllib.parse.urlsplit(value).scheme in {"http", "https"}


def _truthy(value: Any) -> bool:
    return str(value or "").strip().casefold() in {"1", "true", "yes", "on"}


def load_euro_top_tech_observations(
    *,
    url: str = EURO_TOP_TECH_DATA_ENTRIES_URL,
    max_pages: int = 10,
    http: JsonFeedFetcher | None = None,
    on_load_outcome: Callable[[EuroTopTechLoadOutcome], None] | None = None,
) -> tuple[ReportedCompensationObservation, ...]:
    """Load public Euro Top Tech approved data-entry rows as compensation observations.

    ``http`` is a gateway-routed JSON fetcher (``(url) -> dict | None``). When
    omitted a default politeness gateway is used so this public API is fetched
    with the honest UA, per-host pacing, and a per-run budget (R10). A ``None``
    payload means the gateway blocked the page; loaded rows are kept.
    """

    fetch = (
        http
        if http is not None
        else compensation_feed_client(
            PolitenessGateway(),
            "euro_top_tech",
            None,
            None,
        ).fetch_json
    )
    observations: list[ReportedCompensationObservation] = []
    next_url: str | None = url
    seen_urls: set[str] = set()
    pages = 0
    requested_pages = 0
    parsed_pages = 0
    while next_url and pages < max(0, max_pages) and next_url not in seen_urls:
        seen_urls.add(next_url)
        requested_pages += 1
        try:
            payload = fetch(next_url)
        except Exception:
            if observations:
                break
            raise
        if not isinstance(payload, dict):
            break
        rows = payload.get("rows")
        if not isinstance(rows, list):
            break
        parsed_pages += 1
        for item in rows:
            if isinstance(item, dict) and (observation := _euro_top_tech_observation(item)) is not None:
                observations.append(observation)
        pages += 1
        cursor = payload.get("nextCursor") if payload.get("hasMore") else None
        next_url = _cursor_url(url, str(cursor)) if cursor else None
    if on_load_outcome is not None:
        on_load_outcome(
            EuroTopTechLoadOutcome(
                requested_pages=requested_pages,
                parsed_pages=parsed_pages,
            )
        )
    return tuple(observations)


def _cursor_url(base_url: str, cursor: str) -> str:
    parts = urllib.parse.urlsplit(base_url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    query = [(key, value) for key, value in query if key != "cursor"]
    query.append(("cursor", cursor))
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(query), parts.fragment)
    )


def _euro_top_tech_observation(data: dict[str, Any]) -> ReportedCompensationObservation | None:
    amount = _nullable_int(data.get("preTaxTC"))
    country = _text(data.get("country"), default=None)
    if amount is None or amount < 10_000 or country is None or country.casefold() not in EURO_TOP_TECH_EUROPE_COUNTRIES:
        return None
    role = _text(data.get("jobTitle"), default=None) or _role_from_euro_top_tech_seniority(data.get("seniority"))
    level = _text(data.get("seniority"), default=None)
    submitted_month = _text(data.get("submittedMonth"), default=None)
    return ReportedCompensationObservation(
        source_id="euro_top_tech",
        source_provenance="public",
        company_name=_text(data.get("company"), default=None) or "Euro Top Tech community",
        role_title=role,
        minimum_amount=amount,
        maximum_amount=amount,
        currency="EUR",
        period="year",
        component="total_compensation",
        location=_euro_top_tech_location(data),
        level_label=level,
        company_tier="unknown",
        release_year=_year(submitted_month),
        snapshot_version=_euro_top_tech_snapshot_version(submitted_month),
        sample_count=1,
        attribution=EURO_TOP_TECH_ATTRIBUTION,
        source_url="https://www.eurotoptech.com/data",
    )


def _role_from_euro_top_tech_seniority(value: Any) -> str:
    text = str(value or "").strip()
    return f"{text} Software Engineer" if text else "Software Engineer"


def _euro_top_tech_location(data: dict[str, Any]) -> str:
    country = _text(data.get("country"), default="")
    city = _text(data.get("city"), default="")
    if city and country:
        return f"{city}, {country}"
    return str(country or city or "Europe")


def _euro_top_tech_snapshot_version(submitted_month: str | None) -> str:
    text = str(submitted_month or "").strip()
    return f"eurotoptech-data-{text}" if re.fullmatch(r"\d{4}-\d{2}", text) else "eurotoptech-data-public"


def _observation_from_dict(
    data: dict[str, Any],
    *,
    default_source_id: str | None = None,
    source_provenance: MarketSourceProvenance | None = None,
) -> ReportedCompensationObservation | None:
    source_id = _source_id(_pick(data, "source_id", "sourceId", "source") or default_source_id)
    company = _text(_pick(data, "company_name", "companyName", "company"))
    role = _text(_pick(data, "role_title", "roleTitle", "title", "role"))
    minimum = _money(
        _pick(
            data,
            "minimum_amount",
            "minimumAmount",
            "min",
            "total_compensation_min",
            "totalCompensationMin",
            "base_salary_min",
            "baseSalaryMin",
        )
    )
    maximum = _money(
        _pick(
            data,
            "maximum_amount",
            "maximumAmount",
            "max",
            "total_compensation_max",
            "totalCompensationMax",
            "base_salary_max",
            "baseSalaryMax",
        )
    )
    if minimum is None and maximum is None:
        amount = _money(_pick(data, "amount", "total_compensation", "totalCompensation", "base_salary", "baseSalary"))
        minimum = amount
        maximum = amount
    if not source_id or not company or not role:
        return None
    return ReportedCompensationObservation(
        source_id=source_id,
        source_provenance=source_provenance or _default_source_provenance(source_id),
        company_name=company,
        role_title=role,
        minimum_amount=minimum,
        maximum_amount=maximum,
        currency=_text(_pick(data, "currency"), default="EUR").upper(),
        period=_period(_pick(data, "period")),
        component=_component(_pick(data, "component")),
        location=_text(_pick(data, "location", "geo", "geography"), default=None),
        level_label=_text(_pick(data, "level_label", "levelLabel", "level", "seniority"), default=None),
        company_tier=_company_tier(_pick(data, "company_tier", "companyTier", "tier")),
        release_year=_nullable_int(_pick(data, "release_year", "releaseYear", "reported_year", "reportedYear")),
        snapshot_version=_text(
            _pick(data, "snapshot_version", "snapshotVersion"), default="reported-compensation-import-v1"
        ),
        sample_count=_nullable_int(_pick(data, "sample_count", "sampleCount", "samples")),
        attribution=_text(_pick(data, "attribution"), default=None),
        source_url=_safe_evidence_url(
            _pick(
                data,
                "source_url",
                "sourceUrl",
                "url",
                "record_url",
                "recordUrl",
                "profile_url",
                "profileUrl",
                "evidence_url",
                "evidenceUrl",
            )
        ),
    )


def _row_to_estimate(row: sqlite3.Row | tuple[Any, ...]) -> MarketCompensationEstimate:
    return MarketCompensationEstimate(
        tenant_id=str(_row_value(row, "tenant_id")),
        job_id=canonical_job_id(str(_row_value(row, "job_id"))),
        estimate_state=_row_value(row, "estimate_state"),  # type: ignore[arg-type]
        currency=_nullable_str(_row_value(row, "currency")),
        period=_row_value(row, "period"),  # type: ignore[arg-type]
        component=_component(_row_value(row, "component")),
        minimum_amount=_nullable_int(_row_value(row, "minimum_amount")),
        maximum_amount=_nullable_int(_row_value(row, "maximum_amount")),
        confidence_interval_minimum_amount=_nullable_int(_row_value(row, "confidence_interval_minimum_amount")),
        confidence_interval_maximum_amount=_nullable_int(_row_value(row, "confidence_interval_maximum_amount")),
        confidence_band=_confidence_band(_row_value(row, "confidence_band")),  # type: ignore[arg-type]
        confidence_score=float(_row_value(row, "confidence_score") or 0),
        source_count=int(_row_value(row, "source_count") or 0),
        sample_count=_nullable_int(_row_value(row, "sample_count")),
        aggregate_bucket=_safe_metadata_text(_row_value(row, "aggregate_bucket")),
        geography_scope=_safe_metadata_text(_row_value(row, "geography_scope")),
        occupation_code=_nullable_str(_row_value(row, "occupation_code")),
        occupation_label=_nullable_str(_row_value(row, "occupation_label")),
        seniority_label=_nullable_str(_row_value(row, "seniority_label")),
        sources=tuple(
            source
            for item in _json_list(_row_value(row, "source_snapshot_json"))
            if (source := _source_from_dict(item)) is not None
        ),
        factors=tuple(
            factor
            for item in _json_list(_row_value(row, "factor_reasons_json"))
            if (factor := _factor_from_dict(item)) is not None
        ),
        evidence=tuple(
            evidence
            for item in _json_list(_row_value(row, "selected_evidence_json"))
            if (evidence := _evidence_from_dict(item)) is not None
        ),
        insufficient_reasons=tuple(str(item) for item in _json_list(_row_value(row, "insufficient_reasons_json"))),
        unsupported_reasons=tuple(str(item) for item in _json_list(_row_value(row, "unsupported_reasons_json"))),
        source_unavailable_reasons=tuple(
            str(item) for item in _json_list(_row_value(row, "source_unavailable_reasons_json"))
        ),
        warnings=tuple(str(item) for item in _json_list(_row_value(row, "warnings_json"))),
        estimator_version=str(_row_value(row, "estimator_version")),
        estimated_at=str(_row_value(row, "estimated_at")),
        company_name=_nullable_str(_row_value(row, "company_name")),
        normalized_company=_nullable_str(_row_value(row, "normalized_company")),
        role_title=_nullable_str(_row_value(row, "role_title")),
        normalized_role=_nullable_str(_row_value(row, "normalized_role")),
        company_tier=_company_tier(_row_value(row, "company_tier")),
        match_scope=_match_scope(_row_value(row, "match_scope")),
    )


def _source_to_dict(source: MarketSourceSnapshot) -> dict[str, Any]:
    source = sanitize_market_source_snapshot(source)
    return {
        "source_id": source.source_id,
        "source_provenance": source.source_provenance,
        "display_name": source.display_name,
        "source_type": source.source_type,
        "release_year": source.release_year,
        "snapshot_version": source.snapshot_version,
        "geography_scope": source.geography_scope,
        "aggregate_bucket": source.aggregate_bucket,
        "attribution": source.attribution,
        "sample_count": source.sample_count,
    }


def _source_from_dict(value: Any) -> MarketSourceSnapshot | None:
    data = value if isinstance(value, dict) else {}
    source_id = _source_id(data.get("source_id"))
    if source_id is None:
        return None
    return sanitize_market_source_snapshot(
        MarketSourceSnapshot(
            source_id=source_id,
            source_provenance=_source_provenance(data.get("source_provenance"), source_id),
            display_name=str(data.get("display_name") or ""),
            source_type=_source_type(source_id),
            release_year=_nullable_int(data.get("release_year")),
            snapshot_version=str(data.get("snapshot_version") or ""),
            geography_scope=str(data.get("geography_scope") or ""),
            aggregate_bucket=str(data.get("aggregate_bucket") or ""),
            attribution=str(data.get("attribution") or ""),
            sample_count=_nullable_int(data.get("sample_count")),
        )
    )


def _evidence_to_dict(row: MarketEvidenceRow) -> dict[str, Any]:
    return {
        "source_id": row.source_id,
        "display_name": row.display_name,
        "source_url": _safe_evidence_url(row.source_url),
        "company_name": row.company_name,
        "role_title": row.role_title,
        "location": row.location,
        "level_label": row.level_label,
        "company_tier": row.company_tier,
        "component": row.component,
        "currency": row.currency,
        "period": row.period,
        "minimum_amount": row.minimum_amount,
        "maximum_amount": row.maximum_amount,
        "sample_count": row.sample_count,
        "release_year": row.release_year,
        "company_score": row.company_score,
        "role_score": row.role_score,
        "level_score": row.level_score,
        "location_score": row.location_score,
        "freshness_score": row.freshness_score,
    }


def _evidence_from_dict(value: Any) -> MarketEvidenceRow | None:
    data = value if isinstance(value, dict) else {}
    source_id = _source_id(data.get("source_id"))
    if source_id is None:
        return None
    minimum_amount = _nullable_int(data.get("minimum_amount"))
    maximum_amount = _nullable_int(data.get("maximum_amount"))
    if minimum_amount is None and maximum_amount is None:
        return None
    if minimum_amount is None:
        minimum_amount = maximum_amount
    if maximum_amount is None:
        maximum_amount = minimum_amount
    return MarketEvidenceRow(
        source_id=source_id,
        display_name=_display_name(source_id),
        source_url=_safe_evidence_url(data.get("source_url")),
        company_name=_safe_evidence_text(data.get("company_name")) or "unknown company",
        role_title=_safe_evidence_text(data.get("role_title")) or "unknown role",
        location=_safe_evidence_text(data.get("location")),
        level_label=_safe_evidence_text(data.get("level_label")),
        company_tier=_company_tier(data.get("company_tier")),
        component=_component(data.get("component")),
        currency=_currency(data.get("currency")),
        period=_period(data.get("period")),
        minimum_amount=minimum_amount or 0,
        maximum_amount=maximum_amount or 0,
        sample_count=_nullable_int(data.get("sample_count")),
        release_year=_nullable_int(data.get("release_year")),
        company_score=_score(data.get("company_score")),
        role_score=_score(data.get("role_score")),
        level_score=_score(data.get("level_score")),
        location_score=_score(data.get("location_score")),
        freshness_score=_score(data.get("freshness_score")),
    )


def _factor_to_dict(factor: MarketConfidenceFactor) -> dict[str, Any]:
    return {
        "name": factor.name,
        "score": factor.score,
        "band": factor.band,
        "reason": factor.reason,
    }


def _factor_from_dict(value: Any) -> MarketConfidenceFactor | None:
    data = value if isinstance(value, dict) else {}
    name = str(data.get("name") or "")
    if name not in SAFE_FACTOR_NAMES:
        return None
    return MarketConfidenceFactor(
        name=name,  # type: ignore[arg-type]
        score=float(data.get("score") or 0),
        band=_confidence_band(data.get("band")),  # type: ignore[arg-type]
        reason=_safe_factor_reason(data.get("reason")),
    )


def _safe_factor_reason(value: Any) -> str:
    if not isinstance(value, str):
        return DEFAULT_FACTOR_REASON
    text = " ".join(value.split())
    if not text:
        return DEFAULT_FACTOR_REASON
    lowered = text.casefold()
    if any(term in lowered for term in UNSAFE_FACTOR_REASON_TERMS):
        return DEFAULT_FACTOR_REASON
    if len(text) > MAX_FACTOR_REASON_LENGTH:
        return text[: MAX_FACTOR_REASON_LENGTH - 3].rstrip() + "..."
    return text


def _pick(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return None


def _source_id(value: Any) -> Any:
    text = str(value or "").strip().casefold().replace("-", "_").replace(".", "_")
    aliases = {
        "levels": "levels_fyi",
        "levels_fyi": "levels_fyi",
        "levels_fyi_reported_compensation": "levels_fyi",
        "glassdoor": "glassdoor",
        "glassdoor_reported_compensation": "glassdoor",
        "manual": "manual_reported_compensation",
        "manual_reported_compensation": "manual_reported_compensation",
        "eurotoptech": "euro_top_tech",
        "euro_top_tech": "euro_top_tech",
        "euro_top_tech_reported_compensation": "euro_top_tech",
        "posted_salary_text": "posted_salary_text",
        "posted_salary": "posted_salary_text",
        "job_posting_salary_text": "posted_salary_text",
    }
    source_id = aliases.get(text)
    return source_id if source_id in SAFE_SOURCE_IDS else None


def _source_type(source_id: str) -> Any:
    return "posted_salary" if source_id == "posted_salary_text" else "reported_compensation"


def _default_source_provenance(source_id: str) -> MarketSourceProvenance:
    if source_id == "levels_fyi" or source_id == "glassdoor":
        return "licensed"
    if source_id == "euro_top_tech":
        return "public"
    if source_id == "posted_salary_text":
        return "employer_posted"
    return "manual"


def _source_provenance(value: Any, source_id: str) -> MarketSourceProvenance:
    text = str(value or "").strip().casefold()
    if source_id == "levels_fyi" and text in {"public", "licensed"}:
        return text  # type: ignore[return-value]
    return _default_source_provenance(source_id)


def _display_name(source_id: str) -> str:
    return SAFE_SOURCE_DISPLAY_NAMES.get(source_id, "Manual reported compensation import")


def _score(value: Any) -> float:
    try:
        score = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return round(max(0.0, min(1.0, score)), 2)


def _currency(value: Any) -> str:
    text = str(value or "EUR").strip().upper()
    return text if re.fullmatch(r"[A-Z]{3}", text) else "EUR"


def _year(value: Any) -> int | None:
    try:
        return int(str(value or "")[:4])
    except ValueError:
        return None


def _company_tier(value: Any) -> Any:
    text = str(value or "").strip().casefold().replace("-", "_").replace(" ", "_")
    if text in {"tier_1", "tier_1_local", "local", "local_market"}:
        return "tier_1_local"
    if text in {"tier_2", "tier_2_ambitious", "ambitious", "scaleup", "regional"}:
        return "tier_2_ambitious"
    if text in {"tier_3", "tier_3_top_of_market", "top_of_market", "global", "big_tech"}:
        return "tier_3_top_of_market"
    return "unknown"


def _match_scope(value: Any) -> Any:
    text = str(value or "").strip().casefold()
    return text if text in SAFE_MATCH_SCOPES else "none"


def _component(value: Any) -> Any:
    text = str(value or "total_compensation").strip().casefold()
    return text if text in SAFE_COMPONENTS else "total_compensation"


def _period(value: Any) -> Any:
    text = str(value or "year").strip().casefold()
    return text if text in {"year", "month"} else "year"


def _confidence_band(value: Any) -> Any:
    text = str(value or "none").strip().casefold()
    return text if text in SAFE_CONFIDENCE_BANDS else "none"


def _money(value: Any) -> int | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value)
    match = re.search(r"\d[\d,._ ]*", text)
    if not match:
        return None
    digits = re.sub(r"[^0-9]", "", match.group(0))
    return int(digits) if digits else None


def _text(value: Any, default: str | None = "") -> str | None:
    if value in (None, ""):
        return default
    text = str(value).strip()
    return text if text else default


def _safe_metadata_text(value: Any) -> str | None:
    text = _text(value, default=None)
    if text is None:
        return None
    lowered = text.casefold()
    if any(
        pattern in lowered
        for pattern in ("rawproviderpayload", "credential", "secret", "/users/", "\\users\\", "private")
    ):
        return None
    return text


def _safe_evidence_text(value: Any) -> str | None:
    text = _safe_metadata_text(value)
    if text is None:
        return None
    compact = " ".join(text.split())
    return compact[:160] if compact else None


def _safe_evidence_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        return None
    lowered = text.casefold()
    if any(term in lowered for term in UNSAFE_FACTOR_REASON_TERMS):
        return None
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def _json_list(value: Any) -> list[Any]:
    try:
        parsed = json.loads(str(value or "[]"))
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _row_value(row: sqlite3.Row | tuple[Any, ...], key: str) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[key]
    keys = (
        "tenant_id",
        "job_id",
        "estimate_state",
        "currency",
        "period",
        "component",
        "minimum_amount",
        "maximum_amount",
        "confidence_interval_minimum_amount",
        "confidence_interval_maximum_amount",
        "confidence_band",
        "confidence_score",
        "source_count",
        "sample_count",
        "aggregate_bucket",
        "geography_scope",
        "occupation_code",
        "occupation_label",
        "seniority_label",
        "source_snapshot_json",
        "factor_reasons_json",
        "selected_evidence_json",
        "insufficient_reasons_json",
        "unsupported_reasons_json",
        "source_unavailable_reasons_json",
        "warnings_json",
        "estimator_version",
        "estimated_at",
        "company_name",
        "normalized_company",
        "role_title",
        "normalized_role",
        "company_tier",
        "match_scope",
    )
    return row[keys.index(key)]


def _nullable_str(value: Any) -> str | None:
    return None if value is None else str(value)


def _nullable_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    return int(value)
