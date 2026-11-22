import type { BrowserCapabilitiesResponse } from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { browserCapabilityKeys } from "../browserCapabilityKeys.js";
import { parseBrowserCapabilities } from "../browserApi.js";

export function useBrowserCapabilitiesQuery(): UseQueryResult<BrowserCapabilitiesResponse> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: browserCapabilityKeys.capabilities(tenantId),
    queryFn: async () => parseBrowserCapabilities(await http.json<unknown>("GET", "/v1/browser-capabilities")),
  });
}
