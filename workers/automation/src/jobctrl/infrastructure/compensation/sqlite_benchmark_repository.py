"""SQLite persistence for immutable compensation benchmark authorities."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping
from typing import Any

from jobctrl.domain.compensation.benchmarks import (
    LOWER_FACTOR_BOUND,
    UPPER_FACTOR_BOUND,
    BenchmarkGeography,
    CompanyBenchmarkPair,
    DirectBenchmarkFact,
    ExtrapolatedBenchmarkFact,
    ExtrapolationDirectInput,
    ExtrapolationPriceInput,
    PriceLevelFact,
    canonical_benchmark_timestamp,
)


class SqliteCompensationBenchmarkRepository:
    """Persist and query content-addressed benchmark facts.

    Fact and lineage tables are append-only. Idempotency therefore reads by
    content hash before inserting and re-reads after a concurrent collision;
    it never relies on ``INSERT OR REPLACE`` or an update path.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save_direct(self, fact: DirectBenchmarkFact) -> DirectBenchmarkFact:
        if fact.source_provenance == "employer_posted" or fact.source_id == "posted_salary_text":
            raise ValueError("employer-posted compensation must use the posted compensation authority")
        fact.assert_integrity()
        existing = self.get_direct_by_evidence_hash(fact.tenant_id, fact.evidence_hash)
        if existing is not None:
            return existing
        try:
            self._conn.execute(
                """
                INSERT INTO compensation_direct_benchmark_facts (
                    tenant_id, fact_id, taxonomy_version, role_family_code,
                    seniority_label, country_code, subdivision_code, locality,
                    geography_scope, market_scope, normalized_company, component,
                    original_currency, original_period, original_minimum_amount,
                    original_maximum_amount, eur_annual_minimum_amount,
                    eur_annual_maximum_amount,
                    confidence_interval_minimum_amount,
                    confidence_interval_maximum_amount, confidence_score,
                    sample_count, source_id, source_provenance, source_snapshot_id,
                    source_url, attribution, fx_reference_json, as_of_date,
                    fetched_at, fresh_until, evidence_hash, created_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                _direct_values(fact),
            )
        except sqlite3.IntegrityError:
            existing = self.get_direct_by_evidence_hash(
                fact.tenant_id,
                fact.evidence_hash,
            )
            if existing is not None:
                return existing
            raise
        return fact

    def save_price_level(self, fact: PriceLevelFact) -> PriceLevelFact:
        fact.assert_integrity()
        existing = self.get_price_level_by_evidence_hash(
            fact.tenant_id,
            fact.evidence_hash,
        )
        if existing is not None:
            return existing
        try:
            self._conn.execute(
                """
                INSERT INTO compensation_price_level_facts (
                    tenant_id, fact_id, country_code, category, reference_year,
                    base_geography_code, index_value, source_id,
                    source_snapshot_id, source_url, attribution, as_of_date,
                    fetched_at, fresh_until, evidence_hash, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    fact.tenant_id,
                    fact.fact_id,
                    fact.country_code,
                    fact.category,
                    fact.reference_year,
                    fact.base_geography_code,
                    fact.index_value,
                    fact.source_id,
                    fact.source_snapshot_id,
                    fact.source_url,
                    fact.attribution,
                    fact.as_of_date,
                    fact.fetched_at,
                    fact.fresh_until,
                    fact.evidence_hash,
                    fact.created_at,
                ),
            )
        except sqlite3.IntegrityError:
            existing = self.get_price_level_by_evidence_hash(
                fact.tenant_id,
                fact.evidence_hash,
            )
            if existing is not None:
                return existing
            raise
        return fact

    def save_extrapolated(
        self,
        fact: ExtrapolatedBenchmarkFact,
    ) -> ExtrapolatedBenchmarkFact:
        fact.assert_integrity()
        existing = self.get_extrapolated_by_inputs_hash(
            fact.tenant_id,
            fact.inputs_hash,
        )
        if existing is not None:
            return existing

        savepoint = "compensation_extrapolation_save"
        self._conn.execute(f"SAVEPOINT {savepoint}")
        try:
            self._conn.execute(
                """
                INSERT INTO compensation_extrapolated_benchmark_facts (
                    tenant_id, fact_id, anchor_direct_fact_id, taxonomy_version,
                    role_family_code, seniority_label, target_country_code,
                    target_subdivision_code, target_locality,
                    target_geography_scope, component, currency, period,
                    minimum_amount, maximum_amount,
                    confidence_interval_minimum_amount,
                    confidence_interval_maximum_amount, confidence_band,
                    confidence_score, extrapolation_method, raw_factor,
                    shrinkage_weight, lower_factor_bound, upper_factor_bound,
                    factor_bound_state, matched_company_count, formula_version,
                    inputs_hash, warnings_json, as_of_date, derived_at, fresh_until
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EUR', 'year', ?, ?, ?, ?,
                    ?, ?, 'evidence_weighted_shrinkage', ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?
                )
                """,
                (
                    fact.tenant_id,
                    fact.fact_id,
                    fact.anchor_direct_fact_id,
                    fact.taxonomy_version,
                    fact.role_family_code,
                    fact.seniority_label,
                    fact.target_geography.country_code,
                    fact.target_geography.subdivision_code,
                    fact.target_geography.locality,
                    fact.target_geography.scope,
                    fact.component,
                    fact.minimum_amount,
                    fact.maximum_amount,
                    fact.confidence_interval_minimum_amount,
                    fact.confidence_interval_maximum_amount,
                    fact.confidence_band,
                    fact.confidence_score,
                    fact.raw_factor,
                    fact.shrinkage_weight,
                    LOWER_FACTOR_BOUND,
                    UPPER_FACTOR_BOUND,
                    fact.factor_bound_state,
                    fact.matched_company_count,
                    fact.formula_version,
                    fact.inputs_hash,
                    json.dumps(fact.warnings, separators=(",", ":")),
                    fact.as_of_date,
                    fact.derived_at,
                    fact.fresh_until,
                ),
            )
            self._conn.executemany(
                """
                INSERT INTO compensation_extrapolation_direct_inputs (
                    tenant_id, extrapolated_fact_id, direct_fact_id,
                    input_role, weight
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    (
                        fact.tenant_id,
                        fact.fact_id,
                        item.direct_fact_id,
                        item.input_role,
                        item.weight,
                    )
                    for item in fact.direct_inputs
                ),
            )
            self._conn.executemany(
                """
                INSERT INTO compensation_extrapolation_price_inputs (
                    tenant_id, extrapolated_fact_id, price_level_fact_id,
                    input_role, weight
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    (
                        fact.tenant_id,
                        fact.fact_id,
                        item.price_level_fact_id,
                        item.input_role,
                        item.weight,
                    )
                    for item in fact.price_inputs
                ),
            )
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        except sqlite3.IntegrityError:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            existing = self.get_extrapolated_by_inputs_hash(
                fact.tenant_id,
                fact.inputs_hash,
            )
            if existing is not None:
                return existing
            raise
        except BaseException:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise
        return fact

    def get_direct(self, tenant_id: str, fact_id: str) -> DirectBenchmarkFact | None:
        row = _fetchone_mapping(
            self._conn.execute(
                """
                SELECT *
                FROM compensation_direct_benchmark_facts
                WHERE tenant_id = ? AND fact_id = ?
                """,
                (tenant_id, fact_id),
            )
        )
        return _direct_from_row(row) if row is not None else None

    def get_direct_by_evidence_hash(
        self,
        tenant_id: str,
        evidence_hash: str,
    ) -> DirectBenchmarkFact | None:
        row = _fetchone_mapping(
            self._conn.execute(
                """
                SELECT *
                FROM compensation_direct_benchmark_facts
                WHERE tenant_id = ? AND evidence_hash = ?
                """,
                (tenant_id, evidence_hash),
            )
        )
        return _direct_from_row(row) if row is not None else None

    def get_price_level(
        self,
        tenant_id: str,
        fact_id: str,
    ) -> PriceLevelFact | None:
        row = _fetchone_mapping(
            self._conn.execute(
                """
                SELECT *
                FROM compensation_price_level_facts
                WHERE tenant_id = ? AND fact_id = ?
                """,
                (tenant_id, fact_id),
            )
        )
        return _price_level_from_row(row) if row is not None else None

    def get_price_level_by_evidence_hash(
        self,
        tenant_id: str,
        evidence_hash: str,
    ) -> PriceLevelFact | None:
        row = _fetchone_mapping(
            self._conn.execute(
                """
                SELECT *
                FROM compensation_price_level_facts
                WHERE tenant_id = ? AND evidence_hash = ?
                """,
                (tenant_id, evidence_hash),
            )
        )
        return _price_level_from_row(row) if row is not None else None

    def get_extrapolated(
        self,
        tenant_id: str,
        fact_id: str,
    ) -> ExtrapolatedBenchmarkFact | None:
        row = _fetchone_mapping(
            self._conn.execute(
                """
                SELECT *
                FROM compensation_extrapolated_benchmark_facts
                WHERE tenant_id = ? AND fact_id = ?
                """,
                (tenant_id, fact_id),
            )
        )
        return self._extrapolated_from_row(row) if row is not None else None

    def get_extrapolated_by_inputs_hash(
        self,
        tenant_id: str,
        inputs_hash: str,
    ) -> ExtrapolatedBenchmarkFact | None:
        row = _fetchone_mapping(
            self._conn.execute(
                """
                SELECT *
                FROM compensation_extrapolated_benchmark_facts
                WHERE tenant_id = ? AND inputs_hash = ?
                """,
                (tenant_id, inputs_hash),
            )
        )
        return self._extrapolated_from_row(row) if row is not None else None

    def latest_direct(
        self,
        *,
        tenant_id: str,
        taxonomy_version: str,
        role_family_code: str,
        seniority_label: str,
        geography: BenchmarkGeography,
        component: str,
        market_scope: str = "market",
        normalized_company: str | None = None,
        fresh_at: str | None = None,
    ) -> DirectBenchmarkFact | None:
        sql = """
            SELECT *
            FROM compensation_direct_benchmark_facts
            WHERE tenant_id = ?
              AND taxonomy_version = ?
              AND role_family_code = ?
              AND seniority_label = ?
              AND country_code = ?
              AND subdivision_code = ?
              AND locality = ?
              AND geography_scope = ?
              AND component = ?
              AND market_scope = ?
              AND (
                    (? IS NULL AND normalized_company IS NULL)
                    OR normalized_company = ?
              )
        """
        params: list[Any] = [
            tenant_id,
            taxonomy_version,
            role_family_code,
            seniority_label,
            geography.country_code,
            geography.subdivision_code,
            geography.locality,
            geography.scope,
            component,
            market_scope,
            normalized_company,
            normalized_company,
        ]
        if fresh_at is not None:
            sql += " AND fresh_until >= ?"
            params.append(canonical_benchmark_timestamp(fresh_at, "fresh_at"))
        sql += " ORDER BY fetched_at DESC, fact_id DESC LIMIT 1"
        row = _fetchone_mapping(self._conn.execute(sql, params))
        return _direct_from_row(row) if row is not None else None

    def latest_price_level(
        self,
        *,
        tenant_id: str,
        country_code: str,
        category: str,
        fresh_at: str | None = None,
    ) -> PriceLevelFact | None:
        sql = """
            SELECT *
            FROM compensation_price_level_facts
            WHERE tenant_id = ? AND country_code = ? AND category = ?
        """
        params: list[Any] = [tenant_id, country_code, category]
        if fresh_at is not None:
            sql += " AND fresh_until >= ?"
            params.append(canonical_benchmark_timestamp(fresh_at, "fresh_at"))
        sql += " ORDER BY reference_year DESC, fetched_at DESC, fact_id DESC LIMIT 1"
        row = _fetchone_mapping(self._conn.execute(sql, params))
        return _price_level_from_row(row) if row is not None else None

    def latest_extrapolated(
        self,
        *,
        tenant_id: str,
        taxonomy_version: str,
        role_family_code: str,
        seniority_label: str,
        geography: BenchmarkGeography,
        component: str,
        fresh_at: str | None = None,
    ) -> ExtrapolatedBenchmarkFact | None:
        sql = """
            SELECT *
            FROM compensation_extrapolated_benchmark_facts
            WHERE tenant_id = ?
              AND taxonomy_version = ?
              AND role_family_code = ?
              AND seniority_label = ?
              AND target_country_code = ?
              AND target_subdivision_code = ?
              AND target_locality = ?
              AND target_geography_scope = ?
              AND component = ?
        """
        params: list[Any] = [
            tenant_id,
            taxonomy_version,
            role_family_code,
            seniority_label,
            geography.country_code,
            geography.subdivision_code,
            geography.locality,
            geography.scope,
            component,
        ]
        if fresh_at is not None:
            sql += " AND fresh_until >= ?"
            params.append(canonical_benchmark_timestamp(fresh_at, "fresh_at"))
        sql += " ORDER BY derived_at DESC, fact_id DESC LIMIT 1"
        row = _fetchone_mapping(self._conn.execute(sql, params))
        return self._extrapolated_from_row(row) if row is not None else None

    def matched_company_pairs(
        self,
        *,
        tenant_id: str,
        taxonomy_version: str,
        role_family_code: str,
        seniority_label: str,
        component: str,
        source_country_code: str,
        target_country_code: str,
        fresh_at: str | None = None,
    ) -> tuple[CompanyBenchmarkPair, ...]:
        freshness_clause = ""
        params: list[Any] = [
            tenant_id,
            taxonomy_version,
            role_family_code,
            seniority_label,
            component,
            source_country_code,
            target_country_code,
        ]
        if fresh_at is not None:
            freshness_clause = "AND fresh_until >= ?"
            params.append(canonical_benchmark_timestamp(fresh_at, "fresh_at"))
        rows = _fetchall_mappings(
            self._conn.execute(
                f"""
                WITH ranked AS (
                    SELECT facts.*,
                           ROW_NUMBER() OVER (
                               PARTITION BY normalized_company, country_code
                               ORDER BY fetched_at DESC, fact_id DESC
                           ) AS country_rank
                    FROM compensation_direct_benchmark_facts AS facts
                    WHERE tenant_id = ?
                      AND taxonomy_version = ?
                      AND role_family_code = ?
                      AND seniority_label = ?
                      AND component = ?
                      AND market_scope = 'company'
                      AND country_code IN (?, ?)
                      {freshness_clause}
                )
                SELECT source.fact_id AS source_fact_id,
                       target.fact_id AS target_fact_id
                FROM ranked AS source
                JOIN ranked AS target
                  ON target.normalized_company = source.normalized_company
                 AND target.country_code = ?
                 AND target.country_rank = 1
                WHERE source.country_code = ?
                  AND source.country_rank = 1
                ORDER BY source.normalized_company
                """,
                (
                    *params,
                    target_country_code,
                    source_country_code,
                ),
            )
        )
        pairs: list[CompanyBenchmarkPair] = []
        for row in rows:
            source = self.get_direct(tenant_id, str(row["source_fact_id"]))
            target = self.get_direct(tenant_id, str(row["target_fact_id"]))
            if source is not None and target is not None:
                pairs.append(CompanyBenchmarkPair(source=source, target=target))
        return tuple(pairs)

    def _extrapolated_from_row(
        self,
        row: Mapping[str, Any],
    ) -> ExtrapolatedBenchmarkFact:
        direct_rows = _fetchall_mappings(
            self._conn.execute(
                """
                SELECT direct_fact_id, input_role, weight
                FROM compensation_extrapolation_direct_inputs
                WHERE tenant_id = ? AND extrapolated_fact_id = ?
                ORDER BY input_role, direct_fact_id
                """,
                (str(row["tenant_id"]), str(row["fact_id"])),
            )
        )
        price_rows = _fetchall_mappings(
            self._conn.execute(
                """
                SELECT price_level_fact_id, input_role, weight
                FROM compensation_extrapolation_price_inputs
                WHERE tenant_id = ? AND extrapolated_fact_id = ?
                ORDER BY input_role, price_level_fact_id
                """,
                (str(row["tenant_id"]), str(row["fact_id"])),
            )
        )
        return ExtrapolatedBenchmarkFact(
            tenant_id=str(row["tenant_id"]),
            fact_id=str(row["fact_id"]),
            anchor_direct_fact_id=str(row["anchor_direct_fact_id"]),
            taxonomy_version=str(row["taxonomy_version"]),
            role_family_code=str(row["role_family_code"]),
            seniority_label=str(row["seniority_label"]),  # type: ignore[arg-type]
            target_geography=BenchmarkGeography(
                country_code=str(row["target_country_code"]),
                scope=str(row["target_geography_scope"]),  # type: ignore[arg-type]
                subdivision_code=str(row["target_subdivision_code"]),
                locality=str(row["target_locality"]),
            ),
            component=str(row["component"]),  # type: ignore[arg-type]
            minimum_amount=int(row["minimum_amount"]),
            maximum_amount=int(row["maximum_amount"]),
            confidence_interval_minimum_amount=int(row["confidence_interval_minimum_amount"]),
            confidence_interval_maximum_amount=int(row["confidence_interval_maximum_amount"]),
            confidence_band=str(row["confidence_band"]),  # type: ignore[arg-type]
            confidence_score=float(row["confidence_score"]),
            raw_factor=float(row["raw_factor"]),
            shrinkage_weight=float(row["shrinkage_weight"]),
            factor_bound_state=str(row["factor_bound_state"]),  # type: ignore[arg-type]
            matched_company_count=int(row["matched_company_count"]),
            formula_version=str(row["formula_version"]),
            inputs_hash=str(row["inputs_hash"]),
            warnings=tuple(str(value) for value in _json_list(row["warnings_json"])),
            as_of_date=str(row["as_of_date"]),
            derived_at=str(row["derived_at"]),
            fresh_until=str(row["fresh_until"]),
            direct_inputs=tuple(
                ExtrapolationDirectInput(
                    direct_fact_id=str(item["direct_fact_id"]),
                    input_role=str(item["input_role"]),  # type: ignore[arg-type]
                    weight=float(item["weight"]),
                )
                for item in direct_rows
            ),
            price_inputs=tuple(
                ExtrapolationPriceInput(
                    price_level_fact_id=str(item["price_level_fact_id"]),
                    input_role=str(item["input_role"]),  # type: ignore[arg-type]
                    weight=float(item["weight"]),
                )
                for item in price_rows
            ),
        )


def _direct_values(fact: DirectBenchmarkFact) -> tuple[Any, ...]:
    return (
        fact.tenant_id,
        fact.fact_id,
        fact.taxonomy_version,
        fact.role_family_code,
        fact.seniority_label,
        fact.geography.country_code,
        fact.geography.subdivision_code,
        fact.geography.locality,
        fact.geography.scope,
        fact.market_scope,
        fact.normalized_company,
        fact.component,
        fact.original_currency,
        fact.original_period,
        fact.original_minimum_amount,
        fact.original_maximum_amount,
        fact.eur_annual_minimum_amount,
        fact.eur_annual_maximum_amount,
        fact.confidence_interval_minimum_amount,
        fact.confidence_interval_maximum_amount,
        fact.confidence_score,
        fact.sample_count,
        fact.source_id,
        fact.source_provenance,
        fact.source_snapshot_id,
        fact.source_url,
        fact.attribution,
        json.dumps(
            fact.fx_reference_payload,
            sort_keys=True,
            separators=(",", ":"),
        ),
        fact.as_of_date,
        fact.fetched_at,
        fact.fresh_until,
        fact.evidence_hash,
        fact.created_at,
    )


def _direct_from_row(row: Mapping[str, Any]) -> DirectBenchmarkFact:
    return DirectBenchmarkFact(
        tenant_id=str(row["tenant_id"]),
        fact_id=str(row["fact_id"]),
        taxonomy_version=str(row["taxonomy_version"]),
        role_family_code=str(row["role_family_code"]),
        seniority_label=str(row["seniority_label"]),  # type: ignore[arg-type]
        geography=BenchmarkGeography(
            country_code=str(row["country_code"]),
            scope=str(row["geography_scope"]),  # type: ignore[arg-type]
            subdivision_code=str(row["subdivision_code"]),
            locality=str(row["locality"]),
        ),
        market_scope=str(row["market_scope"]),  # type: ignore[arg-type]
        normalized_company=(str(row["normalized_company"]) if row["normalized_company"] is not None else None),
        component=str(row["component"]),  # type: ignore[arg-type]
        original_currency=str(row["original_currency"]),
        original_period=str(row["original_period"]),
        original_minimum_amount=int(row["original_minimum_amount"]),
        original_maximum_amount=int(row["original_maximum_amount"]),
        eur_annual_minimum_amount=int(row["eur_annual_minimum_amount"]),
        eur_annual_maximum_amount=int(row["eur_annual_maximum_amount"]),
        confidence_interval_minimum_amount=int(row["confidence_interval_minimum_amount"]),
        confidence_interval_maximum_amount=int(row["confidence_interval_maximum_amount"]),
        confidence_score=float(row["confidence_score"]),
        sample_count=int(row["sample_count"]),
        source_id=str(row["source_id"]),
        source_provenance=str(row["source_provenance"]),  # type: ignore[arg-type]
        source_snapshot_id=str(row["source_snapshot_id"]),
        source_url=str(row["source_url"]) if row["source_url"] is not None else None,
        attribution=str(row["attribution"]),
        fx_reference=_json_object(row["fx_reference_json"]),
        as_of_date=str(row["as_of_date"]),
        fetched_at=str(row["fetched_at"]),
        fresh_until=str(row["fresh_until"]),
        evidence_hash=str(row["evidence_hash"]),
        created_at=str(row["created_at"]),
    )


def _price_level_from_row(row: Mapping[str, Any]) -> PriceLevelFact:
    return PriceLevelFact(
        tenant_id=str(row["tenant_id"]),
        fact_id=str(row["fact_id"]),
        country_code=str(row["country_code"]),
        category=str(row["category"]),  # type: ignore[arg-type]
        reference_year=int(row["reference_year"]),
        base_geography_code=str(row["base_geography_code"]),
        index_value=float(row["index_value"]),
        source_id=str(row["source_id"]),  # type: ignore[arg-type]
        source_snapshot_id=str(row["source_snapshot_id"]),
        source_url=str(row["source_url"]),
        attribution=str(row["attribution"]),
        as_of_date=str(row["as_of_date"]),
        fetched_at=str(row["fetched_at"]),
        fresh_until=str(row["fresh_until"]),
        evidence_hash=str(row["evidence_hash"]),
        created_at=str(row["created_at"]),
    )


def _fetchone_mapping(cursor: sqlite3.Cursor) -> Mapping[str, Any] | None:
    row = cursor.fetchone()
    if row is None:
        return None
    if isinstance(row, sqlite3.Row):
        return dict(row)
    return dict(zip((column[0] for column in cursor.description), row, strict=True))


def _fetchall_mappings(cursor: sqlite3.Cursor) -> tuple[Mapping[str, Any], ...]:
    columns = tuple(column[0] for column in cursor.description)
    rows = cursor.fetchall()
    return tuple(dict(row) if isinstance(row, sqlite3.Row) else dict(zip(columns, row, strict=True)) for row in rows)


def _json_object(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _json_list(value: Any) -> list[Any]:
    try:
        parsed = json.loads(str(value or "[]"))
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


__all__ = ["SqliteCompensationBenchmarkRepository"]
