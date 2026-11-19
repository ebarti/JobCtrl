import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { jobsKeys } from "../jobs/index.js";
import { offerKeys } from "./queryKeys.js";

export const offerEvents: FeatureEventHandler = {
  eventTypes: ["OfferRecordChanged"] as const,
  handle(event, invalidate) {
    const tenant = event.tenantId;
    const jobId = event.aggregateId;
    invalidate(jobId ? offerKeys.detail(tenant, jobId) : offerKeys.all(tenant));
    invalidate(jobId ? jobsKeys.detail(tenant, jobId) : jobsKeys.all(tenant));
    invalidate(["tenant", tenant, "outreach"]);
  },
};
