"""Contact & Outreach domain events (the ninth bounded context).

Payloads carry ONLY safe references and extracted metadata — identifiers,
kinds, provenance summaries, confidence, and timestamps. Contact data is
sensitive: no names, emails, or fetched page bodies ever appear in an event
payload (mirrors the apply-feedback rule; see the outreach planner plan §6,
§10.1 and CLAUDE.md "Constraints And Do-Not Rules").

TypeScript mirror: ``packages/domain-types/src/events/contact.ts``.
Registry parity is guarded by ``tests/test_domain_event_parity.py``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from jobctrl.domain.events.base import DomainEvent, create_domain_event
from jobctrl.domain.tenant import TenantId

# -- Contact aggregate ------------------------------------------------------


@dataclass(frozen=True)
class ContactCreatedPayload:
    contact_id: str
    employer: str | None
    job_id: str | None
    role: str
    created_at: str


def create_contact_created(tenant_id: TenantId, payload: ContactCreatedPayload) -> DomainEvent:
    return create_domain_event("ContactCreated", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ContactUpdatedPayload:
    contact_id: str
    changed_fields: tuple[str, ...]
    updated_at: str


def create_contact_updated(tenant_id: TenantId, payload: ContactUpdatedPayload) -> DomainEvent:
    return create_domain_event("ContactUpdated", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ContactAttributeRecordedPayload:
    contact_id: str
    attribute_id: str
    attribute_kind: str
    source_kind: str
    source_ref: str
    capture_method: str
    confidence: float
    user_confirmed: bool
    recorded_at: str


def create_contact_attribute_recorded(
    tenant_id: TenantId, payload: ContactAttributeRecordedPayload
) -> DomainEvent:
    return create_domain_event("ContactAttributeRecorded", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ContactDeletedPayload:
    contact_id: str
    reason: str
    deleted_at: str


def create_contact_deleted(tenant_id: TenantId, payload: ContactDeletedPayload) -> DomainEvent:
    return create_domain_event("ContactDeleted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class WarmIntroIdentifiedPayload:
    contact_id: str
    relationship_id: str
    match_basis: str
    confidence: float
    identified_at: str


def create_warm_intro_identified(
    tenant_id: TenantId, payload: WarmIntroIdentifiedPayload
) -> DomainEvent:
    return create_domain_event("WarmIntroIdentified", tenant_id, asdict(payload))


# -- ContactResearchTask aggregate ------------------------------------------


@dataclass(frozen=True)
class ContactResearchTaskStartedPayload:
    task_id: str
    employer: str | None
    job_id: str | None
    started_at: str


def create_contact_research_task_started(
    tenant_id: TenantId, payload: ContactResearchTaskStartedPayload
) -> DomainEvent:
    return create_domain_event("ContactResearchTaskStarted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ContactCandidateProposedPayload:
    task_id: str
    candidate_id: str
    role: str
    source_kind: str
    source_ref: str
    capture_method: str
    confidence: float
    proposed_at: str


def create_contact_candidate_proposed(
    tenant_id: TenantId, payload: ContactCandidateProposedPayload
) -> DomainEvent:
    return create_domain_event("ContactCandidateProposed", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ContactResearchTaskNeedsReviewPayload:
    task_id: str
    candidate_count: int
    needs_review_at: str


def create_contact_research_task_needs_review(
    tenant_id: TenantId, payload: ContactResearchTaskNeedsReviewPayload
) -> DomainEvent:
    return create_domain_event("ContactResearchTaskNeedsReview", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ContactResearchTaskCompletedPayload:
    task_id: str
    confirmed_count: int
    completed_at: str


def create_contact_research_task_completed(
    tenant_id: TenantId, payload: ContactResearchTaskCompletedPayload
) -> DomainEvent:
    return create_domain_event("ContactResearchTaskCompleted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ContactResearchTaskFailedPayload:
    task_id: str
    error_class: str
    retryable: bool
    failed_at: str


def create_contact_research_task_failed(
    tenant_id: TenantId, payload: ContactResearchTaskFailedPayload
) -> DomainEvent:
    return create_domain_event("ContactResearchTaskFailed", tenant_id, asdict(payload))


# -- OutreachThread aggregate -----------------------------------------------


@dataclass(frozen=True)
class OutreachDraftGeneratedPayload:
    thread_id: str
    contact_id: str
    job_id: str | None
    draft_id: str
    generation: int
    kind: str
    generated_at: str


def create_outreach_draft_generated(
    tenant_id: TenantId, payload: OutreachDraftGeneratedPayload
) -> DomainEvent:
    return create_domain_event("OutreachDraftGenerated", tenant_id, asdict(payload))


@dataclass(frozen=True)
class OutreachDraftRevisedPayload:
    thread_id: str
    draft_id: str
    generation: int
    revised_at: str


def create_outreach_draft_revised(
    tenant_id: TenantId, payload: OutreachDraftRevisedPayload
) -> DomainEvent:
    return create_domain_event("OutreachDraftRevised", tenant_id, asdict(payload))


@dataclass(frozen=True)
class OutreachDraftApprovedPayload:
    thread_id: str
    draft_id: str
    generation: int
    approved_at: str


def create_outreach_draft_approved(
    tenant_id: TenantId, payload: OutreachDraftApprovedPayload
) -> DomainEvent:
    return create_domain_event("OutreachDraftApproved", tenant_id, asdict(payload))


@dataclass(frozen=True)
class OutreachDraftRejectedPayload:
    thread_id: str
    draft_id: str
    generation: int
    reason: str
    rejected_at: str


def create_outreach_draft_rejected(
    tenant_id: TenantId, payload: OutreachDraftRejectedPayload
) -> DomainEvent:
    return create_domain_event("OutreachDraftRejected", tenant_id, asdict(payload))


@dataclass(frozen=True)
class OutreachSendLoggedPayload:
    """User-attested send record — the ONLY path to a "sent" state (INV-1).

    The system never sends; there is no transport. ``channel`` is a free-text
    label of where the *user* sent the approved draft.
    """

    thread_id: str
    draft_id: str
    channel: str
    sent_at: str
    logged_at: str


def create_outreach_send_logged(
    tenant_id: TenantId, payload: OutreachSendLoggedPayload
) -> DomainEvent:
    return create_domain_event("OutreachSendLogged", tenant_id, asdict(payload))


@dataclass(frozen=True)
class FollowUpScheduledPayload:
    thread_id: str
    job_id: str | None
    due_at: str
    basis: str
    scheduled_at: str


def create_follow_up_scheduled(
    tenant_id: TenantId, payload: FollowUpScheduledPayload
) -> DomainEvent:
    return create_domain_event("FollowUpScheduled", tenant_id, asdict(payload))


@dataclass(frozen=True)
class FollowUpCompletedPayload:
    thread_id: str
    completed_at: str


def create_follow_up_completed(
    tenant_id: TenantId, payload: FollowUpCompletedPayload
) -> DomainEvent:
    return create_domain_event("FollowUpCompleted", tenant_id, asdict(payload))


@dataclass(frozen=True)
class FollowUpDismissedPayload:
    thread_id: str
    reason: str
    dismissed_at: str


def create_follow_up_dismissed(
    tenant_id: TenantId, payload: FollowUpDismissedPayload
) -> DomainEvent:
    return create_domain_event("FollowUpDismissed", tenant_id, asdict(payload))


__all__ = [
    "ContactAttributeRecordedPayload",
    "ContactCandidateProposedPayload",
    "ContactCreatedPayload",
    "ContactDeletedPayload",
    "ContactResearchTaskCompletedPayload",
    "ContactResearchTaskFailedPayload",
    "ContactResearchTaskNeedsReviewPayload",
    "ContactResearchTaskStartedPayload",
    "ContactUpdatedPayload",
    "FollowUpCompletedPayload",
    "FollowUpDismissedPayload",
    "FollowUpScheduledPayload",
    "OutreachDraftApprovedPayload",
    "OutreachDraftGeneratedPayload",
    "OutreachDraftRejectedPayload",
    "OutreachDraftRevisedPayload",
    "OutreachSendLoggedPayload",
    "WarmIntroIdentifiedPayload",
    "create_contact_attribute_recorded",
    "create_contact_candidate_proposed",
    "create_contact_created",
    "create_contact_deleted",
    "create_contact_research_task_completed",
    "create_contact_research_task_failed",
    "create_contact_research_task_needs_review",
    "create_contact_research_task_started",
    "create_contact_updated",
    "create_follow_up_completed",
    "create_follow_up_dismissed",
    "create_follow_up_scheduled",
    "create_outreach_draft_approved",
    "create_outreach_draft_generated",
    "create_outreach_draft_rejected",
    "create_outreach_draft_revised",
    "create_outreach_send_logged",
    "create_warm_intro_identified",
]
