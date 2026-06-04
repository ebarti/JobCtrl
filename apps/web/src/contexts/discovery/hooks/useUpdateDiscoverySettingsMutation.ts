import type { DiscoverySettingsUpdateRequest } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import type { DiscoverySettingsResponse } from "../../operations/types.js";
import { discoveryKeys } from "../queryKeys.js";

export function useUpdateDiscoverySettingsMutation(): UseMutationResult<
  DiscoverySettingsResponse,
  Error,
  DiscoverySettingsUpdateRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.updateDiscoverySettings(body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.settings(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}
