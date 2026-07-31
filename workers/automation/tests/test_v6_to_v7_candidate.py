"""End-to-end safety contracts for v6-to-v7 candidate population."""

from __future__ import annotations

import sqlite3
from collections import Counter
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.v6_to_v7_candidate import (
    CandidatePopulationError,
    candidate_logical_digest,
    populate_v7_candidate,
    source_logical_digest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import CandidateCopyError
from jobctrl.infrastructure.migrations.v6_to_v7_plan import target_tables
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    V6MigrationPreflightError,
)
from tests.v6_migration_fixture import (
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)


_MIGRATION_AT = "2026-07-31T10:00:00+00:00"
_SOURCE_URL = "https://jobs.example/shipped-v6"
_SOURCE_TITLE = "Shipped V6 fixture"
_STEP_IDS = (
    "root",
    "direct_scalar",
    "duplicate_links",
    "events",
    "work_items",
    "contact_projections",
    "pipeline_step_projections",
    "workflow_run_projections",
    "apply_run_projections",
    "artifact_list_projections",
    "job_detail_projections",
    "evidence_usage_projections",
    "job_list_projections",
    "dashboard_projections",
)
_JOB_IDS = (
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
)


def _allocator(*values: str) -> Callable[[], str]:
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _connections(
    tmp_path: Path,
    *,
    source_name: str = "source.db",
    candidate_name: str = "candidate.db",
    history: bool = False,
) -> tuple[sqlite3.Connection, sqlite3.Connection]:
    source_path = tmp_path / source_name
    create = create_supported_upgrade_history_v6_database if history else create_shipped_v6_database
    create(source_path)
    source = sqlite3.connect(source_path)
    candidate = sqlite3.connect(tmp_path / candidate_name)
    source.execute("PRAGMA foreign_keys = ON")
    candidate.execute("PRAGMA foreign_keys = ON")
    return source, candidate


def _logical_dump(conn: sqlite3.Connection) -> tuple[object, ...]:
    return (
        conn.execute("PRAGMA user_version").fetchone()[0],
        schema_dump(conn),
        tuple(conn.iterdump()),
    )


def _source_snapshot(conn: sqlite3.Connection) -> tuple[object, ...]:
    return (
        conn.execute("PRAGMA schema_version").fetchone()[0],
        conn.execute("PRAGMA user_version").fetchone()[0],
        conn.total_changes,
        _logical_dump(conn),
    )


def _assert_source_unchanged(
    conn: sqlite3.Connection,
    snapshot: tuple[object, ...],
) -> None:
    assert _source_snapshot(conn) == snapshot


def _assert_raw_candidate(conn: sqlite3.Connection) -> None:
    assert schema_dump(conn) == ()
    assert conn.execute("PRAGMA user_version").fetchone() == (0,)
    assert conn.execute("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'").fetchone() is None


def _sequence_rows(conn: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").fetchone() is None:
        return ()
    return tuple(conn.execute("SELECT name, seq FROM sqlite_sequence ORDER BY name"))


def _assert_successful_result(
    result: object,
    candidate: sqlite3.Connection,
    *,
    source_digest: str,
    source_total_changes: int,
) -> None:
    assert getattr(result, "migration_at") == _MIGRATION_AT
    candidate_digest = getattr(result, "candidate_digest")
    assert candidate_digest == candidate_logical_digest(candidate)
    assert len(candidate_digest) == 64
    assert int(candidate_digest, 16) >= 0
    observed_source_digest = getattr(result, "source_digest")
    assert observed_source_digest == source_digest
    assert len(observed_source_digest) == 64
    assert int(observed_source_digest, 16) >= 0
    assert getattr(result, "source_total_changes") == source_total_changes
    receipts = tuple(getattr(result, "steps"))
    assert tuple(getattr(receipt, "step_id") for receipt in receipts) == _STEP_IDS
    assert len(receipts) == len(_STEP_IDS)

    owned_tables = [table for receipt in receipts for table in getattr(receipt, "owned_tables")]
    assert set(owned_tables) == target_tables()
    assert Counter(owned_tables) == Counter(set(owned_tables))
    assert len(owned_tables) == EXACT_V7_MANIFEST.table_count

    for receipt in receipts:
        counts = dict(getattr(receipt, "table_row_counts"))
        assert set(counts) == set(getattr(receipt, "owned_tables"))
        for table, count in counts.items():
            assert candidate.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone() == (count,)

    receipt_counts = tuple(
        sorted((table, count) for receipt in receipts for table, count in getattr(receipt, "table_row_counts"))
    )
    assert tuple(getattr(result, "table_row_counts")) == receipt_counts

    assert getattr(result, "event_sequence_high_water") == next(
        (int(seq) for name, seq in _sequence_rows(candidate) if name == "job_events"),
        None,
    )
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    assert candidate.execute("PRAGMA user_version").fetchone() == (0,)
    assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    assert candidate.execute("PRAGMA integrity_check").fetchall() == [("ok",)]


def _callback_step_id(args: tuple[object, ...], kwargs: dict[str, object]) -> str | None:
    for value in (*args, *kwargs.values()):
        step_id = getattr(value, "step_id", value)
        if isinstance(step_id, str) and step_id in _STEP_IDS:
            return step_id
    return None


def test_population_builds_an_exact_unstamped_candidate_without_exposing_source_data(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path)
    try:
        source.execute("PRAGMA query_only = 1")
        before = _source_snapshot(source)

        result = populate_v7_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(*_JOB_IDS),
        )

        _assert_successful_result(
            result,
            candidate,
            source_digest=source_logical_digest(source),
            source_total_changes=int(before[2]),
        )
        _assert_source_unchanged(source, before)
        assert source.execute("PRAGMA query_only").fetchone() == (1,)
        assert _SOURCE_URL not in repr(result)
        assert _SOURCE_TITLE not in repr(result)

        candidate.execute("PRAGMA user_version = 7")
        assert candidate_logical_digest(candidate) == result.candidate_digest
        candidate.execute("PRAGMA user_version = 0")
        candidate.execute("UPDATE dashboard_projections SET generated_at = 'tampered'")
        candidate.commit()
        assert candidate_logical_digest(candidate) != result.candidate_digest
    finally:
        source.close()
        candidate.close()


def test_population_is_deterministic_for_fresh_equivalent_candidates(
    tmp_path: Path,
) -> None:
    source, first = _connections(tmp_path, candidate_name="first.db")
    second_source, second = _connections(
        tmp_path,
        source_name="second-source.db",
        candidate_name="second.db",
    )
    try:
        first_result = populate_v7_candidate(
            source,
            first,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(*_JOB_IDS),
        )
        second_result = populate_v7_candidate(
            second_source,
            second,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(*_JOB_IDS),
        )

        assert second_result == first_result
        assert _logical_dump(second) == _logical_dump(first)
        assert _sequence_rows(second) == _sequence_rows(first)
    finally:
        source.close()
        first.close()
        second_source.close()
        second.close()


def test_population_rolls_back_a_late_failure_and_retries_from_the_same_raw_candidate(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path)
    reference_source, reference = _connections(
        tmp_path,
        source_name="reference-source.db",
        candidate_name="reference.db",
    )
    seen_steps: list[str] = []
    source.execute("PRAGMA query_only = 0")
    before = _source_snapshot(source)

    def fail_after_dashboard(*args: object, **kwargs: object) -> None:
        assert source.execute("PRAGMA query_only").fetchone() == (1,)
        step_id = _callback_step_id(args, dict(kwargs))
        if step_id is not None:
            seen_steps.append(step_id)
        if step_id == "dashboard_projections":
            raise RuntimeError("forced failure after dashboard projection rebuild")

    try:
        with pytest.raises(RuntimeError, match="forced failure"):
            populate_v7_candidate(
                source,
                candidate,
                migration_at=_MIGRATION_AT,
                job_id_factory=_allocator(*_JOB_IDS),
                _after_step=fail_after_dashboard,
            )

        assert seen_steps[-1:] == ["dashboard_projections"]
        _assert_raw_candidate(candidate)
        _assert_source_unchanged(source, before)
        assert source.execute("PRAGMA query_only").fetchone() == (0,)

        retry_result = populate_v7_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(*_JOB_IDS),
        )
        reference_result = populate_v7_candidate(
            reference_source,
            reference,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(*_JOB_IDS),
        )

        assert retry_result == reference_result
        assert _logical_dump(candidate) == _logical_dump(reference)
    finally:
        source.close()
        candidate.close()
        reference_source.close()
        reference.close()


def test_population_rejects_invalid_entry_states_without_mutating_candidates(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path)
    try:
        candidate.execute("PRAGMA user_version = 6")
        before = _logical_dump(candidate)
        with pytest.raises(CandidatePopulationError):
            populate_v7_candidate(source, candidate, migration_at=_MIGRATION_AT)
        assert _logical_dump(candidate) == before
    finally:
        source.close()
        candidate.close()

    source, candidate = _connections(
        tmp_path,
        source_name="nonempty-source.db",
        candidate_name="nonempty-candidate.db",
    )
    try:
        candidate.execute("CREATE TABLE unrelated_entry_state (value TEXT)")
        before = _logical_dump(candidate)
        with pytest.raises(CandidatePopulationError):
            populate_v7_candidate(source, candidate, migration_at=_MIGRATION_AT)
        assert _logical_dump(candidate) == before
    finally:
        source.close()
        candidate.close()

    source, candidate = _connections(
        tmp_path,
        source_name="residual-source.db",
        candidate_name="residual-candidate.db",
    )
    try:
        candidate.execute("CREATE TABLE discarded (id INTEGER PRIMARY KEY AUTOINCREMENT)")
        candidate.execute("DROP TABLE discarded")
        before = _logical_dump(candidate)
        with pytest.raises(
            CandidatePopulationError,
            match="requires a raw empty schema",
        ):
            populate_v7_candidate(source, candidate, migration_at=_MIGRATION_AT)
        assert _logical_dump(candidate) == before
    finally:
        source.close()
        candidate.close()

    source, candidate = _connections(
        tmp_path,
        source_name="transaction-source.db",
        candidate_name="transaction-candidate.db",
    )
    try:
        candidate.execute("BEGIN")
        before = _logical_dump(candidate)
        with pytest.raises(CandidatePopulationError):
            populate_v7_candidate(source, candidate, migration_at=_MIGRATION_AT)
        assert candidate.in_transaction
        assert _logical_dump(candidate) == before
        candidate.execute("ROLLBACK")
    finally:
        source.close()
        candidate.close()

    source, unused_candidate = _connections(tmp_path, source_name="same-source.db")
    try:
        before = _source_snapshot(source)
        with pytest.raises(CandidatePopulationError):
            populate_v7_candidate(source, source, migration_at=_MIGRATION_AT)
        _assert_source_unchanged(source, before)
    finally:
        source.close()
        unused_candidate.close()

    unsupported = sqlite3.connect(tmp_path / "unsupported.db")
    unsupported.execute("CREATE TABLE unrelated_source (value TEXT)")
    candidate = sqlite3.connect(tmp_path / "unsupported-candidate.db")
    try:
        before = _logical_dump(candidate)
        with pytest.raises(V6MigrationPreflightError):
            populate_v7_candidate(unsupported, candidate, migration_at=_MIGRATION_AT)
        assert _logical_dump(candidate) == before
    finally:
        unsupported.close()
        candidate.close()


def test_population_accepts_an_empty_shipped_workspace_without_spurious_rows(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path)
    try:
        source.execute("DELETE FROM jobs")
        source.commit()

        result = populate_v7_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(*_JOB_IDS),
        )

        _assert_successful_result(
            result,
            candidate,
            source_digest=source_logical_digest(source),
            source_total_changes=source.total_changes,
        )
        nonempty_rows = {
            table: candidate.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            for table in sorted(target_tables())
            if candidate.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        }
        assert nonempty_rows == {
            "dashboard_projections": 1,
            "resume_template_versions": 1,
            "resume_templates": 1,
        }
        assert _sequence_rows(candidate) == ()
    finally:
        source.close()
        candidate.close()


def test_population_seeds_the_builtin_template_when_v6_omits_it(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path)
    try:
        source.execute("DELETE FROM job_resume_template_assignments")
        source.execute("DELETE FROM resume_template_defaults")
        source.execute("DELETE FROM resume_template_versions")
        source.execute("DELETE FROM resume_templates")
        source.commit()

        result = populate_v7_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(*_JOB_IDS),
        )

        _assert_successful_result(
            result,
            candidate,
            source_digest=source_logical_digest(source),
            source_total_changes=source.total_changes,
        )
        assert candidate.execute(
            """
            SELECT template_id, version_id
            FROM resume_templates
            JOIN resume_template_versions USING (tenant_id, template_id)
            """
        ).fetchall() == [("built_in:modern-html", "built_in:modern-html:v1")]
    finally:
        source.close()
        candidate.close()


def test_population_accepts_only_empty_retired_upgrade_history_tables(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path, history=True)
    try:
        result = populate_v7_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(*_JOB_IDS),
        )
        _assert_successful_result(
            result,
            candidate,
            source_digest=source_logical_digest(source),
            source_total_changes=source.total_changes,
        )
    finally:
        source.close()
        candidate.close()

    source, candidate = _connections(
        tmp_path,
        source_name="retired-source.db",
        candidate_name="retired-candidate.db",
        history=True,
    )
    try:
        source.execute("INSERT INTO discovery_run_projections (run_id) VALUES ('retired-run')")
        source.commit()
        before = _source_snapshot(source)

        with pytest.raises(CandidateCopyError):
            populate_v7_candidate(
                source,
                candidate,
                migration_at=_MIGRATION_AT,
                job_id_factory=_allocator(*_JOB_IDS),
            )

        _assert_raw_candidate(candidate)
        _assert_source_unchanged(source, before)
    finally:
        source.close()
        candidate.close()
