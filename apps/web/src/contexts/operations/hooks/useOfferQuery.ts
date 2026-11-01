import { jobsKeys } from "../jobsKeys.js";
import { getApiCapabilityAvailability } from "../../../shared/lib/apiCapabilityAvailability.js";
import { useQuery } from "@tanstack/react-query";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outcomesKeys } from "../outcomesKeys.js";
import type { JobId } from "../types.js";

export function useOfferQuery(jobId: JobId) {
  const tenantId = useTenantId();
  const { api, featureFlags } = usePorts();
  return useQuery({
    enabled: getApiCapabilityAvailability(featureFlags, "jobOffer").available,
    queryKey: outcomesKeys.offer(tenantId, jobId),
    queryFn: () => api.jobOffer(jobId),
  });
}

export function useOfferCompensationQuery(jobId: JobId) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: [...jobsKeys.detail(tenantId, jobId), "offer-compensation"],
    queryFn: async () => {
      const [posted, market] = await Promise.all([
        api.postedCompensationFact(jobId),
        api.marketCompensationEstimate(jobId),
      ]);
      return { posted, market };
    },
  });
}
