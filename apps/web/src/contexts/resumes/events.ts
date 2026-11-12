import type { QueryClient } from "@tanstack/react-query";

import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { DomainEventEnvelope } from "../../shared/ports/EventStreamPort.js";
import { resumeKeys } from "./client.js";

/** Source changes refresh reads only; accepted documents and local drafts retain their identity. */
export const resumesInvalidation = {
  eventTypes: ["ResumeComposed", "ResumeEdited", "ResumeReviewStarted", "ResumeReviewed", "ResumeRendered", "ResumeAccepted", "ResumeLocaleUpdated", "ResumeTemplateUpdated", "ResumeCommentUpdated", "ProfileUpdated", "ProfileWordingUpdated", "ProfileSourceUpdated", "JobSourceObserved", "JobUpdated", "RequirementsUpdated", "RequirementBindingCorrected", "RequirementMeaningRevised", "FitAssessed", "FitCorrected", "FitRequirementCorrected", "FitCoverageUpdated", "FitCurrentWordingUpdated"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) {
    void invalidateQueriesWithOptimisticOwnership(client, resumeKeys.all(event.tenantId));
  },
};
