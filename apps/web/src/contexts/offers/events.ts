import type { QueryClient } from "@tanstack/react-query";
import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { DomainEventEnvelope } from "../../shared/ports/EventStreamPort.js";
import { jobsKeys } from "../jobs/index.js";
import { offerKeys } from "./queryKeys.js";

export const offerEvents = {
  eventTypes: ["OfferRecordChanged"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) {
    const tenant = event.tenantId;
    const jobId = event.aggregateId;
    void invalidateQueriesWithOptimisticOwnership(client, jobId ? offerKeys.detail(tenant, jobId) : offerKeys.all(tenant));
    void invalidateQueriesWithOptimisticOwnership(client, jobId ? jobsKeys.detail(tenant, jobId) : jobsKeys.all(tenant));
    void invalidateQueriesWithOptimisticOwnership(client, ["tenant", tenant, "outreach"]);
  },
};
