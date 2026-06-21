"""SQLite repository for company-role reported compensation estimates."""

from __future__ import annotations

import json
import re
import sqlite3
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
SAFE_SOURCE_IDS = frozenset({"levels_fyi", "glassdoor", "manual_reported_compensation", "posted_salary_text"})
SAFE_COMPONENTS = frozenset({"base_salary", "total_compensation"})
SAFE_COMPANY_TIERS = frozenset({"tier_1_local", "tier_2_ambitious", "tier_3_top_of_market", "unknown"})
SAFE_MATCH_SCOPES = frozenset({"exact_company_role", "company_adjacent_role", "tier_role_fallback", "none"})
DEFAULT_FACTOR_REASON = "Reported compensation estimate factor recorded by the deterministic company-role estimator."
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
                minimum_amount, maximum_amount, confidence_band, confidence_score,
                source_count, sample_count, aggregate_bucket, geography_scope,
                occupation_code, occupation_label, seniority_label, source_snapshot_json,
                factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
                source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
                company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_url) DO UPDATE SET
                estimate_state                    = excluded.estimate_state,
                currency                          = excluded.currency,
                period                            = excluded.period,
                component                         = excluded.component,
                minimum_amount                    = excluded.minimum_amount,
                maximum_amount                    = excluded.maximum_amount,
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
                   minimum_amount, maximum_amount, confidence_band, confidence_score,
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
        posted_minimum, posted_maximum = self._posted_annualized_range(tenant_id, job_url)
        estimate = estimate_market_compensation(
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
        self.save_estimate(estimate)
        return estimate

    def backfill_from_jobs(
        self,
        observations: tuple[ReportedCompensationObservation, ...],
        *,
        tenant_id: str = "local",
        estimated_at: str | None = None,
        limit: int = 0,
        job_url: str | None = None,
    ) -> int:
        effective_observations = (
            observations
            if observations
            else self._posted_salary_observations(tenant_id=tenant_id, job_url=job_url)
        )
        component = "total_compensation" if observations else "base_salary"
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
            self.estimate_and_save_job(
                tenant_id=tenant_id,
                job_url=str(_row_value(row, "url")),
                title=str(_row_value(row, "title") or ""),
                company=_nullable_str(_row_value(row, "company")) or _nullable_str(_row_value(row, "site")),
                location=_nullable_str(_row_value(row, "location")),
                observations=effective_observations,
                component=component,
                estimated_at=estimated_at,
            )
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
                   f.currency, f.annualized_minimum_amount, f.annualized_maximum_amount,
                   f.parsed_at
            FROM job_posted_compensation_facts f
            JOIN jobs j ON j.url = f.job_url
            WHERE f.tenant_id = ?
              AND f.parse_state = 'parsed_range'
              AND (f.annualized_minimum_amount IS NOT NULL OR f.annualized_maximum_amount IS NOT NULL)
        """
        params: list[Any] = [tenant_id]
        if job_url:
            sql += " AND f.job_url = ?"
            params.append(job_url)
        rows = self._conn.execute(sql, params).fetchall()
        observations: list[ReportedCompensationObservation] = []
        for row in rows:
            currency = _nullable_str(_row_value(row, "currency"))
            minimum = _normalize_annualized_eur(_row_value(row, "annualized_minimum_amount"), currency)
            maximum = _normalize_annualized_eur(_row_value(row, "annualized_maximum_amount"), currency)
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


def load_reported_compensation_observations(path: Path | str) -> tuple[ReportedCompensationObservation, ...]:
    """Load Levels.fyi, Glassdoor, or manual reported compensation observations from JSON."""

    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    items = raw.get("observations", raw) if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        raise ValueError("reported compensation JSON must be a list or an object with an observations list")
    observations = []
    for item in items:
        if not isinstance(item, dict):
            continue
        observation = _observation_from_dict(item)
        if observation is not None:
            observations.append(observation)
    return tuple(observations)


def _observation_from_dict(data: dict[str, Any]) -> ReportedCompensationObservation | None:
    source_id = _source_id(_pick(data, "source_id", "sourceId", "source"))
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
        reason=DEFAULT_FACTOR_REASON,
    )


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
