import type {
  DiscoverySettingsResponse,
  DiscoverySettingsUpdateRequest,
  EffectiveDiscoverySettings,
  EffectiveSetting,
} from "@jobctrl/contracts";
import { DiscoverySettingsResponseSchema } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
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
  current: unknown,
  body: DiscoverySettingsUpdateRequest,
): unknown {
  if (!isDiscoverySettingsResponse(current)) {
    return current;
  }

  const effectiveSettings: EffectiveDiscoverySettings = {
    boards: persistedValue(current.effectiveSettings.boards, body.boards),
    resultsPerSite: persistedValue(
      current.effectiveSettings.resultsPerSite,
      body.resultsPerSite,
    ),
    hoursOld: persistedValue(current.effectiveSettings.hoursOld, body.hoursOld),
    schedulingEnabled: persistedValue(
      current.effectiveSettings.schedulingEnabled,
      body.schedulingEnabled,
    ),
    scheduleCron: persistedValue(current.effectiveSettings.scheduleCron, body.scheduleCron),
    roleFilterMode: persistedValue(
      current.effectiveSettings.roleFilterMode,
      body.roleFilterMode,
    ),
    roleFilterModel: persistedValue(
      current.effectiveSettings.roleFilterModel,
      body.roleFilterModel,
    ),
    maxParallelFamilies: persistedValue(
      current.effectiveSettings.maxParallelFamilies,
      body.maxParallelFamilies,
    ),
    crawlUserAgentProduct: persistedValue(
      current.effectiveSettings.crawlUserAgentProduct,
      body.crawlUserAgentProduct,
    ),
    crawlUserAgentContact: persistedValue(
      current.effectiveSettings.crawlUserAgentContact,
      body.crawlUserAgentContact,
    ),
  };
  return {
    ...current,
    settings: {
      ...current.settings,
      ...(body.boards !== undefined ? { boards: body.boards } : {}),
      ...(body.resultsPerSite !== undefined ? { resultsPerSite: body.resultsPerSite } : {}),
      ...(body.hoursOld !== undefined ? { hoursOld: body.hoursOld } : {}),
      ...(body.schedulingEnabled !== undefined
        ? { schedulingEnabled: body.schedulingEnabled }
        : {}),
      ...(body.scheduleCron !== undefined ? { scheduleCron: body.scheduleCron } : {}),
      ...(body.roleFilterMode !== undefined ? { roleFilterMode: body.roleFilterMode } : {}),
      ...(body.roleFilterModel !== undefined ? { roleFilterModel: body.roleFilterModel } : {}),
      ...(body.maxParallelFamilies !== undefined
        ? { maxParallelFamilies: body.maxParallelFamilies }
        : {}),
      ...(body.crawlUserAgentProduct !== undefined
        ? { crawlUserAgentProduct: body.crawlUserAgentProduct }
        : {}),
      ...(body.crawlUserAgentContact !== undefined
        ? { crawlUserAgentContact: body.crawlUserAgentContact }
        : {}),
    },
    effectiveSettings,
  };
}

function isDiscoverySettingsResponse(value: unknown): value is DiscoverySettingsResponse {
  return DiscoverySettingsResponseSchema.safeParse(value).success;
}

function persistedValue<T>(
  metadata: EffectiveSetting<T>,
  value: T | undefined,
): EffectiveSetting<T> {
  if (value === undefined || !metadata.editable) {
    return metadata;
  }
  return { ...metadata, value, source: "persisted" };
}
