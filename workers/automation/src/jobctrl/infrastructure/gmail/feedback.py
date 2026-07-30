"""Bounded Gmail application-outcome feedback ingestion."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import getaddresses, parsedate_to_datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

from jobctrl.infrastructure.gmail.client import GmailClient

TENANT_ID = "local"
PROVIDER = "gmail"
LINK_THRESHOLD = 0.7
DEFAULT_LIMIT = 25
DEFAULT_MAX_RESULTS_PER_ANCHOR = 5
DEFAULT_WINDOW_DAYS = 45
MAX_LIMIT = 100
MAX_RESULTS_PER_ANCHOR = 20
MAX_WINDOW_DAYS = 180
APPLICATION_REVIEW_REFERENCE_SCHEMA_VERSION = 20
APPLICATION_OUTCOME_REFERENCE_SCHEMA_VERSION = 21
APPLICATION_FEEDBACK_CANDIDATE_REFERENCE_SCHEMA_VERSION = 22

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{1,64}")
_ATS_HINTS = {
    "ashby",
    "greenhouse",
    "icims",
    "lever",
    "smartrecruiters",
    "workable",
    "workday",
}
_OUTCOME_TERMS = (
    "application",
    "applied",
    "applying",
    "assessment",
    "bounced",
    "challenge",
    "interview",
    "offer",
    "received",
    "recruiter",
    "rejection",
    "submitted",
    "undeliverable",
)


class GmailFeedbackError(RuntimeError):
    """Raised when a bounded feedback scan cannot run safely."""


class GmailFeedbackClient(Protocol):
    def search_feedback_emails(
        self,
        *,
        query: str,
        to_email: str,
        after: datetime,
        before: datetime,
        max_results: int,
    ) -> list[dict[str, Any]]:
        """Return Gmail metadata only for bounded application-feedback search."""

    def read_email(self, *, message_id: str) -> dict[str, Any]:
        """Read a full Gmail message after metadata has been linked."""


@dataclass(frozen=True)
class ApplicationAnchor:
    job_key: str
    title: str
    company: str
    application_url: str
    anchor_at: datetime


@dataclass(frozen=True)
class LinkDecision:
    linked: bool
    confidence: float
    signals: tuple[str, ...]


@dataclass(frozen=True)
class Classification:
    kind: str
    confidence: float
    rationale: str


def scan_gmail_feedback(
    *,
    db_path: Path | str,
    client: GmailFeedbackClient | None = None,
    recipient_email: str | None = None,
    limit: int = DEFAULT_LIMIT,
    max_results_per_anchor: int = DEFAULT_MAX_RESULTS_PER_ANCHOR,
    window_days: int = DEFAULT_WINDOW_DAYS,
) -> dict[str, Any]:
    """Scan Gmail metadata for known application anchors and store linked evidence."""

    bounded_limit = _bounded_int(limit, minimum=1, maximum=MAX_LIMIT, default=DEFAULT_LIMIT)
    bounded_max_results = _bounded_int(
        max_results_per_anchor,
        minimum=1,
        maximum=MAX_RESULTS_PER_ANCHOR,
        default=DEFAULT_MAX_RESULTS_PER_ANCHOR,
    )
    bounded_window_days = _bounded_int(
        window_days,
        minimum=1,
        maximum=MAX_WINDOW_DAYS,
        default=DEFAULT_WINDOW_DAYS,
    )

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=10000")
    gmail = client or GmailClient()
    try:
        ensure_application_feedback_tables(conn)
        recipient = (recipient_email or _profile_email(conn)).strip().lower()
        if not recipient or not _EMAIL_RE.match(recipient):
            raise GmailFeedbackError(
                "Gmail feedback scan requires a recipient email or candidate profile email."
            )

        anchors = _load_application_anchors(conn, limit=bounded_limit)
        summary = {
            "ok": True,
            "scannedAnchorCount": len(anchors),
            "searchedMessageCount": 0,
            "linkedEvidenceCount": 0,
            "suggestionsCreatedCount": 0,
            "duplicateMessageCount": 0,
            "unlinkedCandidateCount": 0,
            "evidence": [],
            "suggestions": [],
        }
        now = _utc_now()

        for anchor in anchors:
            after = anchor.anchor_at
            before = anchor.anchor_at + timedelta(days=bounded_window_days)
            query = _anchor_query(anchor)
            if not query:
                continue
            metadata_items = gmail.search_feedback_emails(
                query=query,
                to_email=recipient,
                after=after,
                before=before,
                max_results=bounded_max_results,
            )
            summary["searchedMessageCount"] += len(metadata_items)

            for metadata in metadata_items:
                decision = _link_metadata(
                    anchor=anchor,
                    metadata=metadata,
                    recipient_email=recipient,
                    after=after,
                    before=before,
                )
                if not decision.linked:
                    summary["unlinkedCandidateCount"] += 1
                    continue

                message_id = _text(metadata.get("id"))
                if not message_id:
                    summary["unlinkedCandidateCount"] += 1
                    continue
                if _provider_message_exists(conn, message_id):
                    summary["duplicateMessageCount"] += 1
                    continue

                full_message = gmail.read_email(message_id=message_id)
                evidence = _store_linked_message(
                    conn=conn,
                    anchor=anchor,
                    metadata=metadata,
                    full_message=full_message,
                    decision=decision,
                    linked_at=now,
                )
                classification = classify_outcome(
                    subject=evidence["subject"] or "",
                    snippet=evidence["snippet"] or "",
                    body_text=_text(full_message.get("body_text")),
                )
                suggestion = _store_suggestion(
                    conn=conn,
                    anchor=anchor,
                    evidence_id=evidence["evidenceId"],
                    provider_message_id=message_id,
                    classification=classification,
                    created_at=now,
                )
                _record_safe_event(
                    conn,
                    job_key=anchor.job_key,
                    evidence_id=evidence["evidenceId"],
                    suggestion_id=suggestion["suggestionId"],
                    classification=classification,
                    link_confidence=evidence["linkConfidence"],
                    signals=decision.signals,
                    occurred_at=now,
                )
                conn.commit()

                summary["linkedEvidenceCount"] += 1
                if suggestion["created"]:
                    summary["suggestionsCreatedCount"] += 1
                summary["evidence"].append(
                    {
                        "evidenceId": evidence["evidenceId"],
                        "jobKey": anchor.job_key,
                        "providerMessageId": message_id,
                        "linkConfidence": evidence["linkConfidence"],
                    }
                )
                summary["suggestions"].append(
                    {
                        "suggestionId": suggestion["suggestionId"],
                        "evidenceId": evidence["evidenceId"],
                        "jobKey": anchor.job_key,
                        "kind": classification.kind,
                        "confidence": classification.confidence,
                    }
                )

        return summary
    finally:
        conn.close()


def ensure_application_feedback_tables(conn: sqlite3.Connection) -> None:
    """Create the feedback tables with the TypeScript API's table shape."""

    schema_version = int(
        conn.execute("PRAGMA user_version").fetchone()[0]
    )
    stable_review_schema = (
        schema_version >= APPLICATION_REVIEW_REFERENCE_SCHEMA_VERSION
    )
    created_review_reference = (
        "job_id" if stable_review_schema else "job_key"
    )
    review_foreign_key = (
        """,
          FOREIGN KEY (tenant_id, job_id)
            REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if stable_review_schema
        else ""
    )
    stable_outcome_schema = (
        schema_version >= APPLICATION_OUTCOME_REFERENCE_SCHEMA_VERSION
    )
    created_outcome_reference = (
        "job_id" if stable_outcome_schema else "job_key"
    )
    outcome_foreign_key = (
        """,
          FOREIGN KEY (tenant_id, job_id)
            REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if stable_outcome_schema
        else ""
    )
    stable_candidate_schema = (
        schema_version
        >= APPLICATION_FEEDBACK_CANDIDATE_REFERENCE_SCHEMA_VERSION
    )
    created_candidate_reference = (
        "job_id" if stable_candidate_schema else "job_key"
    )
    candidate_foreign_key = (
        """,
          FOREIGN KEY (tenant_id, job_id)
            REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if stable_candidate_schema
        else ""
    )
    conn.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS application_review_decisions (
          tenant_id    TEXT NOT NULL DEFAULT 'local',
          decision_id  TEXT NOT NULL,
          {created_review_reference} TEXT NOT NULL,
          decision     TEXT NOT NULL,
          reason       TEXT,
          decided_by   TEXT NOT NULL DEFAULT 'user',
          decided_at   TEXT NOT NULL,
          materials_generation INTEGER,
          profile_version INTEGER,
          application_url TEXT,
          partial_override_run_id TEXT,
          email_recipient TEXT,
          email_attachment_artifact_id TEXT,
          PRIMARY KEY (tenant_id, decision_id)
          {review_foreign_key}
        );

        CREATE TABLE IF NOT EXISTS application_outcomes (
          tenant_id     TEXT NOT NULL DEFAULT 'local',
          outcome_id    TEXT NOT NULL,
          {created_outcome_reference} TEXT NOT NULL,
          kind          TEXT NOT NULL,
          source        TEXT NOT NULL,
          note          TEXT,
          occurred_at   TEXT NOT NULL,
          recorded_at   TEXT NOT NULL,
          suggestion_id TEXT,
          evidence_id   TEXT,
          created_by    TEXT NOT NULL DEFAULT 'user',
          interview_prep_generation INTEGER,
          PRIMARY KEY (tenant_id, outcome_id)
          {outcome_foreign_key}
        );

        CREATE TABLE IF NOT EXISTS application_email_evidence (
          tenant_id            TEXT NOT NULL DEFAULT 'local',
          evidence_id          TEXT NOT NULL,
          {created_candidate_reference} TEXT NOT NULL,
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
          {candidate_foreign_key}
        );

        CREATE TABLE IF NOT EXISTS application_outcome_suggestions (
          tenant_id          TEXT NOT NULL DEFAULT 'local',
          suggestion_id      TEXT NOT NULL,
          {created_candidate_reference} TEXT NOT NULL,
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
          {candidate_foreign_key}
        );
        CREATE INDEX IF NOT EXISTS idx_application_outcome_suggestions_status
          ON application_outcome_suggestions(tenant_id, status, created_at DESC);
        """
    )
    _ensure_columns(
        conn,
        "application_review_decisions",
        {
            "materials_generation": "INTEGER",
            "profile_version": "INTEGER",
            "application_url": "TEXT",
            "partial_override_run_id": "TEXT",
            "email_recipient": "TEXT",
            "email_attachment_artifact_id": "TEXT",
        },
    )
    review_reference = (
        "job_id"
        if "job_id" in _columns(conn, "application_review_decisions")
        else "job_key"
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_application_review_decisions_job
        ON application_review_decisions(
            tenant_id,
            %s,
            decided_at DESC
        )
        """
        % review_reference
    )
    _ensure_columns(
        conn,
        "application_outcomes",
        {"interview_prep_generation": "INTEGER"},
    )
    outcome_reference = (
        "job_id"
        if "job_id" in _columns(conn, "application_outcomes")
        else "job_key"
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_application_outcomes_job
        ON application_outcomes(
            tenant_id,
            %s,
            occurred_at DESC,
            recorded_at DESC
        )
        """
        % outcome_reference
    )
    evidence_reference = (
        "job_id"
        if "job_id" in _columns(conn, "application_email_evidence")
        else "job_key"
    )
    suggestion_reference = (
        "job_id"
        if "job_id" in _columns(
            conn,
            "application_outcome_suggestions",
        )
        else "job_key"
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_application_email_evidence_job
        ON application_email_evidence(
            tenant_id,
            %s,
            received_at DESC
        )
        """
        % evidence_reference
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_application_outcome_suggestions_job
        ON application_outcome_suggestions(
            tenant_id,
            %s,
            status,
            created_at DESC
        )
        """
        % suggestion_reference
    )


def classify_outcome(*, subject: str, snippet: str, body_text: str) -> Classification:
    """Classify linked application email evidence with deterministic v1 rules."""

    haystack = " ".join([subject, snippet, body_text]).lower()
    rules: tuple[tuple[str, float, str, tuple[str, ...]], ...] = (
        (
            "bounced",
            0.95,
            "Delivery failure language indicates the application email bounced.",
            ("undeliverable", "delivery status notification", "address not found", "bounced"),
        ),
        (
            "offer",
            0.95,
            "Offer language indicates a positive application outcome.",
            ("pleased to offer", "offer letter", "employment offer", "congratulations"),
        ),
        (
            "rejection",
            0.9,
            "Rejection language indicates the employer is not moving forward.",
            (
                "not moving forward",
                "not selected",
                "unfortunately",
                "pursue other candidates",
                "after careful consideration",
            ),
        ),
        (
            "interview",
            0.9,
            "Interview scheduling language indicates an interview outcome.",
            ("interview", "schedule a call", "availability", "meet with", "technical screen"),
        ),
        (
            "assessment",
            0.88,
            "Assessment language indicates a test or take-home step.",
            ("assessment", "coding challenge", "take-home", "take home", "online test"),
        ),
        (
            "applied_confirmation",
            0.9,
            "Application confirmation language indicates the submission was received.",
            (
                "application received",
                "thank you for applying",
                "thanks for applying",
                "we received your application",
                "application has been submitted",
            ),
        ),
        (
            "recruiter_reply",
            0.82,
            "Recruiter reply language indicates direct follow-up from recruiting.",
            ("recruiter", "talent acquisition", "thanks for reaching out", "next steps"),
        ),
    )
    for kind, confidence, rationale, terms in rules:
        if any(term in haystack for term in terms):
            return Classification(kind=kind, confidence=confidence, rationale=rationale)
    return Classification(
        kind="unknown",
        confidence=0.25,
        rationale="No deterministic outcome language matched this linked email.",
    )


def _store_linked_message(
    *,
    conn: sqlite3.Connection,
    anchor: ApplicationAnchor,
    metadata: dict[str, Any],
    full_message: dict[str, Any],
    decision: LinkDecision,
    linked_at: datetime,
) -> dict[str, Any]:
    message_id = _text(metadata.get("id") or full_message.get("id"))
    evidence_id = _stable_id("gmail-evidence", message_id)
    body_text = _text(full_message.get("body_text"))[:12000]
    body_sha256 = hashlib.sha256(body_text.encode("utf-8")).hexdigest()
    received_at = _message_datetime(metadata) or _message_datetime(full_message)
    subject = _nullable_text(full_message.get("subject") or metadata.get("subject"))
    snippet = _nullable_text(full_message.get("snippet") or metadata.get("snippet"))
    from_address = _nullable_text(full_message.get("from") or metadata.get("from"))
    to_addresses = _email_addresses(_text(full_message.get("to") or metadata.get("to")))
    thread_id = _nullable_text(full_message.get("threadId") or metadata.get("threadId"))
    linked_at_text = _iso(linked_at)
    reference_column, job_reference = _job_key_reference_for_url(
        conn,
        "application_email_evidence",
        anchor.job_key,
    )

    conn.execute(
        f"""
        INSERT INTO application_email_evidence (
            tenant_id, evidence_id, {reference_column}, provider,
            provider_message_id,
            provider_thread_id, from_address, to_addresses_json, subject, snippet,
            received_at, linked_at, link_confidence, link_signals_json,
            body_text, body_sha256, body_stored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            TENANT_ID,
            evidence_id,
            job_reference,
            PROVIDER,
            message_id,
            thread_id,
            from_address,
            json.dumps(to_addresses),
            subject,
            snippet,
            _iso(received_at) if received_at else None,
            linked_at_text,
            decision.confidence,
            json.dumps(list(decision.signals), sort_keys=True),
            body_text,
            body_sha256,
            linked_at_text,
        ),
    )
    return {
        "evidenceId": evidence_id,
        "subject": subject,
        "snippet": snippet,
        "linkConfidence": decision.confidence,
    }


def _store_suggestion(
    *,
    conn: sqlite3.Connection,
    anchor: ApplicationAnchor,
    evidence_id: str,
    provider_message_id: str,
    classification: Classification,
    created_at: datetime,
) -> dict[str, Any]:
    suggestion_id = _stable_id(
        "gmail-suggestion",
        f"{anchor.job_key}|{provider_message_id}|{classification.kind}",
    )
    reference_column, job_reference = _job_key_reference_for_url(
        conn,
        "application_outcome_suggestions",
        anchor.job_key,
    )
    cursor = conn.execute(
        f"""
        INSERT OR IGNORE INTO application_outcome_suggestions (
            tenant_id, suggestion_id, {reference_column}, evidence_id,
            suggested_kind,
            confidence, rationale, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            TENANT_ID,
            suggestion_id,
            job_reference,
            evidence_id,
            classification.kind,
            classification.confidence,
            classification.rationale,
            "pending",
            _iso(created_at),
        ),
    )
    return {"suggestionId": suggestion_id, "created": cursor.rowcount > 0}


def _record_safe_event(
    conn: sqlite3.Connection,
    *,
    job_key: str,
    evidence_id: str,
    suggestion_id: str,
    classification: Classification,
    link_confidence: float,
    signals: tuple[str, ...],
    occurred_at: datetime,
) -> None:
    if not _table_exists(conn, "job_events"):
        return
    columns = _columns(conn, "job_events")
    payload = {
        "tenantId": TENANT_ID,
        "jobKey": job_key,
        "evidenceId": evidence_id,
        "suggestionId": suggestion_id,
        "provider": PROVIDER,
        "suggestedKind": classification.kind,
        "classificationConfidence": classification.confidence,
        "linkConfidence": link_confidence,
        "linkSignals": list(signals),
    }
    values: dict[str, Any] = {
        "job_url": job_key,
        "stage": "apply",
        "event_type": "ApplicationEmailFeedbackIngested",
        "level": "info",
        "message": "Application email feedback ingested.",
        "occurred_at": _iso(occurred_at),
        "payload_json": json.dumps(payload, sort_keys=True),
    }
    names = [name for name in values if name in columns]
    if not names:
        return
    conn.execute(
        f"INSERT INTO job_events ({', '.join(names)}) VALUES ({', '.join('?' for _ in names)})",
        tuple(values[name] for name in names),
    )


def _link_metadata(
    *,
    anchor: ApplicationAnchor,
    metadata: dict[str, Any],
    recipient_email: str,
    after: datetime,
    before: datetime,
) -> LinkDecision:
    text = " ".join(
        [
            _text(metadata.get("subject")),
            _text(metadata.get("from")),
            _text(metadata.get("to")),
        ]
    ).lower()
    signals: list[str] = []
    score = 0.0

    recipients = {address.lower() for address in _email_addresses(_text(metadata.get("to")))}
    if recipient_email.lower() in recipients:
        signals.append("recipient")
        score += 0.2

    message_at = _message_datetime(metadata)
    if message_at and after <= message_at <= before:
        signals.append("time_window")
        score += 0.2

    if _any_hint_match(_name_tokens(anchor.company), text):
        signals.append("company")
        score += 0.2

    if _any_hint_match(_title_tokens(anchor.title), text):
        signals.append("job_title")
        score += 0.15

    if _any_hint_match(_application_url_tokens(anchor.application_url), text):
        signals.append("application_domain")
        score += 0.15

    if _any_hint_match(_ATS_HINTS, text):
        signals.append("ats_hint")
        score += 0.1

    if any(term in text for term in _OUTCOME_TERMS):
        signals.append("outcome_term")
        score += 0.1

    confidence = round(min(score, 1.0), 2)
    return LinkDecision(
        linked=confidence >= LINK_THRESHOLD,
        confidence=confidence,
        signals=tuple(signals),
    )


def _load_application_anchors(conn: sqlite3.Connection, *, limit: int) -> list[ApplicationAnchor]:
    anchors: dict[str, ApplicationAnchor] = {}
    for anchor in [*_job_anchors(conn), *_outcome_anchors(conn), *_apply_run_anchors(conn)]:
        existing = anchors.get(anchor.job_key)
        if existing is None or anchor.anchor_at < existing.anchor_at:
            anchors[anchor.job_key] = anchor
    return sorted(anchors.values(), key=lambda item: item.anchor_at, reverse=True)[:limit]


def _job_anchors(conn: sqlite3.Connection) -> list[ApplicationAnchor]:
    if not _table_exists(conn, "jobs"):
        return []
    columns = _columns(conn, "jobs")
    title_expr = _column_expr(columns, "title")
    company_expr = _first_column_expr(columns, ["company", "site", "employer"])
    application_url_expr = _column_expr(columns, "application_url")
    applied_at_expr = _column_expr(columns, "applied_at")
    discovered_at_expr = _column_expr(columns, "discovered_at")
    apply_status_expr = _column_expr(columns, "apply_status")
    rows = conn.execute(
        f"""
        SELECT url AS job_key, {title_expr} AS title, {company_expr} AS company,
               {application_url_expr} AS application_url,
               COALESCE(NULLIF({applied_at_expr}, ''), NULLIF({discovered_at_expr}, '')) AS anchor_at
        FROM jobs
        WHERE NULLIF({applied_at_expr}, '') IS NOT NULL
           OR lower(COALESCE({apply_status_expr}, '')) = 'applied'
        """
    ).fetchall()
    return [_anchor_from_row(row) for row in rows if _anchor_from_row(row) is not None]


def _outcome_anchors(conn: sqlite3.Connection) -> list[ApplicationAnchor]:
    if not _table_exists(conn, "application_outcomes") or not _table_exists(conn, "jobs"):
        return []
    columns = _columns(conn, "jobs")
    title_expr = _column_expr(columns, "title", prefix="j")
    company_expr = _first_column_expr(columns, ["company", "site", "employer"], prefix="j")
    application_url_expr = _column_expr(columns, "application_url", prefix="j")
    outcome_columns = _columns(conn, "application_outcomes")
    stable_references = "job_id" in outcome_columns
    outcome_job_key = "j.url" if stable_references else "o.job_key"
    identity_join = (
        "j.tenant_id = o.tenant_id AND j.job_id = o.job_id"
        if stable_references
        else "j.url = o.job_key"
    )
    rows = conn.execute(
        f"""
        SELECT {outcome_job_key} AS job_key, {title_expr} AS title, {company_expr} AS company,
               {application_url_expr} AS application_url, o.occurred_at AS anchor_at
        FROM application_outcomes o
        LEFT JOIN jobs j ON {identity_join}
        WHERE o.tenant_id = ?
          AND o.kind IN (
            'applied_confirmation', 'recruiter_reply', 'interview',
            'assessment', 'rejection', 'offer', 'bounced'
          )
        """,
        (TENANT_ID,),
    ).fetchall()
    return [_anchor_from_row(row) for row in rows if _anchor_from_row(row) is not None]


def _apply_run_anchors(conn: sqlite3.Connection) -> list[ApplicationAnchor]:
    if not _table_exists(conn, "apply_run_projections") or not _table_exists(conn, "jobs"):
        return []
    columns = _columns(conn, "jobs")
    title_expr = _column_expr(columns, "title", prefix="j")
    company_expr = _first_column_expr(columns, ["company", "site", "employer"], prefix="j")
    application_url_expr = _column_expr(columns, "application_url", prefix="j")
    rows = conn.execute(
        f"""
        SELECT a.job_id AS job_key, {title_expr} AS title, {company_expr} AS company,
               {application_url_expr} AS application_url,
               COALESCE(NULLIF(a.finished_at, ''), NULLIF(a.started_at, '')) AS anchor_at
        FROM apply_run_projections a
        LEFT JOIN jobs j ON j.url = a.job_id
        WHERE COALESCE(a.dry_run, 0) = 0
          AND (
            lower(COALESCE(a.status, '')) IN ('succeeded', 'success', 'complete', 'completed')
            OR lower(COALESCE(a.result, '')) LIKE '%applied%'
            OR lower(COALESCE(a.result, '')) LIKE '%submitted%'
          )
        """
    ).fetchall()
    return [_anchor_from_row(row) for row in rows if _anchor_from_row(row) is not None]


def _anchor_from_row(row: sqlite3.Row) -> ApplicationAnchor | None:
    anchor_at = _parse_datetime(_text(row["anchor_at"]))
    job_key = _text(row["job_key"])
    if not job_key or anchor_at is None:
        return None
    return ApplicationAnchor(
        job_key=job_key,
        title=_text(row["title"]),
        company=_text(row["company"]),
        application_url=_text(row["application_url"]),
        anchor_at=anchor_at,
    )


def _anchor_query(anchor: ApplicationAnchor) -> str:
    hints: list[str] = []
    hints.extend(_name_tokens(anchor.company))
    hints.extend(_title_tokens(anchor.title))
    hints.extend(_application_url_tokens(anchor.application_url))
    hints.extend(hint for hint in _ATS_HINTS if hint in anchor.application_url.lower())
    return " ".join(_dedupe(hints))


def _profile_email(conn: sqlite3.Connection) -> str:
    if not _table_exists(conn, "candidate_profiles") or "personal_email" not in _columns(conn, "candidate_profiles"):
        return ""
    row = conn.execute(
        """
        SELECT personal_email
        FROM candidate_profiles
        WHERE tenant_id = ? AND profile_id = ?
        LIMIT 1
        """,
        (TENANT_ID, "default"),
    ).fetchone()
    return _text(row["personal_email"] if row else "")


def _provider_message_exists(conn: sqlite3.Connection, provider_message_id: str) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM application_email_evidence
        WHERE tenant_id = ? AND provider = ? AND provider_message_id = ?
        LIMIT 1
        """,
        (TENANT_ID, PROVIDER, provider_message_id),
    ).fetchone()
    return row is not None


def _message_datetime(message: dict[str, Any]) -> datetime | None:
    internal_date = _text(message.get("internalDate"))
    if internal_date.isdigit():
        return datetime.fromtimestamp(int(internal_date) / 1000, tz=timezone.utc)
    date_header = _text(message.get("date"))
    if date_header:
        try:
            parsed = parsedate_to_datetime(date_header)
        except (TypeError, ValueError):
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    return None


def _parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _stable_id(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}-{digest}"


def _job_key_reference_for_url(
    conn: sqlite3.Connection,
    table_name: str,
    job_url: str,
) -> tuple[str, str]:
    """Return the table's reference column and URL-owned stored value."""

    columns = _columns(conn, table_name)
    if "job_key" in columns:
        return "job_key", job_url
    if "job_id" not in columns:
        raise GmailFeedbackError(
            f"{table_name} has no Job identity column."
        )

    job_columns = _columns(conn, "jobs")
    if not {"tenant_id", "job_id", "url"}.issubset(job_columns):
        raise GmailFeedbackError(
            "Stable Gmail feedback storage requires tenant-scoped Job "
            "identities."
        )
    direct = conn.execute(
        """
        SELECT job_id
        FROM jobs
        WHERE tenant_id = ? AND url = ?
        LIMIT 1
        """,
        (TENANT_ID, job_url),
    ).fetchone()
    if direct is not None and _text(direct["job_id"]):
        return "job_id", _text(direct["job_id"])

    if _table_exists(conn, "job_identity_aliases"):
        alias = conn.execute(
            """
            SELECT aliases.job_id
            FROM job_identity_aliases AS aliases
            JOIN jobs
              ON jobs.tenant_id = aliases.tenant_id
             AND jobs.job_id = aliases.job_id
            WHERE aliases.tenant_id = ?
              AND aliases.alias_kind = 'posting_url'
              AND aliases.alias_value = ?
            LIMIT 1
            """,
            (TENANT_ID, job_url),
        ).fetchone()
        if alias is not None and _text(alias["job_id"]):
            return "job_id", _text(alias["job_id"])

    raise GmailFeedbackError(
        f"No stable Job identity for {job_url}."
    )


def _bounded_int(value: int, *, minimum: int, maximum: int, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))


def _email_addresses(value: str) -> list[str]:
    return [address for _name, address in getaddresses([value]) if address]


def _name_tokens(value: str) -> list[str]:
    return [
        token
        for token in _safe_tokens(value)
        if len(token) >= 3 and token.lower() not in {"inc", "llc", "ltd", "the"}
    ][:4]


def _title_tokens(value: str) -> list[str]:
    stop = {"and", "for", "the", "with", "engineer", "developer", "manager"}
    return [
        token
        for token in _safe_tokens(value)
        if len(token) >= 4 and token.lower() not in stop
    ][:6]


def _application_url_tokens(value: str) -> list[str]:
    if not value:
        return []
    parsed = urlparse(value)
    tokens = _safe_tokens(" ".join([parsed.netloc, parsed.path]))
    return [
        token
        for token in tokens
        if len(token) >= 3 and token.lower() not in {"www", "com", "jobs", "apply"}
    ][:8]


def _safe_tokens(value: str) -> list[str]:
    return _dedupe(
        token
        for token in _TOKEN_RE.findall(value or "")
        if token.lower() not in {"from", "to", "after", "before", "older_than", "newer_than"}
    )


def _dedupe(values: Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value).strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def _any_hint_match(hints: Any, text: str) -> bool:
    lowered = text.lower()
    return any(str(hint).lower() in lowered for hint in hints if str(hint).strip())


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        row["name"] if isinstance(row, sqlite3.Row) else row[1]
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }


def _ensure_columns(
    conn: sqlite3.Connection,
    table_name: str,
    additions: dict[str, str],
) -> None:
    columns = _columns(conn, table_name)
    for column, definition in additions.items():
        if column not in columns:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column} {definition}")


def _column_expr(columns: set[str], column: str, *, prefix: str | None = None) -> str:
    if column not in columns:
        return "''"
    qualified = f"{prefix}.{column}" if prefix else column
    return f"COALESCE({qualified}, '')"


def _first_column_expr(
    columns: set[str],
    names: list[str],
    *,
    prefix: str | None = None,
) -> str:
    available = [
        f"{prefix}.{name}" if prefix else name
        for name in names
        if name in columns
    ]
    if not available:
        return "''"
    return "COALESCE(" + ", ".join(available + ["''"]) + ")"


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _nullable_text(value: Any) -> str | None:
    text = _text(value)
    return text or None


def _read_stdin_json() -> dict[str, Any]:
    if sys.stdin.isatty():
        return {}
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise GmailFeedbackError("Gmail feedback worker input must be a JSON object.")
    return parsed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a bounded Gmail feedback scan.")
    parser.add_argument("--db-path", required=True)
    parser.add_argument("--recipient-email")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--max-results-per-anchor", type=int, default=DEFAULT_MAX_RESULTS_PER_ANCHOR)
    parser.add_argument("--window-days", type=int, default=DEFAULT_WINDOW_DAYS)
    args = parser.parse_args(argv)
    try:
        payload = _read_stdin_json()
        summary = scan_gmail_feedback(
            db_path=args.db_path,
            recipient_email=payload.get("recipientEmail") or args.recipient_email,
            limit=int(payload.get("limit") or args.limit),
            max_results_per_anchor=int(
                payload.get("maxResultsPerAnchor") or args.max_results_per_anchor
            ),
            window_days=int(payload.get("windowDays") or args.window_days),
        )
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": exc.__class__.__name__,
                    "message": str(exc),
                },
                sort_keys=True,
            )
        )
        return 1
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
