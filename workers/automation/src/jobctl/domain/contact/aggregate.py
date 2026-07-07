"""Contact aggregate root (ninth bounded context — Contact & Outreach).

Identity is ``(TenantId, ContactId)``. The aggregate encloses a durable person
record: its link to an employer and/or application, its role, and its
provenance-bearing attributes. One command mutates one contact.

Invariants (outreach planner plan §4.1):

  * Every :class:`ContactAttribute` carries a non-null
    :class:`ContactFactProvenance` (INV-2) — enforced by the attribute VO and
    re-asserted here.
  * A contact links to at least one of ``{employer, job_id}`` — enforced by
    :class:`ContactLink`.
  * ``ContactId`` is immutable once assigned.

The aggregate is immutable; lifecycle helpers return new instances via
``dataclasses.replace``.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from jobctl.domain.contact.value_objects import (
    ContactAttribute,
    ContactLink,
    ContactRole,
)
from jobctl.domain.identifiers import ContactId
from jobctl.domain.tenant import TenantId


@dataclass(frozen=True)
class Contact:
    """Aggregate root for one durable person record."""

    tenant_id: TenantId
    contact_id: ContactId
    link: ContactLink
    role: ContactRole = ContactRole.OTHER
    attributes: tuple[ContactAttribute, ...] = field(default_factory=tuple)
    created_at: str = ""
    updated_at: str = ""
    deleted_at: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.contact_id, str) or not str(self.contact_id).strip():
            raise ValueError("Contact.contact_id must be a non-empty string")
        if not isinstance(self.link, ContactLink):
            raise ValueError("Contact.link must be a ContactLink")
        if not isinstance(self.role, ContactRole):
            raise ValueError("Contact.role must be a ContactRole")
        if not isinstance(self.attributes, tuple):
            raise ValueError("Contact.attributes must be a tuple")
        for attribute in self.attributes:
            if not isinstance(attribute, ContactAttribute):
                raise ValueError(
                    "Contact.attributes must contain ContactAttribute values "
                    "(each carrying provenance — INV-2)"
                )

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    @classmethod
    def create(
        cls,
        *,
        tenant_id: TenantId,
        contact_id: ContactId,
        link: ContactLink,
        role: ContactRole = ContactRole.OTHER,
        attributes: tuple[ContactAttribute, ...] = (),
        created_at: str,
    ) -> "Contact":
        return cls(
            tenant_id=tenant_id,
            contact_id=contact_id,
            link=link,
            role=role,
            attributes=tuple(attributes),
            created_at=created_at,
            updated_at=created_at,
            deleted_at=None,
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def revise(
        self,
        *,
        link: ContactLink | None = None,
        role: ContactRole | None = None,
        attributes: tuple[ContactAttribute, ...] | None = None,
        updated_at: str,
    ) -> "Contact":
        """Return a revised contact. ``ContactId`` and ``created_at`` are immutable."""
        return replace(
            self,
            link=link if link is not None else self.link,
            role=role if role is not None else self.role,
            attributes=(tuple(attributes) if attributes is not None else self.attributes),
            updated_at=updated_at,
        )

    def mark_deleted(self, *, deleted_at: str) -> "Contact":
        return replace(self, deleted_at=deleted_at, updated_at=deleted_at)

    # ------------------------------------------------------------------
    # Predicates / derived
    # ------------------------------------------------------------------

    @property
    def is_deleted(self) -> bool:
        return bool(self.deleted_at)

    @property
    def display_name(self) -> str:
        """The ``name`` attribute value, or empty when none is recorded.

        Derived from canonical attribute values; never a separately stored fact.
        """
        for attribute in self.attributes:
            if attribute.kind == "name" and attribute.value.strip():
                return attribute.value.strip()
        return ""

    def attribute(self, kind: str) -> ContactAttribute | None:
        for attribute in self.attributes:
            if attribute.kind == kind:
                return attribute
        return None
