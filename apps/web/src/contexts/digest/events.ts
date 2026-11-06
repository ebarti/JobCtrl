import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { digestKeys } from "./queryKeys.js";

export const digestEvents: FeatureEventHandler = {
  eventTypes: ["DigestReviewed", "CareerLearningRecorded", "CompanyBriefingUpdated", "ApplicationsUpdated", "ApplicationOutcomeRecorded", "DiscoveryRunUpdated", "DiscoverySourceUpdated", "OutreachSendLogged", "FollowUpScheduled", "FollowUpCompleted", "FollowUpDismissed", "JobCaptured", "JobSourceObserved", "JobUpdated", "FitAssessed", "FitCorrected", "FitRequirementCorrected", "ResumeComposed", "ResumeEdited", "ResumeReviewStarted", "ResumeReviewed", "ResumeRendered", "ResumeAccepted"],
  handle(event, queryClient) {
    void invalidateQueriesWithOptimisticOwnership(queryClient, digestKeys.all(event.tenantId));
  },
};
