import type { DiscoveryBrowserBridgeStatusResponse } from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { browserCapabilityKeys } from "../browserCapabilityKeys.js";

const DISCOVERY_BROWSER_HEARTBEAT_POLL_MS = 5_000;

export function useDiscoveryBrowserBridgeQuery(options: {
  enabled?: boolean;
} = {}): UseQueryResult<DiscoveryBrowserBridgeStatusResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: browserCapabilityKeys.discoveryBrowserBridge(tenantId),
    queryFn: () => api.discoveryBrowserBridgeStatus(),
    enabled: options.enabled ?? true,
    refetchInterval: DISCOVERY_BROWSER_HEARTBEAT_POLL_MS,
    staleTime: 2_000,
    meta: { suppressGlobalErrorToast: true },
  });
}
