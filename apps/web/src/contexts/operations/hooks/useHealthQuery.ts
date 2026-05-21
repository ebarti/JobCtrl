import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { ApiHealthResponse } from "../../../shared/ports/ApiClientPort.js";
import { healthKeys } from "../healthKeys.js";
const HEALTH_POLL_INTERVAL_MS = 30_000;

export function useHealthQuery(): UseQueryResult<ApiHealthResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: healthKeys.live(tenantId),
    queryFn: () => api.health(),
    refetchInterval: HEALTH_POLL_INTERVAL_MS,
    staleTime: 10_000,
  });
}
