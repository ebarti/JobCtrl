import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { sampleDataKeys } from "../sampleDataKeys.js";
import type { SampleDataStatus } from "../types.js";

export function useSampleDataStatusQuery(): UseQueryResult<SampleDataStatus> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: sampleDataKeys.status(tenantId),
    queryFn: () => api.sampleDataStatus(),
    staleTime: 0,
    refetchOnMount: "always",
  });
}
