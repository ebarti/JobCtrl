"""SQLite repository for company-role reported compensation estimates."""

from __future__ import annotations

import csv
import json
import logging
import os
import re
import sqlite3
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jobhunter.database import ensure_market_compensation_tables
from jobhunter.domain.compensation import (
    MarketCompensationEstimate,
    MarketConfidenceFactor,
    MarketSourceSnapshot,
    ReportedCompensationObservation,
    estimate_market_compensation,
    sanitize_market_source_snapshot,
)

SAFE_FACTOR_NAMES = frozenset(
    {"agreement", "company", "component", "freshness", "level", "location", "role", "sample", "trimodal_tier"}
)
SAFE_CONFIDENCE_BANDS = frozenset({"none", "low", "medium", "high"})
SAFE_SOURCE_IDS = frozenset(
    {"levels_fyi", "glassdoor", "manual_reported_compensation", "euro_top_tech", "posted_salary_text"}
)
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
)
EURO_TOP_TECH_DATA_ENTRIES_URL = "https://www.eurotoptech.com/api/data-entries?sort=submitted&dir=desc"
EURO_TOP_TECH_ATTRIBUTION = "Euro Top Tech public crowdsourced compensation data (https://www.eurotoptech.com/data)"
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
EUR_NORMALIZATION_RATES = {
    "EUR": 1,
    "USD": 0.92,
    "GBP": 1.17,
    "CHF": 1.06,
    "SEK": 0.09,
    "NOK": 0.087,
    "DKK": 0.134,
    "PLN": 0.235,
    "CZK": 0.041,
}
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ReportedCompensationSourceLoad:
    observations: tuple[ReportedCompensationObservation, ...]
    local_count: int = 0
    levels_fyi_count: int = 0
    glassdoor_count: int = 0
    euro_top_tech_count: int = 0

    @property
    def licensed_count(self) -> int:
        return self.levels_fyi_count + self.glassdoor_count


class SqliteMarketCompensationRepository:
    """SQLite-backed repository for canonical reported compensation estimates."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_market_compensation_tables(conn)

    def save_estimate(self, estimate: MarketCompensationEstimate) -> None:
        if estimate.estimate_state == "not_requested":
            raise ValueError("not_requested market estimates are read-side markers and must not be persisted")
        self._conn.execute(
            """
            INSERT INTO job_market_compensation_estimates (
                tenant_id, job_url, estimate_state, currency, period, component,
                minimum_amount, maximum_amount, confidence_interval_minimum_amount,
                confidence_interval_maximum_amount, confidence_band, confidence_score,
                source_count, sample_count, aggregate_bucket, geography_scope,
                occupation_code, occupation_label, seniority_label, source_snapshot_json,
                factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
                source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
                company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_url) DO UPDATE SET
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
                estimate.job_url,
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
        self._conn.commit()
        self._record_updated_event(estimate)

    def get_estimate(self, tenant_id: str, job_url: str) -> MarketCompensationEstimate | None:
        row = self._conn.execute(
            """
            SELECT tenant_id, job_url, estimate_state, currency, period, component,
                   minimum_amount, maximum_amount, confidence_interval_minimum_amount,
                   confidence_interval_maximum_amount, confidence_band, confidence_score,
                   source_count, sample_count, aggregate_bucket, geography_scope,
                   occupation_code, occupation_label, seniority_label, source_snapshot_json,
                   factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
                   source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
                   company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
            FROM job_market_compensation_estimates
            WHERE tenant_id = ? AND job_url = ?
            """,
            (tenant_id, job_url),
        ).fetchone()
        return _row_to_estimate(row) if row is not None else None

    def estimate_and_save_job(
        self,
        *,
        job_url: str,
        title: str,
        company: str | None,
        location: str | None,
        observations: tuple[ReportedCompensationObservation, ...],
        tenant_id: str = "local",
        component: str = "total_compensation",
        seniority_label: str | None = None,
        estimated_at: str | None = None,
    ) -> MarketCompensationEstimate:
        estimate = self._estimate_job(
            tenant_id=tenant_id,
            job_url=job_url,
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
        job_url: str,
        title: str,
        company: str | None,
        location: str | None,
        observations: tuple[ReportedCompensationObservation, ...],
        tenant_id: str,
        component: str,
        seniority_label: str | None = None,
        estimated_at: str | None = None,
    ) -> MarketCompensationEstimate:
        posted_minimum, posted_maximum = self._posted_annualized_range(tenant_id, job_url)
        return estimate_market_compensation(
            tenant_id=tenant_id,
            job_url=job_url,
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
        job_url: str | None = None,
    ) -> int:
        posted_observations = self._posted_salary_observations(tenant_id=tenant_id, job_url=job_url)
        sql = "SELECT url, title, site, company, location FROM jobs"
        params: list[Any] = []
        if job_url:
            sql += " WHERE url = ?"
            params.append(job_url)
        sql += " ORDER BY url"
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        for row in rows:
            current_job_url = str(_row_value(row, "url"))
            title = str(_row_value(row, "title") or "")
            company = _nullable_str(_row_value(row, "company")) or _nullable_str(_row_value(row, "site"))
            location = _nullable_str(_row_value(row, "location"))
            estimate: MarketCompensationEstimate | None = None
            if observations:
                estimate = self._estimate_job(
                    tenant_id=tenant_id,
                    job_url=current_job_url,
                    title=title,
                    company=company,
                    location=location,
                    observations=observations,
                    component="total_compensation",
                    estimated_at=estimated_at,
                )
            if estimate is None or (estimate.estimate_state != "estimated_range" and posted_observations):
                estimate = self._estimate_job(
                    tenant_id=tenant_id,
                    job_url=current_job_url,
                    title=title,
                    company=company,
                    location=location,
                    observations=posted_observations,
                    component="base_salary",
                    estimated_at=estimated_at,
                )
            self.save_estimate(estimate)
        self._conn.commit()
        return len(rows)

    def _posted_salary_observations(
        self,
        *,
        tenant_id: str,
        job_url: str | None,
    ) -> tuple[ReportedCompensationObservation, ...]:
        sql = """
            SELECT j.title, j.company, j.site, j.location,
                   f.currency, f.period, f.minimum_amount, f.maximum_amount,
                   f.annualized_minimum_amount, f.annualized_maximum_amount,
                   f.warnings_json, f.source_text, f.parsed_at
            FROM job_posted_compensation_facts f
            JOIN jobs j ON j.url = f.job_url
            WHERE f.tenant_id = ?
              AND f.parse_state = 'parsed_range'
              AND (
                f.annualized_minimum_amount IS NOT NULL
                OR f.annualized_maximum_amount IS NOT NULL
                OR f.minimum_amount IS NOT NULL
                OR f.maximum_amount IS NOT NULL
              )
        """
        params: list[Any] = [tenant_id]
        if job_url:
            sql += " AND f.job_url = ?"
            params.append(job_url)
        rows = self._conn.execute(sql, params).fetchall()
        observations: list[ReportedCompensationObservation] = []
        for row in rows:
            currency = _nullable_str(_row_value(row, "currency"))
            warnings = tuple(str(item) for item in _json_list(_row_value(row, "warnings_json")))
            minimum = _posted_annualized_eur(
                annualized_amount=_row_value(row, "annualized_minimum_amount"),
                raw_amount=_row_value(row, "minimum_amount"),
                currency=currency,
                period=_nullable_str(_row_value(row, "period")),
                warnings=warnings,
                source_text=_nullable_str(_row_value(row, "source_text")),
            )
            maximum = _posted_annualized_eur(
                annualized_amount=_row_value(row, "annualized_maximum_amount"),
                raw_amount=_row_value(row, "maximum_amount"),
                currency=currency,
                period=_nullable_str(_row_value(row, "period")),
                warnings=warnings,
                source_text=_nullable_str(_row_value(row, "source_text")),
            )
            company = _nullable_str(_row_value(row, "company")) or _nullable_str(_row_value(row, "site"))
            role = _nullable_str(_row_value(row, "title"))
            if not company or not role or (minimum is None and maximum is None):
                continue
            observations.append(
                ReportedCompensationObservation(
                    source_id="posted_salary_text",
                    company_name=company,
                    role_title=role,
                    minimum_amount=minimum,
                    maximum_amount=maximum,
                    currency="EUR",
                    period="year",
                    component="base_salary",
                    location=_nullable_str(_row_value(row, "location")),
                    level_label=None,
                    company_tier="unknown",
                    release_year=_year(_row_value(row, "parsed_at")),
                    snapshot_version="jobhunter-posted-compensation-v1",
                    sample_count=1,
                    attribution="Employer-posted salary text captured by JobHunter",
                )
            )
        return tuple(observations)

    def _posted_annualized_range(self, tenant_id: str, job_url: str) -> tuple[int | None, int | None]:
        row = self._conn.execute(
            """
            SELECT annualized_minimum_amount, annualized_maximum_amount
            FROM job_posted_compensation_facts
            WHERE tenant_id = ? AND job_url = ?
            """,
            (tenant_id, job_url),
        ).fetchone()
        if row is None:
            return None, None
        return _nullable_int(_row_value(row, "annualized_minimum_amount")), _nullable_int(
            _row_value(row, "annualized_maximum_amount")
        )

    def _record_updated_event(self, estimate: MarketCompensationEstimate) -> None:
        try:
            from jobhunter.state import record_job_event

            record_job_event(
                self._conn,
                estimate.job_url,
                "enrich",
                "CompensationFactsUpdated",
                message="Market compensation estimate updated",
                occurred_at=estimate.estimated_at,
                payload={
                    "jobId": estimate.job_url,
                    "changedSections": ["market"],
                    "postedRecordStatus": None,
                    "postedParseState": None,
                    "marketRecordStatus": "recorded",
                    "marketEstimateState": estimate.estimate_state,
                    "updatedAt": estimate.estimated_at,
                },
            )
            self._conn.commit()
        except sqlite3.OperationalError:
            return


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
    include_eurotoptech: bool = True,
    eurotoptech_max_pages: int = 10,
    env: dict[str, str] | None = None,
) -> ReportedCompensationSourceLoad:
    """Load every configured reported-compensation source for refresh paths."""

    source_env = env if env is not None else os.environ
    observations: list[ReportedCompensationObservation] = []
    local = _load_optional_observation_ref(local_observations_path, default_source_id=None)
    levels_fyi = _load_configured_provider_observations(
        source_env,
        provider="levels_fyi",
        default_source_id="levels_fyi",
        access_var="JOBHUNTER_LEVELS_FYI_ACCESS_MODE",
        permitted_access_modes={"licensed_api", "licensed_data_feed", "enterprise_mcp"},
        required_true_vars=("JOBHUNTER_LEVELS_FYI_EUROPE_COVERAGE",),
        ref_vars=(
            "JOBHUNTER_LEVELS_FYI_OBSERVATIONS_PATH",
            "JOBHUNTER_LEVELS_FYI_OBSERVATIONS_JSON",
            "JOBHUNTER_LEVELS_FYI_DATA_FEED_PATH",
            "JOBHUNTER_LEVELS_FYI_OBSERVATIONS_URL",
            "JOBHUNTER_LEVELS_FYI_DATA_FEED_URL",
        ),
        auth_token_vars=(
            "JOBHUNTER_LEVELS_FYI_API_TOKEN",
            "JOBHUNTER_LEVELS_FYI_API_KEY",
            "JOBHUNTER_LEVELS_FYI_TOKEN",
        ),
        default_paths=(
            Path.home() / ".jobhunter" / "compensation" / "levels_fyi.json",
            Path.home() / ".jobhunter" / "compensation" / "levels_fyi.csv",
            Path.home() / ".jobhunter" / "compensation" / "levels-fyi.json",
            Path.home() / ".jobhunter" / "compensation" / "levels-fyi.csv",
        ),
    )
    glassdoor = _load_configured_provider_observations(
        source_env,
        provider="glassdoor",
        default_source_id="glassdoor",
        access_var="JOBHUNTER_GLASSDOOR_ACCESS_MODE",
        permitted_access_modes={"partner_api", "written_permission"},
        required_true_vars=(),
        ref_vars=(
            "JOBHUNTER_GLASSDOOR_OBSERVATIONS_PATH",
            "JOBHUNTER_GLASSDOOR_OBSERVATIONS_JSON",
            "JOBHUNTER_GLASSDOOR_DATA_FEED_PATH",
            "JOBHUNTER_GLASSDOOR_OBSERVATIONS_URL",
            "JOBHUNTER_GLASSDOOR_DATA_FEED_URL",
        ),
        auth_token_vars=(
            "JOBHUNTER_GLASSDOOR_API_TOKEN",
            "JOBHUNTER_GLASSDOOR_API_KEY",
            "JOBHUNTER_GLASSDOOR_TOKEN",
        ),
        default_paths=(
            Path.home() / ".jobhunter" / "compensation" / "glassdoor.json",
            Path.home() / ".jobhunter" / "compensation" / "glassdoor.csv",
        ),
    )
    eurotoptech = load_euro_top_tech_observations(max_pages=eurotoptech_max_pages) if include_eurotoptech else ()
    observations.extend(local)
    observations.extend(levels_fyi)
    observations.extend(glassdoor)
    observations.extend(eurotoptech)
    return ReportedCompensationSourceLoad(
        observations=tuple(observations),
        local_count=len(local),
        levels_fyi_count=len(levels_fyi),
        glassdoor_count=len(glassdoor),
        euro_top_tech_count=len(eurotoptech),
    )


def _load_reported_compensation_payload(
    text: str,
    *,
    default_source_id: str | None,
) -> tuple[ReportedCompensationObservation, ...]:
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return _load_reported_compensation_csv(text, default_source_id=default_source_id)
    items = raw.get("observations", raw) if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        raise ValueError("reported compensation JSON must be a list or an object with an observations list")
    observations = []
    for item in items:
        if not isinstance(item, dict):
            continue
        observation = _observation_from_dict(item, default_source_id=default_source_id)
        if observation is not None:
            observations.append(observation)
    return tuple(observations)


def _load_reported_compensation_csv(
    text: str,
    *,
    default_source_id: str | None,
) -> tuple[ReportedCompensationObservation, ...]:
    observations: list[ReportedCompensationObservation] = []
    for item in csv.DictReader(text.splitlines()):
        observation = _observation_from_dict(item, default_source_id=default_source_id)
        if observation is not None:
            observations.append(observation)
    return tuple(observations)


def _load_optional_observation_ref(
    ref: Path | str | None,
    *,
    default_source_id: str | None,
) -> tuple[ReportedCompensationObservation, ...]:
    if ref is None or str(ref).strip() == "":
        return ()
    return _load_observation_ref(str(ref), default_source_id=default_source_id, auth_token=None)


def _load_configured_provider_observations(
    env: dict[str, str],
    *,
    provider: str,
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

    auth_token = next((str(env.get(var) or "").strip() for var in auth_token_vars if str(env.get(var) or "").strip()), None)
    observations: list[ReportedCompensationObservation] = []
    for ref in refs:
        try:
            observations.extend(_load_observation_ref(ref, default_source_id=default_source_id, auth_token=auth_token))
        except Exception as exc:  # noqa: BLE001 - one unavailable licensed feed should not block refresh
            log.warning("%s reported compensation feed could not be loaded from %s: %s", provider, ref, exc)
    return tuple(row for row in observations if row.source_id == provider)


def _load_observation_ref(
    ref: str,
    *,
    default_source_id: str | None,
    auth_token: str | None,
) -> tuple[ReportedCompensationObservation, ...]:
    if _is_url(ref):
        return _load_reported_compensation_payload(
            _fetch_text(ref, timeout_seconds=20.0, auth_token=auth_token),
            default_source_id=default_source_id,
        )

    path = Path(ref).expanduser()
    if path.is_dir():
        observations: list[ReportedCompensationObservation] = []
        for child in sorted(path.iterdir()):
            if child.suffix.casefold() not in {".csv", ".json"}:
                continue
            observations.extend(load_reported_compensation_observations(child, default_source_id=default_source_id))
        return tuple(observations)
    return load_reported_compensation_observations(path, default_source_id=default_source_id)


def _fetch_text(url: str, *, timeout_seconds: float, auth_token: str | None) -> str:
    headers = {"Accept": "application/json, text/csv;q=0.9, */*;q=0.8", "User-Agent": "JobHunter/0.3"}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        return response.read().decode("utf-8")


def _is_url(value: str) -> bool:
    return urllib.parse.urlsplit(value).scheme in {"http", "https"}


def _truthy(value: Any) -> bool:
    return str(value or "").strip().casefold() in {"1", "true", "yes", "on"}


def load_euro_top_tech_observations(
    *,
    url: str = EURO_TOP_TECH_DATA_ENTRIES_URL,
    max_pages: int = 10,
    timeout_seconds: float = 10.0,
) -> tuple[ReportedCompensationObservation, ...]:
    """Load public Euro Top Tech approved data-entry rows as compensation observations."""

    observations: list[ReportedCompensationObservation] = []
    next_url: str | None = url
    seen_urls: set[str] = set()
    pages = 0
    while next_url and pages < max(0, max_pages) and next_url not in seen_urls:
        seen_urls.add(next_url)
        try:
            payload = _fetch_json(next_url, timeout_seconds=timeout_seconds)
        except Exception:
            if observations:
                break
            raise
        rows = payload.get("rows")
        if not isinstance(rows, list):
            break
        for item in rows:
            if isinstance(item, dict) and (observation := _euro_top_tech_observation(item)) is not None:
                observations.append(observation)
        pages += 1
        cursor = payload.get("nextCursor") if payload.get("hasMore") else None
        next_url = _cursor_url(url, str(cursor)) if cursor else None
    return tuple(observations)


def _fetch_json(url: str, *, timeout_seconds: float) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "JobHunter/0.3"})
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        raw = response.read()
    parsed = json.loads(raw.decode("utf-8"))
    return parsed if isinstance(parsed, dict) else {}


def _cursor_url(base_url: str, cursor: str) -> str:
    parts = urllib.parse.urlsplit(base_url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    query = [(key, value) for key, value in query if key != "cursor"]
    query.append(("cursor", cursor))
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(query), parts.fragment))


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
        snapshot_version=_text(_pick(data, "snapshot_version", "snapshotVersion"), default="reported-compensation-import-v1"),
        sample_count=_nullable_int(_pick(data, "sample_count", "sampleCount", "samples")) or 1,
        attribution=_text(_pick(data, "attribution"), default=None),
    )


def _row_to_estimate(row: sqlite3.Row | tuple[Any, ...]) -> MarketCompensationEstimate:
    return MarketCompensationEstimate(
        tenant_id=str(_row_value(row, "tenant_id")),
        job_url=str(_row_value(row, "job_url")),
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


def _normalize_annualized_eur(amount: Any, currency: str | None) -> int | None:
    value = _nullable_int(amount)
    if value is None:
        return None
    rate = EUR_NORMALIZATION_RATES.get(str(currency or "").upper())
    if rate is None:
        return None
    return round(value * rate)


def _posted_annualized_eur(
    *,
    annualized_amount: Any,
    raw_amount: Any,
    currency: str | None,
    period: str | None,
    warnings: tuple[str, ...],
    source_text: str | None,
) -> int | None:
    annualized = _normalize_annualized_eur(annualized_amount, currency)
    if annualized is not None:
        return annualized
    value = _nullable_int(raw_amount)
    if value is None or not _can_assume_annual_period(value, period, warnings, source_text):
        return None
    return _normalize_annualized_eur(value, currency)


def _can_assume_annual_period(
    value: int,
    period: str | None,
    warnings: tuple[str, ...],
    source_text: str | None,
) -> bool:
    if str(period or "").casefold() != "unknown":
        return False
    if value < 30_000:
        return False
    if "bonus_component" in warnings or "one_sided_range" in warnings:
        return False
    text = str(source_text or "").casefold()
    return bool(re.search(r"\b(base salaries|base salary|salary|compensation|gross)\b", text))


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
    if any(pattern in lowered for pattern in ("rawproviderpayload", "credential", "secret", "/users/", "\\users\\", "private")):
        return None
    return text


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
        "job_url",
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
