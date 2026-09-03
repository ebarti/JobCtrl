"""Gmail application outcome feedback ingestion tests."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

import jobctrl.infrastructure.events as events_module
from jobctrl.database import close_connection, get_connection
from jobctrl.infrastructure.events import get_default_publisher, reset_default_publisher
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.gmail.client import _safe_query_hints
from jobctrl.infrastructure.gmail.feedback import (
    ApplicationAnchor,
    _anchor_query,
    _apply_run_anchors,
    _outcome_anchors,
    classify_outcome,
    ensure_application_feedback_tables,
    scan_gmail_feedback,
)
from jobctrl.infrastructure.migrations.schema_v9 import (
    create_unstamped_exact_v9_candidate,
)
from jobctrl.infrastructure.projections.projection_builder import (
    PROJECTION_NAME,
    ProjectionBuilder,
)


RECIPIENT = "candidate@example.com"
JOB_URL = "https://jobs.example.com/platform-engineer"
APPLIED_AT = "2026-06-01T10:00:00+00:00"
JOB_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"


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


class DeleteJobDuringReadClient(FakeGmailClient):
    def __init__(
        self,
        db_path: Path,
        metadata: list[dict[str, Any]],
        bodies: dict[str, dict[str, Any]],
    ) -> None:
        super().__init__(metadata, bodies)
        self.db_path = db_path
        self.deleted_count = 0

    def read_email(self, *, message_id: str) -> dict[str, Any]:
        with closing(sqlite3.connect(self.db_path, timeout=0.25)) as conn:
            conn.execute("PRAGMA busy_timeout=250")
            conn.execute("PRAGMA foreign_keys=ON")
            assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
            cursor = conn.execute(
                "DELETE FROM jobs WHERE tenant_id = ? AND job_id = ?",
                ("local", JOB_ID),
            )
            conn.commit()
            self.deleted_count = cursor.rowcount
        return super().read_email(message_id=message_id)


class BarrierGmailClient(FakeGmailClient):
    def __init__(
        self,
        barrier: threading.Barrier,
        metadata: list[dict[str, Any]],
        bodies: dict[str, dict[str, Any]],
    ) -> None:
        super().__init__(metadata, bodies)
        self.barrier = barrier

    def read_email(self, *, message_id: str) -> dict[str, Any]:
        self.barrier.wait(timeout=3)
        return super().read_email(message_id=message_id)


def _linked_message_metadata(message_id: str) -> dict[str, Any]:
    return {
        "id": message_id,
        "threadId": f"thread-{message_id}",
        "subject": "ExampleCo application received for Platform Engineer",
        "from": "recruiting@exampleco.com",
        "to": RECIPIENT,
        "date": "Mon, 01 Jun 2026 12:00:00 +0000",
        "snippet": "Thank you for applying to ExampleCo.",
        "internalDate": str(epoch_ms("2026-06-01T12:00:00+00:00")),
    }


def _linked_message_body(message_id: str, body_text: str) -> dict[str, Any]:
    return {
        "id": message_id,
        "body_text": body_text,
    }


def test_anchor_query_prioritizes_application_hints_before_job_url() -> None:
    anchor = ApplicationAnchor(
        job_id=JOB_ID,
        job_url="https://www.linkedin.com/jobs/view/4123456789",
        title="Staff Engineer",
        company="Acme",
        application_url="https://jobs.lever.co/acme/1b2c3d4e",
        anchor_at=datetime.fromisoformat(APPLIED_AT),
    )

    assert _safe_query_hints(_anchor_query(anchor)) == [
        "Acme",
        "Staff",
        "jobs.lever.co",
        "1b2c3d4e",
        "lever",
        "www.linkedin.com",
    ]


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
            "jobId": JOB_ID,
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


def test_job_deleted_during_body_read_is_not_persisted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = seed_feedback_db(tmp_path)
    with closing(sqlite3.connect(db_path)) as conn:
        conn.execute(
            """
            INSERT INTO jobs (
                tenant_id, job_id, url, title, company, application_url,
                applied_at, apply_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "other",
                JOB_ID,
                "https://jobs.example.com/other-tenant-platform-engineer",
                "Platform Engineer",
                "ExampleCo",
                "https://boards.greenhouse.io/exampleco/jobs/other-tenant-123",
                APPLIED_AT,
                "applied",
            ),
        )
        conn.commit()

    message_id = "deleted-job-race"
    body_text = "Private body that must not survive the deleted-job race."
    client = DeleteJobDuringReadClient(
        db_path,
        [_linked_message_metadata(message_id)],
        {message_id: _linked_message_body(message_id, body_text)},
    )
    publisher = InProcessEventBus()
    published_event_types: list[str] = []
    publisher.subscribe(None, lambda event: published_event_types.append(event.event_type))
    monkeypatch.setattr(events_module, "get_default_publisher", lambda: publisher)

    summary = scan_gmail_feedback(
        db_path=db_path,
        client=client,
        recipient_email=RECIPIENT,
        limit=1,
        max_results_per_anchor=5,
        window_days=7,
    )

    assert client.deleted_count == 1
    assert client.read_calls == [message_id]
    assert summary["ok"] is True
    assert summary["scannedAnchorCount"] == 1
    assert summary["searchedMessageCount"] == 1
    assert summary["linkedEvidenceCount"] == 0
    assert summary["suggestionsCreatedCount"] == 0
    assert summary["duplicateMessageCount"] == 0
    assert summary["unlinkedCandidateCount"] == 1
    assert summary["evidence"] == []
    assert summary["suggestions"] == []
    assert published_event_types == []

    with closing(sqlite3.connect(db_path)) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE tenant_id = ? AND job_id = ?",
            ("local", JOB_ID),
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE tenant_id = ? AND job_id = ?",
            ("other", JOB_ID),
        ).fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) FROM application_email_evidence WHERE tenant_id = ?",
            ("local",),
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM application_email_evidence WHERE body_text = ?",
            (body_text,),
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM application_outcome_suggestions WHERE tenant_id = ?",
            ("local",),
        ).fetchone()[0] == 0
        assert conn.execute(
            """
            SELECT COUNT(*)
            FROM job_events
            WHERE tenant_id = ? AND job_id = ?
              AND event_type = 'ApplicationEmailFeedbackIngested'
            """,
            ("local", JOB_ID),
        ).fetchone()[0] == 0
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_concurrent_scans_dedupe_after_body_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = seed_feedback_db(tmp_path)
    message_id = "concurrent-message"
    metadata = [_linked_message_metadata(message_id)]
    bodies = {
        message_id: _linked_message_body(
            message_id,
            "Private application confirmation body for the candidate.",
        )
    }
    barrier = threading.Barrier(2)
    clients = [
        BarrierGmailClient(barrier, metadata, bodies),
        BarrierGmailClient(barrier, metadata, bodies),
    ]
    publisher = InProcessEventBus()
    published_event_types: list[str] = []
    published_lock = threading.Lock()

    def capture_event(event: Any) -> None:
        with published_lock:
            published_event_types.append(event.event_type)

    publisher.subscribe(None, capture_event)
    monkeypatch.setattr(events_module, "get_default_publisher", lambda: publisher)

    def run_scan(client: BarrierGmailClient) -> dict[str, Any]:
        return scan_gmail_feedback(
            db_path=db_path,
            client=client,
            recipient_email=RECIPIENT,
            limit=1,
            max_results_per_anchor=5,
            window_days=7,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(run_scan, client) for client in clients]
        summaries = [future.result(timeout=15) for future in futures]

    assert all(summary["ok"] is True for summary in summaries)
    assert all(summary["scannedAnchorCount"] == 1 for summary in summaries)
    assert all(summary["searchedMessageCount"] == 1 for summary in summaries)
    assert all(client.read_calls == [message_id] for client in clients)
    assert sorted(
        (
            summary["linkedEvidenceCount"],
            summary["duplicateMessageCount"],
            summary["suggestionsCreatedCount"],
        )
        for summary in summaries
    ) == [(0, 1, 0), (1, 0, 1)]
    assert published_event_types == ["ApplicationEmailFeedbackIngested"]

    with closing(sqlite3.connect(db_path)) as conn:
        assert conn.execute(
            """
            SELECT COUNT(*)
            FROM application_email_evidence
            WHERE tenant_id = ? AND provider = ? AND provider_message_id = ?
            """,
            ("local", "gmail", message_id),
        ).fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) FROM application_outcome_suggestions WHERE tenant_id = ?",
            ("local",),
        ).fetchone()[0] == 1
        assert conn.execute(
            """
            SELECT COUNT(*)
            FROM job_events
            WHERE tenant_id = ? AND job_id = ?
              AND event_type = 'ApplicationEmailFeedbackIngested'
            """,
            ("local", JOB_ID),
        ).fetchone()[0] == 1
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


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


def test_outcome_anchors_join_v9_job_id(tmp_path: Path) -> None:
    """Outcome anchors use the tenant-scoped canonical job identity."""
    db_path = tmp_path / "jobctrl.db"
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    create_unstamped_exact_v9_candidate(conn)
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, company, application_url)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            JOB_ID,
            JOB_URL,
            "Principal Platform Engineer",
            "ExampleCo",
            "https://boards.greenhouse.io/exampleco/jobs/123",
        ),
    )
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, company, application_url)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            "other",
            JOB_ID,
            "https://jobs.example.com/other-tenant-role",
            "Other Tenant Role",
            "OtherTenantCo",
            "https://boards.example.com/other/456",
        ),
    )
    conn.execute(
        """
        INSERT INTO application_outcomes (
            tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            "outcome-1",
            JOB_ID,
            "interview",
            "gmail",
            "2026-06-02T12:00:00+00:00",
            "2026-06-02T12:01:00+00:00",
        ),
    )
    conn.execute(
        """
        INSERT INTO application_outcomes (
            tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "other",
            "outcome-other",
            JOB_ID,
            "interview",
            "gmail",
            "2026-06-02T12:00:00+00:00",
            "2026-06-02T12:01:00+00:00",
        ),
    )
    conn.commit()
    try:
        anchors = _outcome_anchors(conn)
    finally:
        conn.close()

    assert len(anchors) == 1
    assert anchors[0].job_id == JOB_ID
    assert anchors[0].job_url == JOB_URL
    assert anchors[0].company == "ExampleCo"


def test_apply_run_anchors_join_v9_tenant_and_job_id(tmp_path: Path) -> None:
    """Apply-run anchors cannot cross tenants that share a JobId."""
    db_path = tmp_path / "jobctrl.db"
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    create_unstamped_exact_v9_candidate(conn)
    conn.executemany(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, company, application_url)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (
                "local",
                JOB_ID,
                JOB_URL,
                "Principal Platform Engineer",
                "ExampleCo",
                "https://boards.greenhouse.io/exampleco/jobs/123",
            ),
            (
                "other",
                JOB_ID,
                "https://jobs.example.com/other-tenant-role",
                "Other Tenant Role",
                "OtherTenantCo",
                "https://boards.example.com/other/456",
            ),
        ],
    )
    conn.executemany(
        """
        INSERT INTO apply_run_projections (
            run_id, tenant_id, job_id, status, result, dry_run, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                "run-local",
                "local",
                JOB_ID,
                "succeeded",
                "applied",
                0,
                "2026-06-01T10:00:00+00:00",
                "2026-06-01T10:01:00+00:00",
            ),
            (
                "run-other",
                "other",
                JOB_ID,
                "succeeded",
                "applied",
                0,
                "2026-06-01T10:00:00+00:00",
                "2026-06-01T10:01:00+00:00",
            ),
        ],
    )
    conn.commit()
    try:
        anchors = _apply_run_anchors(conn)
    finally:
        conn.close()

    assert len(anchors) == 1
    assert anchors[0].job_id == JOB_ID
    assert anchors[0].job_url == JOB_URL
    assert anchors[0].company == "ExampleCo"


def test_v9_scan_writes_canonical_job_id_and_sse_event(tmp_path: Path) -> None:
    """The production scanner persists canonical records and an SSE-ready event."""
    db_path = tmp_path / "jobctrl.db"
    conn = sqlite3.connect(db_path)
    create_unstamped_exact_v9_candidate(conn)
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, application_url,
            applied_at, apply_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            JOB_ID,
            JOB_URL,
            "Principal Platform Engineer",
            "ExampleCo",
            "https://boards.greenhouse.io/exampleco/jobs/123",
            APPLIED_AT,
            "applied",
        ),
    )
    conn.commit()
    conn.close()

    body_text = "Private application confirmation body for the candidate."
    client = FakeGmailClient(
        [
            {
                "id": "v9-linked",
                "threadId": "thread-v9",
                "subject": "ExampleCo application received for Platform Engineer",
                "from": "recruiting@exampleco.com",
                "to": RECIPIENT,
                "date": "Mon, 01 Jun 2026 12:00:00 +0000",
                "snippet": "Thank you for applying to ExampleCo.",
                "internalDate": str(epoch_ms("2026-06-01T12:00:00+00:00")),
            }
        ],
        {
            "v9-linked": {
                "id": "v9-linked",
                "threadId": "thread-v9",
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
        limit=10,
        max_results_per_anchor=5,
        window_days=7,
    )

    assert summary["linkedEvidenceCount"] == 1
    conn = sqlite3.connect(db_path)
    try:
        evidence_job_id = conn.execute(
            "SELECT job_id FROM application_email_evidence"
        ).fetchone()[0]
        suggestion_job_id = conn.execute(
            "SELECT job_id FROM application_outcome_suggestions"
        ).fetchone()[0]
        event = conn.execute(
            """
            SELECT tenant_id, job_id, identity_version, stage, event_type,
                   level, message, payload_json
            FROM job_events
            WHERE event_type = 'ApplicationEmailFeedbackIngested'
            """
        ).fetchone()
    finally:
        conn.close()
    assert evidence_job_id == JOB_ID
    assert suggestion_job_id == JOB_ID
    assert event is not None
    assert event[:7] == (
        "local",
        JOB_ID,
        1,
        "apply",
        "ApplicationEmailFeedbackIngested",
        "info",
        "Application email feedback ingested.",
    )
    event_payload = json.loads(event[7])
    assert set(event_payload) == {
        "evidenceId",
        "suggestionId",
        "provider",
        "suggestedKind",
        "classificationConfidence",
        "linkConfidence",
        "linkSignals",
        "stage",
        "level",
        "message",
        "jobId",
    }
    assert event_payload["jobId"] == JOB_ID
    assert event_payload["evidenceId"] == summary["evidence"][0]["evidenceId"]
    assert event_payload["suggestionId"] == summary["suggestions"][0]["suggestionId"]
    assert event_payload["stage"] == "apply"
    assert event_payload["level"] == "info"
    assert event_payload["message"] == "Application email feedback ingested."
    assert "tenantId" not in event_payload
    for legacy_alias in ("jobKey", "job_key", "jobUrl", "job_url", "job_id"):
        assert legacy_alias not in event_payload


def test_feedback_events_publish_after_commit_for_projection_refresh(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    db_path = seed_feedback_db(tmp_path)
    reset_default_publisher()
    projection_conn = get_connection(db_path)
    projection_conn.execute("PRAGMA busy_timeout=50")
    builder = ProjectionBuilder(conn_factory=lambda: get_connection(db_path))
    publisher = get_default_publisher()
    builder.refresh()
    projection_subscription = builder.subscribe_to(publisher)
    published_event_types: list[str] = []
    capture_subscription = publisher.subscribe(
        "ApplicationEmailFeedbackIngested",
        lambda event: published_event_types.append(event.event_type),
    )
    client = FakeGmailClient(
        [
            {
                "id": message_id,
                "threadId": f"thread-{index}",
                "subject": "ExampleCo application received for Platform Engineer",
                "from": "recruiting@exampleco.com",
                "to": RECIPIENT,
                "date": f"Mon, 01 Jun 2026 12:0{index}:00 +0000",
                "snippet": "Thank you for applying to ExampleCo.",
                "internalDate": str(epoch_ms(f"2026-06-01T12:0{index}:00+00:00")),
            }
            for index, message_id in enumerate(("projection-1", "projection-2"), start=1)
        ],
        {
            message_id: {
                "id": message_id,
                "body_text": "Private application confirmation body for the candidate.",
            }
            for message_id in ("projection-1", "projection-2")
        },
    )

    try:
        caplog.clear()
        summary = scan_gmail_feedback(
            db_path=db_path,
            client=client,
            recipient_email=RECIPIENT,
            limit=1,
            max_results_per_anchor=5,
            window_days=7,
        )

        max_event_id = projection_conn.execute(
            "SELECT MAX(event_id) FROM job_events"
        ).fetchone()[0]
        watermark = projection_conn.execute(
            "SELECT last_event_id FROM event_watermarks WHERE projection_name = ?",
            (PROJECTION_NAME,),
        ).fetchone()
        projected_job = projection_conn.execute(
            "SELECT job_id FROM job_list_projections WHERE tenant_id = ? AND job_id = ?",
            ("local", JOB_ID),
        ).fetchone()

        assert summary["linkedEvidenceCount"] == 2
        assert published_event_types == [
            "ApplicationEmailFeedbackIngested",
            "ApplicationEmailFeedbackIngested",
        ]
        assert "database is locked" not in caplog.text.lower()
        assert max_event_id is not None
        assert watermark is not None
        assert watermark[0] == max_event_id
        assert projected_job is not None
    finally:
        capture_subscription.unsubscribe()
        projection_subscription.unsubscribe()
        reset_default_publisher()
        close_connection(db_path)


def seed_feedback_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "jobctrl.db"
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    create_unstamped_exact_v9_candidate(conn)
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, site, application_url, applied_at,
            apply_status, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            JOB_ID,
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
        INSERT INTO candidate_profiles (
            tenant_id, profile_id, personal_email, updated_at
        ) VALUES (?, ?, ?, ?)
        """,
        ("local", "default", RECIPIENT, "2026-06-01T09:00:00+00:00"),
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
            tenant_id, evidence_id, job_id, provider, provider_message_id,
            provider_thread_id, from_address, to_addresses_json, subject, snippet,
            received_at, linked_at, link_confidence, link_signals_json,
            body_text, body_sha256, body_stored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            "existing-evidence",
            JOB_ID,
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
