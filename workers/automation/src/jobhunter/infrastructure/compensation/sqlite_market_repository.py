"""SQLite repository for Europe public market compensation estimates."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobhunter.database import ensure_market_compensation_tables
from jobhunter.domain.compensation import (
    MarketCompensationEstimate,
    MarketConfidenceFactor,
    MarketSourceSnapshot,
    PublicMarketBaseline,
    estimate_market_compensation,
    sanitize_market_source_snapshot,
)


class SqliteMarketCompensationRepository:
    """SQLite-backed repository for canonical market compensation estimates."""

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
                source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                estimated_at                      = excluded.estimated_at
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
            ),
        )
        self._conn.commit()

    def get_estimate(self, tenant_id: str, job_url: str) -> MarketCompensationEstimate | None:
        row = self._conn.execute(
            """
            SELECT tenant_id, job_url, estimate_state, currency, period, component,
                   minimum_amount, maximum_amount, confidence_band, confidence_score,
                   source_count, sample_count, aggregate_bucket, geography_scope,
                   occupation_code, occupation_label, seniority_label, source_snapshot_json,
                   factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
                   source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at
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
        location: str | None,
        baselines: tuple[PublicMarketBaseline, ...],
        tenant_id: str = "local",
        component: str = "base_salary",
        seniority_label: str | None = None,
        posted_annualized_minimum: int | None = None,
        posted_annualized_maximum: int | None = None,
        estimated_at: str | None = None,
    ) -> MarketCompensationEstimate:
        estimate = estimate_market_compensation(
            tenant_id=tenant_id,
            job_url=job_url,
            title=title,
            location=location,
            component=component,
            seniority_label=seniority_label,
            baselines=baselines,
            posted_annualized_minimum=posted_annualized_minimum,
            posted_annualized_maximum=posted_annualized_maximum,
            estimated_at=estimated_at,
        )
        self.save_estimate(estimate)
        return estimate

    def backfill_from_jobs(
        self,
        baselines: tuple[PublicMarketBaseline, ...],
        *,
        tenant_id: str = "local",
        estimated_at: str | None = None,
    ) -> int:
        rows = self._conn.execute("SELECT url, title, location FROM jobs ORDER BY url").fetchall()
        for row in rows:
            self.estimate_and_save_job(
                tenant_id=tenant_id,
                job_url=str(_row_value(row, "url")),
                title=str(_row_value(row, "title") or ""),
                location=_nullable_str(_row_value(row, "location")),
                baselines=baselines,
                estimated_at=estimated_at,
            )
        self._conn.commit()
        return len(rows)


def _row_to_estimate(row: sqlite3.Row | tuple[Any, ...]) -> MarketCompensationEstimate:
    return MarketCompensationEstimate(
        tenant_id=str(_row_value(row, "tenant_id")),
        job_url=str(_row_value(row, "job_url")),
        estimate_state=_row_value(row, "estimate_state"),  # type: ignore[arg-type]
        currency=_nullable_str(_row_value(row, "currency")),
        period=_row_value(row, "period"),  # type: ignore[arg-type]
        component=_row_value(row, "component"),  # type: ignore[arg-type]
        minimum_amount=_nullable_int(_row_value(row, "minimum_amount")),
        maximum_amount=_nullable_int(_row_value(row, "maximum_amount")),
        confidence_band=_row_value(row, "confidence_band"),  # type: ignore[arg-type]
        confidence_score=float(_row_value(row, "confidence_score") or 0),
        source_count=int(_row_value(row, "source_count") or 0),
        sample_count=_nullable_int(_row_value(row, "sample_count")),
        aggregate_bucket=_safe_aggregate_bucket(
            _nullable_str(_row_value(row, "aggregate_bucket")),
            _json_list(_row_value(row, "source_snapshot_json")),
        ),
        geography_scope=_nullable_str(_row_value(row, "geography_scope")),
        occupation_code=_nullable_str(_row_value(row, "occupation_code")),
        occupation_label=_nullable_str(_row_value(row, "occupation_label")),
        seniority_label=_nullable_str(_row_value(row, "seniority_label")),
        sources=tuple(
            source
            for item in _json_list(_row_value(row, "source_snapshot_json"))
            if (source := _source_from_dict(item)) is not None
        ),
        factors=tuple(_factor_from_dict(item) for item in _json_list(_row_value(row, "factor_reasons_json"))),
        insufficient_reasons=tuple(str(item) for item in _json_list(_row_value(row, "insufficient_reasons_json"))),
        unsupported_reasons=tuple(str(item) for item in _json_list(_row_value(row, "unsupported_reasons_json"))),
        source_unavailable_reasons=tuple(
            str(item) for item in _json_list(_row_value(row, "source_unavailable_reasons_json"))
        ),
        warnings=tuple(str(item) for item in _json_list(_row_value(row, "warnings_json"))),
        estimator_version=str(_row_value(row, "estimator_version")),
        estimated_at=str(_row_value(row, "estimated_at")),
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
    source_id = str(data.get("source_id") or "")
    if source_id not in {"eurostat_structure_of_earnings", "esco_occupation_taxonomy", "spain_ine_salary_structure"}:
        return None
    source_type = "occupation_taxonomy" if source_id == "esco_occupation_taxonomy" else "public_wage_baseline"
    return sanitize_market_source_snapshot(
        MarketSourceSnapshot(
            source_id=source_id,  # type: ignore[arg-type]
            display_name=str(data.get("display_name") or ""),
            source_type=source_type,
            release_year=_nullable_int(data.get("release_year")),
            snapshot_version=str(data.get("snapshot_version") or ""),
            geography_scope=str(data.get("geography_scope") or ""),
            aggregate_bucket=str(data.get("aggregate_bucket") or ""),
            attribution=str(data.get("attribution") or ""),
            sample_count=_nullable_int(data.get("sample_count")),
        )
    )


def _safe_aggregate_bucket(value: str | None, source_values: list[Any]) -> str | None:
    safe_buckets = {
        "Eurostat SES occupation/country aggregate",
        "ESCO occupation mapping",
        "Spain INE occupation aggregate",
    }
    if value in safe_buckets:
        return value
    sources = tuple(source for item in source_values if (source := _source_from_dict(item)) is not None)
    buckets = tuple(dict.fromkeys(source.aggregate_bucket for source in sources))
    return ", ".join(buckets) if buckets else None


def _factor_to_dict(factor: MarketConfidenceFactor) -> dict[str, Any]:
    return {
        "name": factor.name,
        "score": factor.score,
        "band": factor.band,
        "reason": factor.reason,
    }


def _factor_from_dict(value: Any) -> MarketConfidenceFactor:
    data = value if isinstance(value, dict) else {}
    return MarketConfidenceFactor(
        name=str(data.get("name") or "occupation"),  # type: ignore[arg-type]
        score=float(data.get("score") or 0),
        band=str(data.get("band") or "none"),  # type: ignore[arg-type]
        reason=str(data.get("reason") or ""),
    )


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
    )
    return row[keys.index(key)]


def _nullable_str(value: Any) -> str | None:
    return None if value is None else str(value)


def _nullable_int(value: Any) -> int | None:
    return None if value is None else int(value)
