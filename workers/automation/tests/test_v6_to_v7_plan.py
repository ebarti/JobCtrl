"""Coverage tests for the declarative v6-to-v7 migration inventory."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from pathlib import Path

from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_plan import (
    ColumnRole,
    TABLE_PLANS,
    TableDisposition,
    classify_column,
    required_source_tables,
    table_plan,
    target_tables,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    _V6_AUXILIARY_DDL,
    _V6_AUXILIARY_TABLE_VARIANTS,
)
from tests.v6_migration_fixture import (
    create_runtime_attestation_v6_database,
    create_runtime_attestation_upgrade_history_v6_database,
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)


def _tables(conn: sqlite3.Connection) -> dict[str, tuple[str, ...]]:
    return {
        str(row[0]): tuple(
            str(column[1])
            for column in conn.execute(f'PRAGMA table_info("{row[0]}")')
        )
        for row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    }


def _assert_covered(
    tables: dict[str, tuple[str, ...]],
    side: str,
) -> None:
    for table, columns in tables.items():
        plan = table_plan(table)
        assert plan is not None, f"unclassified {side} table: {table}"
        for column in columns:
            assert classify_column(table, column, side) is not None, (
                f"unclassified {side} column: {table}.{column}"
            )


def _open_fixture(
    tmp_path: Path,
    name: str,
    create: Callable[[Path], None],
) -> sqlite3.Connection:
    path = tmp_path / f"{name}.db"
    create(path)
    return sqlite3.connect(path)


def test_registry_covers_all_admitted_source_and_target_tables_and_columns(
    tmp_path: Path,
) -> None:
    with _open_fixture(tmp_path, "shipped-v6", create_shipped_v6_database) as v6:
        source = _tables(v6)
    assert set(source) == required_source_tables()
    _assert_covered(source, "source")

    with _open_fixture(
        tmp_path,
        "runtime-attestations-v6",
        create_runtime_attestation_v6_database,
    ) as runtime_attestations:
        _assert_covered(_tables(runtime_attestations), "source")

    with _open_fixture(
        tmp_path,
        "runtime-attestations-history-v6",
        create_runtime_attestation_upgrade_history_v6_database,
    ) as runtime_attestations_history:
        _assert_covered(_tables(runtime_attestations_history), "source")

    history_path = tmp_path / "upgrade-history.db"
    create_supported_upgrade_history_v6_database(history_path)
    with sqlite3.connect(history_path) as history:
        history_tables = _tables(history)
    assert set(history_tables) == required_source_tables() | {
        "discovery_run_projections"
    }
    _assert_covered(history_tables, "source")

    with _open_fixture(tmp_path, "optional-v6", create_shipped_v6_database) as optional:
        for statement in _V6_AUXILIARY_DDL:
            optional.execute(statement)
        optional.commit()
        optional_tables = _tables(optional)
    _assert_covered(optional_tables, "source")

    with sqlite3.connect(tmp_path / "exact-v7.db") as v7:
        create_exact_v7_schema(v7)
        target = _tables(v7)
    assert set(target) == target_tables()
    _assert_covered(target, "target")


def test_registry_covers_every_admitted_optional_table_variant() -> None:
    for table_name, variants in _V6_AUXILIARY_TABLE_VARIANTS.items():
        for ddl in variants:
            with sqlite3.connect(":memory:") as conn:
                conn.executescript(ddl)
                tables = _tables(conn)
            assert set(tables) == {table_name}
            _assert_covered(tables, "source")


def test_both_admitted_core_variants_have_the_same_semantic_plan(
    tmp_path: Path,
) -> None:
    shipped_path = tmp_path / "shipped-v6.db"
    history_path = tmp_path / "upgrade-history.db"
    create_shipped_v6_database(shipped_path)
    create_supported_upgrade_history_v6_database(history_path)

    with sqlite3.connect(shipped_path) as shipped, sqlite3.connect(history_path) as history:
        shipped_tables = _tables(shipped)
        history_tables = _tables(history)

    common = set(shipped_tables) & set(history_tables)
    assert common == required_source_tables()
    for table in common:
        assert {
            (column, classify_column(table, column, "source"))
            for column in shipped_tables[table]
        } == {
            (column, classify_column(table, column, "source"))
            for column in history_tables[table]
        }


def test_identity_locator_and_sequence_roles_are_not_inferred_from_names() -> None:
    assert {plan.disposition for plan in TABLE_PLANS.values()} == set(
        TableDisposition
    )
    assert table_plan("job_locators").disposition is TableDisposition.STRUCTURED_REWRITE
    assert (
        table_plan("jobctrl_hidden_jobs").disposition
        is TableDisposition.SCALAR_JOB_ID_REWRITE
    )
    assert not table_plan("jobctrl_hidden_jobs").source_required
    for table in (
        "application_email_evidence",
        "application_outcome_suggestions",
        "application_outcomes",
    ):
        plan = table_plan(table)
        assert plan is not None
        assert plan.disposition is TableDisposition.SCALAR_JOB_ID_REWRITE
        assert not plan.source_required
        assert classify_column(table, "job_key", "source") is ColumnRole.LEGACY_URL_IDENTITY
        assert classify_column(table, "job_id", "target") is ColumnRole.JOB_ID
    assert (
        classify_column("apply_run_projections", "job_id", "source")
        is ColumnRole.UNCHANGED_SCHEMA_URL_IDENTITY
    )
    assert (
        classify_column("apply_run_projections", "job_id", "target")
        is ColumnRole.JOB_ID
    )
    assert (
        classify_column("jobs", "url", "source")
        is ColumnRole.LEGACY_URL_IDENTITY
    )
    assert classify_column("jobs", "url", "target") is ColumnRole.LOCATOR_URL
    assert (
        classify_column("job_source_observations", "observed_url", "source")
        is ColumnRole.LOCATOR_URL
    )
    assert table_plan("job_events").sequence_owned
    assert (
        classify_column("job_events", "event_id", "target")
        is ColumnRole.SEQUENCE_OWNED
    )
    assert table_plan("discovery_run_projections").disposition is TableDisposition.RETIRED


def test_transformation_sensitive_columns_are_explicitly_classified() -> None:
    structured = ColumnRole.STRUCTURED_REFERENCE
    assert classify_column("job_events", "job_url", "source") is ColumnRole.LEGACY_URL_IDENTITY
    assert classify_column("job_events", "payload_json", "source") is structured
    assert classify_column("job_events", "payload_json", "target") is structured
    assert classify_column("job_events", "entity_ref", "source") is structured
    assert classify_column("job_events", "entity_ref", "target") is structured
    assert classify_column("discovery_quarantine_entries", "job_key", "source") is structured
    assert classify_column("discovery_quarantine_entries", "job_id", "source") is structured
    assert (
        classify_column("discovery_quarantine_entries", "job_id", "target")
        is ColumnRole.JOB_ID
    )
    assert classify_column("preparation_work_items", "idempotency_key", "source") is structured
    assert classify_column("preparation_work_items", "idempotency_key", "target") is structured
    assert classify_column("evidence_usage_projections", "projection_id", "source") is structured
    assert classify_column("evidence_usage_projections", "projection_id", "target") is structured
    assert classify_column("evidence_usage_projections", "payload_json", "source") is structured
    assert classify_column("workflow_run_projections", "input_summary_json", "target") is structured
    assert classify_column("workflow_run_projections", "events_json", "source") is structured
    assert classify_column("jobctrl_deleted_jobs", "tenant_id", "target") is ColumnRole.DERIVED
    assert classify_column("jobctrl_hidden_jobs", "tenant_id", "target") is ColumnRole.DERIVED
    for column in (
        "application_attestation_age_18_plus",
        "application_attestation_background_check_consent",
        "application_attestation_felony_conviction",
        "application_attestation_previously_worked_at_employer",
        "application_attestation_additional_json",
        "application_preference_how_heard",
    ):
        assert classify_column("candidate_profiles", column, "source") is ColumnRole.PRESERVE
        assert classify_column("candidate_profiles", column, "target") is ColumnRole.PRESERVE


def test_registry_rejects_unknown_tables_and_columns() -> None:
    assert table_plan("future_job_projection") is None
    assert classify_column("future_job_projection", "job_id", "source") is None
    assert classify_column("jobs", "future_job_id", "source") is None
    assert classify_column("jobs", "future_job_id", "target") is None
