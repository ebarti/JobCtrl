import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { compensationKeys } from "../queryKeys.js";
import type { CompensationPolicyRegistry } from "../contracts.js";
import { compensationPolicyEnvelope } from "../responseSchemas.js";

export function useCompensationSourcePolicyQuery(): UseQueryResult<CompensationPolicyRegistry> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: compensationKeys.sources(tenantId),
    queryFn: async () => {
      const value = await http.json<unknown>("GET", "/v1/compensation/sources");
      if (!compensationPolicyEnvelope.safeParse(value).success) {
        throw new Error("The compensation source policy response is invalid.");
      }
      return value as CompensationPolicyRegistry;
    },
    staleTime: 0,
  });
}
