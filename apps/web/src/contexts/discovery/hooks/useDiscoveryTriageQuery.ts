import { useQuery } from "@tanstack/react-query";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { discoveryKeys } from "../queryKeys.js";
export function useDiscoveryTriageQuery(offset: number) {
  const { api } = usePorts();
  const tenantId = useTenantId();
  return useQuery({
    queryKey: discoveryKeys.triage(tenantId, offset),
    queryFn: () => api.discoveryTriage(offset),
    refetchInterval: 10000,
  });
}
