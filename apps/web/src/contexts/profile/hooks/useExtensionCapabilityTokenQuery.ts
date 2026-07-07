import type { ExtensionCapabilityTokenResponse } from "@jobctl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { profileKeys } from "../queryKeys.js";

export function useExtensionCapabilityTokenQuery(): UseQueryResult<ExtensionCapabilityTokenResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: profileKeys.extensionPairing(tenantId),
    queryFn: () => api.extensionCapabilityToken(),
  });
}
