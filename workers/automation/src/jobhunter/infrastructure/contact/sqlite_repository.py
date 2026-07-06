"""SQLite-backed ``ContactRepository`` adapter (ninth bounded context).

Follows the publisher-injected repository shape proven by
``jobhunter.infrastructure.profile.sqlite_repository`` (ctor takes
``publisher: EventPublisher``; ``save()`` persists the canonical rows first,
then emits domain events inside a ``try/except`` so event publication never
blocks the write).

Sensitivity rule (outreach planner plan §6; CLAUDE.md): attribute *values*
(names, emails, notes) are persisted ONLY in ``contact_attributes.value_json``.
Event payloads written to ``job_events`` carry only identifiers, kinds,
provenance metadata, and timestamps — never a value. Contact-only events (no
application link) carry honest identity via ``entity_kind='contact'`` /
``entity_ref=<contact_id>`` (schema v2). Application-linked events additionally
key on the job's ``job_url`` so they surface in the job's audit history.
"""

from __future__ import annotations

import json
import logging
import sqlite3

from jobhunter.database import ensure_contact_tables
from jobhunter.domain.contact.aggregate import Contact
from jobhunter.domain.contact.value_objects import (
    ContactAttribute,
    ContactFactProvenance,
    ContactLink,
    ContactRole,
)
from jobhunter.domain.identifiers import ContactId
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.tenant import TenantId
from jobhunter.state import record_job_event, utc_now

logger = logging.getLogger(__name__)


class SqliteContactRepository:
    """SQLite-backed implementation of ``ContactRepository``."""

    def __init__(self, conn: sqlite3.Connection, *, publisher: EventPublisher) -> None:
        self._conn = conn
        self._publisher = publisher
        ensure_contact_tables(self._conn)

    # ------------------------------------------------------------------
    # Load
    # ------------------------------------------------------------------

    def load(self, tenant_id: TenantId, contact_id: ContactId) -> Contact | None:
        row = self._conn.execute(
            "SELECT * FROM contacts WHERE tenant_id = ? AND contact_id = ?",
            (str(tenant_id), str(contact_id)),
        ).fetchone()
        if row is None or row["deleted_at"]:
            return None
        return self._row_to_contact(tenant_id, row)

    def list_for_tenant(self, tenant_id: TenantId) -> list[Contact]:
        return self._list(tenant_id, "", ())

    def list_for_job(self, tenant_id: TenantId, job_id: str) -> list[Contact]:
        return self._list(tenant_id, "AND job_url = ?", (job_id,))

    def list_for_employer(self, tenant_id: TenantId, employer: str) -> list[Contact]:
        return self._list(tenant_id, "AND employer = ?", (employer,))

    def _list(
        self, tenant_id: TenantId, extra_where: str, params: tuple[str, ...]
    ) -> list[Contact]:
        rows = self._conn.execute(
            f"""
            SELECT * FROM contacts
            WHERE tenant_id = ? AND deleted_at IS NULL {extra_where}
            ORDER BY updated_at DESC, contact_id ASC
            """,
            (str(tenant_id), *params),
        ).fetchall()
        return [self._row_to_contact(tenant_id, row) for row in rows]

    def _row_to_contact(self, tenant_id: TenantId, row: sqlite3.Row) -> Contact:
        return Contact(
            tenant_id=tenant_id,
            contact_id=ContactId(str(row["contact_id"])),
            link=ContactLink(employer=row["employer"], job_id=row["job_url"]),
            role=_role(row["role"]),
            attributes=self._load_attributes(tenant_id, str(row["contact_id"])),
            created_at=str(row["created_at"] or ""),
            updated_at=str(row["updated_at"] or ""),
            deleted_at=row["deleted_at"],
        )

    def _load_attributes(
        self, tenant_id: TenantId, contact_id: str
    ) -> tuple[ContactAttribute, ...]:
        rows = self._conn.execute(
            """
            SELECT attribute_id, attribute_kind, value_json, source_kind, source_ref,
                   capture_method, confidence, user_confirmed, recorded_at
            FROM contact_attributes
            WHERE tenant_id = ? AND contact_id = ?
            ORDER BY recorded_at ASC, attribute_id ASC
            """,
            (str(tenant_id), contact_id),
        ).fetchall()
        return tuple(
            ContactAttribute(
                attribute_id=str(row["attribute_id"]),
                kind=str(row["attribute_kind"]),
                value=_decode_value(row["value_json"]),
                provenance=ContactFactProvenance(
                    source_kind=str(row["source_kind"]),
                    source_ref=str(row["source_ref"]),
                    capture_method=str(row["capture_method"] or "manual"),
                    captured_at=str(row["recorded_at"] or ""),
                    confidence=float(row["confidence"] or 0.0),
                    user_confirmed=bool(row["user_confirmed"]),
                ),
            )
            for row in rows
        )

    # ------------------------------------------------------------------
    # Save
    # ------------------------------------------------------------------

    def save(self, tenant_id: TenantId, contact: Contact) -> Contact:
        previous = self.load(tenant_id, contact.contact_id)
        self._persist_canonical(tenant_id, contact)
        try:
            self._emit_events(tenant_id, contact, previous)
            self._conn.commit()
        except Exception:  # noqa: BLE001 — event publication must not corrupt the write
            logger.exception("Failed to emit Contact domain events for %s", contact.contact_id)
        return contact

    def _persist_canonical(self, tenant_id: TenantId, contact: Contact) -> None:
        tenant = str(tenant_id)
        contact_id = str(contact.contact_id)
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO contacts (
                    tenant_id, contact_id, employer, job_url, role,
                    created_at, updated_at, deleted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(tenant_id, contact_id) DO UPDATE SET
                    employer = excluded.employer,
                    job_url = excluded.job_url,
                    role = excluded.role,
                    updated_at = excluded.updated_at,
                    deleted_at = excluded.deleted_at
                """,
                (
                    tenant,
                    contact_id,
                    contact.link.employer,
                    contact.link.job_id,
                    contact.role.value,
                    contact.created_at,
                    contact.updated_at,
                    contact.deleted_at,
                ),
            )
            self._conn.execute(
                "DELETE FROM contact_attributes WHERE tenant_id = ? AND contact_id = ?",
                (tenant, contact_id),
            )
            for attribute in contact.attributes:
                provenance = attribute.provenance
                self._conn.execute(
                    """
                    INSERT INTO contact_attributes (
                        tenant_id, attribute_id, contact_id, attribute_kind, value_json,
                        source_kind, source_ref, capture_method, confidence,
                        user_confirmed, recorded_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        tenant,
                        attribute.attribute_id,
                        contact_id,
                        attribute.kind,
                        _encode_value(attribute.value),
                        provenance.source_kind,
                        provenance.source_ref,
                        provenance.capture_method,
                        float(provenance.confidence),
                        1 if provenance.user_confirmed else 0,
                        provenance.captured_at or contact.updated_at,
                    ),
                )

    def delete(self, tenant_id: TenantId, contact_id: ContactId, *, reason: str = "") -> bool:
        deleted_at = utc_now()
        cursor = self._conn.execute(
            """
            UPDATE contacts SET deleted_at = ?, updated_at = ?
            WHERE tenant_id = ? AND contact_id = ? AND deleted_at IS NULL
            """,
            (deleted_at, deleted_at, str(tenant_id), str(contact_id)),
        )
        if cursor.rowcount <= 0:
            return False
        try:
            record_job_event(
                self._conn,
                None,
                None,
                "ContactDeleted",
                message="Contact deleted.",
                payload={
                    "tenantId": str(tenant_id),
                    "contactId": str(contact_id),
                    "reason": reason,
                    "deletedAt": deleted_at,
                },
                publisher=self._publisher,
                entity_kind="contact",
                entity_ref=str(contact_id),
            )
            self._conn.commit()
        except Exception:  # noqa: BLE001
            logger.exception("Failed to emit ContactDeleted for %s", contact_id)
        return True

    # ------------------------------------------------------------------
    # Events (durable + SSE via ``record_job_event``; safe references only)
    # ------------------------------------------------------------------

    def _emit_events(
        self, tenant_id: TenantId, contact: Contact, previous: Contact | None
    ) -> None:
        tenant = str(tenant_id)
        contact_id = str(contact.contact_id)
        job_url = contact.link.job_id or None

        if previous is None:
            self._record(
                job_url,
                "ContactCreated",
                "Contact created.",
                {
                    "tenantId": tenant,
                    "contactId": contact_id,
                    "employer": contact.link.employer,
                    "jobId": contact.link.job_id,
                    "role": contact.role.value,
                    "createdAt": contact.created_at,
                },
                contact_id,
            )
            new_attributes = contact.attributes
        else:
            changed = _changed_fields(previous, contact)
            self._record(
                job_url,
                "ContactUpdated",
                "Contact updated.",
                {
                    "tenantId": tenant,
                    "contactId": contact_id,
                    "changedFields": changed,
                    "updatedAt": contact.updated_at,
                },
                contact_id,
            )
            existing_facts = {(a.kind, a.value) for a in previous.attributes}
            new_attributes = tuple(
                a for a in contact.attributes if (a.kind, a.value) not in existing_facts
            )

        for attribute in new_attributes:
            provenance = attribute.provenance
            self._record(
                job_url,
                "ContactAttributeRecorded",
                "Contact fact recorded.",
                {
                    "tenantId": tenant,
                    "contactId": contact_id,
                    "attributeId": attribute.attribute_id,
                    "attributeKind": attribute.kind,
                    "sourceKind": provenance.source_kind,
                    "sourceRef": provenance.source_ref,
                    "captureMethod": provenance.capture_method,
                    "confidence": float(provenance.confidence),
                    "userConfirmed": bool(provenance.user_confirmed),
                    "recordedAt": provenance.captured_at or contact.updated_at,
                },
                contact_id,
            )

    def _record(
        self,
        job_url: str | None,
        event_type: str,
        message: str,
        payload: dict[str, object],
        contact_id: str,
    ) -> None:
        record_job_event(
            self._conn,
            job_url,
            None,
            event_type,
            message=message,
            payload=payload,
            publisher=self._publisher,
            entity_kind="contact",
            entity_ref=contact_id,
        )


def _role(value: object) -> ContactRole:
    try:
        return ContactRole(str(value))
    except ValueError:
        return ContactRole.OTHER


def _encode_value(value: str) -> str:
    return json.dumps(value)


def _decode_value(raw: object) -> str:
    if raw is None:
        return ""
    text = str(raw)
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        return text
    return decoded if isinstance(decoded, str) else text


def _changed_fields(previous: Contact, current: Contact) -> list[str]:
    changed: list[str] = []
    if previous.role != current.role:
        changed.append("role")
    if previous.link.employer != current.link.employer:
        changed.append("employer")
    if previous.link.job_id != current.link.job_id:
        changed.append("jobId")
    prev_facts = {(a.kind, a.value) for a in previous.attributes}
    curr_facts = {(a.kind, a.value) for a in current.attributes}
    if prev_facts != curr_facts:
        changed.append("attributes")
    return changed
