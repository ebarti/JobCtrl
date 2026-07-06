/**
 * SSE invalidation handlers for the Contact & Outreach context.
 *
 * One handler per domain event type; registered in the invalidation router's
 * `handlers` map. The `HandlerMap` mapped type makes a missing handler a
 * compile error, and `every-event-has-handler.test.ts` asserts each returns at
 * least one InvalidationItem.
 */
import type {
  ContactCreated,
  ContactUpdated,
  ContactAttributeRecorded,
  ContactDeleted,
  WarmIntroIdentified,
  ContactResearchTaskStarted,
  ContactCandidateProposed,
  ContactResearchTaskNeedsReview,
  ContactResearchTaskCompleted,
  ContactResearchTaskFailed,
  OutreachDraftGenerated,
  OutreachDraftRevised,
  OutreachDraftApproved,
  OutreachDraftRejected,
  OutreachSendLogged,
  FollowUpScheduled,
  FollowUpCompleted,
  FollowUpDismissed,
} from "@jobhunter/domain-types";

import { invalidate, type InvalidationItem } from "../operations/invalidation-router.js";
import { outreachKeys } from "./queryKeys.js";

// -- Contact aggregate ------------------------------------------------------

export const contactCreatedHandler = (event: ContactCreated): readonly InvalidationItem[] => [
  invalidate(outreachKeys.contactLists(event.tenantId)),
];

export const contactUpdatedHandler = (event: ContactUpdated): readonly InvalidationItem[] => [
  invalidate(outreachKeys.contactDetail(event.tenantId, event.payload.contactId)),
  invalidate(outreachKeys.contactLists(event.tenantId)),
];

export const contactAttributeRecordedHandler = (
  event: ContactAttributeRecorded,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.contactDetail(event.tenantId, event.payload.contactId)),
];

export const contactDeletedHandler = (event: ContactDeleted): readonly InvalidationItem[] => [
  invalidate(outreachKeys.contactDetail(event.tenantId, event.payload.contactId)),
  invalidate(outreachKeys.contactLists(event.tenantId)),
];

export const warmIntroIdentifiedHandler = (
  event: WarmIntroIdentified,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.contactDetail(event.tenantId, event.payload.contactId)),
];

// -- ContactResearchTask aggregate ------------------------------------------

export const contactResearchTaskStartedHandler = (
  event: ContactResearchTaskStarted,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.researchTask(event.tenantId, event.payload.taskId)),
  invalidate(outreachKeys.researchTaskLists(event.tenantId)),
];

export const contactCandidateProposedHandler = (
  event: ContactCandidateProposed,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.researchTask(event.tenantId, event.payload.taskId)),
];

export const contactResearchTaskNeedsReviewHandler = (
  event: ContactResearchTaskNeedsReview,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.researchTask(event.tenantId, event.payload.taskId)),
  invalidate(outreachKeys.researchTaskLists(event.tenantId)),
];

export const contactResearchTaskCompletedHandler = (
  event: ContactResearchTaskCompleted,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.researchTask(event.tenantId, event.payload.taskId)),
  invalidate(outreachKeys.researchTaskLists(event.tenantId)),
  invalidate(outreachKeys.contactLists(event.tenantId)),
];

export const contactResearchTaskFailedHandler = (
  event: ContactResearchTaskFailed,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.researchTask(event.tenantId, event.payload.taskId)),
  invalidate(outreachKeys.researchTaskLists(event.tenantId)),
];

// -- OutreachThread aggregate -----------------------------------------------

// The by-thread read (`thread`) and the by-contact read (`threadForContact`,
// nested under `threads`) are both draft-review surfaces. Invalidating the parent
// `threads` scope refreshes the drawer's by-contact query from SSE without the
// event needing to carry the contactId/jobId that key the by-contact read.

export const outreachDraftGeneratedHandler = (
  event: OutreachDraftGenerated,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.thread(event.tenantId, event.payload.threadId)),
  invalidate(outreachKeys.threads(event.tenantId)),
];

export const outreachDraftRevisedHandler = (
  event: OutreachDraftRevised,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.thread(event.tenantId, event.payload.threadId)),
  invalidate(outreachKeys.threads(event.tenantId)),
];

export const outreachDraftApprovedHandler = (
  event: OutreachDraftApproved,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.thread(event.tenantId, event.payload.threadId)),
  invalidate(outreachKeys.threads(event.tenantId)),
];

export const outreachDraftRejectedHandler = (
  event: OutreachDraftRejected,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.thread(event.tenantId, event.payload.threadId)),
  invalidate(outreachKeys.threads(event.tenantId)),
];

export const outreachSendLoggedHandler = (
  event: OutreachSendLogged,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.thread(event.tenantId, event.payload.threadId)),
  invalidate(outreachKeys.dueFollowUps(event.tenantId)),
];

export const followUpScheduledHandler = (
  event: FollowUpScheduled,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.thread(event.tenantId, event.payload.threadId)),
  invalidate(outreachKeys.dueFollowUps(event.tenantId)),
];

export const followUpCompletedHandler = (
  event: FollowUpCompleted,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.thread(event.tenantId, event.payload.threadId)),
  invalidate(outreachKeys.dueFollowUps(event.tenantId)),
];

export const followUpDismissedHandler = (
  event: FollowUpDismissed,
): readonly InvalidationItem[] => [
  invalidate(outreachKeys.thread(event.tenantId, event.payload.threadId)),
  invalidate(outreachKeys.dueFollowUps(event.tenantId)),
];
