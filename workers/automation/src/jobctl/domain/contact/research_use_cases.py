"""Driving ports (use cases) for supervised contact research — plan §4.5.

``RunContactResearchUseCase`` starts a supervised run: it creates the task
(``running``), drives the pure :class:`ContactResearchService` over the opted-in
sources, and records the proposed candidates in ``needs_review`` (INV-4).

``ConfirmContactCandidateUseCase`` is the explicit user command (INV-4) that
promotes one ``needs_review`` candidate into a stored :class:`Contact` fact via
the Phase-1 ``ContactRepository`` — preserving the candidate's provenance (INV-2)
and marking it user-confirmed — then advances the research task (auto-completing
once nothing awaits review). The frontend runtime path for confirmation is
hosted directly in the TS API per integration.md §6.8; this use case is the
authoritative domain contract exercised by the INV-4 regression tests.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Callable

from jobctl.domain.contact.aggregate import Contact
from jobctl.domain.contact.research import ContactCandidate, ContactResearchTask
from jobctl.domain.contact.research_services import ContactResearchService, ResearchSourceSpec
from jobctl.domain.contact.value_objects import ContactAttribute, ContactLink, ContactRole
from jobctl.domain.identifiers import ContactId, generate_contact_id
from jobctl.domain.ports.contact import (
    ContactRepository,
    ContactResearchTaskRepository,
    ResearchPageFetcherPort,
)
from jobctl.domain.ports.llm import LlmPort
from jobctl.domain.tenant import TenantId


class ContactResearchInputError(ValueError):
    """Raised when a caller supplies structurally invalid research input."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class RunContactResearchUseCase:
    repository: ContactResearchTaskRepository
    service: ContactResearchService
    fetcher: ResearchPageFetcherPort
    llm: LlmPort
    clock: Callable[[], str] = _now
    new_id: Callable[[], str] = lambda: generate_contact_id()

    def execute(
        self,
        tenant_id: TenantId,
        *,
        task_id: str,
        link: ContactLink,
        sources: tuple[ResearchSourceSpec, ...],
        model: str | None = None,
    ) -> ContactResearchTask:
        started_at = self.clock()
        task = ContactResearchTask.create(
            tenant_id=tenant_id,
            task_id=task_id,
            link=link,
            created_at=started_at,
        ).start(started_at=started_at)
        self.repository.save(tenant_id, task)

        result = self.service.research(
            task_id=task_id,
            sources=sources,
            fetcher=self.fetcher,
            llm=self.llm,
            clock=self.clock,
            new_id=self.new_id,
            model=model,
        )
        task = task.propose(
            candidates=result.candidates,
            source_attempts=result.source_attempts,
            needs_review_at=self.clock(),
        )
        return self.repository.save(tenant_id, task)


@dataclass
class ConfirmContactCandidateResult:
    contact: Contact
    task: ContactResearchTask


@dataclass
class ConfirmContactCandidateUseCase:
    research_repository: ContactResearchTaskRepository
    contact_repository: ContactRepository
    clock: Callable[[], str] = _now
    new_contact_id: Callable[[], ContactId] = generate_contact_id

    def execute(
        self,
        tenant_id: TenantId,
        *,
        task_id: str,
        candidate_id: str,
        role: ContactRole | None = None,
    ) -> ConfirmContactCandidateResult:
        task = self.research_repository.load(tenant_id, task_id)
        if task is None:
            raise ContactResearchInputError(f"Research task {task_id!r} not found")
        candidate = task.candidate(candidate_id)
        if candidate is None:
            raise ContactResearchInputError(
                f"Candidate {candidate_id!r} not found on task {task_id!r}"
            )
        if not candidate.is_needs_review:
            raise ContactResearchInputError(
                f"Candidate {candidate_id!r} is not awaiting review"
            )

        now = self.clock()
        contact_id = self.new_contact_id()
        contact = Contact.create(
            tenant_id=tenant_id,
            contact_id=contact_id,
            link=task.link,
            role=role or candidate.role,
            attributes=_confirmed_attributes(candidate),
            created_at=now,
        )
        self.contact_repository.save(tenant_id, contact)

        task = task.confirm_candidate(
            candidate_id=candidate_id,
            contact_id=contact_id,
            confirmed_at=now,
        )
        task = self.research_repository.save(tenant_id, task)
        return ConfirmContactCandidateResult(contact=contact, task=task)


def _confirmed_attributes(candidate: ContactCandidate) -> tuple[ContactAttribute, ...]:
    """Promote candidate attributes, preserving provenance but marking confirmed.

    The original ``sourceKind``/``sourceRef``/``captureMethod`` are kept (INV-2:
    the stored fact still shows it came from research), while ``userConfirmed``
    flips to True — the user's confirmation is the authorising act (INV-4).
    """
    return tuple(
        replace(
            attribute,
            provenance=replace(attribute.provenance, user_confirmed=True),
        )
        for attribute in candidate.attributes
    )


__all__ = [
    "ConfirmContactCandidateResult",
    "ConfirmContactCandidateUseCase",
    "ContactResearchInputError",
    "RunContactResearchUseCase",
]
