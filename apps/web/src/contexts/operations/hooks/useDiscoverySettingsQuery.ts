import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { discoveryKeys } from "../queryKeys.js";
import type { DiscoverySettingsResponse } from "../types.js";

export function useDiscoverySettingsQuery(): UseQueryResult<DiscoverySettingsResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: discoveryKeys.settings(tenantId),
    queryFn: () => api.discoverySettings(),
  });
}
