"""Focused v6-to-v7 historical event identity migration tests."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v6_to_v7_events as events
from jobctrl.infrastructure.migrations.v6_to_v7_identity import transform_v6_root_identity
from tests.v6_migration_fixture import create_shipped_v6_database


def _insert_v6_event(
    conn: sqlite3.Connection,
    *,
    payload: dict[str, object],
    event_id: int = 7,
    event_type: str = "StageCompleted",
    job_url: str = "https://jobs.example/shipped-v6",
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
            "fixture",
            "2026-07-30T10:00:00+00:00",
            json.dumps(payload, separators=(",", ":")),
            "job",
            job_url,
            f"fixture-event-{event_id}",
        ),
    )
    conn.execute("UPDATE sqlite_sequence SET seq = 41 WHERE name = 'job_events'")


def test_event_root_identity_is_upcast_without_mutating_nested_payloads(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        transform_v6_root_identity(conn)
        expected_job_id = str(conn.execute("SELECT job_id FROM jobs").fetchone()[0])
        nested_untrusted_payload = {
            "userContext": "Attack vectors:\nPrompt injection",
            "jobUrl": "https://jobs.example/shipped-v6",
            "items": [{"job_url": "https://jobs.example/shipped-v6"}],
        }
        _insert_v6_event(
            conn,
            payload={
                "jobUrl": "https://jobs.example/shipped-v6",
                "untrusted": nested_untrusted_payload,
            },
        )

        events.transform_v6_job_events(conn)

        row = conn.execute(
            "SELECT event_id, job_id, entity_ref, payload_json FROM job_events"
        ).fetchone()
        payload = json.loads(str(row[3]))
        assert row[:3] == (7, expected_job_id, expected_job_id)
        assert payload["jobId"] == expected_job_id
        assert "jobUrl" not in payload
        assert payload["untrusted"] == nested_untrusted_payload
        assert conn.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
        ).fetchone()[0] == 41
    finally:
        conn.close()


def test_event_root_plural_variants_are_upcast_to_job_ids(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        transform_v6_root_identity(conn)
        expected_job_id = str(conn.execute("SELECT job_id FROM jobs").fetchone()[0])
        _insert_v6_event(
            conn,
            payload={
                "jobUrls": ["https://jobs.example/shipped-v6"],
                "job_keys": [expected_job_id],
            },
        )

        events.transform_v6_job_events(conn)

        row = conn.execute(
            "SELECT job_id, entity_ref, payload_json FROM job_events"
        ).fetchone()
        assert row[:2] == (expected_job_id, expected_job_id)
        assert json.loads(str(row[2])) == {
            "jobIds": [expected_job_id],
            "job_ids": [expected_job_id],
        }
    finally:
        conn.close()


def test_duplicate_link_event_preserves_historical_candidate_locator(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        transform_v6_root_identity(conn)
        expected_job_id = str(conn.execute("SELECT job_id FROM jobs").fetchone()[0])
        historical_url = "https://jobs.example/historical-v6"
        conn.execute(
            """
            INSERT INTO job_identity_aliases (
                tenant_id, alias_kind, alias_value, job_id, created_at, retired_at
            ) VALUES ('local', 'posting_url', ?, ?, ?, ?)
            """,
            (
                historical_url,
                expected_job_id,
                "2026-07-01T00:00:00+00:00",
                "2026-07-15T00:00:00+00:00",
            ),
        )
        _insert_v6_event(
            conn,
            event_type="DuplicateJobLinkRejected",
            payload={
                "candidateJobId": historical_url,
                "survivingJobId": historical_url,
                "details": {"candidateJobId": historical_url},
            },
        )

        events.transform_v6_job_events(conn)

        payload = json.loads(
            str(conn.execute("SELECT payload_json FROM job_events").fetchone()[0])
        )
        assert payload == {
            "candidatePostingUrl": historical_url,
            "survivingJobId": expected_job_id,
            "details": {"candidateJobId": historical_url},
        }
    finally:
        conn.close()


@pytest.mark.parametrize(
    "payload_kind",
    ("unresolved", "conflict"),
)
def test_invalid_event_root_reference_rolls_back_without_data_loss(
    tmp_path: Path,
    payload_kind: str,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO jobs (url, title, discovered_at) VALUES (?, ?, ?)
            """,
            (
                "https://jobs.example/conflicting-v6",
                "Conflicting V6 fixture",
                "2026-07-30T09:01:00+00:00",
            ),
        )
        transform_v6_root_identity(conn)
        conflicting_job_id = str(
            conn.execute(
                "SELECT job_id FROM jobs WHERE url = ?",
                ("https://jobs.example/conflicting-v6",),
            ).fetchone()[0]
        )
        _insert_v6_event(
            conn,
            payload=(
                {"jobUrl": "https://jobs.example/unresolved-v6"}
                if payload_kind == "unresolved"
                else {"jobId": conflicting_job_id}
            ),
        )
        before_schema = tuple(
            conn.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()
        )
        before_rows = tuple(conn.execute("SELECT * FROM job_events").fetchall())
        before_sequence = conn.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
        ).fetchone()

        with pytest.raises(RuntimeError, match="event_job_identity"):
            events.transform_v6_job_events(conn)

        assert tuple(
            conn.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()
        ) == before_schema
        assert tuple(conn.execute("SELECT * FROM job_events").fetchall()) == before_rows
        assert conn.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
        ).fetchone() == before_sequence
    finally:
        conn.close()


def test_event_identity_rebuild_rolls_back_when_verification_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        transform_v6_root_identity(conn)
        _insert_v6_event(conn, payload={"jobUrl": "https://jobs.example/shipped-v6"})
        before_schema = tuple(
            conn.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()
        )
        before_rows = tuple(conn.execute("SELECT * FROM job_events").fetchall())
        before_sequence = conn.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
        ).fetchone()
        monkeypatch.setattr(
            events,
            "create_v7_job_event_indexes",
            lambda _conn: (_ for _ in ()).throw(RuntimeError("fault")),
        )

        with pytest.raises(RuntimeError, match="fault"):
            events.transform_v6_job_events(conn)

        assert tuple(
            conn.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()
        ) == before_schema
        assert tuple(conn.execute("SELECT * FROM job_events").fetchall()) == before_rows
        assert conn.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
        ).fetchone() == before_sequence
    finally:
        conn.close()
