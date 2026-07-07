"""``ContactResearchTask`` aggregate (Contact & Outreach, ninth context).

A supervised research run with its own lifecycle
(``queued -> running -> needs_review -> completed | failed``) and the candidates
it proposes. Distinct from the durable :class:`Contact` root, mirroring how
``ApplyRun`` is separate from ``Job`` (outreach planner plan §4.2).

Invariants:

  * A task only fetches sources permitted by the source-access policy (§5); an
    attempt against a disallowed source is rejected before any fetch and recorded
    as a :class:`ResearchSourceAttempt` outcome (§5.3), never a scrape error.
  * Proposed candidates land in ``needs_review``; **no candidate becomes a stored
    Contact fact without an explicit user confirmation command** (INV-4). The
    only transition to ``confirmed`` is :meth:`ContactResearchTask.confirm_candidate`.
  * Every :class:`ContactCandidate` attribute carries provenance (INV-2) — the
    attribute VO enforces it and it is re-asserted here.

Sensitivity: candidate attribute *values* (names, emails) live only on
:class:`ContactCandidate.attributes` and are persisted only in
``contact_candidates.attributes_json``. Events/projections/logs carry ids,
kinds, provenance metadata, confidence, and timestamps — never a value.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum

from jobctl.domain.contact.value_objects import (
    ContactAttribute,
    ContactFactProvenance,
    ContactLink,
    ContactRole,
)
from jobctl.domain.identifiers import ContactId
from jobctl.domain.tenant import TenantId


class ResearchTaskStatus(str, Enum):
    """Lifecycle of a supervised research task."""

    QUEUED = "queued"
    RUNNING = "running"
    NEEDS_REVIEW = "needs_review"
    COMPLETED = "completed"
    FAILED = "failed"


class CandidateStatus(str, Enum):
    """Review state of a proposed candidate (INV-4: default needs_review)."""

    NEEDS_REVIEW = "needs_review"
    CONFIRMED = "confirmed"
    DISMISSED = "dismissed"


class ResearchSourceOutcome(str, Enum):
    """First-class outcome of one attempt against an allowed source.

    Robots-denial / rate-limit / budget-exhaustion are *outcomes* recorded here
    (§5.3), never scrape errors. ``rejected`` and ``manual_capture_required`` are
    the source-policy verdicts recorded before any fetch (§5, INV-3).
    """

    ALLOWED = "allowed"
    NO_CANDIDATES = "no_candidates"
    ROBOTS_DISALLOWED = "robots_disallowed"
    RATE_LIMITED = "rate_limited"
    BUDGET_EXHAUSTED = "budget_exhausted"
    MANUAL_CAPTURE_REQUIRED = "manual_capture_required"
    REJECTED = "rejected"
    EXTRACTION_FAILED = "extraction_failed"


@dataclass(frozen=True)
class ResearchSourceAttempt:
    """Provenance of the search itself: which allowed source was tried + outcome.

    Carries only safe references (source kind, safe ref, outcome, timestamp) —
    never a fetched page body.
    """

    source_kind: str
    source_ref: str
    outcome: str
    attempted_at: str
    detail: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.source_ref, str) or not self.source_ref.strip():
            raise ValueError("ResearchSourceAttempt.source_ref must be a non-empty safe reference")
        if self.outcome not in {member.value for member in ResearchSourceOutcome}:
            raise ValueError(
                f"ResearchSourceAttempt.outcome must be a ResearchSourceOutcome, got {self.outcome!r}"
            )


@dataclass(frozen=True)
class ContactCandidate:
    """An unconfirmed proposed contact produced by a research task.

    Not a stored contact fact until the user confirms it (INV-4). Each attribute
    carries provenance (INV-2); the candidate also records the source attempt
    that produced it (``provenance``).
    """

    candidate_id: str
    task_id: str
    role: ContactRole
    attributes: tuple[ContactAttribute, ...]
    provenance: ContactFactProvenance
    confidence: float = 0.0
    status: CandidateStatus = CandidateStatus.NEEDS_REVIEW
    proposed_at: str = ""
    confirmed_contact_id: str | None = None
    confirmed_at: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.candidate_id, str) or not self.candidate_id.strip():
            raise ValueError("ContactCandidate.candidate_id must be a non-empty string")
        if not isinstance(self.role, ContactRole):
            raise ValueError("ContactCandidate.role must be a ContactRole")
        if not isinstance(self.provenance, ContactFactProvenance):
            raise ValueError(
                "ContactCandidate.provenance is required and must be a ContactFactProvenance "
                "(INV-2: the search that proposed this candidate carries provenance)"
            )
        for attribute in self.attributes:
            if not isinstance(attribute, ContactAttribute):
                raise ValueError(
                    "ContactCandidate.attributes must contain ContactAttribute values "
                    "(each carrying provenance — INV-2)"
                )

    def confirm(self, *, contact_id: ContactId, confirmed_at: str) -> "ContactCandidate":
        """Promote this candidate to a stored contact fact (the user's command).

        The only transition to ``confirmed`` (INV-4). Records which contact the
        candidate became so the audit trail links proposal to stored fact.
        """
        if self.status is CandidateStatus.CONFIRMED:
            raise ValueError(f"ContactCandidate {self.candidate_id!r} is already confirmed")
        return replace(
            self,
            status=CandidateStatus.CONFIRMED,
            confirmed_contact_id=str(contact_id),
            confirmed_at=confirmed_at,
        )

    @property
    def is_needs_review(self) -> bool:
        return self.status is CandidateStatus.NEEDS_REVIEW


@dataclass(frozen=True)
class ContactResearchTask:
    """Aggregate root for one supervised research run."""

    tenant_id: TenantId
    task_id: str
    link: ContactLink
    status: ResearchTaskStatus = ResearchTaskStatus.QUEUED
    candidates: tuple[ContactCandidate, ...] = field(default_factory=tuple)
    source_attempts: tuple[ResearchSourceAttempt, ...] = field(default_factory=tuple)
    started_at: str | None = None
    updated_at: str = ""
    needs_review_at: str | None = None
    completed_at: str | None = None
    failed_at: str | None = None
    error_class: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.task_id, str) or not self.task_id.strip():
            raise ValueError("ContactResearchTask.task_id must be a non-empty string")
        if not isinstance(self.link, ContactLink):
            raise ValueError("ContactResearchTask.link must be a ContactLink")
        if not isinstance(self.status, ResearchTaskStatus):
            raise ValueError("ContactResearchTask.status must be a ResearchTaskStatus")

    @classmethod
    def create(
        cls,
        *,
        tenant_id: TenantId,
        task_id: str,
        link: ContactLink,
        created_at: str,
    ) -> "ContactResearchTask":
        return cls(
            tenant_id=tenant_id,
            task_id=task_id,
            link=link,
            status=ResearchTaskStatus.QUEUED,
            updated_at=created_at,
        )

    def start(self, *, started_at: str) -> "ContactResearchTask":
        return replace(
            self,
            status=ResearchTaskStatus.RUNNING,
            started_at=started_at,
            updated_at=started_at,
        )

    def propose(
        self,
        *,
        candidates: tuple[ContactCandidate, ...],
        source_attempts: tuple[ResearchSourceAttempt, ...],
        needs_review_at: str,
    ) -> "ContactResearchTask":
        """Record proposed candidates + source attempts and enter needs_review.

        Every proposed candidate MUST land in ``needs_review`` (INV-4) — a
        candidate proposed in any other state is rejected here.
        """
        for candidate in candidates:
            if candidate.status is not CandidateStatus.NEEDS_REVIEW:
                raise ValueError(
                    "Proposed candidates must land in needs_review (INV-4); "
                    f"candidate {candidate.candidate_id!r} was {candidate.status.value!r}"
                )
        return replace(
            self,
            status=ResearchTaskStatus.NEEDS_REVIEW,
            candidates=tuple(candidates),
            source_attempts=tuple(source_attempts),
            needs_review_at=needs_review_at,
            updated_at=needs_review_at,
        )

    def confirm_candidate(
        self,
        *,
        candidate_id: str,
        contact_id: ContactId,
        confirmed_at: str,
    ) -> "ContactResearchTask":
        """Promote one needs_review candidate to a stored contact fact (INV-4).

        Raises when the candidate is unknown or is not in ``needs_review``. The
        task auto-completes once no ``needs_review`` candidate remains.
        """
        found = False
        next_candidates: list[ContactCandidate] = []
        for candidate in self.candidates:
            if candidate.candidate_id == candidate_id:
                if not candidate.is_needs_review:
                    raise ValueError(
                        f"Candidate {candidate_id!r} is not awaiting review "
                        f"(status={candidate.status.value!r})"
                    )
                next_candidates.append(
                    candidate.confirm(contact_id=contact_id, confirmed_at=confirmed_at)
                )
                found = True
            else:
                next_candidates.append(candidate)
        if not found:
            raise ValueError(f"Candidate {candidate_id!r} not found on task {self.task_id!r}")
        remaining = any(candidate.is_needs_review for candidate in next_candidates)
        status = self.status if remaining else ResearchTaskStatus.COMPLETED
        completed_at = self.completed_at if remaining else confirmed_at
        return replace(
            self,
            candidates=tuple(next_candidates),
            status=status,
            completed_at=completed_at,
            updated_at=confirmed_at,
        )

    def fail(self, *, error_class: str, failed_at: str) -> "ContactResearchTask":
        return replace(
            self,
            status=ResearchTaskStatus.FAILED,
            error_class=error_class,
            failed_at=failed_at,
            updated_at=failed_at,
        )

    @property
    def confirmed_count(self) -> int:
        return sum(1 for candidate in self.candidates if candidate.status is CandidateStatus.CONFIRMED)

    @property
    def needs_review_count(self) -> int:
        return sum(1 for candidate in self.candidates if candidate.is_needs_review)

    def candidate(self, candidate_id: str) -> ContactCandidate | None:
        for candidate in self.candidates:
            if candidate.candidate_id == candidate_id:
                return candidate
        return None


__all__ = [
    "CandidateStatus",
    "ContactCandidate",
    "ContactResearchTask",
    "ResearchSourceAttempt",
    "ResearchSourceOutcome",
    "ResearchTaskStatus",
]
