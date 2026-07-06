"""``OutreachThread`` aggregate (Contact & Outreach, ninth context) — R6 Phase 3.

The outreach state for one ``(Contact, optional application)``: its
generation-versioned, reviewable, editable :class:`OutreachDraft`s. Distinct
from the durable :class:`~jobhunter.domain.contact.aggregate.Contact` and the
supervised :class:`~jobhunter.domain.contact.research.ContactResearchTask`
roots (outreach planner plan §4.3).

Invariants enforced here:

  * **INV-1 (no auto-send).** The aggregate CANNOT represent a "sent" state.
    There is no ``sent`` field, no send log, and no transition to a sent status
    anywhere in this module — Phase 3 terminates one step before any send. Send
    logging is a later phase and is a *separate* user-attested record; it never
    lands as a draft/thread status here.
  * **INV-5 (truthful, reviewable, generation-versioned).** An
    :class:`OutreachDraft` can only be ``approved`` when its persisted
    :class:`DraftGateResults` passed. Re-drafting mints a NEW generation and
    supersedes prior *candidate* drafts, but the last ``approved`` draft stays
    readable until a replacement is approved — mirroring
    ``MaterialsSetFactory.next_generation`` while honouring the "never destroy
    the last accepted artifact" rule.
  * **INV-2 (provenance).** Every draft carries claim -> fact provenance
    (:class:`~jobhunter.domain.contact.outreach_gates.OutreachClaimProvenance`)
    computed against the ACTUAL draft text.

Lifecycle reuses the materials ``ArtifactStatus`` semantics
(``candidate | approved | rejected | superseded``); ``suppressed`` is a
materials-only policy state and is never used for a draft.

Sensitivity: the draft body is the user's own outreach content and lives on
:class:`OutreachDraft.body_text` / ``outreach_drafts.body_text`` for review. It
is never copied into a domain-event payload, projection, log, or telemetry span
(plan §6, §10.1; CLAUDE.md sensitive-data rule) — events carry only ids, kinds,
generation, and timestamps.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum

from jobhunter.domain.contact.outreach_gates import (
    DraftGateResults,
    OutreachClaimProvenance,
)
from jobhunter.domain.materials.value_objects import ArtifactStatus
from jobhunter.domain.tenant import TenantId


class OutreachDraftKind(str, Enum):
    """The kind of outreach message a draft is.

    Phase 3 generates intro requests; ``follow_up`` is a valid kind the drafting
    path may target, but follow-up *scheduling* is a later phase. Inheriting from
    ``str`` keeps the enum JSON-serialisable for the canonical write side.
    """

    INTRO_REQUEST = "intro_request"
    FOLLOW_UP = "follow_up"


# The draft lifecycle states an ``OutreachDraft`` may hold. A closed subset of
# ``ArtifactStatus`` — ``suppressed`` is a materials-only policy state and never
# applies to a draft.
_DRAFT_STATUSES: frozenset[ArtifactStatus] = frozenset(
    {
        ArtifactStatus.CANDIDATE,
        ArtifactStatus.APPROVED,
        ArtifactStatus.REJECTED,
        ArtifactStatus.SUPERSEDED,
    }
)


@dataclass(frozen=True)
class OutreachDraft:
    """One generation-versioned, reviewable outreach draft.

    The ``body_text`` is the reviewable message. ``gate_results`` is the
    persisted outcome of the truthfulness gate stack (INV-5) and is the ONLY
    authority approval is gated on. ``provenance`` binds each claim in the draft
    to the confirmed fact it rests on (INV-2), computed against ``body_text``.
    """

    draft_id: str
    thread_id: str
    generation: int
    kind: OutreachDraftKind
    status: ArtifactStatus
    body_text: str
    gate_results: DraftGateResults
    provenance: tuple[OutreachClaimProvenance, ...] = field(default_factory=tuple)
    created_at: str = ""
    approved_at: str | None = None
    rejected_at: str | None = None
    reason: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.draft_id, str) or not self.draft_id.strip():
            raise ValueError("OutreachDraft.draft_id must be a non-empty string")
        if not isinstance(self.thread_id, str) or not self.thread_id.strip():
            raise ValueError("OutreachDraft.thread_id must be a non-empty string")
        if not isinstance(self.generation, int) or self.generation < 1:
            raise ValueError(
                f"OutreachDraft.generation must be an int >= 1, got {self.generation!r}"
            )
        if not isinstance(self.kind, OutreachDraftKind):
            raise ValueError("OutreachDraft.kind must be an OutreachDraftKind")
        if self.status not in _DRAFT_STATUSES:
            raise ValueError(
                "OutreachDraft.status must be one of "
                f"{sorted(s.value for s in _DRAFT_STATUSES)!r} (never 'suppressed'), "
                f"got {self.status!r}"
            )
        if not isinstance(self.gate_results, DraftGateResults):
            raise ValueError("OutreachDraft.gate_results must be a DraftGateResults")
        for claim in self.provenance:
            if not isinstance(claim, OutreachClaimProvenance):
                raise ValueError(
                    "OutreachDraft.provenance entries must be OutreachClaimProvenance (INV-2)"
                )
        # INV-5 floor: an approved draft MUST have passed the gates. Constructing
        # an approved draft over failed gates is impossible, so a persisted or
        # rehydrated draft can never lie about being approved-but-ungrounded.
        if self.status is ArtifactStatus.APPROVED and not self.gate_results.passed:
            raise ValueError(
                "OutreachDraft cannot be 'approved' unless its gate results passed "
                "(INV-5: drafts are truthful and reviewable)"
            )

    # ------------------------------------------------------------------
    # Transitions (each returns a new instance)
    # ------------------------------------------------------------------

    def approve(self, *, approved_at: str) -> "OutreachDraft":
        """Approve a candidate draft. Gated on the persisted gate outcome (INV-5).

        Raises when the draft is not a candidate or its gates did not pass — the
        approval authority is the stored :class:`DraftGateResults`, never the
        caller's assertion.
        """
        if self.status is not ArtifactStatus.CANDIDATE:
            raise ValueError(
                f"Only a candidate draft can be approved (draft {self.draft_id!r} "
                f"is {self.status.value!r})"
            )
        if not self.gate_results.passed:
            raise ValueError(
                f"Draft {self.draft_id!r} cannot be approved: its truthfulness gates "
                "did not pass (INV-5)"
            )
        return replace(self, status=ArtifactStatus.APPROVED, approved_at=approved_at)

    def reject(self, *, rejected_at: str, reason: str = "") -> "OutreachDraft":
        """Reject a candidate draft. Never touches an already-approved draft."""
        if self.status is not ArtifactStatus.CANDIDATE:
            raise ValueError(
                f"Only a candidate draft can be rejected (draft {self.draft_id!r} "
                f"is {self.status.value!r})"
            )
        return replace(
            self, status=ArtifactStatus.REJECTED, rejected_at=rejected_at, reason=reason
        )

    def supersede(self) -> "OutreachDraft":
        """Mark this draft superseded by a newer generation (candidate/approved only)."""
        if self.status in {ArtifactStatus.REJECTED, ArtifactStatus.SUPERSEDED}:
            return self
        return replace(self, status=ArtifactStatus.SUPERSEDED)

    @property
    def is_candidate(self) -> bool:
        return self.status is ArtifactStatus.CANDIDATE

    @property
    def is_approved(self) -> bool:
        return self.status is ArtifactStatus.APPROVED


@dataclass(frozen=True)
class OutreachThread:
    """Aggregate root for the outreach state of one ``(contact, optional job)``.

    Encloses the generation-versioned drafts. There is deliberately NO field
    that can represent a "sent" state (INV-1).
    """

    tenant_id: TenantId
    thread_id: str
    contact_id: str
    job_id: str | None = None
    drafts: tuple[OutreachDraft, ...] = field(default_factory=tuple)
    created_at: str = ""
    updated_at: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.thread_id, str) or not self.thread_id.strip():
            raise ValueError("OutreachThread.thread_id must be a non-empty string")
        if not isinstance(self.contact_id, str) or not self.contact_id.strip():
            raise ValueError("OutreachThread.contact_id must be a non-empty string")
        for draft in self.drafts:
            if not isinstance(draft, OutreachDraft):
                raise ValueError("OutreachThread.drafts entries must be OutreachDraft")

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    @classmethod
    def create(
        cls,
        *,
        tenant_id: TenantId,
        thread_id: str,
        contact_id: str,
        job_id: str | None = None,
        created_at: str,
    ) -> "OutreachThread":
        return cls(
            tenant_id=tenant_id,
            thread_id=thread_id,
            contact_id=contact_id,
            job_id=job_id,
            drafts=(),
            created_at=created_at,
            updated_at=created_at,
        )

    # ------------------------------------------------------------------
    # Draft lifecycle
    # ------------------------------------------------------------------

    def next_generation(self) -> int:
        return (max((draft.generation for draft in self.drafts), default=0)) + 1

    def add_draft(self, draft: OutreachDraft, *, at: str) -> "OutreachThread":
        """Append a fresh draft generation, superseding prior *candidate* drafts.

        INV-5: re-drafting supersedes stale unreviewed candidates but never the
        last ``approved`` draft — the approved draft stays readable until a
        replacement is itself approved (see :meth:`approve_draft`). A rejected
        draft is left as audit history.
        """
        if draft.thread_id != self.thread_id:
            raise ValueError("Draft belongs to a different thread")
        superseded = tuple(
            existing.supersede() if existing.is_candidate else existing
            for existing in self.drafts
        )
        return replace(self, drafts=(*superseded, draft), updated_at=at)

    def approve_draft(self, draft_id: str, *, approved_at: str) -> "OutreachThread":
        """Approve a candidate draft; supersede the previously-approved draft.

        The old approved draft becomes ``superseded`` ONLY here — at the moment a
        replacement is approved (INV-5). Raises when the target is unknown, not a
        candidate, or its gates did not pass (via :meth:`OutreachDraft.approve`).
        """
        target = self.draft(draft_id)
        if target is None:
            raise ValueError(f"Draft {draft_id!r} not found on thread {self.thread_id!r}")
        approved = target.approve(approved_at=approved_at)
        next_drafts = tuple(
            approved
            if existing.draft_id == draft_id
            else (existing.supersede() if existing.is_approved else existing)
            for existing in self.drafts
        )
        return replace(self, drafts=next_drafts, updated_at=approved_at)

    def reject_draft(
        self, draft_id: str, *, rejected_at: str, reason: str = ""
    ) -> "OutreachThread":
        """Reject a candidate draft. The last approved draft is untouched (INV-5)."""
        target = self.draft(draft_id)
        if target is None:
            raise ValueError(f"Draft {draft_id!r} not found on thread {self.thread_id!r}")
        rejected = target.reject(rejected_at=rejected_at, reason=reason)
        next_drafts = tuple(
            rejected if existing.draft_id == draft_id else existing
            for existing in self.drafts
        )
        return replace(self, drafts=next_drafts, updated_at=rejected_at)

    # ------------------------------------------------------------------
    # Predicates / derived
    # ------------------------------------------------------------------

    def draft(self, draft_id: str) -> OutreachDraft | None:
        for draft in self.drafts:
            if draft.draft_id == draft_id:
                return draft
        return None

    @property
    def approved_draft(self) -> OutreachDraft | None:
        """The current approved draft (there is at most one), or ``None``."""
        for draft in self.drafts:
            if draft.is_approved:
                return draft
        return None

    @property
    def latest_draft(self) -> OutreachDraft | None:
        if not self.drafts:
            return None
        return max(self.drafts, key=lambda draft: draft.generation)


__all__ = [
    "OutreachDraft",
    "OutreachDraftKind",
    "OutreachThread",
]
