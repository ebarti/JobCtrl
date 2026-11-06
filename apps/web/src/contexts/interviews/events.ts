import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { interviewKeys } from "./queryKeys.js";

export const interviewEvents: FeatureEventHandler = {
  eventTypes: ["InterviewPrepGenerated", "InterviewPrepFailed", "InterviewQuestionNoteSaved", "ProfileUpdated", "ProfileSourceUpdated", "JobSourceObserved", "JobUpdated", "RequirementsUpdated", "RequirementBindingCorrected", "FitAssessed", "FitCorrected", "FitRequirementCorrected"],
  handle(event, queryClient) {
    if (event.eventType === "ProfileUpdated" || event.eventType === "ProfileSourceUpdated") {
      void invalidateQueriesWithOptimisticOwnership(queryClient, interviewKeys.evidence(event.tenantId));
      void invalidateQueriesWithOptimisticOwnership(queryClient, interviewKeys.jobs(event.tenantId));
      return;
    }
    const payload = event.payload;
    const jobId = payload && typeof payload === "object" && "jobId" in payload && typeof payload.jobId === "string" ? payload.jobId : null;
    const questionId = payload && typeof payload === "object" && "questionId" in payload && typeof payload.questionId === "string" ? payload.questionId : null;
    const key = !jobId ? interviewKeys.jobs(event.tenantId)
      : event.eventType === "InterviewQuestionNoteSaved" && questionId ? interviewKeys.note(event.tenantId, jobId, questionId)
      : interviewKeys.job(event.tenantId, jobId);
    void invalidateQueriesWithOptimisticOwnership(queryClient, key);
  },
};
