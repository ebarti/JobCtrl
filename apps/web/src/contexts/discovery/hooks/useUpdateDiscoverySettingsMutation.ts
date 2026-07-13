import type { DiscoverySettingsUpdateRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import type { DiscoverySettingsResponse } from "../../operations/types.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { discoveryKeys } from "../queryKeys.js";

export function useUpdateDiscoverySettingsMutation(): UseMutationResult<
  DiscoverySettingsResponse,
  Error,
  DiscoverySettingsUpdateRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<DiscoverySettingsResponse, DiscoverySettingsUpdateRequest>(queryClient, {
      mutationKey: discoveryKeys.settings(tenantId),
      mutationFn: (body) => api.updateDiscoverySettings(body),
      optimisticUpdates: (body) => [{
        queryKey: discoveryKeys.settings(tenantId),
        patch: (current) => patchDiscoverySettings(current, body),
      }],
      settle: () => [
        discoveryKeys.settings(tenantId),
        discoveryKeys.sourceRegistry(tenantId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}

function patchDiscoverySettings(
  current: DiscoverySettingsResponse,
  body: DiscoverySettingsUpdateRequest,
): DiscoverySettingsResponse {
  const effectiveSettings = { ...current.effectiveSettings };
  for (const [field, value] of Object.entries(body)) {
    if (value === undefined || !(field in effectiveSettings)) continue;
    const key = field as keyof typeof effectiveSettings;
    const metadata = effectiveSettings[key];
    if (metadata.editable) {
      Object.assign(metadata, { value, source: "persisted" });
    }
  }
  return {
    ...current,
    settings: { ...current.settings, ...body },
    effectiveSettings,
  };
}
