"""Focused contracts for candidate-side v6 event identity copying."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v6_to_v7_events as events
from jobctrl.infrastructure.migrations.schema_manifest import schema_dump
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_events import (
    CandidateEventCopyError,
    copy_job_events,
)
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from tests.v6_migration_fixture import create_shipped_v6_database

_JOB_URL = "https://jobs.example/shipped-v6"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
_UNTRUSTED_ANALYSIS_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}


def _connections(tmp_path: Path) -> tuple[sqlite3.Connection, sqlite3.Connection, Path]:
    source_path = tmp_path / "source.db"
    create_shipped_v6_database(source_path)
    source = sqlite3.connect(source_path)
    source.execute("PRAGMA foreign_keys = ON")
    candidate = sqlite3.connect(tmp_path / "candidate.db")
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    return source, candidate, source_path


def _allocator(*values: str):
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _copy_root(source: sqlite3.Connection, candidate: sqlite3.Connection):
    return copy_root_jobs(
        source,
        candidate,
        job_id_factory=_allocator(_JOB_ID),
        migration_at="2026-07-30T10:00:00+00:00",
    ).job_ids


def _insert_event(
    conn: sqlite3.Connection,
    *,
    event_id: int,
    job_url: str | None = _JOB_URL,
    payload: object | None = None,
    event_type: str = "StageCompleted",
    entity_kind: str | None = "job",
    entity_ref: str | None = _JOB_URL,
) -> None:
    conn.execute(
        """
        INSERT INTO job_events (
            event_id, job_url, stage, event_type, level, message, occurred_at,
            payload_json, entity_kind, entity_ref, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_id,
            job_url,
            "discover",
            event_type,
            "info",
            f"event-{event_id}",
            f"2026-07-30T10:0{event_id}:00+00:00",
            json.dumps(payload, separators=(",", ":")) if payload is not None else None,
            entity_kind,
            entity_ref,
            f"event-copy-{event_id}",
        ),
    )


def test_candidate_event_copy_preserves_v6_history_and_only_rewrites_root_identity(
    tmp_path: Path,
) -> None:
    source, candidate, source_path = _connections(tmp_path)
    try:
        nested = {
            "jobUrl": _JOB_URL,
            "job_ids": [_JOB_URL],
            "untrusted": _UNTRUSTED_ANALYSIS_CONTEXT,
        }
        _insert_event(
            source,
            event_id=7,
            payload={
                "jobUrl": _JOB_URL,
                "jobUrls": [_JOB_URL],
                "job_keys": [_JOB_URL],
                "survivingJobKey": _JOB_URL,
                "untrusted": nested,
            },
        )
        _insert_event(
            source,
            event_id=8,
            job_url=None,
            payload=_UNTRUSTED_ANALYSIS_CONTEXT,
            entity_kind="pipeline",
            entity_ref="discover:run-1",
        )
        source.execute("UPDATE sqlite_sequence SET seq = 41 WHERE name = 'job_events'")
        source.commit()
        before_schema = source.execute("PRAGMA schema_version").fetchone()[0]
        before_changes = source.total_changes
        before_bytes = source_path.read_bytes()
        before_events = tuple(source.execute("SELECT * FROM job_events ORDER BY event_id").fetchall())
        job_ids = _copy_root(source, candidate)

        result = copy_job_events(source, candidate, job_ids=job_ids)

        assert result.copied_events == 2
        assert result.sequence_high_water == 41
        rows = candidate.execute(
            """
            SELECT event_id, tenant_id, job_id, identity_version, stage, event_type,
                   level, message, occurred_at, payload_json, entity_kind, entity_ref,
                   idempotency_key
            FROM job_events ORDER BY event_id
            """
        ).fetchall()
        assert rows[0][:5] == (7, "local", _JOB_ID, 1, "discover")
        assert rows[0][5:9] == (
            "StageCompleted",
            "info",
            "event-7",
            "2026-07-30T10:07:00+00:00",
        )
        assert rows[0][10:] == ("job", _JOB_ID, "event-copy-7")
        assert json.loads(str(rows[0][9])) == {
            "jobId": _JOB_ID,
            "jobIds": [_JOB_ID],
            "job_ids": [_JOB_ID],
            "survivingJobId": _JOB_ID,
            "untrusted": nested,
        }
        assert rows[1][:5] == (8, "local", None, 1, "discover")
        assert rows[1][10:] == ("pipeline", "discover:run-1", "event-copy-8")
        assert json.loads(str(rows[1][9])) == _UNTRUSTED_ANALYSIS_CONTEXT
        assert candidate.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
        ).fetchone() == (41,)
        assert tuple(source.execute("SELECT * FROM job_events ORDER BY event_id").fetchall()) == before_events
        assert source.execute("PRAGMA schema_version").fetchone()[0] == before_schema
        assert source.total_changes == before_changes
        assert source_path.read_bytes() == before_bytes
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_duplicate_link_candidate_locator_remains_historical_root_data(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        candidate_url = "https://jobs.example/rejected-candidate"
        _insert_event(
            source,
            event_id=7,
            event_type="DuplicateJobLinkRejected",
            payload={
                "candidateJobId": candidate_url,
                "surviving_job_key": _JOB_URL,
                "nested": {"candidateJobId": candidate_url},
            },
        )
        source.commit()
        job_ids = _copy_root(source, candidate)

        copy_job_events(source, candidate, job_ids=job_ids)

        payload = json.loads(
            str(candidate.execute("SELECT payload_json FROM job_events").fetchone()[0])
        )
        assert payload == {
            "candidatePostingUrl": candidate_url,
            "nested": {"candidateJobId": candidate_url},
            "surviving_job_id": _JOB_ID,
        }
    finally:
        source.close()
        candidate.close()


def test_pipeline_scope_and_content_duplicate_candidate_are_not_url_identities(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        _insert_event(
            source,
            event_id=7,
            job_url=None,
            payload={"jobId": "pipeline"},
            entity_kind="pipeline",
            entity_ref="discover:run-1",
        )
        _insert_event(
            source,
            event_id=8,
            job_url=None,
            event_type="ContentDuplicateCandidateDetected",
            payload={"candidateJobId": _JOB_URL},
            entity_kind="duplicate-candidate",
            entity_ref="observation-1",
        )
        source.commit()
        job_ids = _copy_root(source, candidate)

        copy_job_events(source, candidate, job_ids=job_ids)

        rows = candidate.execute(
            """
            SELECT event_id, job_id, payload_json, entity_ref
            FROM job_events
            ORDER BY event_id
            """
        ).fetchall()
        assert rows[0] == (
            7,
            None,
            json.dumps({"jobId": "pipeline"}, separators=(",", ":"), sort_keys=True),
            "discover:run-1",
        )
        assert rows[1] == (
            8,
            _JOB_ID,
            json.dumps(
                {"candidateJobId": _JOB_ID},
                separators=(",", ":"),
                sort_keys=True,
            ),
            "observation-1",
        )
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    "payload",
    (
        {"jobUrl": "https://jobs.example/unresolved"},
        {"jobUrl": "https://jobs.example/second"},
    ),
)
def test_candidate_event_copy_rejects_unresolved_or_conflicting_identity_without_writes(
    tmp_path: Path,
    payload: dict[str, str],
) -> None:
    source, candidate, source_path = _connections(tmp_path)
    try:
        source.execute(
            "INSERT INTO jobs (url, title, discovered_at) VALUES (?, ?, ?)",
            (
                "https://jobs.example/second",
                "Second fixture",
                "2026-07-30T10:01:00+00:00",
            ),
        )
        _insert_event(source, event_id=7, payload=payload)
        source.commit()
        before_bytes = source_path.read_bytes()
        before_changes = source.total_changes
        job_ids = copy_root_jobs(
            source,
            candidate,
            job_id_factory=_allocator(
                _JOB_ID,
                "00000000-0000-4000-8000-000000000002",
            ),
            migration_at="2026-07-30T10:00:00+00:00",
        ).job_ids

        with pytest.raises(CandidateEventCopyError, match="event_job_identity"):
            copy_job_events(source, candidate, job_ids=job_ids)

        assert candidate.execute("SELECT COUNT(*) FROM job_events").fetchone() == (0,)
        assert candidate.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
        ).fetchone() is None
        assert source.total_changes == before_changes
        assert source_path.read_bytes() == before_bytes
    finally:
        source.close()
        candidate.close()


def test_candidate_event_copy_rolls_back_candidate_and_retries_same_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, source_path = _connections(tmp_path)
    try:
        _insert_event(source, event_id=7, payload={"jobUrl": _JOB_URL})
        source.commit()
        before_bytes = source_path.read_bytes()
        before_changes = source.total_changes
        job_ids = _copy_root(source, candidate)
        original_verify = events._verify_candidate
        monkeypatch.setattr(
            events,
            "_verify_candidate",
            lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("candidate fault")),
        )

        with pytest.raises(RuntimeError, match="candidate fault"):
            copy_job_events(source, candidate, job_ids=job_ids)

        assert candidate.execute("SELECT COUNT(*) FROM job_events").fetchone() == (0,)
        assert candidate.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
        ).fetchone() is None
        assert source.total_changes == before_changes
        assert source_path.read_bytes() == before_bytes
        monkeypatch.setattr(events, "_verify_candidate", original_verify)

        copied = copy_job_events(source, candidate, job_ids=job_ids)

        assert copied.copied_events == 1
        assert candidate.execute("SELECT event_id, job_id FROM job_events").fetchone() == (7, _JOB_ID)
    finally:
        source.close()
        candidate.close()


def test_candidate_event_copy_keeps_the_exact_v7_schema_and_reopens(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    canonical = sqlite3.connect(":memory:")
    candidate_path = Path(str(candidate.execute("PRAGMA database_list").fetchone()[2]))
    try:
        _insert_event(source, event_id=7, payload={"job_id": _JOB_URL})
        source.execute("UPDATE sqlite_sequence SET seq = 13 WHERE name = 'job_events'")
        source.commit()
        job_ids = _copy_root(source, candidate)

        copy_job_events(source, candidate, job_ids=job_ids)
        create_exact_v7_schema(canonical)
        assert tuple(row for row in schema_dump(candidate) if row[2] == "job_events") == tuple(
            row for row in schema_dump(canonical) if row[2] == "job_events"
        )
        candidate.commit()
    finally:
        source.close()
        canonical.close()
        candidate.close()

    reopened = sqlite3.connect(candidate_path)
    try:
        reopened.execute("PRAGMA foreign_keys = ON")
        assert reopened.execute("SELECT event_id, job_id, identity_version FROM job_events").fetchone() == (
            7,
            _JOB_ID,
            1,
        )
        assert reopened.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
        ).fetchone() == (13,)
        assert reopened.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        reopened.close()
