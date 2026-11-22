import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { digestKeys } from "./queryKeys.js";

export const digestEvents: FeatureEventHandler = {
  eventTypes: ["DigestReviewed", "CareerLearningRecorded", "CompanyBriefingUpdated", "ApplicationsUpdated", "ApplicationOutcomeRecorded", "DiscoveryRunUpdated", "DiscoverySourceUpdated", "OutreachSendLogged", "FollowUpScheduled", "FollowUpCompleted", "FollowUpDismissed", "JobCaptured", "JobSourceObserved", "JobUpdated", "FitAssessed", "FitCorrected", "FitRequirementCorrected", "ProfileUpdated", "ProfileSourceUpdated", "RequirementsUpdated", "RequirementsConsolidated", "RequirementBindingCorrected", "RequirementMeaningRevised", "ResumeComposed", "ResumeEdited", "ResumeReviewStarted", "ResumeReviewed", "ResumeRendered", "ResumeAccepted"],
  handle(event, invalidate) {
    invalidate(digestKeys.all(event.tenantId));
  },
};
