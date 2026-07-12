import type { DiscoverySettingsUpdateRequest, EffectiveSetting } from "@jobctrl/contracts";
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
  const effectiveRecord = effectiveSettings as unknown as Record<string, EffectiveSetting<unknown>>;
  for (const [field, value] of Object.entries(body)) {
    if (value === undefined || !(field in effectiveRecord)) continue;
    const metadata = effectiveRecord[field];
    if (metadata?.editable) {
      effectiveRecord[field] = {
        ...metadata,
        value,
        source: "persisted",
      };
    }
  }
  return {
    ...current,
    settings: { ...current.settings, ...body },
    effectiveSettings,
  };
}
