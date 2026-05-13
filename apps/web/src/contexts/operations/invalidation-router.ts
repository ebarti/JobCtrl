import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { ApplyRunEventRecorded, TenantId } from "@jobhunter/domain-types";

import { appendApplyRunEvent } from "../apply/selectors/applyRunSelectors.js";
import {
  applicationFailedHandler,
  applicationSubmittedHandler,
  applyRunEventRecordedHandler,
  applyRunStartedHandler,
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
  jobRestoredHandler,
  jobSourceObservedHandler,
  jobUpdatedHandler,
  sourceLocationCandidateDiscoveredHandler,
  sourceLocationCandidatePromotedHandler,
  sourceRegistryEntryCreatedHandler,
  sourceRegistryEntryUpdatedHandler,
  sourceStateChangedHandler,
} from "../discovery/handlers.js";
import {
  contentDuplicateCandidateDetectedHandler,
  enrichmentFailedHandler,
  jobActiveStateChangedHandler,
  jobEnrichedHandler,
  postingContentSnapshotCapturedHandler,
  postingContentSnapshotFailedHandler,
} from "../enrichment/handlers.js";
import {
  coverLetterGeneratedHandler,
  materialsExhaustedHandler,
  pdfRenderedHandler,
  resumeApprovedHandler,
  resumeFailedHandler,
} from "../materials/handlers.js";
import {
  stageBlockedHandler,
  stageCanceledHandler,
  stageCompletedHandler,
  stageExhaustedHandler,
  stageFailedHandler,
  stageResetHandler,
  stageSkippedHandler,
  stageStartedHandler,
} from "../pipeline/handlers.js";
import { profileImportedHandler, profileUpdatedHandler } from "../profile/handlers.js";
import { jobScoredHandler, scoreCorrectedHandler } from "../scoring/handlers.js";
import { applyRunsKeys } from "./applyRunsKeys.js";
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
  ResumeApproved: resumeApprovedHandler,
  ResumeFailed: resumeFailedHandler,
  CoverLetterGenerated: coverLetterGeneratedHandler,
  PdfRendered: pdfRenderedHandler,
  MaterialsExhausted: materialsExhaustedHandler,
  ApplyRunStarted: applyRunStartedHandler,
  ApplyRunEventRecorded: applyRunEventRecordedHandler,
  ApplicationSubmitted: applicationSubmittedHandler,
  ApplicationFailed: applicationFailedHandler,
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
};

export interface InvalidationRouter {
  handle(event: KnownDomainEvent, queryClient: QueryClient): void;
}

export function dispatch<K extends KnownDomainEventType>(
  event: Extract<KnownDomainEvent, { eventType: K }>,
): readonly InvalidationItem[] {
  const handler = handlers[event.eventType] as InvalidationHandler<typeof event>;
  return handler(event);
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
