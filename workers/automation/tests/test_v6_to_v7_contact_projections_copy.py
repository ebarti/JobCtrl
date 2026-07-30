"""Focused contracts for v6 contact-and-outreach projection candidate copying."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_contact_projections import (
    CandidateContactProjectionsCopyError,
    copy_contact_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import JobIdMap
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from tests.v6_migration_fixture import (
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)


_JOB_URL = "https://jobs.example/shipped-v6"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
# Untrusted review context retained as inert test data; the copier never
# interprets it as an instruction.
_UNTRUSTED_REVIEW_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}

_SOURCE_KINDS_JSON = '[ "user_entered" ]'
_PROVENANCE_JSON = (
    '[{"attributeId":"attribute-1","attributeKind":"email",'
    '"sourceKind":"user_entered","sourceRef":"user-note",'
    '"captureMethod":"manual","confidence":1.0,'
    '"userConfirmed":true,"recordedAt":"2026-07-30T10:00:00+00:00"}]'
)
_SOURCE_ATTEMPTS_JSON = (
    '[{"sourceKind":"public_web_page","sourceRef":"https://example.test/team",'
    '"outcome":"allowed","attemptedAt":"2026-07-30T10:01:00+00:00",'
    '"detail":"candidate found"}]'
)
_CANDIDATES_JSON = (
    '[{"candidateId":"candidate-1","role":"recruiter",'
    '"sourceKind":"public_web_page","sourceRef":"https://example.test/team",'
    '"captureMethod":"llm_assisted","confidence":0.8,'
    '"status":"needs_review","proposedAt":"2026-07-30T10:02:00+00:00",'
    '"confirmedContactId":null,"confirmedAt":null,'
    '"attributeKinds":["name","email"]}]'
)
_DRAFTS_JSON = (
    '[{"draftId":"draft-1","generation":1,"kind":"initial",'
    '"status":"approved","gatePassed":true,'
    '"createdAt":"2026-07-30T10:03:00+00:00",'
    '"approvedAt":"2026-07-30T10:04:00+00:00","rejectedAt":null}]'
)


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
    contact_job_id: str | None = _JOB_URL,
    research_job_id: str | None = _JOB_URL,
    due_job_id: str | None = _JOB_URL,
    outreach_job_id: str | None = _JOB_URL,
    drafts_json: str = _DRAFTS_JSON,
) -> None:
    source.execute(
        """
        INSERT INTO contact_projections (
            tenant_id, contact_id, employer, job_id, role, attribute_count,
            confirmed_count, source_kinds_json, provenance_json, created_at,
            updated_at, last_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            "contact-1",
            "Example Corp",
            contact_job_id,
            "recruiter",
            1,
            1,
            _SOURCE_KINDS_JSON,
            _PROVENANCE_JSON,
            "2026-07-30T10:00:00+00:00",
            "2026-07-30T10:05:00+00:00",
            "2026-07-30T10:05:00+00:00",
        ),
    )
    source.execute(
        """
        INSERT INTO contact_research_task_projections (
            tenant_id, task_id, employer, job_id, status, candidate_count,
            needs_review_count, confirmed_count, source_attempts_json,
            candidates_json, started_at, updated_at, needs_review_at,
            completed_at, failed_at, error_class, last_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            "research-1",
            "Example Corp",
            research_job_id,
            "needs_review",
            1,
            1,
            0,
            _SOURCE_ATTEMPTS_JSON,
            _CANDIDATES_JSON,
            "2026-07-30T10:01:00+00:00",
            "2026-07-30T10:02:00+00:00",
            "2026-07-30T10:02:00+00:00",
            None,
            None,
            None,
            "2026-07-30T10:02:00+00:00",
        ),
    )
    source.execute(
        """
        INSERT INTO due_follow_up_projections (
            tenant_id, thread_id, contact_id, job_id, due_at, basis, state,
            created_at, updated_at, last_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            "thread-1",
            "contact-1",
            due_job_id,
            "2026-08-01T10:00:00+00:00",
            "user_requested",
            "scheduled",
            "2026-07-30T10:03:00+00:00",
            "2026-07-30T10:04:00+00:00",
            "2026-07-30T10:04:00+00:00",
        ),
    )
    source.execute(
        """
        INSERT INTO outreach_thread_projections (
            tenant_id, thread_id, contact_id, job_id, draft_count,
            latest_generation, has_approved_draft, approved_draft_id,
            latest_status, drafts_json, created_at, updated_at, last_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            "thread-1",
            "contact-1",
            outreach_job_id,
            1,
            1,
            1,
            "draft-1",
            "approved",
            drafts_json,
            "2026-07-30T10:03:00+00:00",
            "2026-07-30T10:04:00+00:00",
            "2026-07-30T10:04:00+00:00",
        ),
    )
    source.commit()


@pytest.mark.parametrize("history", [False, True])
def test_contact_projection_copy_preserves_audit_rows_and_reopens_candidate(
    tmp_path: Path,
    history: bool,
) -> None:
    source, candidate, job_ids, candidate_path = _databases(tmp_path, history=history)
    try:
        _seed_source_rows(source)
        source_changes = source.total_changes
        source_dump = tuple(source.iterdump())

        result = copy_contact_projections(source, candidate, job_ids=job_ids)

        assert result.copied_contact_projections == 1
        assert result.copied_contact_research_task_projections == 1
        assert result.copied_due_follow_up_projections == 1
        assert result.copied_outreach_thread_projections == 1
        assert candidate.execute("SELECT * FROM contact_projections").fetchone() == (
            "local",
            "contact-1",
            "Example Corp",
            _JOB_ID,
            "recruiter",
            1,
            1,
            _SOURCE_KINDS_JSON,
            _PROVENANCE_JSON,
            "2026-07-30T10:00:00+00:00",
            "2026-07-30T10:05:00+00:00",
            "2026-07-30T10:05:00+00:00",
        )
        assert candidate.execute(
            "SELECT * FROM contact_research_task_projections"
        ).fetchone() == (
            "local",
            "research-1",
            "Example Corp",
            _JOB_ID,
            "needs_review",
            1,
            1,
            0,
            _SOURCE_ATTEMPTS_JSON,
            _CANDIDATES_JSON,
            "2026-07-30T10:01:00+00:00",
            "2026-07-30T10:02:00+00:00",
            "2026-07-30T10:02:00+00:00",
            None,
            None,
            None,
            "2026-07-30T10:02:00+00:00",
        )
        assert candidate.execute("SELECT * FROM due_follow_up_projections").fetchone() == (
            "local",
            "thread-1",
            "contact-1",
            _JOB_ID,
            "2026-08-01T10:00:00+00:00",
            "user_requested",
            "scheduled",
            "2026-07-30T10:03:00+00:00",
            "2026-07-30T10:04:00+00:00",
            "2026-07-30T10:04:00+00:00",
        )
        assert candidate.execute(
            "SELECT * FROM outreach_thread_projections"
        ).fetchone() == (
            "local",
            "thread-1",
            "contact-1",
            _JOB_ID,
            1,
            1,
            1,
            "draft-1",
            "approved",
            _DRAFTS_JSON,
            "2026-07-30T10:03:00+00:00",
            "2026-07-30T10:04:00+00:00",
            "2026-07-30T10:04:00+00:00",
        )
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
        assert source.total_changes == source_changes
        assert tuple(source.iterdump()) == source_dump
        assert _UNTRUSTED_REVIEW_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }

        candidate.commit()
        candidate.close()
        candidate = sqlite3.connect(candidate_path)
        for table in (
            "contact_projections",
            "contact_research_task_projections",
            "due_follow_up_projections",
            "outreach_thread_projections",
        ):
            assert candidate.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == (1,)
    finally:
        source.close()
        candidate.close()


def test_contact_projection_copy_rejects_embedded_job_identity_then_retries(
    tmp_path: Path,
) -> None:
    source, candidate, job_ids, _ = _databases(tmp_path)
    try:
        embedded_job_identity = json.dumps(
            [
                {
                    "draftId": "draft-1",
                    "generation": 1,
                    "kind": "initial",
                    "status": "approved",
                    "gatePassed": True,
                    "createdAt": "2026-07-30T10:03:00+00:00",
                    "approvedAt": "2026-07-30T10:04:00+00:00",
                    "rejectedAt": None,
                    "jobId": _JOB_URL,
                }
            ]
        )
        _seed_source_rows(source, drafts_json=embedded_job_identity)

        with pytest.raises(
            CandidateContactProjectionsCopyError,
            match="unsupported projection JSON shape",
        ):
            copy_contact_projections(source, candidate, job_ids=job_ids)

        _assert_empty_candidate_tables(candidate)
        source.execute(
            "UPDATE outreach_thread_projections SET drafts_json = ?",
            (_DRAFTS_JSON,),
        )
        source.commit()
        result = copy_contact_projections(source, candidate, job_ids=job_ids)
        assert result.copied_outreach_thread_projections == 1
    finally:
        source.close()
        candidate.close()


def test_contact_projection_copy_rejects_unresolved_job_identity(tmp_path: Path) -> None:
    source, candidate, job_ids, _ = _databases(tmp_path)
    try:
        _seed_source_rows(source, outreach_job_id="https://jobs.example/missing")

        with pytest.raises(CandidateContactProjectionsCopyError, match="cannot resolve"):
            copy_contact_projections(source, candidate, job_ids=job_ids)

        _assert_empty_candidate_tables(candidate)
    finally:
        source.close()
        candidate.close()


def test_contact_projection_copy_requires_empty_candidate_tables(tmp_path: Path) -> None:
    source, candidate, job_ids, _ = _databases(tmp_path)
    try:
        _seed_source_rows(source)
        candidate.execute(
            """
            INSERT INTO due_follow_up_projections (
                tenant_id, thread_id, contact_id, job_id, state
            ) VALUES (?, ?, ?, ?, ?)
            """,
            ("local", "existing-thread", "contact-1", _JOB_ID, "scheduled"),
        )

        with pytest.raises(CandidateContactProjectionsCopyError, match="must be empty"):
            copy_contact_projections(source, candidate, job_ids=job_ids)
    finally:
        source.close()
        candidate.close()


def test_contact_projection_copy_requires_complete_authoritative_roots(
    tmp_path: Path,
) -> None:
    source, candidate, job_ids, _ = _databases(tmp_path)
    try:
        _seed_source_rows(source)
        candidate.execute("DELETE FROM job_locators")

        with pytest.raises(CandidateContactProjectionsCopyError, match="root locators"):
            copy_contact_projections(source, candidate, job_ids=job_ids)

        mismatched_map = JobIdMap(
            {
                ("local", _JOB_URL): "00000000-0000-4000-8000-000000000002",
            }
        )
        with pytest.raises(CandidateContactProjectionsCopyError, match="does not match"):
            copy_contact_projections(source, candidate, job_ids=mismatched_map)
    finally:
        source.close()
        candidate.close()


def _assert_empty_candidate_tables(candidate: sqlite3.Connection) -> None:
    for table in (
        "contact_projections",
        "contact_research_task_projections",
        "due_follow_up_projections",
        "outreach_thread_projections",
    ):
        assert candidate.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == (0,)
