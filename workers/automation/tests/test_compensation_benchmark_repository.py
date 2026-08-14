from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace
from pathlib import Path
import sqlite3

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.compensation import (
    BenchmarkGeography,
    CompanyBenchmarkPair,
    ExtrapolationDirectInput,
    build_direct_benchmark_fact,
    build_price_level_fact,
    extrapolate_benchmark,
)
from jobctrl.infrastructure.compensation import (
    SqliteCompensationBenchmarkRepository,
)
from jobctrl.infrastructure.migrations.schema_v8 import create_exact_v8_schema


class _InterruptingConnection(sqlite3.Connection):
    interrupt_direct_lineage = False

    def executemany(
        self,
        sql: str,
        parameters: Iterable[tuple[object, ...]],
        /,
    ) -> sqlite3.Cursor:
        if self.interrupt_direct_lineage and "compensation_extrapolation_direct_inputs" in sql:
            self.interrupt_direct_lineage = False
            rows = iter(parameters)
            first = next(rows)
            super().executemany(sql, (first,))
            raise KeyboardInterrupt
        return super().executemany(sql, parameters)


def test_repository_supports_plain_sqlite_tuple_rows() -> None:
    conn = sqlite3.connect(":memory:")
    create_exact_v8_schema(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    repository = SqliteCompensationBenchmarkRepository(conn)
    try:
        fact = repository.save_direct(_direct(country="DE", marker="tuple-row"))
        assert repository.get_direct("local", fact.fact_id) == fact
    finally:
        conn.close()


def test_repository_rejects_posted_compensation_authority_tampering() -> None:
    conn = sqlite3.connect(":memory:")
    create_exact_v8_schema(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    repository = SqliteCompensationBenchmarkRepository(conn)
    try:
        fact = _direct(country="DE", marker="posted-tamper")
        object.__setattr__(fact, "source_provenance", "employer_posted")

        with pytest.raises(ValueError, match="posted compensation authority"):
            repository.save_direct(fact)

        assert conn.execute("SELECT COUNT(*) FROM compensation_direct_benchmark_facts").fetchone()[0] == 0
    finally:
        conn.close()


def test_repository_idempotently_persists_facts_and_lineage(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    repository = SqliteCompensationBenchmarkRepository(conn)
    try:
        anchor = repository.save_direct(_direct(country="DE", marker="anchor"))
        source_price = repository.save_price_level(_price(country="DE", index=100, marker="de"))
        target_price = repository.save_price_level(_price(country="ES", index=80, marker="es"))
        extrapolated = extrapolate_benchmark(
            anchor=anchor,
            target_geography=BenchmarkGeography("ES"),
            source_price_level=source_price,
            target_price_level=target_price,
            derived_at="2026-08-12T09:00:00Z",
        )

        assert repository.save_direct(anchor) == anchor
        assert repository.save_price_level(source_price) == source_price
        assert repository.save_extrapolated(extrapolated) == extrapolated
        assert repository.save_extrapolated(extrapolated) == extrapolated
        conn.commit()

        assert conn.execute("SELECT COUNT(*) FROM compensation_direct_benchmark_facts").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM compensation_price_level_facts").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM compensation_extrapolated_benchmark_facts").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM compensation_extrapolation_direct_inputs").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM compensation_extrapolation_price_inputs").fetchone()[0] == 2
        assert repository.get_direct("local", anchor.fact_id) == anchor
        assert repository.get_price_level("local", source_price.fact_id) == source_price
        assert repository.get_extrapolated("local", extrapolated.fact_id) == extrapolated
    finally:
        close_connection(db_path)


def test_repository_rejects_tampered_extrapolation_before_writing(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    repository = SqliteCompensationBenchmarkRepository(conn)
    try:
        anchor = repository.save_direct(_direct(country="DE", marker="anchor"))
        source_price = repository.save_price_level(_price(country="DE", index=100, marker="de"))
        target_price = repository.save_price_level(_price(country="ES", index=80, marker="es"))
        valid = extrapolate_benchmark(
            anchor=anchor,
            target_geography=BenchmarkGeography("ES"),
            source_price_level=source_price,
            target_price_level=target_price,
            derived_at="2026-08-12T09:00:00Z",
        )
        invalid = replace(valid)
        object.__setattr__(
            invalid,
            "direct_inputs",
            (
                *invalid.direct_inputs,
                ExtrapolationDirectInput(
                    direct_fact_id="99999999-9999-4999-8999-999999999999",
                    input_role="occupation_anchor",
                    weight=0.5,
                ),
            ),
        )

        with pytest.raises(ValueError, match="inputs_hash"):
            repository.save_extrapolated(invalid)

        assert conn.execute("SELECT COUNT(*) FROM compensation_extrapolated_benchmark_facts").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM compensation_extrapolation_direct_inputs").fetchone()[0] == 0
    finally:
        close_connection(db_path)


def test_extrapolation_write_rolls_back_on_keyboard_interrupt() -> None:
    conn = sqlite3.connect(":memory:", factory=_InterruptingConnection)
    create_exact_v8_schema(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    repository = SqliteCompensationBenchmarkRepository(conn)
    try:
        anchor = repository.save_direct(_direct(country="DE", marker="anchor"))
        source_price = repository.save_price_level(_price(country="DE", index=100, marker="de"))
        target_price = repository.save_price_level(_price(country="ES", index=80, marker="es"))
        fact = extrapolate_benchmark(
            anchor=anchor,
            target_geography=BenchmarkGeography("ES"),
            source_price_level=source_price,
            target_price_level=target_price,
            derived_at="2026-08-12T09:00:00Z",
        )
        conn.interrupt_direct_lineage = True

        with pytest.raises(KeyboardInterrupt):
            repository.save_extrapolated(fact)
        conn.commit()

        assert conn.execute("SELECT COUNT(*) FROM compensation_extrapolated_benchmark_facts").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM compensation_extrapolation_direct_inputs").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM compensation_extrapolation_price_inputs").fetchone()[0] == 0
        assert repository.save_extrapolated(fact) == fact
    finally:
        conn.close()


def test_latest_queries_apply_freshness_and_company_pair_scope(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    repository = SqliteCompensationBenchmarkRepository(conn)
    try:
        anchor = repository.save_direct(_direct(country="DE", marker="anchor"))
        company_source = repository.save_direct(_direct(country="DE", company="Acme", marker="acme-de"))
        company_target = repository.save_direct(_direct(country="ES", company="Acme", marker="acme-es"))
        repository.save_direct(
            _direct(
                country="DE",
                company="Acme",
                marker="acme-berlin",
                geography=BenchmarkGeography("DE", scope="locality", locality="Berlin"),
                fetched_at="2026-08-13T08:00:00Z",
                fresh_until="2026-08-20T08:00:00Z",
            )
        )
        repository.save_direct(
            _direct(
                country="ES",
                company="Acme",
                marker="acme-madrid",
                geography=BenchmarkGeography("ES", scope="locality", locality="Madrid"),
                fetched_at="2026-08-13T08:00:00Z",
                fresh_until="2026-08-20T08:00:00Z",
            )
        )
        unknown_anchor = repository.save_direct(_direct(country="GB", marker="unknown-gb", seniority_label="unknown"))
        repository.save_direct(
            _direct(
                country="DE",
                marker="berlin-market",
                geography=BenchmarkGeography("DE", scope="locality", locality="Berlin"),
                fetched_at="2026-08-13T08:00:00Z",
                fresh_until="2026-08-20T08:00:00Z",
            )
        )
        source_price = repository.save_price_level(_price(country="DE", index=100, marker="de"))
        target_price = repository.save_price_level(_price(country="ES", index=80, marker="es"))
        pairs = repository.matched_company_pairs(
            tenant_id="local",
            taxonomy_version=anchor.taxonomy_version,
            role_family_code=anchor.role_family_code,
            seniority_label=anchor.seniority_label,
            component=anchor.component,
            source_country_code="DE",
            target_country_code="ES",
            fresh_at="2026-08-15T00:00:00Z",
        )
        result = repository.save_extrapolated(
            extrapolate_benchmark(
                anchor=anchor,
                target_geography=BenchmarkGeography("ES"),
                source_price_level=source_price,
                target_price_level=target_price,
                company_pairs=pairs,
                derived_at="2026-08-12T09:00:00Z",
            )
        )
        conn.commit()

        assert pairs == (CompanyBenchmarkPair(source=company_source, target=company_target),)
        assert repository.fresh_market_anchors(
            tenant_id="local",
            taxonomy_version=anchor.taxonomy_version,
            role_family_code=anchor.role_family_code,
            seniority_label=anchor.seniority_label,
            component=anchor.component,
            exclude_country_code="ES",
            fresh_at="2026-08-15T00:00:00Z",
        ) == (anchor, unknown_anchor)
        assert repository.latest_compatible_price_levels(
            tenant_id="local",
            source_country_code="DE",
            target_country_code="ES",
            category="actual_individual_consumption",
            fresh_at="2026-08-15T00:00:00Z",
        ) == (source_price, target_price)
        assert (
            repository.latest_direct(
                tenant_id="local",
                taxonomy_version=anchor.taxonomy_version,
                role_family_code=anchor.role_family_code,
                seniority_label=anchor.seniority_label,
                geography=BenchmarkGeography("DE"),
                component=anchor.component,
                fresh_at="2026-08-15T00:00:00Z",
            )
            is not None
        )
        assert (
            repository.latest_direct(
                tenant_id="local",
                taxonomy_version=anchor.taxonomy_version,
                role_family_code=anchor.role_family_code,
                seniority_label=anchor.seniority_label,
                geography=BenchmarkGeography("DE"),
                component=anchor.component,
                fresh_at="2026-08-20T00:00:00Z",
            )
            is None
        )
        assert (
            repository.latest_extrapolated(
                tenant_id="local",
                taxonomy_version=result.taxonomy_version,
                role_family_code=result.role_family_code,
                seniority_label=result.seniority_label,
                geography=BenchmarkGeography("ES"),
                component=result.component,
                fresh_at="2026-08-15T00:00:00Z",
            )
            == result
        )
    finally:
        close_connection(db_path)


def _direct(
    *,
    country: str,
    marker: str,
    company: str | None = None,
    seniority_label: str = "senior",
    geography: BenchmarkGeography | None = None,
    fetched_at: str = "2026-08-12T08:00:00Z",
    fresh_until: str = "2026-08-19T08:00:00Z",
):
    return build_direct_benchmark_fact(
        tenant_id="local",
        role_family_code="software_engineering",
        seniority_label=seniority_label,
        geography=geography or BenchmarkGeography(country),
        market_scope="company" if company else "market",
        normalized_company=company,
        component="base_salary",
        original_currency="EUR",
        original_period="year",
        original_minimum_amount=80_000,
        original_maximum_amount=100_000,
        eur_annual_minimum_amount=80_000,
        eur_annual_maximum_amount=100_000,
        confidence_interval_minimum_amount=72_000,
        confidence_interval_maximum_amount=110_000,
        confidence_score=0.8,
        sample_count=10,
        source_id="test-source",
        source_provenance="manual",
        source_snapshot_id=f"snapshot-{marker}",
        source_url="https://example.com/source",
        attribution="Test compensation evidence",
        fx_reference={"rate_to_eur": 1, "reference_id": "eur-identity"},
        as_of_date="2026-08-01",
        fetched_at=fetched_at,
        fresh_until=fresh_until,
    )


def _price(*, country: str, index: float, marker: str):
    return build_price_level_fact(
        tenant_id="local",
        country_code=country,
        category="actual_individual_consumption",
        reference_year=2025,
        base_geography_code="EU27_2020=100",
        index_value=index,
        source_id="eurostat",
        source_snapshot_id="eurostat-shared-snapshot",
        source_url="https://ec.europa.eu/eurostat/",
        attribution="Eurostat purchasing power parities",
        as_of_date="2025-12-31",
        fetched_at="2026-08-12T08:00:00Z",
        fresh_until="2026-08-19T08:00:00Z",
    )
