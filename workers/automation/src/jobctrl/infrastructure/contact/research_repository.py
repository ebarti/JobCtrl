"""SQLite-backed ``ContactResearchTaskRepository`` (ninth bounded context).

Publisher-injected, mirroring ``SqliteContactRepository``: ``save()`` writes the
canonical ``contact_research_tasks`` + ``contact_candidates`` rows first, then
emits domain events inside a ``try/except`` so event publication never blocks the
write.

Sensitivity (outreach planner plan §6): candidate attribute *values* are
persisted ONLY in ``contact_candidates.attributes_json``. Event payloads written
to ``job_events`` carry ids, kinds, provenance metadata, confidence, outcomes,
and timestamps — never a value or a fetched page body. Research events carry
honest identity via ``entity_kind='contact_research'`` / ``entity_ref=<task_id>``;
application-linked tasks additionally key on the canonical ``job_id``.
"""

from __future__ import annotations

import json
import logging
import sqlite3

from jobctrl.domain.contact.research import (
    CandidateStatus,
    ContactCandidate,
    ContactResearchTask,
    ResearchSourceAttempt,
    ResearchTaskStatus,
)
from jobctrl.domain.contact.value_objects import (
    ContactAttribute,
    ContactFactProvenance,
    ContactLink,
    ContactRole,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.tenant import TenantId
from jobctrl.state import record_job_event

logger = logging.getLogger(__name__)


class SqliteContactResearchTaskRepository:
    """SQLite-backed implementation of ``ContactResearchTaskRepository``."""

    def __init__(self, conn: sqlite3.Connection, *, publisher: EventPublisher) -> None:
        self._conn = conn
        self._publisher = publisher

    # ------------------------------------------------------------------ load

    def load(self, tenant_id: TenantId, task_id: str) -> ContactResearchTask | None:
        row = self._conn.execute(
            "SELECT * FROM contact_research_tasks WHERE tenant_id = ? AND task_id = ?",
            (str(tenant_id), str(task_id)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_task(tenant_id, row)

    def list_for_tenant(self, tenant_id: TenantId) -> list[ContactResearchTask]:
        rows = self._conn.execute(
            """
            SELECT * FROM contact_research_tasks
            WHERE tenant_id = ?
            ORDER BY updated_at DESC, task_id ASC
            """,
            (str(tenant_id),),
        ).fetchall()
        return [self._row_to_task(tenant_id, row) for row in rows]

    def _row_to_task(self, tenant_id: TenantId, row: sqlite3.Row) -> ContactResearchTask:
        return ContactResearchTask(
            tenant_id=tenant_id,
            task_id=str(row["task_id"]),
            link=ContactLink(employer=row["employer"], job_id=row["job_id"]),
            status=_status(row["status"]),
            candidates=self._load_candidates(tenant_id, str(row["task_id"])),
            source_attempts=_decode_attempts(row["source_attempts_json"]),
            started_at=row["started_at"],
            updated_at=str(row["updated_at"] or ""),
            needs_review_at=row["needs_review_at"],
            completed_at=row["completed_at"],
            failed_at=row["failed_at"],
            error_class=row["error_class"],
        )

    def _load_candidates(
        self, tenant_id: TenantId, task_id: str
    ) -> tuple[ContactCandidate, ...]:
        rows = self._conn.execute(
            """
            SELECT candidate_id, task_id, role, attributes_json, source_kind, source_ref,
                   capture_method, confidence, status, proposed_at,
                   confirmed_contact_id, confirmed_at
            FROM contact_candidates
            WHERE tenant_id = ? AND task_id = ?
            ORDER BY proposed_at ASC, candidate_id ASC
            """,
            (str(tenant_id), task_id),
        ).fetchall()
        candidates: list[ContactCandidate] = []
        for row in rows:
            provenance = ContactFactProvenance(
                source_kind=str(row["source_kind"]),
                source_ref=str(row["source_ref"]),
                capture_method=str(row["capture_method"] or "llm_assisted"),
                captured_at=str(row["proposed_at"] or ""),
                confidence=float(row["confidence"] or 0.0),
                user_confirmed=_candidate_status(row["status"]) is CandidateStatus.CONFIRMED,
            )
            candidates.append(
                ContactCandidate(
                    candidate_id=str(row["candidate_id"]),
                    task_id=str(row["task_id"]),
                    role=_role(row["role"]),
                    attributes=_decode_attributes(row["attributes_json"], provenance),
                    provenance=provenance,
                    confidence=float(row["confidence"] or 0.0),
                    status=_candidate_status(row["status"]),
                    proposed_at=str(row["proposed_at"] or ""),
                    confirmed_contact_id=row["confirmed_contact_id"],
                    confirmed_at=row["confirmed_at"],
                )
            )
        return tuple(candidates)

    # ------------------------------------------------------------------ save

    def save(self, tenant_id: TenantId, task: ContactResearchTask) -> ContactResearchTask:
        previous = self.load(tenant_id, task.task_id)
        self._persist_canonical(tenant_id, task)
        try:
            self._emit_events(tenant_id, task, previous)
            self._conn.commit()
        except Exception:  # noqa: BLE001 — event publication must not corrupt the write
            logger.exception(
                "Failed to emit ContactResearchTask domain events for %s", task.task_id
            )
        return task

    def _persist_canonical(self, tenant_id: TenantId, task: ContactResearchTask) -> None:
        tenant = str(tenant_id)
        task_id = str(task.task_id)
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO contact_research_tasks (
                    tenant_id, task_id, employer, job_id, status, source_attempts_json,
                    started_at, updated_at, needs_review_at, completed_at, failed_at, error_class
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(tenant_id, task_id) DO UPDATE SET
                    employer             = excluded.employer,
                    job_id               = excluded.job_id,
                    status               = excluded.status,
                    source_attempts_json = excluded.source_attempts_json,
                    started_at           = excluded.started_at,
                    updated_at           = excluded.updated_at,
                    needs_review_at      = excluded.needs_review_at,
                    completed_at         = excluded.completed_at,
                    failed_at            = excluded.failed_at,
                    error_class          = excluded.error_class
                """,
                (
                    tenant,
                    task_id,
                    task.link.employer,
                    task.link.job_id,
                    task.status.value,
                    _encode_attempts(task.source_attempts),
                    task.started_at,
                    task.updated_at,
                    task.needs_review_at,
                    task.completed_at,
                    task.failed_at,
                    task.error_class,
                ),
            )
            self._conn.execute(
                "DELETE FROM contact_candidates WHERE tenant_id = ? AND task_id = ?",
                (tenant, task_id),
            )
            for candidate in task.candidates:
                self._conn.execute(
                    """
                    INSERT INTO contact_candidates (
                        tenant_id, candidate_id, task_id, role, attributes_json,
                        source_kind, source_ref, capture_method, confidence, status,
                        proposed_at, confirmed_contact_id, confirmed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        tenant,
                        candidate.candidate_id,
                        task_id,
                        candidate.role.value,
                        _encode_attributes(candidate.attributes),
                        candidate.provenance.source_kind,
                        candidate.provenance.source_ref,
                        candidate.provenance.capture_method,
                        float(candidate.confidence),
                        candidate.status.value,
                        candidate.proposed_at,
                        candidate.confirmed_contact_id,
                        candidate.confirmed_at,
                    ),
                )

    # ---------------------------------------------------------------- events

    def _emit_events(
        self,
        tenant_id: TenantId,
        task: ContactResearchTask,
        previous: ContactResearchTask | None,
    ) -> None:
        tenant = str(tenant_id)
        task_id = str(task.task_id)
        job_id = task.link.job_id
        previous_status = previous.status if previous is not None else None

        if previous is None:
            self._record(
                tenant_id,
                job_id,
                task_id,
                "ContactResearchTaskStarted",
                "Contact research started.",
                {
                    "tenantId": tenant,
                    "taskId": task_id,
                    "employer": task.link.employer,
                    "jobId": task.link.job_id,
                    "startedAt": task.started_at or task.updated_at,
                },
            )

        if task.status is ResearchTaskStatus.NEEDS_REVIEW and previous_status is not (
            ResearchTaskStatus.NEEDS_REVIEW
        ):
            known = {c.candidate_id for c in previous.candidates} if previous else set()
            for candidate in task.candidates:
                if candidate.candidate_id in known:
                    continue
                self._record(
                    tenant_id,
                    job_id,
                    task_id,
                    "ContactCandidateProposed",
                    "Contact candidate proposed for review.",
                    {
                        "tenantId": tenant,
                        "taskId": task_id,
                        "candidateId": candidate.candidate_id,
                        "role": candidate.role.value,
                        "sourceKind": candidate.provenance.source_kind,
                        "sourceRef": candidate.provenance.source_ref,
                        "captureMethod": candidate.provenance.capture_method,
                        "confidence": float(candidate.confidence),
                        "proposedAt": candidate.proposed_at,
                    },
                )
            self._record(
                tenant_id,
                job_id,
                task_id,
                "ContactResearchTaskNeedsReview",
                "Contact research needs review.",
                {
                    "tenantId": tenant,
                    "taskId": task_id,
                    "candidateCount": len(task.candidates),
                    "needsReviewAt": task.needs_review_at or task.updated_at,
                },
            )

        if (
            task.status is ResearchTaskStatus.COMPLETED
            and previous_status is not ResearchTaskStatus.COMPLETED
        ):
            self._record(
                tenant_id,
                job_id,
                task_id,
                "ContactResearchTaskCompleted",
                "Contact research completed.",
                {
                    "tenantId": tenant,
                    "taskId": task_id,
                    "confirmedCount": task.confirmed_count,
                    "completedAt": task.completed_at or task.updated_at,
                },
            )

        if (
            task.status is ResearchTaskStatus.FAILED
            and previous_status is not ResearchTaskStatus.FAILED
        ):
            self._record(
                tenant_id,
                job_id,
                task_id,
                "ContactResearchTaskFailed",
                "Contact research failed.",
                {
                    "tenantId": tenant,
                    "taskId": task_id,
                    "errorClass": task.error_class or "unknown",
                    "retryable": False,
                    "failedAt": task.failed_at or task.updated_at,
                },
            )

    def _record(
        self,
        tenant_id: TenantId,
        job_id: JobId | None,
        task_id: str,
        event_type: str,
        message: str,
        payload: dict[str, object],
    ) -> None:
        record_job_event(
            self._conn,
            job_id,
            None,
            event_type,
            tenant_id=tenant_id,
            message=message,
            payload=payload,
            publisher=self._publisher,
            entity_kind="contact_research",
            entity_ref=task_id,
        )


def _status(value: object) -> ResearchTaskStatus:
    try:
        return ResearchTaskStatus(str(value))
    except ValueError:
        return ResearchTaskStatus.QUEUED


def _candidate_status(value: object) -> CandidateStatus:
    try:
        return CandidateStatus(str(value))
    except ValueError:
        return CandidateStatus.NEEDS_REVIEW


def _role(value: object) -> ContactRole:
    try:
        return ContactRole(str(value))
    except ValueError:
        return ContactRole.OTHER


def _encode_attempts(attempts: tuple[ResearchSourceAttempt, ...]) -> str:
    return json.dumps(
        [
            {
                "sourceKind": attempt.source_kind,
                "sourceRef": attempt.source_ref,
                "outcome": attempt.outcome,
                "attemptedAt": attempt.attempted_at,
                "detail": attempt.detail,
            }
            for attempt in attempts
        ]
    )


def _decode_attempts(raw: object) -> tuple[ResearchSourceAttempt, ...]:
    if not raw:
        return ()
    try:
        items = json.loads(str(raw))
    except json.JSONDecodeError:
        return ()
    attempts: list[ResearchSourceAttempt] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            attempts.append(
                ResearchSourceAttempt(
                    source_kind=str(item.get("sourceKind") or ""),
                    source_ref=str(item.get("sourceRef") or ""),
                    outcome=str(item.get("outcome") or ""),
                    attempted_at=str(item.get("attemptedAt") or ""),
                    detail=str(item.get("detail") or ""),
                )
            )
        except ValueError:
            continue
    return tuple(attempts)


def _encode_attributes(attributes: tuple[ContactAttribute, ...]) -> str:
    return json.dumps(
        [
            {
                "attributeId": attribute.attribute_id,
                "kind": attribute.kind,
                "value": attribute.value,
                "provenance": attribute.provenance.to_dict(),
            }
            for attribute in attributes
        ]
    )


def _decode_attributes(
    raw: object, fallback_provenance: ContactFactProvenance
) -> tuple[ContactAttribute, ...]:
    if not raw:
        return ()
    try:
        items = json.loads(str(raw))
    except json.JSONDecodeError:
        return ()
    attributes: list[ContactAttribute] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        provenance_data = item.get("provenance")
        provenance = fallback_provenance
        if isinstance(provenance_data, dict):
            try:
                provenance = ContactFactProvenance(
                    source_kind=str(provenance_data.get("source_kind") or fallback_provenance.source_kind),
                    source_ref=str(provenance_data.get("source_ref") or fallback_provenance.source_ref),
                    capture_method=str(
                        provenance_data.get("capture_method") or fallback_provenance.capture_method
                    ),
                    captured_at=str(provenance_data.get("captured_at") or ""),
                    confidence=float(provenance_data.get("confidence") or 0.0),
                    user_confirmed=bool(provenance_data.get("user_confirmed")),
                )
            except (ValueError, TypeError):
                provenance = fallback_provenance
        try:
            attributes.append(
                ContactAttribute(
                    attribute_id=str(item.get("attributeId") or ""),
                    kind=str(item.get("kind") or ""),
                    value=str(item.get("value") or ""),
                    provenance=provenance,
                )
            )
        except ValueError:
            continue
    return tuple(attributes)


__all__ = ["SqliteContactResearchTaskRepository"]
