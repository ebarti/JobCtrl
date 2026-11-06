import type {
  DiscoverySettingsResponse,
  DiscoverySettingsUpdateRequest,
  EffectiveDiscoverySettings,
  EffectiveDiscoverySetting,
} from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { discoveryKeys } from "../queryKeys.js";
import { DiscoverySettingsPythonSchema } from "../contracts.js";

export function useUpdateDiscoverySettingsMutation(): UseMutationResult<
  DiscoverySettingsResponse,
  Error,
  DiscoverySettingsUpdateRequest
> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<DiscoverySettingsResponse, DiscoverySettingsUpdateRequest>(queryClient, {
      mutationKey: discoveryKeys.settings(tenantId),
      mutationFn: async (body) => {
        const current = DiscoverySettingsPythonSchema.safeParse(queryClient.getQueryData(discoveryKeys.settings(tenantId)));
        if (!current.success) throw new Error("Refresh Discovery settings before saving.");
        const response = await http.json<unknown>("PATCH", "/v1/discovery/settings", { body: { ...body, expectedRevision: current.data.revision, expectedPolicyRevision: current.data.policyRevision } });
        const parsed = DiscoverySettingsPythonSchema.safeParse(response);
        if (!parsed.success || parsed.data.revision !== current.data.revision + 1
            || Object.entries(body).some(([key, value]) => key !== "expectedRevision" && key !== "expectedPolicyRevision" && JSON.stringify(parsed.data.settings[key]) !== JSON.stringify(value))) {
          throw createUnconfirmedWriteError("PATCH", "/v1/discovery/settings", new Error("Settings response did not confirm the submitted values."));
        }
        return parsed.data;
      },
      optimisticUpdates: (body) => [{
        queryKey: discoveryKeys.settings(tenantId),
        patch: (current) => patchDiscoverySettings(current, body),
      }],
      settle: () => [
        discoveryKeys.settings(tenantId),
        discoveryKeys.sourceRegistry(tenantId),
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
    ...current.effectiveSettings,
    minFitScore: persistedValue(current.effectiveSettings.minFitScore, body.minFitScore),
    autoApply: persistedValue(current.effectiveSettings.autoApply, body.autoApply),
    applyApprovalRequired: current.effectiveSettings.applyApprovalRequired,
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
    maxParallelFamilies: persistedValue(
      current.effectiveSettings.maxParallelFamilies,
      body.maxParallelFamilies,
    ),
    useBrowserHeaders: persistedValue(
      current.effectiveSettings.useBrowserHeaders,
      body.useBrowserHeaders,
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
      ...(body.minFitScore !== undefined ? { minFitScore: body.minFitScore } : {}),
      ...(body.autoApply !== undefined ? { autoApply: body.autoApply } : {}),
      ...(body.boards !== undefined ? { boards: body.boards } : {}),
      ...(body.resultsPerSite !== undefined ? { resultsPerSite: body.resultsPerSite } : {}),
      ...(body.hoursOld !== undefined ? { hoursOld: body.hoursOld } : {}),
      ...(body.schedulingEnabled !== undefined
        ? { schedulingEnabled: body.schedulingEnabled }
        : {}),
      ...(body.scheduleCron !== undefined ? { scheduleCron: body.scheduleCron } : {}),
      ...(body.maxParallelFamilies !== undefined
        ? { maxParallelFamilies: body.maxParallelFamilies }
        : {}),
      ...(body.useBrowserHeaders !== undefined ? { useBrowserHeaders: body.useBrowserHeaders } : {}),
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
  return DiscoverySettingsPythonSchema.safeParse(value).success;
}

function persistedValue<T>(
  metadata: EffectiveDiscoverySetting<T>,
  value: T | undefined,
): EffectiveDiscoverySetting<T> {
  if (value === undefined || !metadata.editable) {
    return metadata;
  }
  return { ...metadata, value, source: "persisted" };
}
