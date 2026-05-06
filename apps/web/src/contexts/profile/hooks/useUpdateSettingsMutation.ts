import type { SettingsUpdateRequest } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import type { SettingsResponse } from "../../operations/types.js";
import { patchSettingsResponse } from "../lib/profile-patches.js";
import { profileKeys } from "../queryKeys.js";

export function useUpdateSettingsMutation(): UseMutationResult<
  SettingsResponse,
  Error,
  SettingsUpdateRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<SettingsResponse, SettingsUpdateRequest>(queryClient, {
      mutationKey: profileKeys.settings(tenantId),
      mutationFn: (body) => api.updateSettings(body),
      optimisticUpdates: (body) => [
        {
          queryKey: profileKeys.settings(tenantId),
          patch: (current) => patchSettingsResponse(current, body),
        },
      ],
      settle: () => [profileKeys.settings(tenantId)],
    }),
  );
}
