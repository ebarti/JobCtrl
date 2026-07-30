"""Schema-v22 application-feedback candidate JobId reference contracts."""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    close_connection,
    ensure_application_feedback_candidate_references_v22,
    init_db,
    reassign_discovery_identity_references,
)
from jobctrl.domain.discovery import (
    Employer,
    Job,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import SqliteJobRepository
from jobctrl.infrastructure.gmail.feedback import (
    ensure_application_feedback_tables,
    scan_gmail_feedback,
)


PREVIOUS_SCHEMA_VERSION = 21


def _discovered_job(posting_url: str, job_id: JobId) -> Job:
    return Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        posting_url=PostingUrl(value=posting_url),
        source=Source(board="example"),
        employer=Employer(name="ExampleCo"),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(title="Platform Engineer"),
        discovered_at="2026-07-30T10:00:00+00:00",
    )


def _columns(
    conn: sqlite3.Connection,
    table_name: str,
) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table_name}")'
        ).fetchall()
    }


def _downgrade_candidates_to_v21(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        DROP TABLE application_outcome_suggestions;
        DROP TABLE application_email_evidence;
        CREATE TABLE application_email_evidence (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            evidence_id          TEXT NOT NULL,
            job_key              TEXT NOT NULL,
            provider             TEXT NOT NULL DEFAULT 'gmail',
            provider_message_id  TEXT NOT NULL,
            provider_thread_id   TEXT,
            from_address         TEXT,
            to_addresses_json    TEXT NOT NULL DEFAULT '[]',
            subject              TEXT,
            snippet              TEXT,
            received_at          TEXT,
            linked_at            TEXT NOT NULL,
            link_confidence      REAL NOT NULL DEFAULT 0,
            link_signals_json    TEXT NOT NULL DEFAULT '[]',
            body_text            TEXT,
            body_sha256          TEXT,
            body_stored_at       TEXT,
            PRIMARY KEY (tenant_id, evidence_id),
            UNIQUE (tenant_id, provider, provider_message_id)
        );
        CREATE INDEX idx_application_email_evidence_job
        ON application_email_evidence(
            tenant_id, job_key, received_at DESC
        );
        CREATE TABLE application_outcome_suggestions (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            suggestion_id      TEXT NOT NULL,
            job_key            TEXT NOT NULL,
            evidence_id        TEXT,
            suggested_kind     TEXT NOT NULL,
            confidence         REAL NOT NULL DEFAULT 0,
            rationale          TEXT NOT NULL DEFAULT '',
            status             TEXT NOT NULL DEFAULT 'pending',
            created_at         TEXT NOT NULL,
            decided_at         TEXT,
            decision           TEXT,
            decision_reason    TEXT,
            decided_outcome_id TEXT,
            PRIMARY KEY (tenant_id, suggestion_id)
        );
        CREATE INDEX idx_application_outcome_suggestions_job
        ON application_outcome_suggestions(
            tenant_id, job_key, status, created_at DESC
        );
        CREATE INDEX idx_application_outcome_suggestions_status
        ON application_outcome_suggestions(
            tenant_id, status, created_at DESC
        );
        PRAGMA user_version = 21;
        """
    )
    conn.commit()


def _insert_candidate_pair(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    reference_column: str,
    reference: str,
    marker: str,
    evidence_id: str | None = None,
    suggestion_id: str | None = None,
    provider_message_id: str | None = None,
) -> None:
    evidence = evidence_id or f"evidence:{marker}"
    suggestion = suggestion_id or f"suggestion:{marker}"
    message = provider_message_id or f"message:{marker}"
    conn.execute(
        f"""
        INSERT INTO application_email_evidence (
            tenant_id, evidence_id, {reference_column}, provider,
            provider_message_id, provider_thread_id, from_address,
            to_addresses_json, subject, snippet, received_at, linked_at,
            link_confidence, link_signals_json, body_text, body_sha256,
            body_stored_at
        ) VALUES (
            ?, ?, ?, 'gmail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
        (
            tenant_id,
            evidence,
            reference,
            message,
            f"thread:{marker}",
            f"from:{marker}@example.com",
            json.dumps([f"to:{marker}@example.com"]),
            f"subject:{marker}",
            f"snippet:{marker}",
            f"2026-07-30T10:0{len(marker) % 9}:00+00:00",
            "2026-07-30T11:00:00+00:00",
            0.91,
            json.dumps(["recipient", f"signal:{marker}"]),
            f"private-body:{marker}",
            f"sha256:{marker}",
            "2026-07-30T11:00:00+00:00",
        ),
    )
    conn.execute(
        f"""
        INSERT INTO application_outcome_suggestions (
            tenant_id, suggestion_id, {reference_column}, evidence_id,
            suggested_kind, confidence, rationale, status, created_at,
            decided_at, decision, decision_reason, decided_outcome_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            tenant_id,
            suggestion,
            reference,
            evidence,
            "interview",
            0.87,
            f"rationale:{marker}",
            "accepted",
            "2026-07-30T11:01:00+00:00",
            "2026-07-30T11:02:00+00:00",
            "accept",
            f"reason:{marker}",
            f"outcome:{marker}",
        ),
    )


def _rows_without_reference(
    conn: sqlite3.Connection,
    *,
    table: str,
    reference: str,
) -> dict[tuple[str, str], tuple[Any, ...]]:
    id_column = (
        "evidence_id"
        if table == "application_email_evidence"
        else "suggestion_id"
    )
    columns = [
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table}")'
        ).fetchall()
        if str(row[1]) != reference
    ]
    selected = ", ".join(f'"{column}"' for column in columns)
    return {
        (str(row[0]), str(row[1])): tuple(row)
        for row in conn.execute(
            f"""
            SELECT tenant_id, {id_column}, {selected}
            FROM "{table}"
            ORDER BY tenant_id, {id_column}
            """
        ).fetchall()
    }


def test_v21_candidates_migrate_every_alias_uuid_url_and_tenant(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    owner_id = JobId(str(uuid.uuid4()))
    storage_url = "https://boards.example/jobs/evidence"
    alias_url = "https://careers.example/jobs/evidence"
    jobs.save(_discovered_job(storage_url, owner_id))
    jobs.save(_discovered_job(alias_url, owner_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner = JobId(str(uuid.uuid4()))
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/id-text-owner",
            JobId(uuid_shaped_url),
        )
    )
    other_tenant_url = "https://tenant-b.example/jobs/evidence"
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'tenant-b', ?, 'Platform Engineer', 'ExampleCo', ?)
        """,
        (
            other_tenant_url,
            str(owner_id),
            "2026-07-30T10:00:00+00:00",
        ),
    )

    _downgrade_candidates_to_v21(conn)
    fixtures = (
        (
            "local",
            storage_url,
            "storage",
            "storage-evidence",
            "storage-suggestion",
            "storage-message",
        ),
        (
            "local",
            alias_url,
            "alias",
            "alias-evidence",
            "alias-suggestion",
            "alias-message",
        ),
        (
            "local",
            uuid_shaped_url,
            "uuid-url",
            "shared-evidence",
            "shared-suggestion",
            "shared-message",
        ),
        (
            "tenant-b",
            other_tenant_url,
            "tenant-b",
            "shared-evidence",
            "shared-suggestion",
            "shared-message",
        ),
    )
    for (
        tenant_id,
        job_key,
        marker,
        evidence_id,
        suggestion_id,
        provider_message_id,
    ) in fixtures:
        _insert_candidate_pair(
            conn,
            tenant_id=tenant_id,
            reference_column="job_key",
            reference=job_key,
            marker=marker,
            evidence_id=evidence_id,
            suggestion_id=suggestion_id,
            provider_message_id=provider_message_id,
        )
    conn.commit()
    before_evidence = _rows_without_reference(
        conn,
        table="application_email_evidence",
        reference="job_key",
    )
    before_suggestions = _rows_without_reference(
        conn,
        table="application_outcome_suggestions",
        reference="job_key",
    )
    close_connection(db_path)

    reopened = init_db(db_path)
    assert (
        reopened.execute("PRAGMA user_version").fetchone()[0]
        == SCHEMA_VERSION
        == 24
    )
    for table in database_module._APPLICATION_FEEDBACK_CANDIDATE_TABLES:
        assert "job_id" in _columns(reopened, table)
        assert "job_key" not in _columns(reopened, table)
    assert _rows_without_reference(
        reopened,
        table="application_email_evidence",
        reference="job_id",
    ) == before_evidence
    assert _rows_without_reference(
        reopened,
        table="application_outcome_suggestions",
        reference="job_id",
    ) == before_suggestions

    expected_job_ids = {
        ("local", "storage-evidence"): str(owner_id),
        ("local", "alias-evidence"): str(owner_id),
        ("local", "shared-evidence"): str(uuid_url_owner),
        ("tenant-b", "shared-evidence"): str(owner_id),
    }
    assert {
        (str(row[0]), str(row[1])): str(row[2])
        for row in reopened.execute(
            """
            SELECT tenant_id, evidence_id, job_id
            FROM application_email_evidence
            """
        ).fetchall()
    } == expected_job_ids
    assert database_module._has_application_feedback_candidate_schema_v22(
        reopened
    )
    assert reopened.execute("PRAGMA foreign_key_check").fetchone() is None
    with pytest.raises(sqlite3.IntegrityError):
        reopened.execute(
            """
            INSERT INTO application_email_evidence (
                tenant_id, evidence_id, job_id, provider,
                provider_message_id, linked_at
            ) VALUES ('local', 'duplicate-provider-message', ?, 'gmail',
                      'shared-message', '2026-07-30T12:00:00+00:00')
            """,
            (str(owner_id),),
        )
    reopened.rollback()
    close_connection(db_path)

    reopened_again = init_db(db_path)
    assert reopened_again.execute(
        "SELECT COUNT(*) FROM application_email_evidence"
    ).fetchone()[0] == 4
    assert reopened_again.execute(
        "SELECT COUNT(*) FROM application_outcome_suggestions"
    ).fetchone()[0] == 4
    close_connection(db_path)


def test_v22_candidate_migration_rolls_back_and_retries_with_fks_on(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/candidate-retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_candidates_to_v21(conn)
    _insert_candidate_pair(
        conn,
        tenant_id="local",
        reference_column="job_key",
        reference=job_url,
        marker="retry",
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    original_verify = (
        database_module
        ._verify_application_feedback_candidate_references_v22
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_counts: dict[str, int],
    ) -> None:
        del expected_counts
        raise RuntimeError("injected candidate verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_application_feedback_candidate_references_v22",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected candidate verification failure",
    ):
        ensure_application_feedback_candidate_references_v22(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 21
    assert "job_key" in _columns(
        conn,
        "application_email_evidence",
    )
    assert "job_key" in _columns(
        conn,
        "application_outcome_suggestions",
    )
    assert conn.execute(
        "SELECT body_text FROM application_email_evidence"
    ).fetchone()[0] == "private-body:retry"

    monkeypatch.setattr(
        database_module,
        "_verify_application_feedback_candidate_references_v22",
        original_verify,
    )
    assert ensure_application_feedback_candidate_references_v22(conn) == [
        "application_email_evidence",
        "application_outcome_suggestions",
    ]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 22
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


@pytest.mark.parametrize(
    ("schema_version", "expected_reference"),
    ((0, "job_key"), (21, "job_key"), (22, "job_id")),
)
def test_missing_candidate_table_recovery_is_version_aware(
    schema_version: int,
    expected_reference: str,
) -> None:
    for ensure_tables in (
        lambda conn: database_module
        ._ensure_application_feedback_candidate_tables_for_version(
            conn,
            current_version=schema_version,
        ),
        ensure_application_feedback_tables,
    ):
        conn = sqlite3.connect(":memory:")
        conn.executescript(
            f"""
            CREATE TABLE jobs (
                url TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL DEFAULT 'local',
                job_id TEXT NOT NULL,
                UNIQUE (tenant_id, job_id)
            );
            PRAGMA user_version = {schema_version};
            """
        )
        ensure_tables(conn)
        for table in database_module._APPLICATION_FEEDBACK_CANDIDATE_TABLES:
            columns = _columns(conn, table)
            assert expected_reference in columns
            assert (
                {"job_id", "job_key"} - {expected_reference}
            ).isdisjoint(columns)
            if schema_version == 22:
                assert database_module._has_composite_job_id_foreign_key(
                    conn,
                    table,
                    "job_id",
                )
        evidence_index = [
            str(row[2])
            for row in conn.execute(
                "PRAGMA index_info(idx_application_email_evidence_job)"
            ).fetchall()
        ]
        suggestion_index = [
            str(row[2])
            for row in conn.execute(
                "PRAGMA index_info("
                "idx_application_outcome_suggestions_job)"
            ).fetchall()
        ]
        assert evidence_index == [
            "tenant_id",
            expected_reference,
            "received_at",
        ]
        assert suggestion_index == [
            "tenant_id",
            expected_reference,
            "status",
            "created_at",
        ]
        conn.close()


def test_runtime_candidate_merge_preserves_links_counts_and_tenant(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    losing_id = JobId(str(uuid.uuid4()))
    surviving_id = JobId(str(uuid.uuid4()))
    other_tenant_id = JobId(str(uuid.uuid4()))
    losing_url = "https://example.com/jobs/candidate-losing"
    surviving_url = "https://example.com/jobs/candidate-surviving"
    other_url = "https://tenant-b.example/jobs/candidate"
    jobs.save(_discovered_job(losing_url, losing_id))
    jobs.save(_discovered_job(surviving_url, surviving_id))
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'tenant-b', ?, 'Platform Engineer', 'ExampleCo', ?)
        """,
        (
            other_url,
            str(other_tenant_id),
            "2026-07-30T10:00:00+00:00",
        ),
    )
    _insert_candidate_pair(
        conn,
        tenant_id="local",
        reference_column="job_id",
        reference=str(losing_id),
        marker="losing",
    )
    _insert_candidate_pair(
        conn,
        tenant_id="local",
        reference_column="job_id",
        reference=str(surviving_id),
        marker="surviving",
    )
    _insert_candidate_pair(
        conn,
        tenant_id="tenant-b",
        reference_column="job_id",
        reference=str(other_tenant_id),
        marker="tenant-b",
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )
    conn.execute(
        "DELETE FROM jobs WHERE tenant_id = 'local' AND url = ?",
        (losing_url,),
    )

    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, evidence_id, job_id
            FROM application_email_evidence
            ORDER BY tenant_id, evidence_id
            """
        ).fetchall()
    ] == [
        ("local", "evidence:losing", str(surviving_id)),
        ("local", "evidence:surviving", str(surviving_id)),
        ("tenant-b", "evidence:tenant-b", str(other_tenant_id)),
    ]
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, suggestion_id, job_id, evidence_id,
                   decided_outcome_id
            FROM application_outcome_suggestions
            ORDER BY tenant_id, suggestion_id
            """
        ).fetchall()
    ] == [
        (
            "local",
            "suggestion:losing",
            str(surviving_id),
            "evidence:losing",
            "outcome:losing",
        ),
        (
            "local",
            "suggestion:surviving",
            str(surviving_id),
            "evidence:surviving",
            "outcome:surviving",
        ),
        (
            "tenant-b",
            "suggestion:tenant-b",
            str(other_tenant_id),
            "evidence:tenant-b",
            "outcome:tenant-b",
        ),
    ]
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_unresolved_candidate_url_rolls_back_both_tables(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/resolved-candidate"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_candidates_to_v21(conn)
    _insert_candidate_pair(
        conn,
        tenant_id="local",
        reference_column="job_key",
        reference=job_url,
        marker="resolved",
    )
    conn.execute(
        """
        UPDATE application_outcome_suggestions
        SET job_key = 'https://example.com/jobs/unresolved'
        """
    )
    conn.commit()

    with pytest.raises(
        RuntimeError,
        match="application_outcome_suggestions.job_key",
    ):
        ensure_application_feedback_candidate_references_v22(conn)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == 21
    assert "job_key" in _columns(
        conn,
        "application_email_evidence",
    )
    assert "job_key" in _columns(
        conn,
        "application_outcome_suggestions",
    )
    assert conn.execute(
        "SELECT body_text FROM application_email_evidence"
    ).fetchone()[0] == "private-body:resolved"
    close_connection(db_path)


class _FakeGmailClient:
    def search_feedback_emails(
        self,
        *,
        query: str,
        to_email: str,
        after: datetime,
        before: datetime,
        max_results: int,
    ) -> list[dict[str, Any]]:
        del query, to_email, after, before, max_results
        return [
            {
                "id": "stable-message",
                "threadId": "stable-thread",
                "subject": (
                    "ExampleCo application received for Platform Engineer"
                ),
                "from": "recruiting@example.com",
                "to": "candidate@example.com",
                "date": "Thu, 30 Jul 2026 11:00:00 +0000",
                "snippet": "Thank you for applying.",
            }
        ]

    def read_email(self, *, message_id: str) -> dict[str, Any]:
        assert message_id == "stable-message"
        return {
            "id": message_id,
            "threadId": "stable-thread",
            "subject": (
                "ExampleCo application received for Platform Engineer"
            ),
            "from": "recruiting@example.com",
            "to": "candidate@example.com",
            "date": "Thu, 30 Jul 2026 11:00:00 +0000",
            "snippet": "Thank you for applying.",
            "body_text": "private candidate email body",
        }


def test_gmail_v22_stores_url_owner_but_projects_url_and_safe_event(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    uuid_shaped_url = str(uuid.uuid4())
    url_owner_id = JobId(str(uuid.uuid4()))
    SqliteJobRepository(conn).save(
        _discovered_job(uuid_shaped_url, url_owner_id)
    )
    SqliteJobRepository(conn).save(
        _discovered_job(
            "https://example.com/jobs/id-text-owner",
            JobId(uuid_shaped_url),
        )
    )
    conn.execute(
        "UPDATE jobs SET applied_at = ? WHERE url = ?",
        ("2026-07-30T10:00:00+00:00", uuid_shaped_url),
    )
    conn.commit()
    close_connection(db_path)

    summary = scan_gmail_feedback(
        db_path=db_path,
        client=_FakeGmailClient(),
        recipient_email="candidate@example.com",
        limit=1,
        max_results_per_anchor=1,
        window_days=7,
    )

    assert summary["linkedEvidenceCount"] == 1
    assert summary["suggestionsCreatedCount"] == 1
    assert summary["evidence"][0]["jobKey"] == uuid_shaped_url
    assert summary["suggestions"][0]["jobKey"] == uuid_shaped_url
    check = sqlite3.connect(db_path)
    check.row_factory = sqlite3.Row
    assert check.execute(
        "SELECT job_id FROM application_email_evidence"
    ).fetchone()["job_id"] == str(url_owner_id)
    assert check.execute(
        "SELECT job_id FROM application_outcome_suggestions"
    ).fetchone()["job_id"] == str(url_owner_id)
    event_row = check.execute(
        """
        SELECT job_url, payload_json
        FROM job_events
        WHERE event_type = 'ApplicationEmailFeedbackIngested'
        ORDER BY event_id DESC
        LIMIT 1
        """
    ).fetchone()
    assert event_row["job_url"] == uuid_shaped_url
    payload = json.loads(str(event_row["payload_json"]))
    assert payload["jobKey"] == uuid_shaped_url
    assert "body" not in payload
    assert "private candidate email body" not in str(
        event_row["payload_json"]
    )
    check.close()
