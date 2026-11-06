import type { QueryClient } from "@tanstack/react-query";
import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { DomainEventEnvelope } from "../../shared/ports/EventStreamPort.js";
import { jobsKeys } from "../jobs/index.js";
import { compensationKeys } from "./queryKeys.js";

export const compensationEvents = {
  eventTypes: ["CompensationEvidenceChanged", "CompensationRefreshChanged", "CompensationSourcePolicyChanged", "JobSourceObserved", "JobUpdated"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) {
    const tenant = event.tenantId;
    if (event.eventType === "CompensationSourcePolicyChanged") {
      void invalidateQueriesWithOptimisticOwnership(client, compensationKeys.sources(tenant));
      return;
    }
    const jobId = event.aggregateId;
    void invalidateQueriesWithOptimisticOwnership(client, jobId ? compensationKeys.evidence(tenant, jobId) : compensationKeys.all(tenant));
    void invalidateQueriesWithOptimisticOwnership(client, jobId ? compensationKeys.comparison(tenant, jobId) : jobsKeys.all(tenant));
    void invalidateQueriesWithOptimisticOwnership(client, jobId ? jobsKeys.detail(tenant, jobId) : jobsKeys.all(tenant));
    void invalidateQueriesWithOptimisticOwnership(client, jobsKeys.lists(tenant));
  },
};
