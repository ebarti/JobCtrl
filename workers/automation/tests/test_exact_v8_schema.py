from __future__ import annotations

import sqlite3

import pytest

from jobctrl.infrastructure.migrations.compensation_role_family_seed import (
    ROLE_FAMILY_TAXONOMY_VERSION,
)
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    EXACT_V8_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.schema_v8 import (
    create_exact_v8_schema,
    create_unstamped_exact_v8_candidate,
    upgrade_exact_v7_schema_to_v8,
)


def test_fresh_exact_v8_schema_has_separate_benchmark_authorities() -> None:
    conn = sqlite3.connect(":memory:")
    try:
        create_exact_v8_schema(conn)

        assert conn.execute("PRAGMA user_version").fetchone() == (8,)
        assert_exact_manifest(conn, EXACT_V8_MANIFEST)
        tables = {
            str(row[0])
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {
            "compensation_role_families",
            "compensation_direct_benchmark_facts",
            "compensation_price_level_facts",
            "compensation_extrapolated_benchmark_facts",
            "compensation_extrapolation_direct_inputs",
            "compensation_extrapolation_price_inputs",
            "compensation_market_refresh_state",
        } <= tables
        seeded = conn.execute(
            """
            SELECT role_family_code, display_name
            FROM compensation_role_families
            WHERE taxonomy_version = ?
            ORDER BY role_family_code
            """,
            (ROLE_FAMILY_TAXONOMY_VERSION,),
        ).fetchall()
        assert ("software_engineering", "Software Engineering") in seeded
        assert ("security_privacy", "Security & Privacy") in seeded
    finally:
        conn.close()


def test_unstamped_exact_v8_candidate_keeps_version_zero() -> None:
    conn = sqlite3.connect(":memory:")
    try:
        create_unstamped_exact_v8_candidate(conn)

        assert conn.execute("PRAGMA user_version").fetchone() == (0,)
        assert_exact_manifest(conn, EXACT_V8_MANIFEST)
    finally:
        conn.close()


def test_exact_v7_to_v8_upgrade_is_additive_and_seeds_taxonomy() -> None:
    conn = sqlite3.connect(":memory:")
    try:
        create_exact_v7_schema(conn)
        conn.execute(
            """
            INSERT INTO jobs (tenant_id, job_id, url, title, company, location)
            VALUES ('local', '11111111-1111-4111-8111-111111111111',
                    'https://jobs.example/1', 'Senior Platform Engineer', 'Acme', 'Spain')
            """
        )
        conn.commit()
        original_schema = schema_dump(conn)
        original_job = conn.execute("SELECT * FROM jobs").fetchone()

        upgrade_exact_v7_schema_to_v8(conn)

        assert conn.execute("PRAGMA user_version").fetchone() == (8,)
        assert_exact_manifest(conn, EXACT_V8_MANIFEST)
        assert conn.execute("SELECT * FROM jobs").fetchone() == original_job
        assert tuple(item for item in schema_dump(conn) if item in original_schema) == original_schema
        assert conn.execute("SELECT COUNT(*) FROM compensation_role_families").fetchone()[0] > 0
        assert conn.execute("SELECT COUNT(*) FROM compensation_direct_benchmark_facts").fetchone() == (0,)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        conn.close()


def test_exact_v7_to_v8_fault_rolls_back_to_exact_v7() -> None:
    conn = sqlite3.connect(":memory:")
    create_exact_v7_schema(conn)
    before = schema_dump(conn)
    executed = 0

    def fail_after_partial_addition(statement: str) -> object:
        nonlocal executed
        executed += 1
        if executed == 3:
            raise RuntimeError("synthetic v8 schema failure")
        return conn.execute(statement)

    try:
        with pytest.raises(RuntimeError, match="synthetic v8 schema failure"):
            upgrade_exact_v7_schema_to_v8(conn, _execute=fail_after_partial_addition)

        assert executed == 3
        assert conn.execute("PRAGMA user_version").fetchone() == (7,)
        assert schema_dump(conn) == before
        assert_exact_manifest(conn, EXACT_V7_MANIFEST)
    finally:
        conn.close()


def test_direct_and_extrapolated_benchmark_tables_are_append_only() -> None:
    conn = sqlite3.connect(":memory:")
    create_exact_v8_schema(conn)
    fact_id = "11111111-1111-4111-8111-111111111111"
    try:
        conn.execute(
            """
            INSERT INTO compensation_direct_benchmark_facts (
                tenant_id, fact_id, taxonomy_version, role_family_code,
                seniority_label, country_code, geography_scope, market_scope,
                component, original_currency, original_period,
                original_minimum_amount, original_maximum_amount,
                eur_annual_minimum_amount, eur_annual_maximum_amount,
                confidence_interval_minimum_amount,
                confidence_interval_maximum_amount, confidence_score,
                sample_count, source_id, source_provenance, source_snapshot_id,
                attribution, as_of_date, fetched_at, fresh_until, evidence_hash,
                created_at
            ) VALUES (
                'local', ?, ?, 'software_engineering', 'senior', 'ES', 'country',
                'market', 'base_salary', 'EUR', 'year', 80000, 100000, 80000,
                100000, 72000, 110000, 0.8, 10, 'levels_fyi', 'public',
                'levels-2026-08', 'Data source: Levels.fyi', '2026-08-01',
                '2026-08-11T10:00:00Z', '2026-08-18T10:00:00Z', ?,
                '2026-08-11T10:00:00Z'
            )
            """,
            (fact_id, ROLE_FAMILY_TAXONOMY_VERSION, "a" * 64),
        )

        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(
                "UPDATE compensation_direct_benchmark_facts SET sample_count = 11 WHERE fact_id = ?",
                (fact_id,),
            )
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(
                "DELETE FROM compensation_direct_benchmark_facts WHERE fact_id = ?",
                (fact_id,),
            )
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(
                """
                INSERT OR REPLACE INTO compensation_direct_benchmark_facts (
                    tenant_id, fact_id, taxonomy_version, role_family_code,
                    seniority_label, country_code, geography_scope, market_scope,
                    component, original_currency, original_period,
                    original_minimum_amount, original_maximum_amount,
                    eur_annual_minimum_amount, eur_annual_maximum_amount,
                    confidence_interval_minimum_amount,
                    confidence_interval_maximum_amount, confidence_score,
                    sample_count, source_id, source_provenance, source_snapshot_id,
                    attribution, as_of_date, fetched_at, fresh_until, evidence_hash,
                    created_at
                )
                SELECT
                    tenant_id, fact_id, taxonomy_version, role_family_code,
                    seniority_label, country_code, geography_scope, market_scope,
                    component, original_currency, original_period,
                    original_minimum_amount, original_maximum_amount,
                    eur_annual_minimum_amount, eur_annual_maximum_amount,
                    confidence_interval_minimum_amount,
                    confidence_interval_maximum_amount, confidence_score,
                    99, source_id, source_provenance, source_snapshot_id,
                    attribution, as_of_date, fetched_at, fresh_until, ?, created_at
                FROM compensation_direct_benchmark_facts
                WHERE fact_id = ?
                """,
                ("c" * 64, fact_id),
            )
        assert conn.execute(
            "SELECT sample_count, evidence_hash FROM compensation_direct_benchmark_facts WHERE fact_id = ?",
            (fact_id,),
        ).fetchone() == (10, "a" * 64)
    finally:
        conn.close()


def test_append_only_catalog_and_input_links_reject_insert_or_replace() -> None:
    conn = sqlite3.connect(":memory:")
    create_exact_v8_schema(conn)
    try:
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(
                """
                INSERT OR REPLACE INTO compensation_role_families (
                    taxonomy_version, role_family_code, display_name,
                    isco_codes_json, created_at
                ) VALUES (?, 'software_engineering', 'Replaced', '[]', '2026-08-11T10:00:00Z')
                """,
                (ROLE_FAMILY_TAXONOMY_VERSION,),
            )
        assert conn.execute(
            """
            SELECT display_name FROM compensation_role_families
            WHERE taxonomy_version = ? AND role_family_code = 'software_engineering'
            """,
            (ROLE_FAMILY_TAXONOMY_VERSION,),
        ).fetchone() == ("Software Engineering",)

        conn.execute("PRAGMA foreign_keys = ON")
        _insert_direct_fact(conn)
        _insert_extrapolated_fact(conn, raw_factor=1.2, bound_state="within_bounds")
        conn.execute(
            """
            INSERT INTO compensation_extrapolation_direct_inputs (
                tenant_id, extrapolated_fact_id, direct_fact_id, input_role, weight
            ) VALUES (
                'local', '22222222-2222-4222-8222-222222222222',
                '11111111-1111-4111-8111-111111111111', 'anchor', 1.0
            )
            """
        )
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(
                """
                INSERT OR REPLACE INTO compensation_extrapolation_direct_inputs (
                    tenant_id, extrapolated_fact_id, direct_fact_id, input_role, weight
                ) VALUES (
                    'local', '22222222-2222-4222-8222-222222222222',
                    '11111111-1111-4111-8111-111111111111', 'anchor', 0.2
                )
                """
            )
        assert conn.execute(
            "SELECT weight FROM compensation_extrapolation_direct_inputs"
        ).fetchone() == (1.0,)
    finally:
        conn.close()


@pytest.mark.parametrize(
    ("column", "value"),
    (
        ("isco_codes_json", "not-json"),
        ("isco_codes_json", "{}"),
    ),
)
def test_role_family_catalog_rejects_malformed_json(column: str, value: str) -> None:
    conn = sqlite3.connect(":memory:")
    create_exact_v8_schema(conn)
    try:
        with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
            conn.execute(
                f"""
                INSERT INTO compensation_role_families (
                    taxonomy_version, role_family_code, display_name, {column}, created_at
                ) VALUES ('test-v1', 'test', 'Test', ?, '2026-08-11T10:00:00Z')
                """,
                (value,),
            )
    finally:
        conn.close()


def test_direct_fact_rejects_wrong_fx_reference_json_type() -> None:
    conn = sqlite3.connect(":memory:")
    create_exact_v8_schema(conn)
    try:
        with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
            conn.execute(
                """
                INSERT INTO compensation_direct_benchmark_facts (
                    tenant_id, fact_id, taxonomy_version, role_family_code,
                    seniority_label, country_code, geography_scope, market_scope,
                    component, original_currency, original_period,
                    original_minimum_amount, original_maximum_amount,
                    eur_annual_minimum_amount, eur_annual_maximum_amount,
                    confidence_interval_minimum_amount,
                    confidence_interval_maximum_amount, confidence_score,
                    sample_count, source_id, source_provenance, source_snapshot_id,
                    attribution, fx_reference_json, as_of_date, fetched_at,
                    fresh_until, evidence_hash, created_at
                ) VALUES (
                    'local', '11111111-1111-4111-8111-111111111111', ?,
                    'software_engineering', 'senior', 'ES', 'country', 'market',
                    'base_salary', 'EUR', 'year', 80000, 100000, 80000, 100000,
                    72000, 110000, 0.8, 10, 'levels_fyi', 'public', 'levels-2026-08',
                    'Data source: Levels.fyi', '[]', '2026-08-01',
                    '2026-08-11T10:00:00Z', '2026-08-18T10:00:00Z', ?,
                    '2026-08-11T10:00:00Z'
                )
                """,
                (ROLE_FAMILY_TAXONOMY_VERSION, "a" * 64),
            )
    finally:
        conn.close()


@pytest.mark.parametrize(
    "authority",
    ("direct", "extrapolated", "refresh"),
)
def test_benchmark_authorities_reject_whitespace_geography_keys(authority: str) -> None:
    conn = sqlite3.connect(":memory:")
    create_exact_v8_schema(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        if authority == "direct":
            with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
                _insert_direct_fact(
                    conn,
                    subdivision_code=" ",
                    geography_scope="country_subdivision",
                )
        elif authority == "extrapolated":
            _insert_direct_fact(conn)
            with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
                _insert_extrapolated_fact(
                    conn,
                    raw_factor=1.2,
                    bound_state="within_bounds",
                    subdivision_code=" ",
                    geography_scope="country_subdivision",
                )
        else:
            with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
                conn.execute(
                    """
                    INSERT INTO compensation_market_refresh_state (
                        tenant_id, taxonomy_version, role_family_code,
                        seniority_label, country_code, subdivision_code,
                        geography_scope, component, refresh_status, updated_at
                    ) VALUES (
                        'local', ?, 'software_engineering', 'senior', 'ES', ' ',
                        'country_subdivision', 'base_salary', 'missing',
                        '2026-08-11T10:00:00Z'
                    )
                    """,
                    (ROLE_FAMILY_TAXONOMY_VERSION,),
                )
    finally:
        conn.close()


def test_out_of_bound_factor_requires_explicit_bound_state() -> None:
    conn = sqlite3.connect(":memory:")
    create_exact_v8_schema(conn)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        _insert_direct_fact(conn)

        with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
            _insert_extrapolated_fact(conn, raw_factor=12.0, bound_state="within_bounds")

        _insert_extrapolated_fact(conn, raw_factor=12.0, bound_state="above_upper_bound")
        row = conn.execute(
            """
            SELECT raw_factor, factor_bound_state, minimum_amount, maximum_amount
            FROM compensation_extrapolated_benchmark_facts
            """
        ).fetchone()
        assert row == (12.0, "above_upper_bound", 960000, 1200000)
    finally:
        conn.close()


def _insert_direct_fact(
    conn: sqlite3.Connection,
    *,
    subdivision_code: str = "",
    geography_scope: str = "country",
) -> None:
    conn.execute(
        """
        INSERT INTO compensation_direct_benchmark_facts (
            tenant_id, fact_id, taxonomy_version, role_family_code,
            seniority_label, country_code, subdivision_code, geography_scope,
            market_scope,
            component, original_currency, original_period,
            original_minimum_amount, original_maximum_amount,
            eur_annual_minimum_amount, eur_annual_maximum_amount,
            confidence_interval_minimum_amount,
            confidence_interval_maximum_amount, confidence_score,
            sample_count, source_id, source_provenance, source_snapshot_id,
            attribution, as_of_date, fetched_at, fresh_until, evidence_hash,
            created_at
        ) VALUES (
            'local', '11111111-1111-4111-8111-111111111111', ?,
            'software_engineering', 'senior', 'DE', ?, ?, 'market',
            'base_salary', 'EUR', 'year', 80000, 100000, 80000, 100000,
            72000, 110000, 0.8, 10, 'levels_fyi', 'public', 'levels-2026-08',
            'Data source: Levels.fyi', '2026-08-01', '2026-08-11T10:00:00Z',
            '2026-08-18T10:00:00Z', ?, '2026-08-11T10:00:00Z'
        )
        """,
        (
            ROLE_FAMILY_TAXONOMY_VERSION,
            subdivision_code,
            geography_scope,
            "a" * 64,
        ),
    )


def _insert_extrapolated_fact(
    conn: sqlite3.Connection,
    *,
    raw_factor: float,
    bound_state: str,
    subdivision_code: str = "",
    geography_scope: str = "country",
) -> None:
    conn.execute(
        """
        INSERT INTO compensation_extrapolated_benchmark_facts (
            tenant_id, fact_id, anchor_direct_fact_id, taxonomy_version,
            role_family_code, seniority_label, target_country_code,
            target_subdivision_code, target_geography_scope, component,
            currency, period,
            minimum_amount, maximum_amount,
            confidence_interval_minimum_amount,
            confidence_interval_maximum_amount, confidence_band,
            confidence_score, extrapolation_method, raw_factor,
            shrinkage_weight, lower_factor_bound, upper_factor_bound,
            factor_bound_state, matched_company_count, formula_version,
            inputs_hash, as_of_date, derived_at, fresh_until
        ) VALUES (
            'local', '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111', ?,
            'software_engineering', 'senior', 'CH', ?, ?, 'base_salary',
            'EUR', 'year', 960000, 1200000, 864000, 1320000, 'low', 0.25,
            'evidence_weighted_shrinkage', ?, 0.2, 0.1, 10.0, ?, 0,
            'geo-shrinkage-v1', ?, '2026-08-01', '2026-08-11T10:00:00Z',
            '2026-08-18T10:00:00Z'
        )
        """,
        (
            ROLE_FAMILY_TAXONOMY_VERSION,
            subdivision_code,
            geography_scope,
            raw_factor,
            bound_state,
            "b" * 64,
        ),
    )


def test_upgrade_rejects_non_exact_v7_without_mutation() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE jobs (id TEXT)")
    conn.execute("PRAGMA user_version = 7")
    before = schema_dump(conn)
    try:
        with pytest.raises(SchemaManifestError):
            upgrade_exact_v7_schema_to_v8(conn)
        assert conn.execute("PRAGMA user_version").fetchone() == (7,)
        assert schema_dump(conn) == before
    finally:
        conn.close()
