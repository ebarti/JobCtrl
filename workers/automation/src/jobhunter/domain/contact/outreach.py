"""``OutreachThread`` aggregate (Contact & Outreach, ninth context) — R6 Phase 3/4.

The outreach state for one ``(Contact, optional application)``: its
generation-versioned, reviewable, editable :class:`OutreachDraft`s, the
user-attested :class:`OutreachSendLog`s, and the :class:`FollowUpSchedule`.
Distinct from the durable
:class:`~jobhunter.domain.contact.aggregate.Contact` and the supervised
:class:`~jobhunter.domain.contact.research.ContactResearchTask` roots (outreach
planner plan §4.3).

Invariants enforced here:

  * **INV-1 (no auto-send).** The system NEVER sends. There is no outbound
    transport of any kind on this aggregate (no mail/DM/API seam). A thread
    reaches a "sent" state ONLY through an :class:`OutreachSendLog` — a
    *user-attested* record
    that the user sent a specific *approved* draft through their own channel.
    ``log_send`` refuses any draft that is not currently approved, and
    ``__post_init__`` refuses to rehydrate a thread whose send log attests a
    draft that was never approved. This mirrors the ``ApplyRun`` dry-run
    invariant (a terminal marker MUST coincide with the evidence that justifies
    it): here a "sent" marker (a send log) MUST coincide with an approved draft.
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

The follow-up schedule is **surfaced-only**: a suggested next follow-up date is
derived from the application lifecycle (see :func:`suggest_follow_up`), stored
when the user schedules it, and surfaced as a due follow-up. It is never
auto-acted and never sends (INV-1).

Lifecycle reuses the materials ``ArtifactStatus`` semantics
(``candidate | approved | rejected | superseded``); ``suppressed`` is a
materials-only policy state and is never used for a draft.

Sensitivity: the draft body is the user's own outreach content and lives on
:class:`OutreachDraft.body_text` / ``outreach_drafts.body_text`` for review. It
is never copied into a domain-event payload, projection, log, or telemetry span
(plan §6, §10.1; CLAUDE.md sensitive-data rule) — events carry only ids, kinds,
generation, a channel *label*, and timestamps (never contact names/emails).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
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


OUTREACH_SEND_CHANNELS: frozenset[str] = frozenset(
    {
        "email",
        "personal_email",
        "work_email",
        "linkedin_message",
        "phone_call",
        "other",
    }
)


def normalize_outreach_send_channel(channel: str) -> str:
    """Return a supported send-channel label, rejecting contact data/addresses."""
    value = (channel or "").strip()
    if value not in OUTREACH_SEND_CHANNELS:
        raise ValueError("OutreachSendLog.channel must be one of the supported labels")
    return value


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
class OutreachSendLog:
    """A user-attested record that the USER sent an approved draft (INV-1).

    This is a RECORDED FACT, not a transport: JobHunter never sends. ``channel``
    is a controlled *label* of where the user sent the draft (e.g. "email",
    "linkedin_message") — never an address. The presence of a send log is the
    ONLY thing that makes a thread "sent". The aggregate guards that the log can
    only reference an approved draft (see :meth:`OutreachThread.log_send` and
    :meth:`OutreachThread.__post_init__`).
    """

    send_log_id: str
    thread_id: str
    draft_id: str
    channel: str
    sent_at: str
    logged_at: str

    def __post_init__(self) -> None:
        for name in ("send_log_id", "thread_id", "draft_id", "channel", "sent_at", "logged_at"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"OutreachSendLog.{name} must be a non-empty string")
        normalize_outreach_send_channel(self.channel)


class FollowUpState(str, Enum):
    """The lifecycle state of a thread's follow-up schedule.

    Inherits from ``str`` so it round-trips through the ``outreach_threads``
    ``follow_up_state`` TEXT column without a converter. ``none`` is the default:
    no follow-up scheduled. A ``scheduled`` follow-up surfaces as *due* once its
    ``due_at`` has arrived (a derived read-model signal — plan §9), and is only
    ever ``completed`` or ``dismissed`` by an explicit user action.
    """

    NONE = "none"
    SCHEDULED = "scheduled"
    COMPLETED = "completed"
    DISMISSED = "dismissed"


class FollowUpBasis:
    """Why a follow-up was suggested (round-trips through ``follow_up_basis``)."""

    APPLICATION_SUBMITTED = "application_submitted"
    NO_REPLY_NUDGE = "no_reply_nudge"
    MANUAL = "manual"


# Conservative, user-editable cadence defaults (plan §16 resolution 5): the first
# suggested follow-up is 7 calendar days after the application was submitted; a
# subsequent nudge is 14 calendar days later when the thread has no logged reply.
# Suggestions are surfaced-only — never auto-acted, never sent (INV-1).
FIRST_FOLLOW_UP_DAYS = 7
SUBSEQUENT_NUDGE_DAYS = 14


@dataclass(frozen=True)
class FollowUpSchedule:
    """The follow-up state for a thread (plan §9).

    ``due_at`` is the suggested/scheduled next follow-up date; ``basis`` records
    why it was suggested. This is a plan, not an action: nothing is ever sent on
    its behalf (INV-1).
    """

    state: FollowUpState = FollowUpState.NONE
    due_at: str | None = None
    basis: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.state, FollowUpState):
            raise ValueError("FollowUpSchedule.state must be a FollowUpState")
        if self.state is FollowUpState.SCHEDULED and not (self.due_at or "").strip():
            raise ValueError("A scheduled follow-up must carry a due_at date")

    @property
    def is_scheduled(self) -> bool:
        return self.state is FollowUpState.SCHEDULED


@dataclass(frozen=True)
class FollowUpSuggestion:
    """A derived (suggested) next follow-up date + its basis — never auto-acted."""

    due_at: str
    basis: str


def _add_calendar_days(anchor_iso: str, days: int) -> str:
    """Return ``anchor_iso`` shifted forward by ``days`` calendar days (ISO 8601).

    Accepts a trailing ``Z`` (treated as UTC). Naive inputs stay naive.
    """
    text = anchor_iso.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    anchor = datetime.fromisoformat(text)
    return (anchor + timedelta(days=days)).isoformat()


def suggest_follow_up(
    *,
    submitted_at: str,
    last_follow_up_due_at: str | None = None,
    has_logged_reply: bool = False,
) -> FollowUpSuggestion | None:
    """Derive the suggested next follow-up date from application-lifecycle facts.

    Pure derivation (plan §9, §16 resolution 5). The Contact & Outreach context
    REACTS to the application lifecycle; it never owns or triggers it. Returns
    ``None`` when no follow-up should be suggested (the thread has a logged reply,
    or there is no submission anchor). The result is a *suggestion* — surfaced,
    fully user-editable, and never auto-acted or sent (INV-1).

    * First suggestion: ``submitted_at`` + :data:`FIRST_FOLLOW_UP_DAYS` days,
      basis ``application_submitted``.
    * Subsequent nudge (a follow-up already elapsed, still no reply):
      ``last_follow_up_due_at`` + :data:`SUBSEQUENT_NUDGE_DAYS` days, basis
      ``no_reply_nudge``.
    """
    if has_logged_reply:
        return None
    if not (submitted_at or "").strip():
        return None
    if last_follow_up_due_at and last_follow_up_due_at.strip():
        return FollowUpSuggestion(
            due_at=_add_calendar_days(last_follow_up_due_at, SUBSEQUENT_NUDGE_DAYS),
            basis=FollowUpBasis.NO_REPLY_NUDGE,
        )
    return FollowUpSuggestion(
        due_at=_add_calendar_days(submitted_at, FIRST_FOLLOW_UP_DAYS),
        basis=FollowUpBasis.APPLICATION_SUBMITTED,
    )


def follow_up_is_due(schedule: FollowUpSchedule, *, now: str) -> bool:
    """Derived read-model signal: a scheduled follow-up whose ``due_at`` arrived.

    ``FollowUpDue`` is a projected computation over schedule + clock (plan §9),
    NOT an action. A follow-up that is completed or dismissed is never due.
    """
    if not schedule.is_scheduled or not schedule.due_at:
        return False
    return _parse_dt(schedule.due_at) <= _parse_dt(now)


def _parse_dt(iso: str) -> datetime:
    text = iso.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


@dataclass(frozen=True)
class OutreachThread:
    """Aggregate root for the outreach state of one ``(contact, optional job)``.

    Encloses the generation-versioned drafts, the user-attested send logs, and
    the follow-up schedule. The ONLY representation of a "sent" state is a
    :class:`OutreachSendLog` created by an explicit user action over an approved
    draft (INV-1) — there is no send transport anywhere on this aggregate.
    """

    tenant_id: TenantId
    thread_id: str
    contact_id: str
    job_id: str | None = None
    drafts: tuple[OutreachDraft, ...] = field(default_factory=tuple)
    created_at: str = ""
    updated_at: str = ""
    send_logs: tuple[OutreachSendLog, ...] = field(default_factory=tuple)
    follow_up: FollowUpSchedule = field(default_factory=FollowUpSchedule)

    def __post_init__(self) -> None:
        if not isinstance(self.thread_id, str) or not self.thread_id.strip():
            raise ValueError("OutreachThread.thread_id must be a non-empty string")
        if not isinstance(self.contact_id, str) or not self.contact_id.strip():
            raise ValueError("OutreachThread.contact_id must be a non-empty string")
        for draft in self.drafts:
            if not isinstance(draft, OutreachDraft):
                raise ValueError("OutreachThread.drafts entries must be OutreachDraft")
        if not isinstance(self.follow_up, FollowUpSchedule):
            raise ValueError("OutreachThread.follow_up must be a FollowUpSchedule")
        # INV-1 coherence guard (mirrors the ApplyRun dry-run invariant): a thread
        # can only be "sent" via a user-attested send log, and a send log may only
        # attest a draft that WAS approved. Rehydrating a thread whose send log
        # references a missing or never-approved draft is impossible.
        draft_index = {draft.draft_id: draft for draft in self.drafts}
        for log in self.send_logs:
            if not isinstance(log, OutreachSendLog):
                raise ValueError("OutreachThread.send_logs entries must be OutreachSendLog")
            if log.thread_id != self.thread_id:
                raise ValueError("OutreachSendLog belongs to a different thread")
            attested = draft_index.get(log.draft_id)
            if attested is None:
                raise ValueError(
                    f"OutreachSendLog {log.send_log_id!r} references draft "
                    f"{log.draft_id!r} that is not on this thread (INV-1)"
                )
            if attested.approved_at is None:
                raise ValueError(
                    f"OutreachSendLog {log.send_log_id!r} attests draft "
                    f"{log.draft_id!r} that was never approved — a thread cannot be "
                    "'sent' without a user-attested send log over an approved draft "
                    "(INV-1)"
                )

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
    # Send log (user-attested — the ONLY path to "sent", INV-1)
    # ------------------------------------------------------------------

    def log_send(
        self,
        *,
        send_log_id: str,
        draft_id: str,
        channel: str,
        sent_at: str,
        logged_at: str,
    ) -> "OutreachThread":
        """Record that the USER sent an approved draft through their own channel.

        This is a *recorded fact*, not a transport — JobHunter never sends
        (INV-1). Raises when the target draft is unknown or is not currently
        approved: "approve draft" and "log send" are distinct user actions, and a
        thread can only become "sent" over a draft the user actually approved.
        """
        target = self.draft(draft_id)
        if target is None:
            raise ValueError(f"Draft {draft_id!r} not found on thread {self.thread_id!r}")
        if not target.is_approved:
            raise ValueError(
                f"Only an approved draft can be send-logged (draft {draft_id!r} is "
                f"{target.status.value!r}); approving and logging a send are distinct "
                "user actions (INV-1)"
            )
        log = OutreachSendLog(
            send_log_id=send_log_id,
            thread_id=self.thread_id,
            draft_id=draft_id,
            channel=channel,
            sent_at=sent_at,
            logged_at=logged_at,
        )
        return replace(self, send_logs=(*self.send_logs, log), updated_at=logged_at)

    # ------------------------------------------------------------------
    # Follow-up schedule (surfaced-only; never auto-acted, never sent)
    # ------------------------------------------------------------------

    def schedule_follow_up(
        self, *, due_at: str, basis: str, at: str
    ) -> "OutreachThread":
        """Set (or reset) the suggested next follow-up date for this thread.

        The date is a suggestion the user can edit; it is surfaced as a due
        follow-up once it arrives and is never auto-acted or sent (INV-1).
        """
        if not (due_at or "").strip():
            raise ValueError("schedule_follow_up requires a non-empty due_at")
        schedule = FollowUpSchedule(
            state=FollowUpState.SCHEDULED, due_at=due_at, basis=basis or FollowUpBasis.MANUAL
        )
        return replace(self, follow_up=schedule, updated_at=at)

    def complete_follow_up(self, *, at: str) -> "OutreachThread":
        """Mark the scheduled follow-up completed (an explicit user action)."""
        if not self.follow_up.is_scheduled:
            raise ValueError("No scheduled follow-up to complete")
        schedule = replace(self.follow_up, state=FollowUpState.COMPLETED)
        return replace(self, follow_up=schedule, updated_at=at)

    def dismiss_follow_up(self, *, at: str) -> "OutreachThread":
        """Dismiss the scheduled follow-up (an explicit user action)."""
        if not self.follow_up.is_scheduled:
            raise ValueError("No scheduled follow-up to dismiss")
        schedule = replace(self.follow_up, state=FollowUpState.DISMISSED)
        return replace(self, follow_up=schedule, updated_at=at)

    # ------------------------------------------------------------------
    # Predicates / derived
    # ------------------------------------------------------------------

    @property
    def is_sent(self) -> bool:
        """A thread is "sent" iff it carries at least one user-attested send log."""
        return bool(self.send_logs)

    def send_log(self, send_log_id: str) -> OutreachSendLog | None:
        for log in self.send_logs:
            if log.send_log_id == send_log_id:
                return log
        return None

    @property
    def last_send_log(self) -> OutreachSendLog | None:
        return self.send_logs[-1] if self.send_logs else None

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
    "FIRST_FOLLOW_UP_DAYS",
    "SUBSEQUENT_NUDGE_DAYS",
    "FollowUpBasis",
    "FollowUpSchedule",
    "FollowUpState",
    "FollowUpSuggestion",
    "OUTREACH_SEND_CHANNELS",
    "OutreachDraft",
    "OutreachDraftKind",
    "OutreachSendLog",
    "OutreachThread",
    "follow_up_is_due",
    "normalize_outreach_send_channel",
    "suggest_follow_up",
]
