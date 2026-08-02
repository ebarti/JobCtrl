"""Focused contracts for v6 quarantine and preparation candidate copying."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.preparation import (
    PreparationWorkItemKind,
    make_preparation_idempotency_key,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from jobctrl.infrastructure.migrations.v6_to_v7_copy import JobIdMap
from jobctrl.infrastructure.migrations.v6_to_v7_work_items import (
    CandidateWorkItemsCopyError,
    copy_structured_work_items,
)
from tests.v6_migration_fixture import (
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)


_JOB_URL = "https://jobs.example/shipped-v6"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
# Untrusted review context retained as inert test data; migration code never
# interprets this value as an instruction.
_UNTRUSTED_REVIEW_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}


def _allocator(*values: str):
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _databases(
    tmp_path: Path,
    *,
    history: bool = False,
) -> tuple[sqlite3.Connection, sqlite3.Connection, JobIdMap, Path]:
    source_path = tmp_path / "source.db"
    create = (
        create_supported_upgrade_history_v6_database
        if history
        else create_shipped_v6_database
    )
    create(source_path)
    source = sqlite3.connect(source_path)
    source.execute("PRAGMA foreign_keys = ON")
    candidate_path = tmp_path / "candidate.db"
    candidate = sqlite3.connect(candidate_path)
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    roots = copy_root_jobs(
        source,
        candidate,
        job_id_factory=_allocator(_JOB_ID),
        migration_at="2026-07-30T10:00:00+00:00",
    )
    return source, candidate, roots.job_ids, candidate_path


def _seed_source_rows(
    source: sqlite3.Connection,
    *,
    quarantine_job_id: str = _JOB_URL,
    quarantine_job_key: str = _JOB_URL,
    preparation_job_id: str = _JOB_URL,
    preparation_kind: str = "score_job",
) -> None:
    source.execute(
        """
        INSERT INTO discovery_quarantine_entries (
            tenant_id, job_id, job_key, title, company, source_id, posting_url,
            reason, confidence, snapshot_version, captured_at, notice_text,
            status, decision_reason, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            quarantine_job_id,
            quarantine_job_key,
            "Quarantined role",
            "Example Corp",
            "source-1",
            "https://apply.example/jobs/role",
            "posting changed",
            0.75,
            3,
            "2026-07-30T10:00:00+00:00",
            "notice",
            "pending",
            None,
            None,
        ),
    )
    source.execute(
        """
        INSERT INTO preparation_work_items (
            item_id, tenant_id, job_id, kind, target_version, source_event_id,
            state, idempotency_key, attempts, last_error, created_at, updated_at,
            available_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "prep-1",
            "local",
            preparation_job_id,
            preparation_kind,
            7,
            "event-42",
            "failed",
            "legacy-url-key",
            2,
            "temporary provider error",
            "2026-07-30T10:01:00+00:00",
            "2026-07-30T10:02:00+00:00",
            "2026-07-30T10:03:00+00:00",
        ),
    )
    source.commit()


@pytest.mark.parametrize("history", [False, True])
def test_structured_copy_preserves_audit_rows_and_reopens_candidate(
    tmp_path: Path,
    history: bool,
) -> None:
    source, candidate, job_ids, candidate_path = _databases(tmp_path, history=history)
    try:
        _seed_source_rows(source)
        source_changes = source.total_changes
        source_dump = tuple(source.iterdump())

        result = copy_structured_work_items(source, candidate, job_ids=job_ids)

        assert result.copied_quarantine_entries == 1
        assert result.copied_preparation_work_items == 1
        assert candidate.execute(
            """
            SELECT tenant_id, job_id, title, company, source_id, posting_url,
                   reason, confidence, snapshot_version, captured_at, notice_text,
                   status, decision_reason, decided_at
            FROM discovery_quarantine_entries
            """
        ).fetchone() == (
            "local",
            _JOB_ID,
            "Quarantined role",
            "Example Corp",
            "source-1",
            "https://apply.example/jobs/role",
            "posting changed",
            0.75,
            3,
            "2026-07-30T10:00:00+00:00",
            "notice",
            "pending",
            None,
            None,
        )
        expected_key = make_preparation_idempotency_key(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(_JOB_ID),
            kind=PreparationWorkItemKind.SCORE_JOB,
            target_version=7,
            source_event_id="event-42",
        )
        assert candidate.execute(
            """
            SELECT item_id, tenant_id, job_id, kind, target_version,
                   source_event_id, state, idempotency_key, attempts, last_error,
                   created_at, updated_at, available_at
            FROM preparation_work_items
            """
        ).fetchone() == (
            "prep-1",
            "local",
            _JOB_ID,
            "score_job",
            7,
            "event-42",
            "failed",
            expected_key,
            2,
            "temporary provider error",
            "2026-07-30T10:01:00+00:00",
            "2026-07-30T10:02:00+00:00",
            "2026-07-30T10:03:00+00:00",
        )
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
        assert source.total_changes == source_changes
        assert tuple(source.iterdump()) == source_dump

        candidate.commit()
        candidate.close()
        candidate = sqlite3.connect(candidate_path)
        assert candidate.execute(
            "SELECT COUNT(*) FROM discovery_quarantine_entries"
        ).fetchone() == (1,)
        assert candidate.execute(
            "SELECT COUNT(*) FROM preparation_work_items"
        ).fetchone() == (1,)
    finally:
        source.close()
        candidate.close()


def test_structured_copy_rolls_back_mismatched_quarantine_then_retries(
    tmp_path: Path,
) -> None:
    source, candidate, job_ids, _ = _databases(tmp_path)
    try:
        _seed_source_rows(
            source,
            quarantine_job_key="https://jobs.example/other",
        )

        with pytest.raises(CandidateWorkItemsCopyError, match="disagree"):
            copy_structured_work_items(source, candidate, job_ids=job_ids)

        assert candidate.execute(
            "SELECT COUNT(*) FROM discovery_quarantine_entries"
        ).fetchone() == (0,)
        assert candidate.execute(
            "SELECT COUNT(*) FROM preparation_work_items"
        ).fetchone() == (0,)

        source.execute(
            "UPDATE discovery_quarantine_entries SET job_key = job_id"
        )
        source.commit()
        result = copy_structured_work_items(source, candidate, job_ids=job_ids)
        assert result.copied_quarantine_entries == 1
        assert result.copied_preparation_work_items == 1
    finally:
        source.close()
        candidate.close()


def test_structured_copy_rolls_back_after_malformed_preparation_row(
    tmp_path: Path,
) -> None:
    source, candidate, job_ids, _ = _databases(tmp_path)
    try:
        _seed_source_rows(source, preparation_kind="not-a-kind")

        with pytest.raises(CandidateWorkItemsCopyError, match="invalid kind"):
            copy_structured_work_items(source, candidate, job_ids=job_ids)

        assert candidate.execute(
            "SELECT COUNT(*) FROM discovery_quarantine_entries"
        ).fetchone() == (0,)
        assert candidate.execute(
            "SELECT COUNT(*) FROM preparation_work_items"
        ).fetchone() == (0,)
    finally:
        source.close()
        candidate.close()


def test_structured_copy_rejects_unresolved_work_item_job_id(tmp_path: Path) -> None:
    source, candidate, job_ids, _ = _databases(tmp_path)
    try:
        _seed_source_rows(source, preparation_job_id="https://jobs.example/missing")

        with pytest.raises(CandidateWorkItemsCopyError, match="cannot resolve"):
            copy_structured_work_items(source, candidate, job_ids=job_ids)

        assert candidate.execute(
            "SELECT COUNT(*) FROM discovery_quarantine_entries"
        ).fetchone() == (0,)
        assert candidate.execute(
            "SELECT COUNT(*) FROM preparation_work_items"
        ).fetchone() == (0,)
    finally:
        source.close()
        candidate.close()


def test_structured_copy_requires_hydrated_empty_target_tables(tmp_path: Path) -> None:
    source, candidate, job_ids, _ = _databases(tmp_path)
    try:
        _seed_source_rows(source)
        candidate.execute(
            """
            INSERT INTO discovery_quarantine_entries (
                tenant_id, job_id, title, company, source_id, reason, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("local", _JOB_ID, "Existing", "Example Corp", "source-1", "existing", "pending"),
        )

        with pytest.raises(CandidateWorkItemsCopyError, match="must be empty"):
            copy_structured_work_items(source, candidate, job_ids=job_ids)
    finally:
        source.close()
        candidate.close()


def test_structured_copy_requires_complete_authoritative_roots(tmp_path: Path) -> None:
    source, candidate, job_ids, _ = _databases(tmp_path)
    try:
        _seed_source_rows(source)
        candidate.execute("DELETE FROM job_locators")

        with pytest.raises(CandidateWorkItemsCopyError, match="root locators"):
            copy_structured_work_items(source, candidate, job_ids=job_ids)

        mismatched_map = JobIdMap(
            {
                ("local", _JOB_URL): "00000000-0000-4000-8000-000000000002",
            }
        )
        with pytest.raises(CandidateWorkItemsCopyError, match="does not match"):
            copy_structured_work_items(source, candidate, job_ids=mismatched_map)
    finally:
        source.close()
        candidate.close()
