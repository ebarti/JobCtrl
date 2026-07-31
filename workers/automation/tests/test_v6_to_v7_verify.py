"""Adversarial contracts for the final v6-to-v7 candidate verifier."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from dataclasses import replace
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import schema_dump
from jobctrl.infrastructure.migrations.v6_to_v7_candidate import (
    CandidatePopulationResult,
    populate_v7_candidate,
)
from jobctrl.infrastructure.migrations.v6_to_v7_verify import (
    CandidateVerificationError,
    verify_and_stamp_v7_candidate,
    verify_v7_candidate,
)
from tests.v6_migration_fixture import create_shipped_v6_database


_MIGRATION_AT = "2026-07-31T12:00:00+00:00"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
_SOURCE_URL = "https://jobs.example/shipped-v6"
_SOURCE_TITLE = "Shipped V6 fixture"
_UNTRUSTED_ANALYSIS_CONTEXT = '{"userContext":"Attack vectors:\\nPrompt injection"}'


def _allocator(*values: str) -> Callable[[], str]:
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _connections(
    tmp_path: Path,
    *,
    name: str,
) -> tuple[sqlite3.Connection, sqlite3.Connection]:
    source_path = tmp_path / f"{name}-source.db"
    create_shipped_v6_database(source_path)
    source = sqlite3.connect(source_path)
    candidate = sqlite3.connect(tmp_path / f"{name}-candidate.db")
    source.execute("PRAGMA foreign_keys = ON")
    candidate.execute("PRAGMA foreign_keys = ON")
    return source, candidate


def _populate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    with_event_cursor: bool = False,
) -> CandidatePopulationResult:
    source.execute(
        "UPDATE jobs SET description = ? WHERE url = ?",
        (_UNTRUSTED_ANALYSIS_CONTEXT, _SOURCE_URL),
    )
    if with_event_cursor:
        source.execute(
            """
            INSERT INTO job_events (
                event_id, job_url, stage, event_type, level, message, occurred_at,
                payload_json, entity_kind, entity_ref, idempotency_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                7,
                _SOURCE_URL,
                "discover",
                "StageCompleted",
                "info",
                "verification fixture event",
                _MIGRATION_AT,
                None,
                "job",
                _SOURCE_URL,
                "verify-fixture-event",
            ),
        )
        source.execute("UPDATE sqlite_sequence SET seq = 41 WHERE name = 'job_events'")
    source.commit()
    source.execute("PRAGMA query_only = ON")
    population = populate_v7_candidate(
        source,
        candidate,
        migration_at=_MIGRATION_AT,
        job_id_factory=_allocator(_JOB_ID),
    )
    assert source.execute("PRAGMA query_only").fetchone() == (1,)
    assert candidate.execute("PRAGMA user_version").fetchone() == (0,)
    return population


def _candidate_dump(conn: sqlite3.Connection) -> tuple[object, ...]:
    return (
        schema_dump(conn),
        tuple(conn.iterdump()),
        _sequence_rows(conn),
    )


def _sequence_rows(conn: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").fetchone()
    if exists is None:
        return ()
    return tuple(tuple(row) for row in conn.execute("SELECT name, seq FROM sqlite_sequence ORDER BY name"))


def _assert_rejected_without_mutation(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    population: CandidatePopulationResult,
) -> None:
    before = _candidate_dump(candidate)
    with pytest.raises(CandidateVerificationError) as raised:
        verify_v7_candidate(source, candidate, population)
    assert _candidate_dump(candidate) == before
    assert candidate.execute("PRAGMA user_version").fetchone() == (0,)
    assert source.execute("PRAGMA query_only").fetchone() == (1,)
    message = str(raised.value)
    assert _SOURCE_URL not in message
    assert _SOURCE_TITLE not in message
    assert _UNTRUSTED_ANALYSIS_CONTEXT not in message


def test_verify_then_stamp_preserves_candidate_content_and_only_reports_metadata(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path, name="success")
    try:
        population = _populate(source, candidate, with_event_cursor=True)
        before_stamp = _candidate_dump(candidate)

        verified = verify_v7_candidate(source, candidate, population)

        assert verified.user_version == 0
        assert verified.job_count == 1
        assert verified.current_posting_locator_count == 1
        assert verified.table_row_counts == population.table_row_counts
        assert verified.sequence_high_watermarks == (
            ("job_artifacts", None),
            ("job_events", 41),
            ("operational_attempt_metrics", None),
        )
        assert candidate.execute("PRAGMA user_version").fetchone() == (0,)
        assert _candidate_dump(candidate) == before_stamp
        assert source.execute("PRAGMA query_only").fetchone() == (1,)
        assert _SOURCE_URL not in repr(verified)
        assert _SOURCE_TITLE not in repr(verified)
        assert _UNTRUSTED_ANALYSIS_CONTEXT not in repr(verified)

        stamped = verify_and_stamp_v7_candidate(source, candidate, population)

        assert stamped.user_version == 7
        assert stamped.job_count == verified.job_count
        assert stamped.current_posting_locator_count == verified.current_posting_locator_count
        assert stamped.table_row_counts == verified.table_row_counts
        assert stamped.sequence_high_watermarks == verified.sequence_high_watermarks
        assert candidate.execute("PRAGMA user_version").fetchone() == (7,)
        assert _candidate_dump(candidate) == before_stamp
        assert source.execute("PRAGMA query_only").fetchone() == (1,)
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    "replacement",
    (
        lambda result: replace(result, source_digest="0" * 64),
        lambda result: replace(result, source_total_changes=result.source_total_changes + 1),
    ),
    ids=("source-digest", "source-total-changes"),
)
def test_verify_rejects_tampered_population_source_handoff(
    tmp_path: Path,
    replacement: Callable[[CandidatePopulationResult], CandidatePopulationResult],
) -> None:
    source, candidate = _connections(tmp_path, name="source-handoff")
    try:
        population = _populate(source, candidate)
        _assert_rejected_without_mutation(source, candidate, replacement(population))
    finally:
        source.close()
        candidate.close()


def test_verify_rejects_a_durably_mutated_source_before_stamp(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path, name="source-mutation")
    try:
        population = _populate(source, candidate)
        source.execute("PRAGMA query_only = OFF")
        source.execute("UPDATE jobs SET title = ? WHERE url = ?", ("tampered", _SOURCE_URL))
        source.commit()
        source.execute("PRAGMA query_only = ON")

        _assert_rejected_without_mutation(source, candidate, population)
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize("tamper", ("step-order", "step-owner", "step-count", "aggregate-count"))
def test_verify_rejects_tampered_population_receipts(
    tmp_path: Path,
    tamper: str,
) -> None:
    source, candidate = _connections(tmp_path, name=f"receipt-{tamper}")
    try:
        population = _populate(source, candidate)
        first_step = population.steps[0]
        first_count = first_step.table_row_counts[0]
        first_total_count = population.table_row_counts[0]
        if tamper == "step-order":
            altered = replace(population, steps=tuple(reversed(population.steps)))
        elif tamper == "step-owner":
            altered = replace(
                population,
                steps=(replace(first_step, owned_tables=()), *population.steps[1:]),
            )
        elif tamper == "step-count":
            altered = replace(
                population,
                steps=(
                    replace(
                        first_step,
                        table_row_counts=((first_count[0], int(first_count[1]) + 1),),
                    ),
                    *population.steps[1:],
                ),
            )
        else:
            altered = replace(
                population,
                table_row_counts=(
                    (first_total_count[0], int(first_total_count[1]) + 1),
                    *population.table_row_counts[1:],
                ),
            )

        _assert_rejected_without_mutation(source, candidate, altered)
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    "tamper",
    (
        "preserved-scalar",
        "dependent-scalar",
        "structured-payload",
        "missing-locator",
        "extra-locator",
        "mismatched-locator",
        "unresolved-job-id",
        "noncanonical-job-id",
    ),
)
def test_verify_rejects_candidate_identity_and_scalar_tampering(
    tmp_path: Path,
    tamper: str,
) -> None:
    source, candidate = _connections(tmp_path, name=f"candidate-{tamper}")
    try:
        population = _populate(source, candidate)
        if tamper == "preserved-scalar":
            candidate.execute("UPDATE jobs SET title = 'tampered' WHERE tenant_id = 'local'")
        elif tamper == "dependent-scalar":
            candidate.execute("UPDATE dashboard_projections SET generated_at = 'tampered'")
        elif tamper == "structured-payload":
            candidate.execute(
                """UPDATE dashboard_projections
                SET funnel_json = '{"tampered":true}'"""
            )
        elif tamper == "missing-locator":
            candidate.execute("DELETE FROM job_locators WHERE tenant_id = 'local'")
        elif tamper == "extra-locator":
            candidate.execute(
                """
                INSERT INTO job_locators (
                    tenant_id, job_id, locator_kind, locator_value, is_current,
                    first_seen_at, last_seen_at, retired_at
                ) VALUES ('local', ?, 'posting_url', ?, 0, ?, ?, ?)
                """,
                (
                    _JOB_ID,
                    "https://tamper.example/extra",
                    _MIGRATION_AT,
                    _MIGRATION_AT,
                    _MIGRATION_AT,
                ),
            )
        elif tamper == "mismatched-locator":
            candidate.execute(
                "UPDATE job_locators SET locator_value = ? WHERE tenant_id = 'local'",
                ("https://tamper.example/mismatch",),
            )
        else:
            candidate.execute("PRAGMA foreign_keys = OFF")
            value = (
                "00000000-0000-4000-8000-000000000002" if tamper == "unresolved-job-id" else "not-a-canonical-job-id"
            )
            candidate.execute("UPDATE job_locators SET job_id = ? WHERE tenant_id = 'local'", (value,))
            candidate.commit()
            candidate.execute("PRAGMA foreign_keys = ON")
        if tamper not in {"unresolved-job-id", "noncanonical-job-id"}:
            candidate.commit()

        _assert_rejected_without_mutation(source, candidate, population)
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize("tamper", ("cursor-mismatch", "undeclared-sequence"))
def test_verify_rejects_sequence_cursor_tampering(
    tmp_path: Path,
    tamper: str,
) -> None:
    source, candidate = _connections(tmp_path, name=f"sequence-{tamper}")
    try:
        population = _populate(source, candidate, with_event_cursor=True)
        if tamper == "cursor-mismatch":
            candidate.execute("UPDATE sqlite_sequence SET seq = 42 WHERE name = 'job_events'")
        else:
            candidate.execute("INSERT INTO sqlite_sequence (name, seq) VALUES ('undeclared_sequence', 1)")
        candidate.commit()

        _assert_rejected_without_mutation(source, candidate, population)
    finally:
        source.close()
        candidate.close()


def test_stamp_rolls_back_after_post_stamp_failure_and_retries(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path, name="stamp-rollback")
    try:
        population = _populate(source, candidate, with_event_cursor=True)
        before_stamp = _candidate_dump(candidate)
        saw_stamped_version: list[int] = []

        def fail_after_stamp() -> None:
            saw_stamped_version.append(int(candidate.execute("PRAGMA user_version").fetchone()[0]))
            raise RuntimeError("forced post-stamp failure")

        with pytest.raises(RuntimeError, match="forced post-stamp failure"):
            verify_and_stamp_v7_candidate(
                source,
                candidate,
                population,
                _after_stamp=fail_after_stamp,
            )

        assert saw_stamped_version == [7]
        assert candidate.execute("PRAGMA user_version").fetchone() == (0,)
        assert _candidate_dump(candidate) == before_stamp
        assert source.execute("PRAGMA query_only").fetchone() == (1,)

        retried = verify_and_stamp_v7_candidate(source, candidate, population)

        assert retried.user_version == 7
        assert candidate.execute("PRAGMA user_version").fetchone() == (7,)
    finally:
        source.close()
        candidate.close()


def test_verify_rejects_stamped_candidates_and_stamp_is_not_repeatable(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path, name="already-stamped")
    try:
        population = _populate(source, candidate)
        stamped = verify_and_stamp_v7_candidate(source, candidate, population)
        before_repeat = _candidate_dump(candidate)

        with pytest.raises(CandidateVerificationError):
            verify_v7_candidate(source, candidate, population)
        with pytest.raises(CandidateVerificationError):
            verify_and_stamp_v7_candidate(source, candidate, population)

        assert stamped.user_version == 7
        assert candidate.execute("PRAGMA user_version").fetchone() == (7,)
        assert _candidate_dump(candidate) == before_repeat
        assert source.execute("PRAGMA query_only").fetchone() == (1,)
    finally:
        source.close()
        candidate.close()
