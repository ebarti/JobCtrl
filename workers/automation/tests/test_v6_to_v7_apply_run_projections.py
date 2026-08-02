"""Focused contracts for rebuilding v7 apply-run projections from events."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v6_to_v7_apply_run_projections as apply_runs
from jobctrl.infrastructure.migrations.schema_manifest import schema_dump
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_apply_run_projections import (
    CandidateApplyRunProjectionsError,
    rebuild_apply_run_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_events import (
    CandidateEventCopyError,
    copy_job_events,
)
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from tests.v6_migration_fixture import create_shipped_v6_database

_JOB_URL = "https://jobs.example/shipped-v6"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
_SECOND_JOB_URL = "https://jobs.example/second"
_SECOND_JOB_ID = "00000000-0000-4000-8000-000000000002"
# Untrusted context is fixture data only. The candidate projector preserves it
# inside the event payload and never interprets it as an instruction.
_UNTRUSTED_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}


def _allocator(*values: str):
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _connections(tmp_path: Path) -> tuple[sqlite3.Connection, sqlite3.Connection, Path]:
    source_path = tmp_path / "source.db"
    create_shipped_v6_database(source_path)
    source = sqlite3.connect(source_path)
    source.execute("PRAGMA foreign_keys = ON")
    candidate_path = tmp_path / "candidate.db"
    candidate = sqlite3.connect(candidate_path)
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    return source, candidate, candidate_path


def _copy_roots_and_events(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *job_ids: str,
):
    roots = copy_root_jobs(
        source,
        candidate,
        job_id_factory=_allocator(*job_ids),
        migration_at="2026-07-30T10:00:00+00:00",
    )
    copy_job_events(source, candidate, job_ids=roots.job_ids)
    return roots.job_ids


def _insert_source_event(
    source: sqlite3.Connection,
    *,
    event_id: int,
    job_url: str = _JOB_URL,
    event_type: str,
    payload: object | None,
    occurred_at: str,
    message: str | None = None,
) -> None:
    source.execute(
        """
        INSERT INTO job_events (
            event_id, job_url, stage, event_type, level, message, occurred_at,
            payload_json, entity_kind, entity_ref, idempotency_key
        ) VALUES (?, ?, 'apply', ?, 'info', ?, ?, ?, 'job', ?, ?)
        """,
        (
            event_id,
            job_url,
            event_type,
            message,
            occurred_at,
            json.dumps(payload, separators=(",", ":")) if payload is not None else None,
            job_url,
            f"apply-event-{event_id}",
        ),
    )


def _insert_stale_source_projection(source: sqlite3.Connection) -> None:
    source.execute(
        """
        INSERT INTO apply_run_projections (
            run_id, tenant_id, job_id, job_title, job_employer, status, result,
            dry_run, worker_id, model, started_at, finished_at, duration_ms,
            events_json
        ) VALUES (?, 'local', ?, 'Stale', 'Stale Corp', 'failed', 'failed', 0,
                  1, 'stale-model', ?, ?, 1, ?)
        """,
        (
            "run-1",
            _JOB_URL,
            "2026-07-30T09:00:00+00:00",
            "2026-07-30T09:00:01+00:00",
            json.dumps(
                [
                    {
                        "event_type": "ApplicationFailed",
                        "payload": {"job_id": _JOB_URL, "stale": True},
                    }
                ]
            ),
        ),
    )


def test_rebuild_uses_candidate_events_not_the_v6_projection_and_preserves_payload(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        source.execute("UPDATE jobs SET company = ?, site = ? WHERE url = ?", ("Example Corp", "greenhouse", _JOB_URL))
        _insert_stale_source_projection(source)
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplyRunStarted",
            occurred_at="2026-07-30T10:00:00+00:00",
            message="starting",
            payload={
                "run_id": "run-1",
                "job_id": _JOB_URL,
                "started_at": "2026-07-30T09:59:59+00:00",
                "worker_id": "12",
                "model": "test-model",
                "dry_run": False,
                "context": _UNTRUSTED_CONTEXT,
            },
        )
        _insert_source_event(
            source,
            event_id=8,
            event_type="ApplyRunInProgress",
            occurred_at="2026-07-30T10:01:00+00:00",
            payload={"run_id": "run-1", "job_id": _JOB_URL},
        )
        _insert_source_event(
            source,
            event_id=9,
            event_type="ApplicationSubmitted",
            occurred_at="2026-07-30T10:02:00+00:00",
            message="submitted",
            payload={
                "run_id": "run-1",
                "job_id": _JOB_URL,
                "result": "applied",
                "finished_at": "2026-07-30T10:01:58+00:00",
                "duration_ms": "119000",
                "context": _UNTRUSTED_CONTEXT,
            },
        )
        _insert_source_event(
            source,
            event_id=10,
            event_type="LockReleased",
            occurred_at="2026-07-30T10:03:00+00:00",
            payload={"run_id": "run-1", "job_id": _JOB_URL},
        )
        source.commit()
        source_bytes = Path(str(source.execute("PRAGMA database_list").fetchone()[2])).read_bytes()
        source_rows = tuple(source.execute("SELECT * FROM apply_run_projections").fetchall())
        source_changes = source.total_changes
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID)

        result = rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        assert result.rebuilt_apply_runs == 1
        row = candidate.execute(
            """
            SELECT run_id, tenant_id, job_id, job_title, job_employer, status,
                   result, dry_run, worker_id, model, started_at, finished_at,
                   duration_ms, events_json
            FROM apply_run_projections
            """
        ).fetchone()
        assert row is not None
        assert row[:13] == (
            "run-1",
            "local",
            _JOB_ID,
            "Shipped V6 fixture",
            "Example Corp",
            "succeeded",
            "applied",
            0,
            12,
            "test-model",
            "2026-07-30T09:59:59+00:00",
            "2026-07-30T10:01:58+00:00",
            119000,
        )
        timeline = json.loads(str(row[13]))
        assert [entry["event_type"] for entry in timeline] == [
            "ApplyRunStarted",
            "ApplyRunInProgress",
            "ApplicationSubmitted",
            "LockReleased",
        ]
        assert timeline[0]["payload"] == {
            "context": _UNTRUSTED_CONTEXT,
            "dry_run": False,
            "job_id": _JOB_ID,
            "model": "test-model",
            "run_id": "run-1",
            "started_at": "2026-07-30T09:59:59+00:00",
            "worker_id": "12",
        }
        assert timeline[2]["payload"]["job_id"] == _JOB_ID
        assert _UNTRUSTED_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }
        assert tuple(source.execute("SELECT * FROM apply_run_projections").fetchall()) == source_rows
        assert source.total_changes == source_changes
        assert Path(str(source.execute("PRAGMA database_list").fetchone()[2])).read_bytes() == source_bytes
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    "payload",
    (
        {"run_id": None, "job_id": _JOB_URL},
        {"run_id": "", "job_id": _JOB_URL},
        {"run_id": " run-1 ", "job_id": _JOB_URL},
        {"run_id": 7, "job_id": _JOB_URL},
    ),
)
def test_rebuild_rejects_malformed_apply_run_identity_without_writes(
    tmp_path: Path,
    payload: dict[str, object],
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplyRunStarted",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload=payload,
        )
        source.commit()
        source_bytes = Path(str(source.execute("PRAGMA database_list").fetchone()[2])).read_bytes()
        source_changes = source.total_changes
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID)

        with pytest.raises(CandidateApplyRunProjectionsError, match="run_id"):
            rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        assert candidate.execute("SELECT COUNT(*) FROM apply_run_projections").fetchone() == (0,)
        assert source.total_changes == source_changes
        assert Path(str(source.execute("PRAGMA database_list").fetchone()[2])).read_bytes() == source_bytes
    finally:
        source.close()
        candidate.close()


def test_rebuild_preserves_no_run_apply_audit_event_without_a_projection(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        payload = {
            "reason": "User confirmed submission outside the browser flow.",
            "marked_at": "2026-07-30T10:00:00+00:00",
            "source": "user_attestation",
            "context": _UNTRUSTED_CONTEXT,
        }
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplicationManuallyMarked",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload=payload,
        )
        source.commit()
        source_bytes = Path(str(source.execute("PRAGMA database_list").fetchone()[2])).read_bytes()
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID)

        result = rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        assert result.rebuilt_apply_runs == 0
        assert candidate.execute("SELECT COUNT(*) FROM apply_run_projections").fetchone() == (0,)
        event = candidate.execute(
            "SELECT job_id, event_type, payload_json FROM job_events"
        ).fetchone()
        assert event is not None
        assert event[:2] == (_JOB_ID, "ApplicationManuallyMarked")
        assert json.loads(str(event[2])) == payload
        assert Path(str(source.execute("PRAGMA database_list").fetchone()[2])).read_bytes() == source_bytes
        assert _UNTRUSTED_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize("payload", (None, [_UNTRUSTED_CONTEXT]))
def test_rebuild_skips_null_and_non_object_apply_event_payloads(
    tmp_path: Path,
    payload: object | None,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplicationManuallyMarked",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload=payload,
        )
        source.commit()
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID)

        result = rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        assert result.rebuilt_apply_runs == 0
        assert candidate.execute("SELECT COUNT(*) FROM apply_run_projections").fetchone() == (0,)
        payload_json = candidate.execute("SELECT payload_json FROM job_events").fetchone()
        assert payload_json is not None
        if payload is None:
            assert payload_json == (None,)
        else:
            assert json.loads(str(payload_json[0])) == payload
    finally:
        source.close()
        candidate.close()


def test_event_copy_rejects_invalid_apply_payload_before_projection_rebuild(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplyRunStarted",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload={
                "run_id": "run-1",
                "job_id": _JOB_URL,
                "context": _UNTRUSTED_CONTEXT,
            },
        )
        source.execute("UPDATE job_events SET payload_json = '{' WHERE event_id = 7")
        source.commit()
        roots = copy_root_jobs(
            source,
            candidate,
            job_id_factory=_allocator(_JOB_ID),
            migration_at="2026-07-30T10:00:00+00:00",
        )

        with pytest.raises(CandidateEventCopyError, match="event_payload_invalid"):
            copy_job_events(source, candidate, job_ids=roots.job_ids)

        assert candidate.execute("SELECT COUNT(*) FROM job_events").fetchone() == (0,)
        assert candidate.execute("SELECT COUNT(*) FROM apply_run_projections").fetchone() == (0,)
    finally:
        source.close()
        candidate.close()


def test_rebuild_validates_no_run_event_root_before_skipping_it(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplicationManuallyMarked",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload=None,
        )
        source.commit()
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID)
        candidate.commit()
        candidate.execute("PRAGMA foreign_keys = OFF")
        candidate.execute(
            "UPDATE job_events SET job_id = ? WHERE event_id = 7",
            ("00000000-0000-4000-8000-000000000099",),
        )
        candidate.commit()
        candidate.execute("PRAGMA foreign_keys = ON")

        with pytest.raises(CandidateApplyRunProjectionsError, match="hydrated job root"):
            rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        assert candidate.execute("SELECT COUNT(*) FROM apply_run_projections").fetchone() == (0,)
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    ("event_type", "terminal_payload", "expected_status", "expected_result", "expected_dry_run"),
    (
        ("ApplicationFailed", {"result": {"kind": "captcha"}}, "captcha", "captcha", 0),
        (
            "ApplicationFailed",
            {"result": {"kind": "login_issue"}},
            "login_issue",
            "login_issue",
            0,
        ),
        ("ApplicationFailed", {"result": {"kind": "expired"}}, "expired", "expired", 0),
        ("ApplicationFailed", {"result": {"kind": "manual"}}, "manual", "manual", 0),
        (
            "ApplicationFailed",
            {"result": {"kind": "dry_run_complete"}},
            "dry_run_complete",
            "dry_run_complete",
            0,
        ),
        (
            "ApplicationFailed",
            {"result": {"kind": "email_only"}},
            "manual",
            "email_only",
            0,
        ),
        ("DryRunCompleted", {}, "dry_run_complete", "dry_run_complete", 1),
        ("ApplyManualSkip", {}, "manual", "manual", 0),
        ("LockReleased", {}, "failed", "failed", 0),
    ),
)
def test_rebuild_matches_terminal_lifecycle_folds(
    tmp_path: Path,
    event_type: str,
    terminal_payload: dict[str, object],
    expected_status: str,
    expected_result: str,
    expected_dry_run: int,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplyRunStarted",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload={
                "run_id": "run-1",
                "job_id": _JOB_URL,
                "context": _UNTRUSTED_CONTEXT,
            },
        )
        _insert_source_event(
            source,
            event_id=8,
            event_type=event_type,
            occurred_at="2026-07-30T10:01:00+00:00",
            payload={
                "run_id": "run-1",
                "job_id": _JOB_URL,
                "context": _UNTRUSTED_CONTEXT,
                **terminal_payload,
            },
        )
        source.commit()
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID)

        rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        projection = candidate.execute(
            "SELECT status, result, dry_run, events_json FROM apply_run_projections"
        ).fetchone()
        assert projection is not None
        assert projection[:3] == (expected_status, expected_result, expected_dry_run)
        assert json.loads(str(projection[3]))[-1]["payload"]["context"] == _UNTRUSTED_CONTEXT
    finally:
        source.close()
        candidate.close()


def test_rebuild_never_uses_source_board_as_an_employer_fallback(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        source.execute(
            "UPDATE jobs SET company = NULL, site = ? WHERE url = ?",
            ("greenhouse", _JOB_URL),
        )
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplyRunStarted",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload={
                "run_id": "run-1",
                "job_id": _JOB_URL,
                "context": _UNTRUSTED_CONTEXT,
            },
        )
        source.commit()
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID)

        rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        assert candidate.execute(
            "SELECT job_employer FROM apply_run_projections"
        ).fetchone() == ("Unknown company",)
    finally:
        source.close()
        candidate.close()


def test_rebuild_rejects_conflicting_job_identity_for_a_run_without_writes(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        source.execute(
            "INSERT INTO jobs (url, title, discovered_at) VALUES (?, ?, ?)",
            (_SECOND_JOB_URL, "Second fixture", "2026-07-30T09:00:00+00:00"),
        )
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplyRunStarted",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload={"run_id": "shared-run", "job_id": _JOB_URL},
        )
        _insert_source_event(
            source,
            event_id=8,
            job_url=_SECOND_JOB_URL,
            event_type="ApplicationFailed",
            occurred_at="2026-07-30T10:01:00+00:00",
            payload={"run_id": "shared-run", "job_id": _SECOND_JOB_URL},
        )
        source.commit()
        source_bytes = Path(str(source.execute("PRAGMA database_list").fetchone()[2])).read_bytes()
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID, _SECOND_JOB_ID)

        with pytest.raises(CandidateApplyRunProjectionsError, match="conflicting"):
            rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        assert candidate.execute("SELECT COUNT(*) FROM apply_run_projections").fetchone() == (0,)
        assert Path(str(source.execute("PRAGMA database_list").fetchone()[2])).read_bytes() == source_bytes
    finally:
        source.close()
        candidate.close()


def test_rebuild_requires_empty_target_and_hydrated_roots(tmp_path: Path) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplyRunStarted",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload={"run_id": "run-1", "job_id": _JOB_URL},
        )
        source.commit()
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID)
        candidate.execute(
            """
            INSERT INTO apply_run_projections (
                run_id, tenant_id, job_id, job_title, job_employer, status,
                events_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("existing", "local", _JOB_ID, "Existing", "Example Corp", "starting", "[]"),
        )

        with pytest.raises(CandidateApplyRunProjectionsError, match="must be empty"):
            rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        candidate.execute("DELETE FROM apply_run_projections")
        candidate.execute("DELETE FROM job_locators")
        with pytest.raises(CandidateApplyRunProjectionsError, match="root locators"):
            rebuild_apply_run_projections(source, candidate, job_ids=job_ids)
    finally:
        source.close()
        candidate.close()


def test_rebuild_rolls_back_candidate_fault_and_retries_same_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplyRunStarted",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload={"run_id": "run-1", "job_id": _JOB_URL},
        )
        source.commit()
        source_bytes = Path(str(source.execute("PRAGMA database_list").fetchone()[2])).read_bytes()
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID)
        original_verify = apply_runs._verify_candidate
        monkeypatch.setattr(
            apply_runs,
            "_verify_candidate",
            lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("candidate fault")),
        )

        with pytest.raises(RuntimeError, match="candidate fault"):
            rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        assert candidate.execute("SELECT COUNT(*) FROM apply_run_projections").fetchone() == (0,)
        assert Path(str(source.execute("PRAGMA database_list").fetchone()[2])).read_bytes() == source_bytes
        monkeypatch.setattr(apply_runs, "_verify_candidate", original_verify)

        result = rebuild_apply_run_projections(source, candidate, job_ids=job_ids)

        assert result.rebuilt_apply_runs == 1
        assert candidate.execute(
            "SELECT run_id, job_id FROM apply_run_projections"
        ).fetchone() == ("run-1", _JOB_ID)
    finally:
        source.close()
        candidate.close()


def test_rebuild_keeps_exact_v7_schema_and_reopens(tmp_path: Path) -> None:
    source, candidate, candidate_path = _connections(tmp_path)
    canonical = sqlite3.connect(":memory:")
    try:
        _insert_source_event(
            source,
            event_id=7,
            event_type="ApplicationFailed",
            occurred_at="2026-07-30T10:00:00+00:00",
            payload={
                "run_id": "run-1",
                "job_id": _JOB_URL,
                "result": {"kind": "captcha"},
                "duration_ms": 99,
            },
        )
        source.commit()
        job_ids = _copy_roots_and_events(source, candidate, _JOB_ID)

        rebuild_apply_run_projections(source, candidate, job_ids=job_ids)
        create_exact_v7_schema(canonical)
        assert tuple(
            row for row in schema_dump(candidate) if row[2] == "apply_run_projections"
        ) == tuple(
            row for row in schema_dump(canonical) if row[2] == "apply_run_projections"
        )
        candidate.commit()
    finally:
        source.close()
        canonical.close()
        candidate.close()

    reopened = sqlite3.connect(candidate_path)
    try:
        reopened.execute("PRAGMA foreign_keys = ON")
        assert reopened.execute(
            "SELECT run_id, job_id, status, result, duration_ms FROM apply_run_projections"
        ).fetchone() == ("run-1", _JOB_ID, "captcha", "captcha", 99)
        assert reopened.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        reopened.close()
