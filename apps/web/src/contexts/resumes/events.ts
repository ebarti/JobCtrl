
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { resumeKeys } from "./client.js";

/** Source changes refresh reads only; accepted documents and local drafts retain their identity. */
export const resumesInvalidation: FeatureEventHandler = {
  eventTypes: ["ResumeComposed", "ResumeEdited", "ResumeReviewStarted", "ResumeReviewed", "ResumeRendered", "ResumeAccepted", "ResumeLocaleUpdated", "ResumeTemplateUpdated", "ResumeCommentUpdated", "ProfileUpdated", "ProfileWordingUpdated", "ProfileSourceUpdated", "JobSourceObserved", "JobUpdated", "RequirementsUpdated", "RequirementBindingCorrected", "RequirementMeaningRevised", "FitAssessed", "FitCorrected", "FitRequirementCorrected", "FitCoverageUpdated", "FitCurrentWordingUpdated"] as const,
  handle(event, invalidate) {
    invalidate(resumeKeys.all(event.tenantId));
  },
};
