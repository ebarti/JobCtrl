"""Gmail application outcome feedback ingestion tests."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from jobctl.infrastructure.gmail.feedback import (
    classify_outcome,
    ensure_application_feedback_tables,
    scan_gmail_feedback,
)


RECIPIENT = "candidate@example.com"
JOB_URL = "https://jobs.example.com/platform-engineer"
APPLIED_AT = "2026-06-01T10:00:00+00:00"


class FakeGmailClient:
    def __init__(
        self,
        metadata: list[dict[str, Any]],
        bodies: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.metadata = metadata
        self.bodies = bodies or {}
        self.search_calls: list[dict[str, Any]] = []
        self.read_calls: list[str] = []

    def search_feedback_emails(
        self,
        *,
        query: str,
        to_email: str,
        after: datetime,
        before: datetime,
        max_results: int,
    ) -> list[dict[str, Any]]:
        self.search_calls.append(
            {
                "query": query,
                "to_email": to_email,
                "after": after,
                "before": before,
                "max_results": max_results,
            }
        )
        return self.metadata[:max_results]

    def read_email(self, *, message_id: str) -> dict[str, Any]:
        self.read_calls.append(message_id)
        return self.bodies[message_id]


def test_unlinked_metadata_does_not_read_email_body(tmp_path: Path) -> None:
    db_path = seed_feedback_db(tmp_path)
    client = FakeGmailClient(
        [
            {
                "id": "low-confidence",
                "threadId": "thread-1",
                "subject": "Weekly engineering newsletter",
                "from": "newsletter@other.example",
                "to": RECIPIENT,
                "date": "Mon, 01 Jun 2026 11:00:00 +0000",
                "snippet": "General career content with no application signal.",
                "internalDate": str(epoch_ms("2026-06-01T11:00:00+00:00")),
            }
        ]
    )

    summary = scan_gmail_feedback(
        db_path=db_path,
        client=client,
        recipient_email=RECIPIENT,
        limit=1,
        max_results_per_anchor=5,
        window_days=7,
    )

    assert client.search_calls
    search = client.search_calls[0]
    query = search["query"]
    assert search["to_email"] == RECIPIENT
    assert search["after"] == datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc)
    assert search["before"] == datetime(2026, 6, 8, 10, 0, tzinfo=timezone.utc)
    assert "ExampleCo" in query
    assert "Platform" in query
    assert "greenhouse" in query
    assert client.read_calls == []
    assert summary["linkedEvidenceCount"] == 0
    assert summary["unlinkedCandidateCount"] == 1


def test_body_snippet_does_not_contribute_to_pre_link_decision(tmp_path: Path) -> None:
    db_path = seed_feedback_db(tmp_path)
    client = FakeGmailClient(
        [
            {
                "id": "snippet-only-match",
                "threadId": "thread-snippet",
                "subject": "Weekly engineering newsletter",
                "from": "newsletter@other.example",
                "to": RECIPIENT,
                "date": "Mon, 01 Jun 2026 11:00:00 +0000",
                "snippet": "ExampleCo Platform Engineer application received via greenhouse.",
                "internalDate": str(epoch_ms("2026-06-01T11:00:00+00:00")),
            }
        ],
        {
            "snippet-only-match": {
                "id": "snippet-only-match",
                "body_text": "This body must not be fetched from a snippet-only match.",
            }
        },
    )

    summary = scan_gmail_feedback(
        db_path=db_path,
        client=client,
        recipient_email=RECIPIENT,
        limit=1,
        max_results_per_anchor=5,
        window_days=7,
    )

    assert client.read_calls == []
    assert summary["linkedEvidenceCount"] == 0
    assert summary["unlinkedCandidateCount"] == 1


def test_linked_body_is_ingested_and_suggested(tmp_path: Path) -> None:
    db_path = seed_feedback_db(tmp_path)
    body_text = "Private application confirmation body for the candidate."
    client = FakeGmailClient(
        [
            {
                "id": "linked-message",
                "threadId": "thread-2",
                "subject": "ExampleCo application received for Platform Engineer",
                "from": "recruiting@exampleco.com",
                "to": RECIPIENT,
                "date": "Mon, 01 Jun 2026 12:00:00 +0000",
                "snippet": "Thank you for applying to ExampleCo.",
                "internalDate": str(epoch_ms("2026-06-01T12:00:00+00:00")),
            }
        ],
        {
            "linked-message": {
                "id": "linked-message",
                "threadId": "thread-2",
                "subject": "ExampleCo application received for Platform Engineer",
                "from": "recruiting@exampleco.com",
                "to": RECIPIENT,
                "date": "Mon, 01 Jun 2026 12:00:00 +0000",
                "snippet": "Thank you for applying to ExampleCo.",
                "body_text": body_text,
            }
        },
    )

    summary = scan_gmail_feedback(
        db_path=db_path,
        client=client,
        recipient_email=RECIPIENT,
        limit=1,
        max_results_per_anchor=5,
        window_days=7,
    )

    assert client.read_calls == ["linked-message"]
    assert summary["linkedEvidenceCount"] == 1
    assert summary["suggestions"] == [
        {
            "suggestionId": summary["suggestions"][0]["suggestionId"],
            "evidenceId": summary["evidence"][0]["evidenceId"],
            "jobKey": JOB_URL,
            "kind": "applied_confirmation",
            "confidence": pytest.approx(0.9),
        }
    ]

    conn = sqlite3.connect(db_path)
    try:
        evidence = conn.execute(
            """
            SELECT provider_message_id, body_text, body_sha256, link_confidence,
                   link_signals_json
            FROM application_email_evidence
            """
        ).fetchone()
        assert evidence == (
            "linked-message",
            body_text,
            hashlib.sha256(body_text.encode("utf-8")).hexdigest(),
            pytest.approx(1.0),
            json.dumps(
                [
                    "recipient",
                    "time_window",
                    "company",
                    "job_title",
                    "application_domain",
                    "outcome_term",
                ],
                sort_keys=True,
            ),
        )
        suggestion = conn.execute(
            "SELECT suggested_kind, confidence, rationale FROM application_outcome_suggestions"
        ).fetchone()
        assert suggestion[0] == "applied_confirmation"
        assert suggestion[1] == pytest.approx(0.9)
        assert "application confirmation" in suggestion[2].lower()
    finally:
        conn.close()


@pytest.mark.parametrize(
    ("subject", "snippet", "body", "expected"),
    [
        (
            "Application received",
            "Thank you for applying",
            "We received your application.",
            "applied_confirmation",
        ),
        (
            "Recruiter follow-up",
            "Talent acquisition reply",
            "Thanks for reaching out. I am the recruiter for this role.",
            "recruiter_reply",
        ),
        (
            "Interview availability",
            "Schedule a call",
            "Can you share times for a technical interview?",
            "interview",
        ),
        (
            "Assessment invitation",
            "Coding challenge",
            "Please complete this take-home assessment.",
            "assessment",
        ),
        (
            "Application update",
            "Unfortunately",
            "We are not moving forward with your application.",
            "rejection",
        ),
        (
            "Offer from ExampleCo",
            "Congratulations",
            "We are pleased to offer you the position.",
            "offer",
        ),
        (
            "Delivery Status Notification",
            "Undeliverable",
            "Address not found and message bounced.",
            "bounced",
        ),
        ("Hello", "A general note", "No recognizable outcome.", "unknown"),
    ],
)
def test_classification_kinds(
    subject: str,
    snippet: str,
    body: str,
    expected: str,
) -> None:
    result = classify_outcome(subject=subject, snippet=snippet, body_text=body)

    assert result.kind == expected
    assert 0 <= result.confidence <= 1
    assert result.rationale


def test_duplicate_gmail_message_id_is_deduped(tmp_path: Path) -> None:
    db_path = seed_feedback_db(tmp_path)
    seed_existing_evidence(db_path, provider_message_id="dupe-message")
    client = FakeGmailClient(
        [
            {
                "id": "dupe-message",
                "threadId": "thread-dupe",
                "subject": "ExampleCo application received for Platform Engineer",
                "from": "recruiting@exampleco.com",
                "to": RECIPIENT,
                "date": "Mon, 01 Jun 2026 12:00:00 +0000",
                "snippet": "Thank you for applying to ExampleCo.",
                "internalDate": str(epoch_ms("2026-06-01T12:00:00+00:00")),
            }
        ],
        {
            "dupe-message": {
                "id": "dupe-message",
                "body_text": "This duplicate body must not be fetched.",
            }
        },
    )

    summary = scan_gmail_feedback(
        db_path=db_path,
        client=client,
        recipient_email=RECIPIENT,
        limit=1,
        max_results_per_anchor=5,
        window_days=7,
    )

    assert client.read_calls == []
    assert summary["duplicateMessageCount"] == 1
    conn = sqlite3.connect(db_path)
    try:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM application_email_evidence WHERE provider_message_id = ?",
                ("dupe-message",),
            ).fetchone()[0]
            == 1
        )
        assert conn.execute("SELECT COUNT(*) FROM application_outcome_suggestions").fetchone()[0] == 0
    finally:
        conn.close()


def test_raw_body_is_not_written_to_events_or_summary(tmp_path: Path) -> None:
    db_path = seed_feedback_db(tmp_path)
    body_text = "Sensitive private Gmail outcome body."
    client = FakeGmailClient(
        [
            {
                "id": "private-message",
                "threadId": "thread-private",
                "subject": "ExampleCo interview for Platform Engineer",
                "from": "recruiting@exampleco.com",
                "to": RECIPIENT,
                "date": "Mon, 01 Jun 2026 12:00:00 +0000",
                "snippet": "Schedule a call with ExampleCo.",
                "internalDate": str(epoch_ms("2026-06-01T12:00:00+00:00")),
            }
        ],
        {
            "private-message": {
                "id": "private-message",
                "threadId": "thread-private",
                "subject": "ExampleCo interview for Platform Engineer",
                "from": "recruiting@exampleco.com",
                "to": RECIPIENT,
                "date": "Mon, 01 Jun 2026 12:00:00 +0000",
                "snippet": "Schedule a call with ExampleCo.",
                "body_text": body_text,
            }
        },
    )

    summary = scan_gmail_feedback(
        db_path=db_path,
        client=client,
        recipient_email=RECIPIENT,
        limit=1,
        max_results_per_anchor=5,
        window_days=7,
    )

    assert body_text not in json.dumps(summary)
    conn = sqlite3.connect(db_path)
    try:
        payloads = "\n".join(
            row[0] or "" for row in conn.execute("SELECT payload_json FROM job_events").fetchall()
        )
        assert body_text not in payloads
    finally:
        conn.close()


def seed_feedback_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "jobctl.db"
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            title TEXT,
            company TEXT,
            site TEXT,
            application_url TEXT,
            applied_at TEXT,
            apply_status TEXT,
            discovered_at TEXT
        )
        """
    )
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, company, site, application_url, applied_at,
            apply_status, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            JOB_URL,
            "Principal Platform Engineer",
            "ExampleCo",
            "ExampleCo",
            "https://boards.greenhouse.io/exampleco/jobs/123",
            APPLIED_AT,
            "applied",
            "2026-05-31T10:00:00+00:00",
        ),
    )
    conn.execute(
        """
        CREATE TABLE candidate_profiles (
            tenant_id TEXT NOT NULL DEFAULT 'local',
            profile_id TEXT NOT NULL DEFAULT 'default',
            personal_email TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, profile_id)
        )
        """
    )
    conn.execute(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, personal_email) VALUES (?, ?, ?)",
        ("local", "default", RECIPIENT),
    )
    conn.execute(
        """
        CREATE TABLE job_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_url TEXT,
            stage TEXT,
            event_type TEXT NOT NULL DEFAULT '',
            level TEXT NOT NULL DEFAULT 'info',
            message TEXT,
            occurred_at TEXT NOT NULL,
            payload_json TEXT
        )
        """
    )
    ensure_application_feedback_tables(conn)
    conn.commit()
    conn.close()
    return db_path


def seed_existing_evidence(db_path: Path, *, provider_message_id: str) -> None:
    conn = sqlite3.connect(db_path)
    ensure_application_feedback_tables(conn)
    conn.execute(
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
            "existing-evidence",
            JOB_URL,
            "gmail",
            provider_message_id,
            "thread-dupe",
            "recruiting@exampleco.com",
            json.dumps([RECIPIENT]),
            "Existing",
            "Existing",
            "2026-06-01T12:00:00+00:00",
            "2026-06-01T12:01:00+00:00",
            0.95,
            json.dumps(["recipient", "time_window", "company"]),
            "existing body",
            hashlib.sha256(b"existing body").hexdigest(),
            "2026-06-01T12:01:00+00:00",
        ),
    )
    conn.commit()
    conn.close()


def epoch_ms(value: str) -> int:
    return int(datetime.fromisoformat(value).timestamp() * 1000)
