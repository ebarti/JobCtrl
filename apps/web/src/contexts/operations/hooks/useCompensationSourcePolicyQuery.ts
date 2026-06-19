import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { compensationKeys } from "../compensationKeys.js";
import type { CompensationSourceRegistryResponse } from "../types.js";

export function useCompensationSourcePolicyQuery(): UseQueryResult<CompensationSourceRegistryResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: compensationKeys.sources(tenantId),
    queryFn: () => api.compensationSources(),
    staleTime: 0,
  });
}
