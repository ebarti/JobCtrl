import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { ApiHealthResponse } from "../../../shared/ports/ApiClientPort.js";
import { healthKeys } from "../healthKeys.js";

export function useHealthQuery(): UseQueryResult<ApiHealthResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: healthKeys.live(tenantId),
    queryFn: () => api.health(),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
