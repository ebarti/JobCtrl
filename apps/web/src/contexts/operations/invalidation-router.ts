import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  applicationFailedHandler,
  applicationSubmittedHandler,
  applyRunEventRecordedHandler,
  applyRunStartedHandler,
} from "../apply/handlers.js";
import {
  jobDeletedHandler,
  jobDiscoveredHandler,
  jobRestoredHandler,
  jobUpdatedHandler,
} from "../discovery/handlers.js";
import { enrichmentFailedHandler, jobEnrichedHandler } from "../enrichment/handlers.js";
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
import type { KnownDomainEvent, KnownDomainEventType } from "./types.js";

export type InvalidationItem = QueryKey;

export type InvalidationHandler<TEvent extends KnownDomainEvent = KnownDomainEvent> = (
  event: TEvent,
) => readonly InvalidationItem[];

type HandlerMap = {
  readonly [K in KnownDomainEventType]: InvalidationHandler<
    Extract<KnownDomainEvent, { eventType: K }>
  >;
};

const handlers: HandlerMap = {
  JobDiscovered: jobDiscoveredHandler,
  JobUpdated: jobUpdatedHandler,
  JobDeleted: jobDeletedHandler,
  JobRestored: jobRestoredHandler,
  JobEnriched: jobEnrichedHandler,
  EnrichmentFailed: enrichmentFailedHandler,
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

function dispatch<K extends KnownDomainEventType>(
  event: Extract<KnownDomainEvent, { eventType: K }>,
): readonly InvalidationItem[] {
  const handler = handlers[event.eventType] as InvalidationHandler<typeof event>;
  return handler(event);
}

export const invalidationRouter: InvalidationRouter = {
  handle(event, queryClient) {
    const items = dispatch(event);
    for (const key of items) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  },
};
