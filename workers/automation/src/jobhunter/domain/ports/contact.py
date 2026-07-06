"""Driven ports for the Contact & Outreach context.

See outreach planner plan §4.5. ``ContactRepository`` is the tenant-scoped
per-aggregate repository for the :class:`Contact` root
(``docs/architecture/domain-model/persistence.md`` §7.1). Local-mode adapter is
``jobhunter.infrastructure.contact.sqlite_repository.SqliteContactRepository``.

Phase 2 adds ``ContactResearchTaskRepository`` for the supervised research
aggregate plus ``ResearchPageFetcherPort`` — the gateway-routed public-page
fetch seam (every research fetch routes through the merged politeness gateway;
robots-denial / rate-limit / budget-exhaustion are first-class outcomes, not
scrape errors). Phase 3 adds ``OutreachThreadRepository`` for the outreach-draft
aggregate. Local-mode adapter is
``jobhunter.infrastructure.contact.outreach_repository.SqliteOutreachThreadRepository``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from jobhunter.domain.contact.aggregate import Contact
from jobhunter.domain.contact.outreach import OutreachThread
from jobhunter.domain.contact.research import ContactResearchTask
from jobhunter.domain.identifiers import ContactId
from jobhunter.domain.tenant import TenantId

__all__ = [
    "ContactRepository",
    "ContactResearchTaskRepository",
    "OutreachThreadRepository",
    "ResearchPageFetch",
    "ResearchPageFetcherPort",
]


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


class ContactResearchTaskRepository(Protocol):
    """Persistence port for the ``ContactResearchTask`` aggregate."""

    def load(self, tenant_id: TenantId, task_id: str) -> ContactResearchTask | None:
        """Return the research task, or ``None`` when absent."""

    def save(self, tenant_id: TenantId, task: ContactResearchTask) -> ContactResearchTask:
        """Persist the aggregate (task + candidates + attempts) and publish events."""

    def list_for_tenant(self, tenant_id: TenantId) -> list[ContactResearchTask]:
        """Return all research tasks for the tenant, newest first."""


class OutreachThreadRepository(Protocol):
    """Persistence port for the ``OutreachThread`` aggregate (drafts).

    Publisher-injected like the other Contact & Outreach adapters: ``save``
    persists the canonical ``outreach_threads`` + ``outreach_drafts`` rows and
    publishes the draft lifecycle events (``OutreachDraftGenerated`` /
    ``OutreachDraftRevised`` / ``OutreachDraftApproved`` / ``OutreachDraftRejected``).
    There is no send transport on this port (INV-1).
    """

    def load(self, tenant_id: TenantId, thread_id: str) -> OutreachThread | None:
        """Return the outreach thread (with all draft generations), or ``None``."""

    def load_for_contact(
        self, tenant_id: TenantId, contact_id: str, job_id: str | None = None
    ) -> OutreachThread | None:
        """Return the thread for a ``(contact, optional application)``, or ``None``."""

    def save(self, tenant_id: TenantId, thread: OutreachThread) -> OutreachThread:
        """Persist the aggregate (thread + drafts) and publish its domain events."""

    def list_for_tenant(self, tenant_id: TenantId) -> list[OutreachThread]:
        """Return all outreach threads for the tenant, newest first."""


@dataclass(frozen=True)
class ResearchPageFetch:
    """Outcome of one gateway-guarded public-page fetch.

    ``outcome`` is a :class:`~jobhunter.domain.contact.research.ResearchSourceOutcome`
    value; ``text`` is populated only when ``outcome == 'allowed'``. A blocked
    decision (robots/rate-limit/budget) yields the outcome with empty text — it
    is never surfaced as an exception (outreach planner plan §5.3).
    """

    outcome: str
    text: str = ""
    final_url: str = ""
    status: int | None = None


class ResearchPageFetcherPort(Protocol):
    """Gateway-routed public-page fetch seam for contact research.

    The single outbound choke point: implementations wrap
    ``PolitenessGatewayPort.guard(url, policy, budget)`` and only fetch when the
    decision is allowed. No research fetch path bypasses this port.
    """

    def fetch(self, url: str) -> ResearchPageFetch:
        """Fetch a public page through the politeness gateway."""
