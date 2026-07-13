import type { SettingsResponse, SettingsUpdateRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { patchSettingsResponse } from "../../../shared/lib/settings-patches.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { settingsKeys } from "../../operations/settingsKeys.js";

export function useUpdateAiExecutionPolicyMutation(): UseMutationResult<SettingsResponse, Error, SettingsUpdateRequest> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(createOptimisticMutation(queryClient, {
    mutationKey: [...settingsKeys.settings(tenantId), "materials-policy"],
    mutationFn: (body: SettingsUpdateRequest) => api.updateSettings(body),
    optimisticUpdates: (body: SettingsUpdateRequest) => [{ queryKey: settingsKeys.settings(tenantId), patch: (current) => patchSettingsResponse(current, body) }],
    settle: () => [settingsKeys.settings(tenantId)],
  }));
}
