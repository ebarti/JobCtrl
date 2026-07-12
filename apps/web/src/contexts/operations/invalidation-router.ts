import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { ApplyRunEventRecorded, TenantId } from "@jobctrl/domain-types";

import { appendApplyRunEvent } from "../apply/selectors/applyRunSelectors.js";
import {
  applicationEmailFeedbackIngestedHandler,
  applicationFailedHandler,
  applicationOutcomeRecordedHandler,
  applicationSubmittedHandler,
  applyReviewDecisionRecordedHandler,
  applyRunEventRecordedHandler,
  applyRunStartedHandler,
  applySubmitIntendedHandler,
  emailApplicationCandidateRecordedHandler,
  outcomeSuggestionDecidedHandler,
} from "../apply/handlers.js";
import {
  canonicalJobIdentityResolvedHandler,
  discoveryFeedbackRecordedHandler,
  discoveryRunCompletedHandler,
  discoveryRunFailedHandler,
  discoveryRunStartedHandler,
  duplicateJobLinkedHandler,
  duplicateJobLinkRejectedHandler,
  jobDeletedHandler,
  jobDiscoveredHandler,
  jobHiddenHandler,
  jobRestoredHandler,
  jobSourceObservedHandler,
  jobUpdatedHandler,
  jobUnhiddenHandler,
  sourceLocationCandidateDiscoveredHandler,
  sourceLocationCandidatePromotedHandler,
  sourceRegistryEntryCreatedHandler,
  sourceRegistryEntryUpdatedHandler,
  sourceStateChangedHandler,
} from "../discovery/handlers.js";
import {
  contentDuplicateCandidateDetectedHandler,
  compensationFactsUpdatedHandler,
  enrichmentFailedHandler,
  jobActiveStateChangedHandler,
  jobEnrichedHandler,
  postingContentSnapshotCapturedHandler,
  postingContentSnapshotFailedHandler,
} from "../enrichment/handlers.js";
import {
  bulletProvenanceRecordedHandler,
  coverLetterGeneratedHandler,
  employerAnalyzedHandler,
  interviewPrepFailedHandler,
  interviewPrepGeneratedHandler,
  materialsExhaustedHandler,
  pdfRenderedHandler,
  resumeApprovedHandler,
  resumeFailedHandler,
  resumeTemplateDefaultChangedHandler,
  resumeTemplateRefreshCompletedHandler,
  resumeTemplateRefreshFailedHandler,
  resumeTemplateVersionSavedHandler,
  tailoredArtifactsSuppressedHandler,
  tailorRetailorRequestedHandler,
  jobResumeTemplateAssignedHandler,
} from "../materials/handlers.js";
import {
  preparationWorkItemCompletedHandler,
  preparationWorkItemFailedHandler,
  preparationWorkItemQueuedHandler,
  preparationWorkItemStartedHandler,
  stageBlockedHandler,
  stageCanceledHandler,
  stageCompletedHandler,
  stageExhaustedHandler,
  stageFailedHandler,
  stageResetHandler,
  stageSkippedHandler,
  stageStartedHandler,
  workflowStartedHandler,
  workflowCompletedHandler,
  workflowFailedHandler,
  workflowCanceledHandler,
  workflowTimedOutHandler,
  workflowTerminatedHandler,
} from "../pipeline/handlers.js";
import {
  profileImportedHandler,
  profileUpdatedHandler,
  tailoringPolicyUpdatedHandler,
} from "../profile/handlers.js";
import {
  jobScoredHandler,
  scoreCorrectedHandler,
  scoreRescoreRequestedHandler,
} from "../scoring/handlers.js";
import {
  contactCreatedHandler,
  contactUpdatedHandler,
  contactAttributeRecordedHandler,
  contactDeletedHandler,
  warmIntroIdentifiedHandler,
  contactResearchTaskStartedHandler,
  contactCandidateProposedHandler,
  contactResearchTaskNeedsReviewHandler,
  contactResearchTaskCompletedHandler,
  contactResearchTaskFailedHandler,
  outreachDraftGeneratedHandler,
  outreachDraftRevisedHandler,
  outreachDraftApprovedHandler,
  outreachDraftRejectedHandler,
  outreachSendLoggedHandler,
  followUpScheduledHandler,
  followUpCompletedHandler,
  followUpDismissedHandler,
} from "../outreach/handlers.js";
import { activityKeys } from "./activityKeys.js";
import { applyRunsKeys } from "./applyRunsKeys.js";
import { digestKeys } from "./digestKeys.js";
import type { KnownDomainEvent, KnownDomainEventType } from "./types.js";

export type InvalidationItem =
  | { readonly kind: "invalidate"; readonly queryKey: QueryKey }
  | {
      readonly kind: "apply-run-event-append";
      readonly tenantId: TenantId;
      readonly runId: string;
      readonly event: ApplyRunEventRecorded;
    };

export type InvalidationHandler<TEvent extends KnownDomainEvent = KnownDomainEvent> = (
  event: TEvent,
) => readonly InvalidationItem[];

export const invalidate = (queryKey: QueryKey): InvalidationItem => ({
  kind: "invalidate",
  queryKey,
});

export const patchApplyRunEvent = (
  tenantId: TenantId,
  runId: string,
  event: ApplyRunEventRecorded,
): InvalidationItem => ({
  kind: "apply-run-event-append",
  tenantId,
  runId,
  event,
});

export type HandlerMap = {
  readonly [K in KnownDomainEventType]: InvalidationHandler<
    Extract<KnownDomainEvent, { eventType: K }>
  >;
};

export const handlers: HandlerMap = {
  JobDiscovered: jobDiscoveredHandler,
  JobUpdated: jobUpdatedHandler,
  JobDeleted: jobDeletedHandler,
  JobRestored: jobRestoredHandler,
  JobHidden: jobHiddenHandler,
  JobUnhidden: jobUnhiddenHandler,
  JobSourceObserved: jobSourceObservedHandler,
  DiscoveryRunStarted: discoveryRunStartedHandler,
  DiscoveryRunCompleted: discoveryRunCompletedHandler,
  DiscoveryRunFailed: discoveryRunFailedHandler,
  CanonicalJobIdentityResolved: canonicalJobIdentityResolvedHandler,
  DuplicateJobLinked: duplicateJobLinkedHandler,
  DuplicateJobLinkRejected: duplicateJobLinkRejectedHandler,
  DiscoveryFeedbackRecorded: discoveryFeedbackRecordedHandler,
  SourceLocationCandidateDiscovered: sourceLocationCandidateDiscoveredHandler,
  SourceLocationCandidatePromoted: sourceLocationCandidatePromotedHandler,
  SourceRegistryEntryCreated: sourceRegistryEntryCreatedHandler,
  SourceRegistryEntryUpdated: sourceRegistryEntryUpdatedHandler,
  SourceStateChanged: sourceStateChangedHandler,
  JobEnriched: jobEnrichedHandler,
  EnrichmentFailed: enrichmentFailedHandler,
  PostingContentSnapshotCaptured: postingContentSnapshotCapturedHandler,
  PostingContentSnapshotFailed: postingContentSnapshotFailedHandler,
  JobActiveStateChanged: jobActiveStateChangedHandler,
  ContentDuplicateCandidateDetected: contentDuplicateCandidateDetectedHandler,
  JobScored: jobScoredHandler,
  ScoreCorrected: scoreCorrectedHandler,
  ScoreRescoreRequested: scoreRescoreRequestedHandler,
  ResumeApproved: resumeApprovedHandler,
  ResumeFailed: resumeFailedHandler,
  CoverLetterGenerated: coverLetterGeneratedHandler,
  PdfRendered: pdfRenderedHandler,
  MaterialsExhausted: materialsExhaustedHandler,
  EmployerAnalyzed: employerAnalyzedHandler,
  BulletProvenanceRecorded: bulletProvenanceRecordedHandler,
  InterviewPrepGenerated: interviewPrepGeneratedHandler,
  InterviewPrepFailed: interviewPrepFailedHandler,
  TailoringPolicyUpdated: tailoringPolicyUpdatedHandler,
  TailorRetailorRequested: tailorRetailorRequestedHandler,
  TailoredArtifactsSuppressed: tailoredArtifactsSuppressedHandler,
  ResumeTemplateVersionSaved: resumeTemplateVersionSavedHandler,
  ResumeTemplateDefaultChanged: resumeTemplateDefaultChangedHandler,
  JobResumeTemplateAssigned: jobResumeTemplateAssignedHandler,
  ResumeTemplateRefreshCompleted: resumeTemplateRefreshCompletedHandler,
  ResumeTemplateRefreshFailed: resumeTemplateRefreshFailedHandler,
  PreparationWorkItemQueued: preparationWorkItemQueuedHandler,
  PreparationWorkItemStarted: preparationWorkItemStartedHandler,
  PreparationWorkItemCompleted: preparationWorkItemCompletedHandler,
  PreparationWorkItemFailed: preparationWorkItemFailedHandler,
  ApplyRunStarted: applyRunStartedHandler,
  ApplySubmitIntended: applySubmitIntendedHandler,
  ApplyRunEventRecorded: applyRunEventRecordedHandler,
  EmailApplicationCandidateRecorded: emailApplicationCandidateRecordedHandler,
  ApplicationEmailFeedbackIngested: applicationEmailFeedbackIngestedHandler,
  ApplicationSubmitted: applicationSubmittedHandler,
  ApplicationFailed: applicationFailedHandler,
  ApplyReviewDecisionRecorded: applyReviewDecisionRecordedHandler,
  ApplicationOutcomeRecorded: applicationOutcomeRecordedHandler,
  OutcomeSuggestionDecided: outcomeSuggestionDecidedHandler,
  StageStarted: stageStartedHandler,
  StageCompleted: stageCompletedHandler,
  StageFailed: stageFailedHandler,
  StageExhausted: stageExhaustedHandler,
  StageReset: stageResetHandler,
  StageBlocked: stageBlockedHandler,
  StageSkipped: stageSkippedHandler,
  StageCanceled: stageCanceledHandler,
  ProfileUpdated: profileUpdatedHandler,
  ProfileImported: profileImportedHandler,
  CompensationFactsUpdated: compensationFactsUpdatedHandler,
  DigestReviewed: (event) => [invalidate(digestKeys.all(event.tenantId))],
  WorkflowStarted: workflowStartedHandler,
  WorkflowCompleted: workflowCompletedHandler,
  WorkflowFailed: workflowFailedHandler,
  WorkflowCanceled: workflowCanceledHandler,
  WorkflowTimedOut: workflowTimedOutHandler,
  WorkflowTerminated: workflowTerminatedHandler,
  ContactCreated: contactCreatedHandler,
  ContactUpdated: contactUpdatedHandler,
  ContactAttributeRecorded: contactAttributeRecordedHandler,
  ContactDeleted: contactDeletedHandler,
  WarmIntroIdentified: warmIntroIdentifiedHandler,
  ContactResearchTaskStarted: contactResearchTaskStartedHandler,
  ContactCandidateProposed: contactCandidateProposedHandler,
  ContactResearchTaskNeedsReview: contactResearchTaskNeedsReviewHandler,
  ContactResearchTaskCompleted: contactResearchTaskCompletedHandler,
  ContactResearchTaskFailed: contactResearchTaskFailedHandler,
  OutreachDraftGenerated: outreachDraftGeneratedHandler,
  OutreachDraftRevised: outreachDraftRevisedHandler,
  OutreachDraftApproved: outreachDraftApprovedHandler,
  OutreachDraftRejected: outreachDraftRejectedHandler,
  OutreachSendLogged: outreachSendLoggedHandler,
  FollowUpScheduled: followUpScheduledHandler,
  FollowUpCompleted: followUpCompletedHandler,
  FollowUpDismissed: followUpDismissedHandler,
};

export interface InvalidationRouter {
  handle(event: KnownDomainEvent, queryClient: QueryClient): void;
}

export function dispatch<K extends KnownDomainEventType>(
  event: Extract<KnownDomainEvent, { eventType: K }>,
): readonly InvalidationItem[] {
  const handler = handlers[event.eventType] as InvalidationHandler<typeof event>;
  const items = handler(event);
  if (event.eventType === "ApplyRunEventRecorded") {
    return items;
  }
  return [...items, invalidate(activityKeys.lists(event.tenantId))];
}

export const invalidationRouter: InvalidationRouter = {
  handle(event, queryClient) {
    const items = dispatch(event);
    for (const item of items) {
      if (item.kind === "invalidate") {
        void queryClient.invalidateQueries({ queryKey: item.queryKey });
        continue;
      }
      // High-frequency `ApplyRunEventRecorded` events patch the apply-run
      // cache surgically per target §7.5; refetching per per-second event
      // would saturate the API.
      queryClient.setQueryData(applyRunsKeys.detail(item.tenantId, item.runId), (current) =>
        appendApplyRunEvent(current as never, item.event),
      );
    }
  },
};
