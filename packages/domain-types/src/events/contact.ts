/**
 * Contact & Outreach domain events (the ninth bounded context).
 *
 * Payloads carry ONLY safe references and extracted metadata — identifiers,
 * kinds, provenance summaries, confidence, and timestamps. Contact data is
 * sensitive: no names, emails, or fetched page bodies ever appear in an event
 * payload (mirrors the apply-feedback rule; see the outreach planner plan §6,
 * §10.1 and CLAUDE.md "Constraints And Do-Not Rules").
 *
 * @see docs/plans/2026-07-05-outreach-planner-plan.md §4 (domain model), §4.6 (registry parity)
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

/** Provenance categories for a stored/proposed contact fact (INV-2). */
export const CONTACT_SOURCE_KINDS = [
  "user_entered",
  "public_web_page",
  "user_imported_list",
  "derived",
] as const;
export type ContactSourceKind = (typeof CONTACT_SOURCE_KINDS)[number];

/** Contact roles relevant to a company/application. */
export const CONTACT_ROLES = [
  "recruiter",
  "hiring_manager",
  "referrer",
  "warm_intro",
  "other",
] as const;
export type ContactRoleValue = (typeof CONTACT_ROLES)[number];

/** Outreach draft kinds. */
export const OUTREACH_DRAFT_KINDS = ["intro_request", "follow_up"] as const;
export type OutreachDraftKind = (typeof OUTREACH_DRAFT_KINDS)[number];

// -- Contact aggregate ------------------------------------------------------

export interface ContactCreatedPayload {
  readonly contactId: string;
  readonly employer: string | null;
  readonly jobId: string | null;
  readonly role: ContactRoleValue;
  readonly createdAt: string;
}
export type ContactCreated = DomainEvent<"ContactCreated", ContactCreatedPayload>;
export function createContactCreated(
  tenantId: TenantId,
  payload: ContactCreatedPayload,
): ContactCreated {
  return createDomainEvent("ContactCreated", tenantId, payload);
}

export interface ContactUpdatedPayload {
  readonly contactId: string;
  readonly changedFields: readonly string[];
  readonly updatedAt: string;
}
export type ContactUpdated = DomainEvent<"ContactUpdated", ContactUpdatedPayload>;
export function createContactUpdated(
  tenantId: TenantId,
  payload: ContactUpdatedPayload,
): ContactUpdated {
  return createDomainEvent("ContactUpdated", tenantId, payload);
}

export interface ContactAttributeRecordedPayload {
  readonly contactId: string;
  readonly attributeId: string;
  readonly attributeKind: string;
  readonly sourceKind: ContactSourceKind;
  readonly sourceRef: string;
  readonly captureMethod: string;
  readonly confidence: number;
  readonly userConfirmed: boolean;
  readonly recordedAt: string;
}
export type ContactAttributeRecorded = DomainEvent<
  "ContactAttributeRecorded",
  ContactAttributeRecordedPayload
>;
export function createContactAttributeRecorded(
  tenantId: TenantId,
  payload: ContactAttributeRecordedPayload,
): ContactAttributeRecorded {
  return createDomainEvent("ContactAttributeRecorded", tenantId, payload);
}

export interface ContactDeletedPayload {
  readonly contactId: string;
  readonly reason: string;
  readonly deletedAt: string;
}
export type ContactDeleted = DomainEvent<"ContactDeleted", ContactDeletedPayload>;
export function createContactDeleted(
  tenantId: TenantId,
  payload: ContactDeletedPayload,
): ContactDeleted {
  return createDomainEvent("ContactDeleted", tenantId, payload);
}

export interface WarmIntroIdentifiedPayload {
  readonly contactId: string;
  readonly relationshipId: string;
  readonly matchBasis: string;
  readonly confidence: number;
  readonly identifiedAt: string;
}
export type WarmIntroIdentified = DomainEvent<
  "WarmIntroIdentified",
  WarmIntroIdentifiedPayload
>;
export function createWarmIntroIdentified(
  tenantId: TenantId,
  payload: WarmIntroIdentifiedPayload,
): WarmIntroIdentified {
  return createDomainEvent("WarmIntroIdentified", tenantId, payload);
}

// -- ContactResearchTask aggregate ------------------------------------------

export interface ContactResearchTaskStartedPayload {
  readonly taskId: string;
  readonly employer: string | null;
  readonly jobId: string | null;
  readonly startedAt: string;
}
export type ContactResearchTaskStarted = DomainEvent<
  "ContactResearchTaskStarted",
  ContactResearchTaskStartedPayload
>;
export function createContactResearchTaskStarted(
  tenantId: TenantId,
  payload: ContactResearchTaskStartedPayload,
): ContactResearchTaskStarted {
  return createDomainEvent("ContactResearchTaskStarted", tenantId, payload);
}

export interface ContactCandidateProposedPayload {
  readonly taskId: string;
  readonly candidateId: string;
  readonly role: ContactRoleValue;
  readonly sourceKind: ContactSourceKind;
  readonly sourceRef: string;
  readonly captureMethod: string;
  readonly confidence: number;
  readonly proposedAt: string;
}
export type ContactCandidateProposed = DomainEvent<
  "ContactCandidateProposed",
  ContactCandidateProposedPayload
>;
export function createContactCandidateProposed(
  tenantId: TenantId,
  payload: ContactCandidateProposedPayload,
): ContactCandidateProposed {
  return createDomainEvent("ContactCandidateProposed", tenantId, payload);
}

export interface ContactResearchTaskNeedsReviewPayload {
  readonly taskId: string;
  readonly candidateCount: number;
  readonly needsReviewAt: string;
}
export type ContactResearchTaskNeedsReview = DomainEvent<
  "ContactResearchTaskNeedsReview",
  ContactResearchTaskNeedsReviewPayload
>;
export function createContactResearchTaskNeedsReview(
  tenantId: TenantId,
  payload: ContactResearchTaskNeedsReviewPayload,
): ContactResearchTaskNeedsReview {
  return createDomainEvent("ContactResearchTaskNeedsReview", tenantId, payload);
}

export interface ContactResearchTaskCompletedPayload {
  readonly taskId: string;
  readonly confirmedCount: number;
  readonly completedAt: string;
}
export type ContactResearchTaskCompleted = DomainEvent<
  "ContactResearchTaskCompleted",
  ContactResearchTaskCompletedPayload
>;
export function createContactResearchTaskCompleted(
  tenantId: TenantId,
  payload: ContactResearchTaskCompletedPayload,
): ContactResearchTaskCompleted {
  return createDomainEvent("ContactResearchTaskCompleted", tenantId, payload);
}

export interface ContactResearchTaskFailedPayload {
  readonly taskId: string;
  readonly errorClass: string;
  readonly retryable: boolean;
  readonly failedAt: string;
}
export type ContactResearchTaskFailed = DomainEvent<
  "ContactResearchTaskFailed",
  ContactResearchTaskFailedPayload
>;
export function createContactResearchTaskFailed(
  tenantId: TenantId,
  payload: ContactResearchTaskFailedPayload,
): ContactResearchTaskFailed {
  return createDomainEvent("ContactResearchTaskFailed", tenantId, payload);
}

// -- OutreachThread aggregate -----------------------------------------------

export interface OutreachDraftGeneratedPayload {
  readonly threadId: string;
  readonly contactId: string;
  readonly jobId: string | null;
  readonly draftId: string;
  readonly generation: number;
  readonly kind: OutreachDraftKind;
  readonly generatedAt: string;
}
export type OutreachDraftGenerated = DomainEvent<
  "OutreachDraftGenerated",
  OutreachDraftGeneratedPayload
>;
export function createOutreachDraftGenerated(
  tenantId: TenantId,
  payload: OutreachDraftGeneratedPayload,
): OutreachDraftGenerated {
  return createDomainEvent("OutreachDraftGenerated", tenantId, payload);
}

export interface OutreachDraftRevisedPayload {
  readonly threadId: string;
  readonly draftId: string;
  readonly generation: number;
  readonly revisedAt: string;
}
export type OutreachDraftRevised = DomainEvent<
  "OutreachDraftRevised",
  OutreachDraftRevisedPayload
>;
export function createOutreachDraftRevised(
  tenantId: TenantId,
  payload: OutreachDraftRevisedPayload,
): OutreachDraftRevised {
  return createDomainEvent("OutreachDraftRevised", tenantId, payload);
}

export interface OutreachDraftApprovedPayload {
  readonly threadId: string;
  readonly draftId: string;
  readonly generation: number;
  readonly approvedAt: string;
}
export type OutreachDraftApproved = DomainEvent<
  "OutreachDraftApproved",
  OutreachDraftApprovedPayload
>;
export function createOutreachDraftApproved(
  tenantId: TenantId,
  payload: OutreachDraftApprovedPayload,
): OutreachDraftApproved {
  return createDomainEvent("OutreachDraftApproved", tenantId, payload);
}

export interface OutreachDraftRejectedPayload {
  readonly threadId: string;
  readonly draftId: string;
  readonly generation: number;
  readonly reason: string;
  readonly rejectedAt: string;
}
export type OutreachDraftRejected = DomainEvent<
  "OutreachDraftRejected",
  OutreachDraftRejectedPayload
>;
export function createOutreachDraftRejected(
  tenantId: TenantId,
  payload: OutreachDraftRejectedPayload,
): OutreachDraftRejected {
  return createDomainEvent("OutreachDraftRejected", tenantId, payload);
}

/**
 * A user-attested record that the user sent an approved draft. The ONLY way a
 * thread reaches a "sent" state (INV-1). The system never sends; there is no
 * transport. `channel` is a controlled label of where the user sent it.
 */
export interface OutreachSendLoggedPayload {
  readonly threadId: string;
  readonly draftId: string;
  readonly channel: string;
  readonly sentAt: string;
  readonly loggedAt: string;
}
export type OutreachSendLogged = DomainEvent<"OutreachSendLogged", OutreachSendLoggedPayload>;
export function createOutreachSendLogged(
  tenantId: TenantId,
  payload: OutreachSendLoggedPayload,
): OutreachSendLogged {
  return createDomainEvent("OutreachSendLogged", tenantId, payload);
}

export interface FollowUpScheduledPayload {
  readonly threadId: string;
  readonly jobId: string | null;
  readonly dueAt: string;
  readonly basis: string;
  readonly scheduledAt: string;
}
export type FollowUpScheduled = DomainEvent<"FollowUpScheduled", FollowUpScheduledPayload>;
export function createFollowUpScheduled(
  tenantId: TenantId,
  payload: FollowUpScheduledPayload,
): FollowUpScheduled {
  return createDomainEvent("FollowUpScheduled", tenantId, payload);
}

export interface FollowUpCompletedPayload {
  readonly threadId: string;
  readonly completedAt: string;
}
export type FollowUpCompleted = DomainEvent<"FollowUpCompleted", FollowUpCompletedPayload>;
export function createFollowUpCompleted(
  tenantId: TenantId,
  payload: FollowUpCompletedPayload,
): FollowUpCompleted {
  return createDomainEvent("FollowUpCompleted", tenantId, payload);
}

export interface FollowUpDismissedPayload {
  readonly threadId: string;
  readonly reason: string;
  readonly dismissedAt: string;
}
export type FollowUpDismissed = DomainEvent<"FollowUpDismissed", FollowUpDismissedPayload>;
export function createFollowUpDismissed(
  tenantId: TenantId,
  payload: FollowUpDismissedPayload,
): FollowUpDismissed {
  return createDomainEvent("FollowUpDismissed", tenantId, payload);
}
