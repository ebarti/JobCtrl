"""Focused v6 feedback-table candidate-copy contracts."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.gmail.feedback import ensure_application_feedback_tables
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    CandidateCopyError,
    copy_direct_and_scalar_tables,
)
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from tests.v6_migration_fixture import create_shipped_v6_database

_JOB_URL = "https://jobs.example/shipped-v6"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
# Inert synthetic payload: migration code copies it as data and never interprets it.
_UNTRUSTED_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}


def _allocator(*values: str):
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _connections(
    tmp_path: Path,
    *,
    with_interview_prep_generation: bool,
) -> tuple[sqlite3.Connection, sqlite3.Connection, Path, Path]:
    source_path = tmp_path / "source.db"
    create_shipped_v6_database(source_path)
    source = sqlite3.connect(source_path)
    source.execute("PRAGMA foreign_keys = ON")
    ensure_application_feedback_tables(source)
    if with_interview_prep_generation:
        source.execute(
            "ALTER TABLE application_outcomes ADD COLUMN interview_prep_generation INTEGER"
        )

    candidate_path = tmp_path / "candidate.db"
    candidate = sqlite3.connect(candidate_path)
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    copy_root_jobs(
        source,
        candidate,
        job_id_factory=_allocator(_JOB_ID),
        migration_at="2026-07-30T10:00:00+00:00",
    )
    return source, candidate, source_path, candidate_path


def _seed_feedback_rows(
    source: sqlite3.Connection,
    *,
    outcome_job_key: str = _JOB_URL,
    interview_prep_generation: int | None = None,
) -> None:
    untrusted_text = json.dumps(_UNTRUSTED_CONTEXT, separators=(",", ":"))
    source.execute(
        """
        INSERT INTO application_email_evidence (
            tenant_id, evidence_id, job_key, provider, provider_message_id,
            provider_thread_id, from_address, to_addresses_json, subject, snippet,
            received_at, linked_at, link_confidence, link_signals_json,
            body_text, body_sha256, body_stored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            "evidence-1",
            _JOB_URL,
            "gmail",
            "message-1",
            "thread-1",
            "recruiter@example.test",
            '["candidate@example.test"]',
            "Application update",
            "We would like to schedule an interview.",
            "2026-07-30T10:00:00+00:00",
            "2026-07-30T10:01:00+00:00",
            0.93,
            '["recipient","subject"]',
            untrusted_text,
            "sha256-fixture",
            "2026-07-30T10:01:00+00:00",
        ),
    )
    source.execute(
        """
        INSERT INTO application_outcome_suggestions (
            tenant_id, suggestion_id, job_key, evidence_id, suggested_kind,
            confidence, rationale, status, created_at, decided_at, decision,
            decision_reason, decided_outcome_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            "suggestion-1",
            _JOB_URL,
            "evidence-1",
            "interview",
            0.91,
            "Interview wording is explicit.",
            "accepted",
            "2026-07-30T10:02:00+00:00",
            "2026-07-30T10:03:00+00:00",
            "accept",
            "User confirmed.",
            "outcome-1",
        ),
    )
    outcome_columns = [
        "tenant_id",
        "outcome_id",
        "job_key",
        "kind",
        "source",
        "note",
        "occurred_at",
        "recorded_at",
        "suggestion_id",
        "evidence_id",
        "created_by",
    ]
    outcome_values: list[object] = [
        "local",
        "outcome-1",
        outcome_job_key,
        "interview",
        "gmail",
        "User confirmed the interview invitation.",
        "2026-07-30T10:04:00+00:00",
        "2026-07-30T10:05:00+00:00",
        "suggestion-1",
        "evidence-1",
        "user",
    ]
    if interview_prep_generation is not None:
        outcome_columns.append("interview_prep_generation")
        outcome_values.append(interview_prep_generation)
    source.execute(
        f"INSERT INTO application_outcomes ({', '.join(outcome_columns)}) "
        f"VALUES ({', '.join('?' for _ in outcome_columns)})",
        outcome_values,
    )
    source.commit()


@pytest.mark.parametrize(
    ("with_interview_prep_generation", "expected_generation"),
    ((False, None), (True, 7)),
)
def test_candidate_copy_preserves_admitted_feedback_rows_and_reopens(
    tmp_path: Path,
    with_interview_prep_generation: bool,
    expected_generation: int | None,
) -> None:
    source, candidate, source_path, candidate_path = _connections(
        tmp_path,
        with_interview_prep_generation=with_interview_prep_generation,
    )
    try:
        _seed_feedback_rows(
            source,
            interview_prep_generation=expected_generation,
        )
        source_changes = source.total_changes
        source_bytes = source_path.read_bytes()
        source_evidence = source.execute(
            "SELECT to_addresses_json, link_signals_json, body_text "
            "FROM application_email_evidence"
        ).fetchone()

        copied = copy_direct_and_scalar_tables(source, candidate)

        assert {
            "application_email_evidence",
            "application_outcome_suggestions",
            "application_outcomes",
        }.issubset(copied)
        assert candidate.execute(
            """
            SELECT tenant_id, evidence_id, job_id, provider, provider_message_id,
                   provider_thread_id, from_address, to_addresses_json, subject,
                   snippet, received_at, linked_at, link_confidence,
                   link_signals_json, body_text, body_sha256, body_stored_at
            FROM application_email_evidence
            """
        ).fetchone() == (
            "local",
            "evidence-1",
            _JOB_ID,
            "gmail",
            "message-1",
            "thread-1",
            "recruiter@example.test",
            '["candidate@example.test"]',
            "Application update",
            "We would like to schedule an interview.",
            "2026-07-30T10:00:00+00:00",
            "2026-07-30T10:01:00+00:00",
            0.93,
            '["recipient","subject"]',
            json.dumps(_UNTRUSTED_CONTEXT, separators=(",", ":")),
            "sha256-fixture",
            "2026-07-30T10:01:00+00:00",
        )
        assert candidate.execute(
            """
            SELECT tenant_id, suggestion_id, job_id, evidence_id, suggested_kind,
                   confidence, rationale, status, created_at, decided_at, decision,
                   decision_reason, decided_outcome_id
            FROM application_outcome_suggestions
            """
        ).fetchone() == (
            "local",
            "suggestion-1",
            _JOB_ID,
            "evidence-1",
            "interview",
            0.91,
            "Interview wording is explicit.",
            "accepted",
            "2026-07-30T10:02:00+00:00",
            "2026-07-30T10:03:00+00:00",
            "accept",
            "User confirmed.",
            "outcome-1",
        )
        assert candidate.execute(
            """
            SELECT tenant_id, outcome_id, job_id, kind, source, note, occurred_at,
                   recorded_at, suggestion_id, evidence_id, created_by,
                   interview_prep_generation
            FROM application_outcomes
            """
        ).fetchone() == (
            "local",
            "outcome-1",
            _JOB_ID,
            "interview",
            "gmail",
            "User confirmed the interview invitation.",
            "2026-07-30T10:04:00+00:00",
            "2026-07-30T10:05:00+00:00",
            "suggestion-1",
            "evidence-1",
            "user",
            expected_generation,
        )
        assert candidate.execute(
            "SELECT to_addresses_json, link_signals_json, body_text "
            "FROM application_email_evidence"
        ).fetchone() == source_evidence
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
        assert source.total_changes == source_changes
        assert source_path.read_bytes() == source_bytes

        candidate.commit()
        candidate.close()
        candidate = sqlite3.connect(candidate_path)
        candidate.execute("PRAGMA foreign_keys = ON")
        assert candidate.execute(
            "SELECT COUNT(*) FROM application_email_evidence"
        ).fetchone() == (1,)
        assert candidate.execute(
            "SELECT COUNT(*) FROM application_outcome_suggestions"
        ).fetchone() == (1,)
        assert candidate.execute(
            "SELECT COUNT(*) FROM application_outcomes"
        ).fetchone() == (1,)
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_candidate_copy_rolls_back_feedback_rows_and_retries(
    tmp_path: Path,
) -> None:
    source, candidate, source_path, _ = _connections(
        tmp_path,
        with_interview_prep_generation=False,
    )
    try:
        _seed_feedback_rows(source, outcome_job_key="https://jobs.example/missing")
        source_changes = source.total_changes
        source_bytes = source_path.read_bytes()

        with pytest.raises(CandidateCopyError, match="cannot resolve a legacy job locator"):
            copy_direct_and_scalar_tables(source, candidate)

        for table in (
            "application_email_evidence",
            "application_outcome_suggestions",
            "application_outcomes",
        ):
            assert candidate.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == (0,)
        assert source.total_changes == source_changes
        assert source_path.read_bytes() == source_bytes

        source.execute("UPDATE application_outcomes SET job_key = ?", (_JOB_URL,))
        source.commit()
        copy_direct_and_scalar_tables(source, candidate)

        assert candidate.execute(
            "SELECT COUNT(*) FROM application_outcomes"
        ).fetchone() == (1,)
    finally:
        source.close()
        candidate.close()


def test_candidate_copy_requires_empty_feedback_targets(tmp_path: Path) -> None:
    source, candidate, _, _ = _connections(
        tmp_path,
        with_interview_prep_generation=False,
    )
    try:
        _seed_feedback_rows(source)
        candidate.execute(
            """
            INSERT INTO application_outcomes (
                tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "local",
                "existing-outcome",
                _JOB_ID,
                "interview",
                "manual",
                "2026-07-30T10:00:00+00:00",
                "2026-07-30T10:00:00+00:00",
            ),
        )

        with pytest.raises(
            CandidateCopyError,
            match="candidate table must be empty: application_outcomes",
        ):
            copy_direct_and_scalar_tables(source, candidate)
    finally:
        source.close()
        candidate.close()
