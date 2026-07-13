import type { ProviderStatusResponse } from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { profileKeys } from "../queryKeys.js";

export function useProviderStatusQuery(): UseQueryResult<ProviderStatusResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: profileKeys.providerStatus(tenantId),
    queryFn: () => api.providerStatus(),
  });
}
