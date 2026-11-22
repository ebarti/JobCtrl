import { OfferReadResponseSchema } from "@jobctrl/contracts";
import { useQuery } from "@tanstack/react-query";

import { getApiCapabilityAvailability } from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { offerKeys } from "../queryKeys.js";

export function useOfferQuery(jobId: string) {
  const tenantId = useTenantId();
  const { http, featureFlags } = usePorts();
  return useQuery({
    enabled: getApiCapabilityAvailability(featureFlags, "jobOffer").available,
    queryKey: offerKeys.detail(tenantId, jobId),
    queryFn: async () => {
      const result = OfferReadResponseSchema.safeParse(
        await http.json<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/offer`),
      );
      if (!result.success || result.data.jobId !== jobId) {
        throw new Error("The offer response is invalid.");
      }
      return result.data;
    },
  });
}
