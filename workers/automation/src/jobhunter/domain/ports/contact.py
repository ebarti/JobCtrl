"""Driven ports for the Contact & Outreach context.

See outreach planner plan §4.5. ``ContactRepository`` is the tenant-scoped
per-aggregate repository for the :class:`Contact` root
(``docs/architecture/domain-model/persistence.md`` §7.1). Local-mode adapter is
``jobhunter.infrastructure.contact.sqlite_repository.SqliteContactRepository``.

Only the ``Contact`` aggregate is realised in Phase 1; the
``ContactResearchTaskRepository`` / ``OutreachThreadRepository`` ports land with
their aggregates in later phases.
"""

from __future__ import annotations

from typing import Protocol

from jobhunter.domain.contact.aggregate import Contact
from jobhunter.domain.identifiers import ContactId
from jobhunter.domain.tenant import TenantId

__all__ = ["ContactRepository"]


class ContactRepository(Protocol):
    """Persistence port for the ``Contact`` aggregate."""

    def load(self, tenant_id: TenantId, contact_id: ContactId) -> Contact | None:
        """Return the contact, or ``None`` when absent or soft-deleted."""

    def save(self, tenant_id: TenantId, contact: Contact) -> Contact:
        """Persist the aggregate and publish its domain events."""

    def list_for_tenant(self, tenant_id: TenantId) -> list[Contact]:
        """Return all non-deleted contacts for the tenant."""

    def list_for_job(self, tenant_id: TenantId, job_id: str) -> list[Contact]:
        """Return non-deleted contacts linked to a specific application."""

    def list_for_employer(self, tenant_id: TenantId, employer: str) -> list[Contact]:
        """Return non-deleted contacts linked to a specific employer."""

    def delete(self, tenant_id: TenantId, contact_id: ContactId, *, reason: str) -> bool:
        """Soft-delete the contact. Returns ``True`` when a row was affected."""
