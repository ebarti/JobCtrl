import type { DiscoverySettingsResponse } from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { discoveryKeys } from "../queryKeys.js";
import { DiscoverySettingsPythonSchema } from "../contracts.js";

export function useDiscoverySettingsQuery(): UseQueryResult<DiscoverySettingsResponse> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({ queryKey: discoveryKeys.settings(tenantId),
    queryFn: async () => DiscoverySettingsPythonSchema.parse(await http.json<unknown>("GET", "/v1/discovery/settings")) });
}
