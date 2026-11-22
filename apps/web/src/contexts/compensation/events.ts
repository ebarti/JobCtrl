import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { jobsKeys } from "../jobs/index.js";
import { compensationKeys } from "./queryKeys.js";

export const compensationEvents: FeatureEventHandler = {
  eventTypes: ["CompensationEvidenceChanged", "CompensationRefreshChanged", "CompensationSourcePolicyChanged", "JobSourceObserved", "JobUpdated"] as const,
  handle(event, invalidate) {
    const tenant = event.tenantId;
    if (event.eventType === "CompensationSourcePolicyChanged") {
      invalidate(compensationKeys.sources(tenant));
      return;
    }
    const jobId = event.aggregateId;
    invalidate(jobId ? compensationKeys.evidence(tenant, jobId) : compensationKeys.all(tenant));
    invalidate(jobId ? compensationKeys.comparison(tenant, jobId) : jobsKeys.all(tenant));
    invalidate(jobId ? jobsKeys.detail(tenant, jobId) : jobsKeys.all(tenant));
    invalidate(jobsKeys.lists(tenant));
  },
};
