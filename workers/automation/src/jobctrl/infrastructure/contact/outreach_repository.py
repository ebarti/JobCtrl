"""SQLite-backed ``OutreachThreadRepository`` (ninth bounded context) — R6 Phase 3.

Publisher-injected, mirroring the other Contact & Outreach adapters: ``save``
writes the canonical ``outreach_threads`` + ``outreach_drafts`` rows first, then
emits the draft-lifecycle domain events inside a ``try/except`` so event
publication never blocks the write.

Event choice is derived from the diff between the persisted and current thread —
no send transport is involved at any point (INV-1):

  * a NEW draft at generation 1        -> ``OutreachDraftGenerated``
  * a NEW draft at generation >= 2     -> ``OutreachDraftRevised`` (a re-draft/edit)
  * candidate -> approved              -> ``OutreachDraftApproved``
  * candidate -> rejected              -> ``OutreachDraftRejected``
  * -> superseded                      -> no event (internal generation bookkeeping)

Sensitivity (plan §6, §10.1): the draft ``body_text``, ``gate_results_json`` and
``provenance_json`` are the user's own reviewable content and live only in
``outreach_drafts`` (canonical write side). Event payloads written to
``job_events`` carry ONLY ids, kinds, generation, and timestamps — never the body,
gate text, or contact PII. Application-linked threads additionally key on the
job's ``job_url``; contact-only threads carry ``entity_kind='outreach'`` /
``entity_ref=<thread_id>``.
"""

from __future__ import annotations

import json
import logging
import sqlite3

from jobctrl.database import ensure_contact_tables
from jobctrl.domain.contact.outreach import (
    FollowUpSchedule,
    FollowUpState,
    OutreachDraft,
    OutreachDraftKind,
    OutreachSendLog,
    OutreachThread,
)
from jobctrl.domain.contact.outreach_gates import (
    DraftGateResults,
    OutreachClaimProvenance,
)
from jobctrl.domain.materials.value_objects import ArtifactStatus
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.tenant import TenantId
from jobctrl.state import record_job_event

logger = logging.getLogger(__name__)


class SqliteOutreachThreadRepository:
    """SQLite-backed implementation of ``OutreachThreadRepository``."""

    def __init__(self, conn: sqlite3.Connection, *, publisher: EventPublisher) -> None:
        self._conn = conn
        self._publisher = publisher
        ensure_contact_tables(self._conn)

    # ------------------------------------------------------------------ load

    def load(self, tenant_id: TenantId, thread_id: str) -> OutreachThread | None:
        row = self._conn.execute(
            "SELECT * FROM outreach_threads WHERE tenant_id = ? AND thread_id = ?",
            (str(tenant_id), str(thread_id)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_thread(tenant_id, row)

    def load_for_contact(
        self, tenant_id: TenantId, contact_id: str, job_id: str | None = None
    ) -> OutreachThread | None:
        if job_id:
            row = self._conn.execute(
                """
                SELECT * FROM outreach_threads
                WHERE tenant_id = ? AND contact_id = ? AND job_url = ?
                ORDER BY updated_at DESC LIMIT 1
                """,
                (str(tenant_id), str(contact_id), str(job_id)),
            ).fetchone()
        else:
            row = self._conn.execute(
                """
                SELECT * FROM outreach_threads
                WHERE tenant_id = ? AND contact_id = ? AND job_url IS NULL
                ORDER BY updated_at DESC LIMIT 1
                """,
                (str(tenant_id), str(contact_id)),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_thread(tenant_id, row)

    def list_for_tenant(self, tenant_id: TenantId) -> list[OutreachThread]:
        rows = self._conn.execute(
            """
            SELECT * FROM outreach_threads
            WHERE tenant_id = ?
            ORDER BY updated_at DESC, thread_id ASC
            """,
            (str(tenant_id),),
        ).fetchall()
        return [self._row_to_thread(tenant_id, row) for row in rows]

    def _row_to_thread(self, tenant_id: TenantId, row: sqlite3.Row) -> OutreachThread:
        thread_id = str(row["thread_id"])
        return OutreachThread(
            tenant_id=tenant_id,
            thread_id=thread_id,
            contact_id=str(row["contact_id"]),
            job_id=row["job_url"],
            drafts=self._load_drafts(tenant_id, thread_id),
            created_at=str(row["created_at"] or ""),
            updated_at=str(row["updated_at"] or ""),
            send_logs=self._load_send_logs(tenant_id, thread_id),
            follow_up=FollowUpSchedule(
                state=_follow_up_state(row["follow_up_state"]),
                due_at=row["follow_up_due_at"],
                basis=str(row["follow_up_basis"] or ""),
            ),
        )

    def _load_send_logs(
        self, tenant_id: TenantId, thread_id: str
    ) -> tuple[OutreachSendLog, ...]:
        rows = self._conn.execute(
            """
            SELECT send_log_id, thread_id, draft_id, channel, sent_at, logged_at
            FROM outreach_send_logs
            WHERE tenant_id = ? AND thread_id = ?
            ORDER BY logged_at ASC, send_log_id ASC
            """,
            (str(tenant_id), thread_id),
        ).fetchall()
        return tuple(
            OutreachSendLog(
                send_log_id=str(row["send_log_id"]),
                thread_id=str(row["thread_id"]),
                draft_id=str(row["draft_id"]),
                channel=str(row["channel"] or ""),
                sent_at=str(row["sent_at"] or ""),
                logged_at=str(row["logged_at"] or ""),
            )
            for row in rows
        )

    def _load_drafts(self, tenant_id: TenantId, thread_id: str) -> tuple[OutreachDraft, ...]:
        rows = self._conn.execute(
            """
            SELECT draft_id, thread_id, generation, kind, status, body_text,
                   gate_results_json, provenance_json, created_at, approved_at,
                   rejected_at, reason
            FROM outreach_drafts
            WHERE tenant_id = ? AND thread_id = ?
            ORDER BY generation ASC, draft_id ASC
            """,
            (str(tenant_id), thread_id),
        ).fetchall()
        return tuple(
            OutreachDraft(
                draft_id=str(row["draft_id"]),
                thread_id=str(row["thread_id"]),
                generation=int(row["generation"] or 1),
                kind=_kind(row["kind"]),
                status=_status(row["status"]),
                body_text=str(row["body_text"] or ""),
                gate_results=DraftGateResults.from_read_model(_decode(row["gate_results_json"])),
                provenance=tuple(
                    OutreachClaimProvenance.from_read_model(item)
                    for item in _decode_list(row["provenance_json"])
                ),
                created_at=str(row["created_at"] or ""),
                approved_at=row["approved_at"],
                rejected_at=row["rejected_at"],
                reason=str(row["reason"] or ""),
            )
            for row in rows
        )

    # ------------------------------------------------------------------ save

    def save(self, tenant_id: TenantId, thread: OutreachThread) -> OutreachThread:
        previous = self.load(tenant_id, thread.thread_id)
        self._persist_canonical(tenant_id, thread)
        try:
            self._emit_events(tenant_id, thread, previous)
            self._conn.commit()
        except Exception:  # noqa: BLE001 — event publication must not corrupt the write
            logger.exception("Failed to emit OutreachThread domain events for %s", thread.thread_id)
        return thread

    def _persist_canonical(self, tenant_id: TenantId, thread: OutreachThread) -> None:
        tenant = str(tenant_id)
        thread_id = str(thread.thread_id)
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO outreach_threads (
                    tenant_id, thread_id, contact_id, job_url, created_at, updated_at,
                    follow_up_due_at, follow_up_basis, follow_up_state
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(tenant_id, thread_id) DO UPDATE SET
                    contact_id       = excluded.contact_id,
                    job_url          = excluded.job_url,
                    updated_at       = excluded.updated_at,
                    follow_up_due_at = excluded.follow_up_due_at,
                    follow_up_basis  = excluded.follow_up_basis,
                    follow_up_state  = excluded.follow_up_state
                """,
                (
                    tenant,
                    thread_id,
                    thread.contact_id,
                    thread.job_id,
                    thread.created_at,
                    thread.updated_at,
                    thread.follow_up.due_at,
                    thread.follow_up.basis or None,
                    thread.follow_up.state.value,
                ),
            )
            self._conn.execute(
                "DELETE FROM outreach_send_logs WHERE tenant_id = ? AND thread_id = ?",
                (tenant, thread_id),
            )
            for log in thread.send_logs:
                self._conn.execute(
                    """
                    INSERT INTO outreach_send_logs (
                        tenant_id, send_log_id, thread_id, draft_id, channel,
                        sent_at, logged_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        tenant,
                        log.send_log_id,
                        thread_id,
                        log.draft_id,
                        log.channel,
                        log.sent_at,
                        log.logged_at,
                    ),
                )
            self._conn.execute(
                "DELETE FROM outreach_drafts WHERE tenant_id = ? AND thread_id = ?",
                (tenant, thread_id),
            )
            for draft in thread.drafts:
                self._conn.execute(
                    """
                    INSERT INTO outreach_drafts (
                        tenant_id, draft_id, thread_id, generation, kind, status,
                        body_text, gate_results_json, provenance_json, created_at,
                        approved_at, rejected_at, reason
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        tenant,
                        draft.draft_id,
                        thread_id,
                        draft.generation,
                        draft.kind.value,
                        draft.status.value,
                        draft.body_text,
                        json.dumps(draft.gate_results.to_read_model()),
                        json.dumps([claim.to_read_model() for claim in draft.provenance]),
                        draft.created_at,
                        draft.approved_at,
                        draft.rejected_at,
                        draft.reason,
                    ),
                )

    # ---------------------------------------------------------------- events

    def _emit_events(
        self, tenant_id: TenantId, thread: OutreachThread, previous: OutreachThread | None
    ) -> None:
        tenant = str(tenant_id)
        thread_id = str(thread.thread_id)
        job_url = thread.job_id or None
        prior = {draft.draft_id: draft for draft in previous.drafts} if previous else {}

        for draft in thread.drafts:
            existing = prior.get(draft.draft_id)
            if existing is None:
                if draft.generation <= 1:
                    self._record(
                        job_url,
                        thread_id,
                        "OutreachDraftGenerated",
                        "Outreach draft generated.",
                        {
                            "tenantId": tenant,
                            "threadId": thread_id,
                            "contactId": thread.contact_id,
                            "jobId": thread.job_id,
                            "draftId": draft.draft_id,
                            "generation": draft.generation,
                            "kind": draft.kind.value,
                            "generatedAt": draft.created_at,
                        },
                    )
                else:
                    self._record(
                        job_url,
                        thread_id,
                        "OutreachDraftRevised",
                        "Outreach draft revised.",
                        {
                            "tenantId": tenant,
                            "threadId": thread_id,
                            "draftId": draft.draft_id,
                            "generation": draft.generation,
                            "revisedAt": draft.created_at,
                        },
                    )
                continue
            if existing.status is draft.status:
                continue
            if draft.status is ArtifactStatus.APPROVED:
                self._record(
                    job_url,
                    thread_id,
                    "OutreachDraftApproved",
                    "Outreach draft approved.",
                    {
                        "tenantId": tenant,
                        "threadId": thread_id,
                        "draftId": draft.draft_id,
                        "generation": draft.generation,
                        "approvedAt": draft.approved_at or thread.updated_at,
                    },
                )
            elif draft.status is ArtifactStatus.REJECTED:
                self._record(
                    job_url,
                    thread_id,
                    "OutreachDraftRejected",
                    "Outreach draft rejected.",
                    {
                        "tenantId": tenant,
                        "threadId": thread_id,
                        "draftId": draft.draft_id,
                        "generation": draft.generation,
                        "rejectedAt": draft.rejected_at or thread.updated_at,
                    },
                )

        self._emit_send_log_events(tenant, thread, previous, job_url)
        self._emit_follow_up_events(tenant, thread, previous, job_url)

    def _emit_send_log_events(
        self,
        tenant: str,
        thread: OutreachThread,
        previous: OutreachThread | None,
        job_url: str | None,
    ) -> None:
        """Emit ``OutreachSendLogged`` for each newly-recorded user-attested send.

        The payload carries ids, the channel LABEL, and timestamps only — never a
        contact name/email or the draft body (sensitivity; plan §6). This records
        a fact; nothing is ever sent (INV-1).
        """
        prior_ids = {log.send_log_id for log in previous.send_logs} if previous else set()
        for log in thread.send_logs:
            if log.send_log_id in prior_ids:
                continue
            self._record(
                job_url,
                thread.thread_id,
                "OutreachSendLogged",
                "Outreach send logged (user-attested).",
                {
                    "tenantId": tenant,
                    "threadId": thread.thread_id,
                    "draftId": log.draft_id,
                    "channel": log.channel,
                    "sentAt": log.sent_at,
                    "loggedAt": log.logged_at,
                },
            )

    def _emit_follow_up_events(
        self,
        tenant: str,
        thread: OutreachThread,
        previous: OutreachThread | None,
        job_url: str | None,
    ) -> None:
        """Emit FollowUpScheduled/Completed/Dismissed on a follow-up state change.

        Follow-ups are surfaced-only; these events drive the due-follow-ups read
        model and never trigger any outbound action (INV-1).
        """
        current = thread.follow_up
        prev = previous.follow_up if previous else FollowUpSchedule()
        if current.state is FollowUpState.SCHEDULED and (
            prev.state is not FollowUpState.SCHEDULED or prev.due_at != current.due_at
        ):
            self._record(
                job_url,
                thread.thread_id,
                "FollowUpScheduled",
                "Outreach follow-up scheduled.",
                {
                    "tenantId": tenant,
                    "threadId": thread.thread_id,
                    "jobId": thread.job_id,
                    "dueAt": current.due_at,
                    "basis": current.basis,
                    "scheduledAt": thread.updated_at,
                },
            )
        elif current.state is FollowUpState.COMPLETED and prev.state is not FollowUpState.COMPLETED:
            self._record(
                job_url,
                thread.thread_id,
                "FollowUpCompleted",
                "Outreach follow-up completed.",
                {
                    "tenantId": tenant,
                    "threadId": thread.thread_id,
                    "completedAt": thread.updated_at,
                },
            )
        elif current.state is FollowUpState.DISMISSED and prev.state is not FollowUpState.DISMISSED:
            self._record(
                job_url,
                thread.thread_id,
                "FollowUpDismissed",
                "Outreach follow-up dismissed.",
                {
                    "tenantId": tenant,
                    "threadId": thread.thread_id,
                    "reason": "",
                    "dismissedAt": thread.updated_at,
                },
            )

    def _record(
        self,
        job_url: str | None,
        thread_id: str,
        event_type: str,
        message: str,
        payload: dict[str, object],
    ) -> None:
        record_job_event(
            self._conn,
            job_url,
            None,
            event_type,
            message=message,
            payload=payload,
            publisher=self._publisher,
            entity_kind="outreach",
            entity_ref=thread_id,
        )


def _kind(value: object) -> OutreachDraftKind:
    try:
        return OutreachDraftKind(str(value))
    except ValueError:
        return OutreachDraftKind.INTRO_REQUEST


def _status(value: object) -> ArtifactStatus:
    try:
        return ArtifactStatus(str(value))
    except ValueError:
        return ArtifactStatus.CANDIDATE


def _follow_up_state(value: object) -> FollowUpState:
    try:
        return FollowUpState(str(value or "none"))
    except ValueError:
        return FollowUpState.NONE


def _decode(raw: object) -> dict | None:
    if not raw:
        return None
    try:
        parsed = json.loads(str(raw))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _decode_list(raw: object) -> list[dict]:
    if not raw:
        return []
    try:
        parsed = json.loads(str(raw))
    except json.JSONDecodeError:
        return []
    return [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []


__all__ = ["SqliteOutreachThreadRepository"]
