import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { ApiHealthResponse } from "../../../shared/ports/ApiClientPort.js";
import { healthKeys } from "../healthKeys.js";
import { useEventStreamStatus } from "../providers/EventStreamProvider.js";

const SSE_BACKSTOP_INTERVAL_MS = 30_000;

export function useHealthQuery(): UseQueryResult<ApiHealthResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const streamStatus = useEventStreamStatus();
  // SSE heartbeat covers liveness when the stream is open; HTTP polling
  // only fires as a backstop while the stream is unhealthy (target §7.7).
  const refetchInterval = streamStatus === "open" ? false : SSE_BACKSTOP_INTERVAL_MS;
  return useQuery({
    queryKey: healthKeys.live(tenantId),
    queryFn: () => api.health(),
    refetchInterval,
    staleTime: 10_000,
  });
}
