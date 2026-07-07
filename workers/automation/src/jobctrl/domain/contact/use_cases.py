"""Driving ports (use cases) for the Contact aggregate — outreach plan §4.5.

Phase 1 ships the four supervised, user-authored write paths: create, update,
CSV import, and delete. Each constructs a :class:`Contact` with mandatory
provenance (INV-2) and delegates persistence + event publication to the
injected :class:`ContactRepository`.

Research-driven creation (candidate confirmation) and outreach drafting are
later phases and are intentionally absent here.
"""

from __future__ import annotations

import csv
import io
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from jobctrl.domain.contact.aggregate import Contact
from jobctrl.domain.contact.value_objects import (
    ContactAttribute,
    ContactFactProvenance,
    ContactLink,
    ContactRole,
)
from jobctrl.domain.identifiers import ContactId, generate_contact_id
from jobctrl.domain.ports.contact import ContactRepository
from jobctrl.domain.tenant import TenantId

# Attribute kinds a CSV column can populate, keyed by their normalised header.
_CSV_ATTRIBUTE_COLUMNS: dict[str, str] = {
    "name": "name",
    "full_name": "name",
    "title": "title",
    "role_title": "title",
    "email": "email",
    "phone": "phone",
    "profile_url": "profile_url",
    "profileurl": "profile_url",
    "linkedin": "profile_url",
    "note": "note",
    "notes": "note",
}

_CSV_ROLE_COLUMNS = ("role",)
_CSV_EMPLOYER_COLUMNS = ("employer", "company")
_CSV_JOB_COLUMNS = ("job_id", "jobid", "job_url", "joburl")


class ContactInputError(ValueError):
    """Raised when a caller supplies structurally invalid contact input."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _attribute_id() -> str:
    return uuid.uuid4().hex


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _role_from(value: str | None, *, default: ContactRole = ContactRole.OTHER) -> ContactRole:
    text = _clean(value).lower()
    if not text:
        return default
    try:
        return ContactRole(text)
    except ValueError:
        return default


@dataclass(frozen=True)
class AttributeInput:
    """A user-supplied attribute (kind + value); provenance is set by the use case."""

    kind: str
    value: str


@dataclass(frozen=True)
class ImportResult:
    imported: int = 0
    skipped: int = 0
    contact_ids: tuple[str, ...] = field(default_factory=tuple)


def _build_attributes(
    inputs: list[AttributeInput],
    provenance: ContactFactProvenance,
) -> tuple[ContactAttribute, ...]:
    attributes: list[ContactAttribute] = []
    for item in inputs:
        value = _clean(item.value)
        if not value:
            continue
        attributes.append(
            ContactAttribute(
                attribute_id=_attribute_id(),
                kind=item.kind,
                value=value,
                provenance=provenance,
            )
        )
    return tuple(attributes)


@dataclass
class CreateContactUseCase:
    repository: ContactRepository

    def execute(
        self,
        tenant_id: TenantId,
        *,
        link: ContactLink,
        role: ContactRole = ContactRole.OTHER,
        attributes: list[AttributeInput] | None = None,
    ) -> Contact:
        now = _now()
        provenance = ContactFactProvenance(
            source_kind="user_entered",
            source_ref="user_entered",
            capture_method="manual",
            captured_at=now,
            confidence=1.0,
            user_confirmed=True,
        )
        contact = Contact.create(
            tenant_id=tenant_id,
            contact_id=generate_contact_id(),
            link=link,
            role=role,
            attributes=_build_attributes(attributes or [], provenance),
            created_at=now,
        )
        return self.repository.save(tenant_id, contact)


@dataclass
class UpdateContactUseCase:
    repository: ContactRepository

    def execute(
        self,
        tenant_id: TenantId,
        contact_id: ContactId,
        *,
        link: ContactLink | None = None,
        role: ContactRole | None = None,
        attributes: list[AttributeInput] | None = None,
    ) -> Contact:
        existing = self.repository.load(tenant_id, contact_id)
        if existing is None:
            raise ContactInputError(f"Contact {contact_id!r} not found")
        now = _now()
        revised_attributes: tuple[ContactAttribute, ...] | None = None
        if attributes is not None:
            provenance = ContactFactProvenance(
                source_kind="user_entered",
                source_ref="user_entered",
                capture_method="manual",
                captured_at=now,
                confidence=1.0,
                user_confirmed=True,
            )
            built = _build_attributes(attributes, provenance)
            # A fact whose (kind, value) is unchanged keeps its original
            # attribute id and provenance (INV-2: editing the contact must not
            # re-stamp imported/derived facts as user_entered); only new or
            # value-edited facts are user-entered.
            remaining: dict[tuple[str, str], list[ContactAttribute]] = {}
            for current in existing.attributes:
                remaining.setdefault((current.kind, current.value), []).append(current)
            preserved: list[ContactAttribute] = []
            for candidate in built:
                bucket = remaining.get((candidate.kind, candidate.value))
                preserved.append(bucket.pop(0) if bucket else candidate)
            revised_attributes = tuple(preserved)
        contact = existing.revise(
            link=link,
            role=role,
            attributes=revised_attributes,
            updated_at=now,
        )
        return self.repository.save(tenant_id, contact)


@dataclass
class DeleteContactUseCase:
    repository: ContactRepository

    def execute(
        self, tenant_id: TenantId, contact_id: ContactId, *, reason: str = ""
    ) -> bool:
        return self.repository.delete(tenant_id, contact_id, reason=reason)


@dataclass
class ImportContactsUseCase:
    """Import a user-provided CSV contact list (resolved decision 4: CSV only).

    Every imported fact is tagged ``source_kind=user_imported_list``,
    ``source_ref=<filename>``, ``capture_method=manual``. A row that links to
    neither an employer nor an application is skipped (a contact must link to
    something — plan §4.1).
    """

    repository: ContactRepository

    def execute(self, tenant_id: TenantId, *, filename: str, csv_text: str) -> ImportResult:
        filename = _clean(filename) or "import.csv"
        reader = csv.DictReader(io.StringIO(csv_text))
        imported = 0
        skipped = 0
        contact_ids: list[str] = []
        now = _now()
        provenance = ContactFactProvenance(
            source_kind="user_imported_list",
            source_ref=filename,
            capture_method="manual",
            captured_at=now,
            confidence=1.0,
            user_confirmed=True,
        )
        for raw_row in reader:
            row = {(_clean(key).lower()): value for key, value in raw_row.items() if key}
            employer = _first(row, _CSV_EMPLOYER_COLUMNS)
            job_id = _first(row, _CSV_JOB_COLUMNS)
            if not employer and not job_id:
                skipped += 1
                continue
            attribute_inputs = [
                AttributeInput(kind=kind, value=row[column])
                for column, kind in _CSV_ATTRIBUTE_COLUMNS.items()
                if _clean(row.get(column))
            ]
            attributes = _build_attributes(attribute_inputs, provenance)
            contact = Contact.create(
                tenant_id=tenant_id,
                contact_id=generate_contact_id(),
                link=ContactLink(employer=employer or None, job_id=job_id or None),
                role=_role_from(_first(row, _CSV_ROLE_COLUMNS)),
                attributes=attributes,
                created_at=now,
            )
            self.repository.save(tenant_id, contact)
            imported += 1
            contact_ids.append(str(contact.contact_id))
        return ImportResult(
            imported=imported, skipped=skipped, contact_ids=tuple(contact_ids)
        )


def _first(row: dict[str, str], columns: tuple[str, ...]) -> str:
    for column in columns:
        value = _clean(row.get(column))
        if value:
            return value
    return ""
